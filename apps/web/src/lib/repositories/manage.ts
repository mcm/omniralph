import "server-only";
import { randomBytes } from "node:crypto";
import {
  connectionCredentials,
  connectRepository,
  deleteScmConnection,
  disconnectRepository as disconnectRepositoryRow,
  findScmConnection,
  getAllowedTaskTypeDefaults,
  getRepository,
  getScmConnection,
  listConnectionRepositories,
  removeScmConnectionProblems,
  setRepositoryEnabled as setRepositoryEnabledRow,
  setRepositoryWebhookId,
  upsertScmConnection,
  withSettingsChanges,
  type Database,
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
import { bumpOrganizationHeartbeat } from "@/lib/harnesses/heartbeat-cache";
import { parseGitLabConnectForm, type GitLabConnectForm } from "@/lib/repositories/gitlab-input";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { getGitHubAppAuth } from "@/lib/scm/github-app";
import {
  connectingWithHistory,
  settingsActor,
  trackedConnection,
} from "@/lib/settings-history/sections";

/**
 * An admin's changes to the organization's code-host connections and connected repositories
 * (the Repositories page and its GitHub/GitLab pickers): the logic behind the
 * `/api/ui/repositories/…` and `/api/ui/scm-connections/…` handlers, which parse, authorize
 * and serialize. Every function is scoped to the admin's active organization, answers an
 * `ActionResult` worded for the panel's toasts, and records what it changed in the
 * connection's change history.
 */

/** The admin making the change, in their active organization. */
type Admin = Pick<OrgUser, "id" | "name" | "email" | "organization">;

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
 * (or re-enables it). A project that's already connected keeps its webhook; otherwise the
 * new one replaces any old one, so there is exactly one per project. Before a project is
 * connected or re-enabled, its read-only clone credential is fetched through `adapter`
 * (minting a project access token, or reusing a valid cached one), so a project agents
 * couldn't clone is never connected. Returns the projects that couldn't be connected, with
 * the reason.
 */
async function connectGitLabProjects(
  db: Database,
  gitlab: GitLabSetupClient,
  adapter: ScmAdapter,
  organizationId: string,
  connectionId: string,
  webhookSecret: string,
  projects: GitLabProject[],
): Promise<string[]> {
  const known = new Map(
    (await listConnectionRepositories(db, connectionId)).map((repo) => [repo.externalId, repo]),
  );
  const enabled = await selectedReviewsSwitch(db, organizationId);
  const failed: string[] = [];
  for (const project of projects) {
    const input = {
      connectionId,
      provider: "gitlab",
      externalId: String(project.id),
      fullPath: project.fullPath,
      enabled,
    } as const;
    const previous = known.get(input.externalId);
    const hooked = Boolean(previous && !previous.disconnectedAt && previous.webhookId);
    if (hooked && previous?.effective.review) {
      await connectRepository(db, input);
      continue;
    }

    // The credential cache needs the repository's row, so a new project gets one with reviews
    // off until it's checked; it's disconnected again if it can't be connected.
    const added = previous ? null : await connectRepository(db, { ...input, enabled: false });
    try {
      await adapter.getReadOnlyCloneCredential({
        fullPath: project.fullPath,
        externalId: input.externalId,
      });
      if (hooked) {
        await connectRepository(db, input);
        continue;
      }
      const webhookId = await createGitLabWebhook(gitlab, project.id, webhookSecret);
      await connectRepository(db, { ...input, webhookId });
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
  return failed;
}

/**
 * Connects GitLab: validates the bot token and stores the connection (token and webhook
 * secret encrypted) in the admin's organization. Its projects are then picked from a list
 * (see {@link saveGitLabProjects}). Nothing is stored if the token is bad, or the connection
 * (same instance and token user) already belongs to another organization. Answers the
 * connection's ID.
 */
export async function connectGitLab(
  db: Database,
  admin: Admin,
  form: GitLabConnectForm,
): Promise<ActionResult & { connectionId?: string }> {
  const organizationId = admin.organization.id;
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
 * Disconnects a repository: disables it, removes its agent pins and, for GitLab, deletes
 * its project webhook. Its review history is kept.
 */
export async function disconnectRepository(
  db: Database,
  admin: Admin,
  id: string,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
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
  // Its pins are gone from the heartbeats of whichever harnesses had it.
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
  admin: Admin,
  repositoryId: string,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
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
  return { ok: true };
}

/**
 * Removes a GitHub App installation or GitLab connection from the admin's organization:
 * deletes the project webhooks of its GitLab repositories, then the connection with its
 * repositories (and their reviews, rules and pins). The installation or token user can then
 * be connected again, from this or another organization. A GitHub App stays installed on
 * GitHub until it's uninstalled there.
 */
export async function removeScmConnection(
  db: Database,
  admin: Admin,
  connectionId: string,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
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
 * The reviews switch a repository ticked on a selection page is connected with: inherit the
 * organization's default, or on when the default leaves reviews off.
 */
async function selectedReviewsSwitch(db: Database, organizationId: string): Promise<true | null> {
  return (await getAllowedTaskTypeDefaults(db, organizationId)).includes("review") ? null : true;
}

/**
 * Saves which repositories of a GitHub App installation get reviews: selected ones are
 * connected (or re-enabled), other connected ones are disabled. Only repositories the
 * installation can access are accepted.
 */
export async function saveGitHubRepositories(
  db: Database,
  admin: Admin,
  connectionId: string,
  selectedRepoIds: number[],
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
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

  const selected = new Set(selectedRepoIds.map(String));
  await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(organizationId, connectionId),
    async (tx) => {
      const enabled = await selectedReviewsSwitch(tx, organizationId);
      for (const repo of available) {
        if (!selected.has(String(repo.id))) continue;
        await connectRepository(tx, {
          connectionId,
          provider: "github",
          externalId: String(repo.id),
          fullPath: repo.fullPath,
          enabled,
        });
      }
      for (const repo of await listConnectionRepositories(tx, connectionId)) {
        if (!repo.disconnectedAt && repo.effective.review && !selected.has(repo.externalId)) {
          await setRepositoryEnabledRow(tx, organizationId, repo.id, false);
        }
      }
    },
  );
  return { ok: true };
}

/**
 * Saves which projects of a GitLab connection get reviews: selected ones are connected (a
 * project webhook is created for those without one) or re-enabled, other listed connected ones
 * are disabled; connected projects the list doesn't show are left alone. Only projects the bot
 * token's user maintains are accepted, and only once a clone token can be minted for them: the
 * others are named in the result's warning.
 */
export async function saveGitLabProjects(
  db: Database,
  admin: Admin,
  connectionId: string,
  selectedProjectIds: number[],
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
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

  const selected = new Set(selectedProjectIds.map(String));
  // One transaction for the history: the adapter's clone credential cache writes on it too
  // (a new project's row exists only there until it commits).
  const failed = await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(organizationId, connectionId),
    async (tx) => {
      const failed = await connectGitLabProjects(
        tx,
        gitlab,
        scmAdapterFor(tx, connection),
        organizationId,
        connectionId,
        webhookSecret,
        available.filter((project) => selected.has(String(project.id))),
      );
      // Projects the list doesn't show (archived, past the cap, no longer maintained) can't be
      // ticked, so only listed ones are disabled when left unticked.
      const listedIds = new Set(available.map((project) => String(project.id)));
      for (const repo of await listConnectionRepositories(tx, connectionId)) {
        if (
          !repo.disconnectedAt &&
          repo.effective.review &&
          listedIds.has(repo.externalId) &&
          !selected.has(repo.externalId)
        ) {
          await setRepositoryEnabledRow(tx, organizationId, repo.id, false);
        }
      }
      return failed;
    },
  );
  if (failed.length > 0) {
    return { ok: true, warning: `Some projects weren't connected. ${failed.join(" ")}` };
  }
  return { ok: true };
}

/** Whether each listed repository (by its code-host ID) is connected with reviews on. */
async function reviewedExternalIds(db: Database, connectionId: string): Promise<Set<string>> {
  return new Set(
    (await listConnectionRepositories(db, connectionId))
      .filter((repo) => !repo.disconnectedAt && repo.effective.review)
      .map((repo) => repo.externalId),
  );
}

/**
 * What a picker lists: the repositories (GitHub) or projects (GitLab) the connection can
 * access, from the code host, each marked with whether it's reviewed here. Calls the code
 * host's API, so it's never polled. Throws the code host's error (the picker names its cause).
 */
export async function listSelectableRepositories(
  db: Database,
  connection: ScmConnection,
): Promise<SelectableRepositories> {
  const reviewed = await reviewedExternalIds(db, connection.id);
  if (connection.provider === "github") {
    const auth = getGitHubAppAuth();
    const installationId = Number(connection.externalId);
    const [installation, repos] = await Promise.all([
      getInstallation(auth, installationId),
      listInstallationRepos(auth, installationId),
    ]);
    return {
      account: installation.account,
      manageUrl: installation.htmlUrl,
      truncated: false,
      repos: repos.map((repo) => ({
        id: repo.id,
        fullPath: repo.fullPath,
        private: repo.private,
        htmlUrl: repo.htmlUrl,
        enabled: reviewed.has(String(repo.id)),
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
      enabled: reviewed.has(String(project.id)),
    })),
  };
}
