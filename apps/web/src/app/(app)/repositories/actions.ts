"use server";

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
  removeScmConnectionProblems,
  setRepositoryEnabled as setRepositoryEnabledRow,
  setRepositoryWebhookId,
  upsertScmConnection,
} from "@omniralph/db";
import {
  GitLabSetupClient,
  GitLabSetupError,
  listInstallationRepos,
  type GitLabProject,
  type ScmAdapter,
} from "@omniralph/scm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { gitlabWebhookUrl } from "@/lib/app-url";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { parseGitLabConnectForm, type GitLabConnectForm } from "@/lib/repositories/gitlab-input";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { getGitHubAppAuth } from "@/lib/scm/github-app";

const REPOSITORIES_PATH = "/repositories";
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
  gitlab: GitLabSetupClient,
  adapter: ScmAdapter,
  organizationId: string,
  connectionId: string,
  webhookSecret: string,
  projects: GitLabProject[],
): Promise<string[]> {
  const db = getDb();
  const known = new Map(
    (await listConnectionRepositories(db, connectionId)).map((repo) => [repo.externalId, repo]),
  );
  const failed: string[] = [];
  for (const project of projects) {
    const input = {
      connectionId,
      provider: "gitlab",
      externalId: String(project.id),
      fullPath: project.fullPath,
    } as const;
    const previous = known.get(input.externalId);
    const hooked = Boolean(previous && !previous.disconnectedAt && previous.webhookId);
    if (hooked && previous?.enabled) {
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
 * secret encrypted) in the admin's active organization. Its projects are then picked from a
 * list (see {@link saveGitLabProjects}). Nothing is stored if the token is bad, or the
 * connection (same instance and token user) already belongs to another organization.
 * Returns the connection's ID.
 */
export async function connectGitLab(
  form: GitLabConnectForm,
): Promise<ActionResult & { connectionId?: string }> {
  return runAdminAction(async (admin) => {
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

    const db = getDb();
    const externalId = String(owner.userId);
    const existing = await findScmConnection(db, "gitlab", baseUrl, externalId);
    if (existing && existing.organizationId !== admin.organization.id) {
      return { ok: false, error: OTHER_ORGANIZATION_ERROR };
    }
    const webhookSecret =
      (existing && connectionCredentials<GitLabCredentials>(existing).webhookSecret) ||
      randomBytes(32).toString("base64url");
    const connection = await upsertScmConnection(db, {
      organizationId: admin.organization.id,
      provider: "gitlab",
      name: `${owner.username} @ ${new URL(baseUrl).host}`,
      baseUrl,
      externalId,
      credentials: { token, webhookSecret } satisfies GitLabCredentials,
      botUsername: owner.username,
      createdBy: admin.id,
    });
    if (!connection) return { ok: false, error: OTHER_ORGANIZATION_ERROR };

    revalidatePath(REPOSITORIES_PATH);
    revalidatePath(`${REPOSITORIES_PATH}/gitlab/${connection.id}`);
    return { ok: true, connectionId: connection.id };
  });
}

/** Turns reviews for a connected repository on or off. */
export async function setRepositoryEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!(await setRepositoryEnabledRow(getDb(), admin.organization.id, id, Boolean(enabled)))) {
      return { ok: false, error: "That repository isn't connected." };
    }
    revalidatePath(REPOSITORIES_PATH);
  });
}

/**
 * Disconnects a repository: disables it, removes its agent pins and, for GitLab, deletes
 * its project webhook. Its review history is kept.
 */
export async function disconnectRepository(id: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    const organizationId = admin.organization.id;
    const repo = await getRepository(db, id, organizationId);
    if (!repo || repo.disconnectedAt)
      return { ok: false, error: "That repository isn't connected." };

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

    await disconnectRepositoryRow(db, organizationId, id);
    revalidatePath(REPOSITORIES_PATH);
    return { ok: true, warning };
  });
}

/**
 * Recreates the webhook of a connected GitLab project (for the health check's
 * `webhook_missing` / `webhook_events_outdated`): deletes the stored webhook if GitLab still
 * has it, creates a new one the same way as the project picker, stores its ID and removes the
 * project's webhook problems from the connection's health. Webhooks are only ever recreated
 * by an admin, never automatically.
 */
export async function recreateGitLabWebhook(repositoryId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
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
      await setRepositoryWebhookId(db, organizationId, repo.id, webhookId);
    }
    await removeScmConnectionProblems(db, connection.id, repo.id, WEBHOOK_PROBLEMS);

    revalidatePath(REPOSITORIES_PATH);
  });
}

/**
 * Removes a GitHub App installation or GitLab connection from the admin's organization:
 * deletes the project webhooks of its GitLab repositories, then the connection with its
 * repositories (and their reviews, rules and pins). The installation or token user can then
 * be connected again, from this or another organization. A GitHub App stays installed on
 * GitHub until it's uninstalled there.
 */
export async function removeScmConnection(connectionId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
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

    await deleteScmConnection(db, organizationId, connection.id);
    revalidatePath(REPOSITORIES_PATH);
    if (failed.length > 0) {
      return {
        ok: true,
        warning: `Removed ${connection.name}, but some GitLab webhooks couldn't be deleted. Remove them under each project's Settings › Webhooks. ${failed.join(" ")}`,
      };
    }
  });
}

/**
 * Saves which repositories of a GitHub App installation get reviews: selected ones are
 * connected (or re-enabled), other connected ones are disabled. Only repositories the
 * installation can access are accepted.
 */
export async function saveGitHubRepositories(
  connectionId: string,
  selectedRepoIds: number[],
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
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
    for (const repo of available) {
      if (!selected.has(String(repo.id))) continue;
      await connectRepository(db, {
        connectionId,
        provider: "github",
        externalId: String(repo.id),
        fullPath: repo.fullPath,
      });
    }
    for (const repo of await listConnectionRepositories(db, connectionId)) {
      if (!repo.disconnectedAt && repo.enabled && !selected.has(repo.externalId)) {
        await setRepositoryEnabledRow(db, organizationId, repo.id, false);
      }
    }
    revalidatePath(REPOSITORIES_PATH);
    revalidatePath(`${REPOSITORIES_PATH}/github/${connectionId}`);
  });
}

/**
 * Saves which projects of a GitLab connection get reviews: selected ones are connected (a
 * project webhook is created for those without one) or re-enabled, other listed connected ones
 * are disabled; connected projects the list doesn't show are left alone. Only projects the bot
 * token's user maintains are accepted, and only once a clone token can be minted for them: the
 * others are named in the result's warning.
 */
export async function saveGitLabProjects(
  connectionId: string,
  selectedProjectIds: number[],
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
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
    const failed = await connectGitLabProjects(
      gitlab,
      scmAdapterFor(db, connection),
      organizationId,
      connectionId,
      webhookSecret,
      available.filter((project) => selected.has(String(project.id))),
    );
    // Projects the list doesn't show (archived, past the cap, no longer maintained) can't be
    // ticked, so only listed ones are disabled when left unticked.
    const listedIds = new Set(available.map((project) => String(project.id)));
    for (const repo of await listConnectionRepositories(db, connectionId)) {
      if (
        !repo.disconnectedAt &&
        repo.enabled &&
        listedIds.has(repo.externalId) &&
        !selected.has(repo.externalId)
      ) {
        await setRepositoryEnabledRow(db, organizationId, repo.id, false);
      }
    }
    revalidatePath(REPOSITORIES_PATH);
    revalidatePath(`${REPOSITORIES_PATH}/gitlab/${connectionId}`);
    if (failed.length > 0) {
      return { ok: true, warning: `Some projects weren't connected. ${failed.join(" ")}` };
    }
  });
}
