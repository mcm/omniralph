import "server-only";
import { randomBytes } from "node:crypto";
import {
  connectionCredentials,
  connectRepository,
  deleteScmConnection,
  disconnectRepository as disconnectRepositoryRow,
  findScmConnection,
  getRepository,
  getScmConnection,
  listConnectionRepositories,
  recordConnectionChange,
  removeScmConnectionProblems,
  setRepositoryWebhookId,
  setScmConnectionAccountType,
  upsertScmConnection,
  withSettingsChanges,
  type Database,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import {
  getInstallation,
  GitLabSetupClient,
  GitLabSetupError,
  listInstallationRepos,
  MAX_LISTED_GITLAB_PROJECTS,
  type GitLabProject,
  type ScmAdapter,
} from "@omniralph/scm";
import type { ActionResult } from "@/lib/action-result";
import type { SelectableRepositories } from "@/lib/api/repositories";
import { gitlabWebhookUrl } from "@/lib/app-url";
import type { OrgUser } from "@/lib/auth/session";
import { bumpOrganizationHeartbeat } from "@/lib/agents/heartbeat-cache";
import { githubAccountType } from "@/lib/connections/github-installation";
import { fetchDefaultBranch } from "@/lib/repositories/default-branch";
import { parseGitLabConnectForm, type GitLabConnectForm } from "@/lib/repositories/gitlab-input";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { getGitHubAppAuth } from "@/lib/scm/github-app";
import {
  connectingWithHistory,
  settingsActor,
  trackedConnection,
} from "@/lib/settings-history/sections";

/**
 * An admin's changes to an organization's code-host connections and connected repositories
 * (the Repos page and its add-repo sheet): the logic behind the `/api/ui/repositories/…`,
 * `/api/ui/scm-connections/…` and `/api/ui/gitlab-connections` handlers, which parse,
 * authorize (admin of `organizationId`) and serialize. Every function is scoped to the
 * organization it's given, answers an `ActionResult` worded for the panel's toasts, and
 * records what it changed in the connection's change history.
 */

/** The admin making the change. */
type Admin = Pick<OrgUser, "id" | "name" | "email">;

/** A repository the add-repo picker connected. */
export interface AddedRepository {
  id: string;
  fullPath: string;
}

/** What adding repositories answers: the ones connected (none when it fails). */
export type AddRepositoriesResult =
  | { ok: true; warning?: string; added: AddedRepository[] }
  | { ok: false; error: string };

function addedRepositories(connected: Repository[]): AddedRepository[] {
  return connected.map((repo) => ({ id: repo.id, fullPath: repo.fullPath }));
}

const OTHER_ORGANIZATION_ERROR =
  "This GitLab token user is already connected to another organization on that instance. Use a different bot token.";

/** Encrypted `scm_connections.encrypted_credentials` of a GitLab connection. */
interface GitLabCredentials extends Record<string, unknown> {
  /** Bot service account's personal access token (`api` scope). */
  token: string;
  /** Secret on every project webhook of the connection (`X-Gitlab-Token`). */
  webhookSecret: string;
}

/** Health problems about a project's webhook, which {@link recreateGitLabWebhook} fixes. */
const WEBHOOK_PROBLEMS = ["webhook_missing", "webhook_events_outdated"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How many added repositories read their default branch from the code host at a time. */
const DEFAULT_BRANCH_CONCURRENCY = 4;

/**
 * Reads and stores the default branch of each added repository that has none stored yet. Best
 * effort: a repository whose read fails stays added, with no default branch (a later run or
 * webhook delivery stores it).
 */
async function storeAddedDefaultBranches(
  db: Database,
  connection: ScmConnection,
  added: Repository[],
): Promise<void> {
  const deps = { db, adapterFor: scmAdapterFor };
  const pending = added.filter((repo) => repo.defaultBranch === null);
  for (let i = 0; i < pending.length; i += DEFAULT_BRANCH_CONCURRENCY) {
    await Promise.all(
      pending.slice(i, i + DEFAULT_BRANCH_CONCURRENCY).map((repo) =>
        fetchDefaultBranch(deps, connection, repo).catch((error: unknown) => {
          console.warn(`Couldn't read the default branch of ${repo.fullPath}`, error);
        }),
      ),
    );
  }
}

/** Creates the Omniralph webhook of a GitLab project. Returns its ID. */
async function createGitLabWebhook(
  gitlab: GitLabSetupClient,
  projectId: number,
  webhookSecret: string,
): Promise<string> {
  const hookId = await gitlab.createProjectHook(projectId, {
    url: gitlabWebhookUrl(),
    secret: webhookSecret,
  });
  return String(hookId);
}

/**
 * Creates the project webhook of every project and connects it to the GitLab connection
 * (or reconnects a disconnected one); the new webhook replaces any old one, so there is
 * exactly one per project. Before a project is connected, its read-only clone credential is
 * fetched through `adapter` (minting a project access token, or reusing a valid cached one),
 * so a project agents couldn't clone is never connected. Projects that are connected already
 * are left alone (adding never changes a connected repository). Returns the connected
 * repositories, and the projects that couldn't be connected with the reason.
 */
async function connectGitLabProjects(
  db: Database,
  gitlab: GitLabSetupClient,
  adapter: ScmAdapter,
  organizationId: string,
  connectionId: string,
  webhookSecret: string,
  projects: GitLabProject[],
): Promise<{ connected: Repository[]; failed: string[] }> {
  const known = new Map(
    (await listConnectionRepositories(db, connectionId)).map((repo) => [repo.externalId, repo]),
  );
  const connected: Repository[] = [];
  const failed: string[] = [];
  for (const project of projects) {
    const input = {
      connectionId,
      provider: "gitlab",
      externalId: String(project.id),
      fullPath: project.fullPath,
    } as const;
    const previous = known.get(input.externalId);
    if (previous && !previous.disconnectedAt) continue;

    // The credential cache needs the repository's row, so a new project gets one with reviews
    // off until it's checked; it's disconnected again if it can't be connected.
    const added = previous
      ? null
      : await connectRepository(db, { ...input, reviewsEnabled: false });
    try {
      await adapter.getReadOnlyCloneCredential({
        fullPath: project.fullPath,
        externalId: input.externalId,
      });
      const webhookId = await createGitLabWebhook(gitlab, project.id, webhookSecret);
      connected.push(await connectRepository(db, { ...input, webhookId }));
      if (previous?.webhookId) {
        await gitlab
          .deleteProjectHook(project.id, Number(previous.webhookId))
          .catch(() => undefined);
      }
    } catch (error) {
      failed.push(`${project.fullPath}: ${errorMessage(error)}`);
      if (added) await disconnectRepositoryRow(db, organizationId, added.id);
    }
  }
  return { connected, failed };
}

/**
 * Connects GitLab: validates the bot token and stores the connection (token and webhook
 * secret encrypted) in the organization. Its projects are then picked from a list
 * (see {@link addGitLabProjects}). Nothing is stored if the token is bad, or the connection
 * (same instance and token user) already belongs to another organization. Answers the
 * connection's ID.
 */
export async function connectGitLab(
  db: Database,
  admin: Admin,
  organizationId: string,
  form: GitLabConnectForm,
): Promise<ActionResult & { connectionId?: string }> {
  const parsed = parseGitLabConnectForm(form);
  if (!parsed.ok) return parsed;
  const { baseUrl, token } = parsed.input;

  let owner;
  try {
    owner = await new GitLabSetupClient({ baseUrl, token }).validateToken();
  } catch (error) {
    if (error instanceof GitLabSetupError) return { ok: false, error: error.message };
    throw error;
  }

  const externalId = String(owner.userId);
  const existing = await findScmConnection(db, "gitlab", baseUrl, externalId);
  if (existing && existing.organizationId !== organizationId) {
    return { ok: false, error: OTHER_ORGANIZATION_ERROR };
  }
  const webhookSecret =
    (existing && connectionCredentials<GitLabCredentials>(existing).webhookSecret) ||
    randomBytes(32).toString("base64url");
  const connection = await connectingWithHistory(
    db,
    settingsActor(admin),
    organizationId,
    existing?.id ?? null,
    (tx) =>
      upsertScmConnection(tx, {
        organizationId,
        provider: "gitlab",
        name: `${owner.username} @ ${new URL(baseUrl).host}`,
        baseUrl,
        externalId,
        credentials: { token, webhookSecret } satisfies GitLabCredentials,
        botUsername: owner.username,
        createdBy: admin.id,
      }),
    (saved) => saved?.id ?? null,
  );
  if (!connection) return { ok: false, error: OTHER_ORGANIZATION_ERROR };
  return { ok: true, connectionId: connection.id };
}

/**
 * Disconnects a repository of the organization: turns Reviews, Coding and Ask off, deletes its
 * work item match and agent pins and, for GitLab, its project webhook. Its review history is
 * kept.
 */
export async function disconnectRepository(
  db: Database,
  admin: Admin,
  organizationId: string,
  id: string,
): Promise<ActionResult> {
  const repo = await getRepository(db, id, organizationId);
  if (!repo || repo.disconnectedAt) return { ok: false, error: "That repository isn't connected." };

  let warning: string | undefined;
  if (repo.provider === "gitlab" && repo.webhookId) {
    const connection = await getScmConnection(db, organizationId, repo.connectionId);
    try {
      if (!connection) throw new Error("its connection no longer exists");
      const { token } = connectionCredentials<GitLabCredentials>(connection);
      await new GitLabSetupClient({ baseUrl: connection.baseUrl, token }).deleteProjectHook(
        Number(repo.externalId),
        Number(repo.webhookId),
      );
    } catch (error) {
      warning = `Disconnected ${repo.fullPath}, but its GitLab webhook (ID ${repo.webhookId}) couldn't be deleted: ${errorMessage(error)}. Remove it under the project's Settings › Webhooks.`;
    }
  }

  await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(organizationId, repo.connectionId),
    (tx) => disconnectRepositoryRow(tx, organizationId, id),
  );
  // Its pins are gone from the heartbeats of whichever agents had it.
  await bumpOrganizationHeartbeat(organizationId);
  return { ok: true, warning };
}

/**
 * Recreates the webhook of a connected GitLab project (for the health check's
 * `webhook_missing` / `webhook_events_outdated`): deletes the stored webhook if GitLab still
 * has it, creates a new one the same way as the project picker, stores its ID and removes the
 * project's webhook problems from the connection's health. Webhooks are only ever recreated
 * by an admin, never automatically.
 */
export async function recreateGitLabWebhook(
  db: Database,
  admin: Pick<OrgUser, "id" | "name" | "email">,
  organizationId: string,
  repositoryId: string,
): Promise<ActionResult> {
  const repo = await getRepository(db, repositoryId, organizationId);
  if (!repo || repo.disconnectedAt || repo.provider !== "gitlab") {
    return { ok: false, error: "That GitLab project isn't connected." };
  }
  const connection = await getScmConnection(db, organizationId, repo.connectionId);
  if (!connection) return { ok: false, error: "That GitLab connection doesn't exist." };
  const { token, webhookSecret } = connectionCredentials<GitLabCredentials>(connection);
  const gitlab = new GitLabSetupClient({ baseUrl: connection.baseUrl, token });
  const projectId = Number(repo.externalId);

  if (repo.webhookId) {
    try {
      await gitlab.deleteProjectHook(projectId, Number(repo.webhookId));
    } catch (error) {
      return {
        ok: false,
        error: `Couldn't delete the old webhook of ${repo.fullPath} (ID ${repo.webhookId}): ${errorMessage(error)}`,
      };
    }
  }
  let webhookId: string | null = null;
  try {
    webhookId = await createGitLabWebhook(gitlab, projectId, webhookSecret);
  } catch (error) {
    return {
      ok: false,
      error: `Couldn't create the webhook of ${repo.fullPath}: ${errorMessage(error)}`,
    };
  } finally {
    // The old webhook is gone either way.
    await withSettingsChanges(
      db,
      settingsActor(admin),
      trackedConnection(organizationId, connection.id),
      (tx) => setRepositoryWebhookId(tx, organizationId, repo.id, webhookId),
    );
  }
  await removeScmConnectionProblems(db, connection.id, repo.id, WEBHOOK_PROBLEMS);
  // Its health changed (the repository's change is its new webhook ID).
  recordConnectionChange(db, connection);
  return { ok: true };
}

/**
 * Removes a GitHub App installation or GitLab connection from the organization:
 * deletes the project webhooks of its GitLab repositories, then the connection with its
 * repositories (and their reviews, rules and pins). The installation or token user can then
 * be connected again, from this or another organization. A GitHub App stays installed on
 * GitHub until it's uninstalled there.
 */
export async function removeScmConnection(
  db: Database,
  admin: Admin,
  organizationId: string,
  connectionId: string,
): Promise<ActionResult> {
  const connection = await getScmConnection(db, organizationId, connectionId);
  if (!connection) return { ok: false, error: "That connection doesn't exist." };

  const failed: string[] = [];
  if (connection.provider === "gitlab") {
    const { token } = connectionCredentials<GitLabCredentials>(connection);
    const gitlab = new GitLabSetupClient({ baseUrl: connection.baseUrl, token });
    for (const repo of await listConnectionRepositories(db, connection.id)) {
      if (!repo.webhookId) continue;
      try {
        await gitlab.deleteProjectHook(Number(repo.externalId), Number(repo.webhookId));
      } catch (error) {
        failed.push(`${repo.fullPath} (webhook ID ${repo.webhookId}): ${errorMessage(error)}`);
      }
    }
  }

  await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(organizationId, connection.id),
    (tx) => deleteScmConnection(tx, organizationId, connection.id),
  );
  await bumpOrganizationHeartbeat(organizationId);
  if (failed.length > 0) {
    return {
      ok: true,
      warning: `Removed ${connection.name}, but some GitLab webhooks couldn't be deleted. Remove them under each project's Settings › Webhooks. ${failed.join(" ")}`,
    };
  }
  return { ok: true };
}

/**
 * Connects the given repositories of a GitHub App installation (or reconnects disconnected
 * ones) with Reviews and Ask on and Coding off. Add-only: connected repositories, listed or
 * not, are never changed. Only repositories the installation can access are accepted; the
 * others are named in the result's warning.
 */
export async function addGitHubRepositories(
  db: Database,
  admin: Admin,
  organizationId: string,
  connectionId: string,
  repoIds: number[],
): Promise<AddRepositoriesResult> {
  const connection = await getScmConnection(db, organizationId, connectionId);
  if (!connection || connection.provider !== "github" || !connection.externalId) {
    return { ok: false, error: "That GitHub installation isn't connected." };
  }
  let available;
  try {
    available = await listInstallationRepos(getGitHubAppAuth(), Number(connection.externalId));
  } catch (error) {
    return {
      ok: false,
      error: `Couldn't list the installation's repositories: ${errorMessage(error)}`,
    };
  }

  const wanted = new Set(repoIds.map(String));
  const connected: Repository[] = [];
  await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(organizationId, connectionId),
    async (tx) => {
      const already = await connectedExternalIds(tx, connectionId);
      for (const repo of available) {
        const externalId = String(repo.id);
        if (!wanted.has(externalId) || already.has(externalId)) continue;
        connected.push(
          await connectRepository(tx, {
            connectionId,
            provider: "github",
            externalId,
            fullPath: repo.fullPath,
          }),
        );
      }
    },
  );
  await storeAddedDefaultBranches(db, connection, connected);
  const listed = new Set(available.map((repo) => String(repo.id)));
  const missing = repoIds.filter((id) => !listed.has(String(id)));
  return {
    ok: true,
    added: addedRepositories(connected),
    ...(missing.length > 0 && {
      warning: `The installation can't access ${missing.length === 1 ? "one of the repositories" : `${missing.length} of the repositories`}, so ${missing.length === 1 ? "it wasn't" : "they weren't"} connected. Add ${missing.length === 1 ? "it" : "them"} to the installation on GitHub first.`,
    }),
  };
}

/**
 * Connects the given projects of a GitLab connection (or reconnects disconnected ones) with
 * Reviews and Ask on and Coding off, each with a project webhook. Add-only: connected
 * projects, listed or not, are never changed. Only projects the bot token's user maintains
 * are accepted, and only once a clone token can be minted for them: the others are named in
 * the result's warning.
 */
export async function addGitLabProjects(
  db: Database,
  admin: Admin,
  organizationId: string,
  connectionId: string,
  projectIds: number[],
): Promise<AddRepositoriesResult> {
  const connection = await getScmConnection(db, organizationId, connectionId);
  if (!connection || connection.provider !== "gitlab") {
    return { ok: false, error: "That GitLab connection doesn't exist." };
  }
  const { token, webhookSecret } = connectionCredentials<GitLabCredentials>(connection);
  const gitlab = new GitLabSetupClient({ baseUrl: connection.baseUrl, token });
  let available;
  try {
    available = await gitlab.listProjects();
  } catch (error) {
    return { ok: false, error: `Couldn't list the GitLab projects: ${errorMessage(error)}` };
  }

  const wanted = new Set(projectIds.map(String));
  // One transaction for the history: the adapter's clone credential cache writes on it too
  // (a new project's row exists only there until it commits).
  const { connected, failed } = await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(organizationId, connectionId),
    (tx) =>
      connectGitLabProjects(
        tx,
        gitlab,
        scmAdapterFor(tx, connection),
        organizationId,
        connectionId,
        webhookSecret,
        available.filter((project) => wanted.has(String(project.id))),
      ),
  );
  await storeAddedDefaultBranches(db, connection, connected);
  const listed = new Set(available.map((project) => String(project.id)));
  const missing = projectIds.filter((id) => !listed.has(String(id)));
  if (missing.length > 0) {
    failed.push(
      `${missing.length === 1 ? "One project isn't" : `${missing.length} projects aren't`} among the projects the bot maintains.`,
    );
  }
  return {
    ok: true,
    added: addedRepositories(connected),
    ...(failed.length > 0 && {
      warning: `Some projects weren't connected. ${failed.join(" ")}`,
    }),
  };
}

/** The code-host IDs of the connection's connected repositories. */
async function connectedExternalIds(db: Database, connectionId: string): Promise<Set<string>> {
  return new Set(
    (await listConnectionRepositories(db, connectionId))
      .filter((repo) => !repo.disconnectedAt)
      .map((repo) => repo.externalId),
  );
}

/**
 * What a picker lists: the repositories (GitHub) or projects (GitLab) the connection can
 * access, from the code host, each marked with whether it's connected here. Calls the code
 * host's API, so it's never polled. Throws the code host's error (the picker names its cause).
 */
export async function listSelectableRepositories(
  db: Database,
  connection: ScmConnection,
): Promise<SelectableRepositories> {
  const connected = await connectedExternalIds(db, connection.id);
  if (connection.provider === "github") {
    const auth = getGitHubAppAuth();
    const installationId = Number(connection.externalId);
    const [installation, repos] = await Promise.all([
      getInstallation(auth, installationId),
      listInstallationRepos(auth, installationId),
    ]);
    // Fills in the account type of an installation saved before it was recorded.
    const accountType = githubAccountType(installation.accountType);
    if (accountType && accountType !== connection.accountType) {
      await setScmConnectionAccountType(db, connection.id, accountType);
    }
    return {
      account: installation.account,
      manageUrl: installation.htmlUrl,
      truncated: false,
      repos: repos.map((repo) => ({
        id: repo.id,
        fullPath: repo.fullPath,
        private: repo.private,
        htmlUrl: repo.htmlUrl,
        connected: connected.has(String(repo.id)),
      })),
    };
  }
  const { token } = connectionCredentials<{ token: string }>(connection);
  const projects = await new GitLabSetupClient({
    baseUrl: connection.baseUrl,
    token,
  }).listProjects();
  return {
    account: connection.name,
    manageUrl: null,
    truncated: projects.length >= MAX_LISTED_GITLAB_PROJECTS,
    repos: projects.map((project) => ({
      id: project.id,
      fullPath: project.fullPath,
      private: project.visibility !== "public",
      htmlUrl: project.webUrl,
      connected: connected.has(String(project.id)),
    })),
  };
}
