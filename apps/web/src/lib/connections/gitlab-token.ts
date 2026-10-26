import "server-only";
import {
  getScmConnectionById,
  updateScmConnectionCredentials,
  withSettingsChanges,
  type Database,
  type ScmConnection,
} from "@omniralph/db";
import { GitLabSetupClient, GitLabSetupError } from "@omniralph/scm";
import type { GitLabTokenResult } from "@/lib/api/connections";
import type { OrgUser } from "@/lib/auth/session";
import { connectionHealth } from "@/lib/connections/health";
import {
  maintainGitLabConnection,
  type GitLabMaintenance,
} from "@/lib/connections/gitlab-maintenance";
import { settingsActor, trackedConnection } from "@/lib/settings-history/sections";

/**
 * An admin's fixes to a GitLab connection's bot token on its connection page: rotate it now,
 * or replace it with a new token of the same GitLab user. Both re-check the connection's
 * health the way the daily `gitlab-maintenance` cron does and answer it.
 */

export type GitLabTokenOutcome =
  ({ ok: true } & GitLabTokenResult) | { ok: false; status: number; code: string; error: string };

export const DIFFERENT_GITLAB_USER_ERROR =
  "This token belongs to a different GitLab user. Add it as a new connection.";

const EMPTY_TOKEN_ERROR = "Enter the bot's access token.";

type Admin = Pick<OrgUser, "id" | "name" | "email">;

/** Encrypted credentials of a GitLab connection, as far as replacing the token reads them. */
interface GitLabCredentials extends Record<string, unknown> {
  token: string;
  rotatedAt?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The health a maintenance run left, as the connection page shows it. */
function healthOf(result: Extract<GitLabMaintenance, { ok: true }>): GitLabTokenResult {
  return { health: connectionHealth({ provider: "gitlab", health: result.health }) };
}

/**
 * Rotates the bot token now (even when the cron rotated it within the hour) and re-checks the
 * health, recording the new token in the connection's change history. Refuses, with what the
 * connection page tells the admin, when the token can't be rotated: the instance has no
 * self-rotation (`rotation_unsupported`), the token is a group or project access token, or
 * GitLab rejects it.
 */
export async function rotateGitLabConnectionToken(
  db: Database,
  admin: Admin,
  connection: ScmConnection,
): Promise<GitLabTokenOutcome> {
  const result = await maintainGitLabConnection(db, connection, {
    force: true,
    actor: settingsActor(admin),
  });
  if (result.rotationProblem) {
    return {
      ok: false,
      status: result.rotationProblem.code === "rotation_unsupported" ? 400 : 502,
      code: result.rotationProblem.code,
      error: result.ok
        ? sentence(result, result.rotationProblem.code)
        : result.rotationProblem.message,
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      status: 502,
      code: "check_failed",
      error:
        result.rotation === "rotated"
          ? `The bot token was rotated, but checking the connection failed: ${errorMessage(result.error)}`
          : `Couldn't reach GitLab to rotate the bot token: ${errorMessage(result.error)}`,
    };
  }
  if (result.rotation === "access_token_bot" || result.rotation === "token_invalid") {
    return {
      ok: false,
      status: 400,
      code: result.rotation,
      error: sentence(result, result.rotation),
    };
  }
  return { ok: true, ...healthOf(result) };
}

/** The connection page's sentence for one of the check's problems. */
function sentence(result: Extract<GitLabMaintenance, { ok: true }>, code: string): string {
  const problem = healthOf(result).health.problems.find((p) => p.code === code);
  return problem?.sentence ?? "The bot token can't be rotated.";
}

/**
 * Replaces the bot token: validates it with GitLab as connecting does, and stores it
 * (encrypted) only when it belongs to the connection's GitLab user; the webhook secret is kept.
 * The change is recorded in the connection's history, then the health is re-checked with the
 * new token.
 */
export async function replaceGitLabConnectionToken(
  db: Database,
  admin: Admin,
  connection: ScmConnection,
  rawToken: string,
): Promise<GitLabTokenOutcome> {
  const token = rawToken.trim();
  if (!token) return { ok: false, status: 400, code: "invalid_request", error: EMPTY_TOKEN_ERROR };
  let owner;
  try {
    owner = await new GitLabSetupClient({ baseUrl: connection.baseUrl, token }).validateToken();
  } catch (error) {
    if (error instanceof GitLabSetupError) {
      return { ok: false, status: 400, code: "invalid_token", error: error.message };
    }
    throw error;
  }
  if (String(owner.userId) !== connection.externalId) {
    return { ok: false, status: 400, code: "different_user", error: DIFFERENT_GITLAB_USER_ERROR };
  }
  const written = await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(connection.organizationId, connection.id),
    (tx) =>
      updateScmConnectionCredentials<GitLabCredentials>(tx, connection.id, async (credentials) => {
        // A replaced token hasn't been rotated: the next daily run rotates it.
        const { rotatedAt: _rotatedAt, ...rest } = credentials;
        return { ...rest, token };
      }),
  );
  const saved = written ? await getScmConnectionById(db, connection.id) : null;
  if (!saved) {
    return { ok: false, status: 404, code: "not_found", error: "That connection doesn't exist." };
  }
  const result = await maintainGitLabConnection(db, saved, { rotate: false });
  if (!result.ok) {
    return {
      ok: false,
      status: 502,
      code: "check_failed",
      error: `The bot token was replaced, but checking the connection failed: ${errorMessage(result.error)}`,
    };
  }
  return { ok: true, ...healthOf(result) };
}
