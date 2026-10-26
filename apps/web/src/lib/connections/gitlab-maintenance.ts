import "server-only";
import {
  connectionCredentials,
  listConnectionRepositories,
  setScmConnectionHealth,
  updateScmConnectionCredentials,
  withSettingsChanges,
  type Database,
  type ScmConnection,
  type SettingsActor,
} from "@omniralph/db";
import {
  checkGitLabConnection,
  rotateGitLabToken,
  type GitLabHealth,
  type GitLabProblem,
  type GitLabRotation,
} from "@omniralph/scm";
import { trackedConnection } from "@/lib/settings-history/sections";

/**
 * A GitLab connection's maintenance, as the daily `gitlab-maintenance` cron runs it for every
 * connection and an admin's "Rotate token" runs it for one: rotate the bot token, then check
 * the token and the webhooks of its enabled projects and replace the connection's `health`.
 */

/** Encrypted credentials of a GitLab connection, as far as maintenance reads them. */
interface GitLabCredentials extends Record<string, unknown> {
  token: string;
  /** When the token was last rotated (ISO); unset until the first rotation. */
  rotatedAt?: string;
}

const ROTATION_PROBLEMS = new Set(["rotation_unsupported", "rotation_failed"]);

/** A token rotated less than this long ago (by an overlapping or repeated run) isn't rotated again. */
const ROTATION_INTERVAL_MS = 60 * 60 * 1000;

/** Why the token wasn't rotated, when it wasn't. */
export type GitLabRotationOutcome =
  | "rotated"
  /** Rotated by another run meanwhile, or within the last hour. */
  | "recent"
  | "token_invalid"
  | "access_token_bot"
  | "unsupported"
  | "failed";

export type GitLabMaintenance =
  | {
      ok: true;
      /** What the rotation did; null when it wasn't asked for (`rotate: false`). */
      rotation: GitLabRotationOutcome | null;
      /** The rotation problem recorded in `health` (`rotation_unsupported`, `rotation_failed`). */
      rotationProblem: GitLabProblem | null;
      health: GitLabHealth;
    }
  /** The check failed (e.g. GitLab unreachable): the previous health is kept, plus any rotation problem. */
  | {
      ok: false;
      error: unknown;
      rotation: GitLabRotationOutcome | null;
      rotationProblem: GitLabProblem | null;
    };

export interface GitLabMaintenanceOptions {
  /** Default true; false only re-checks the health with the stored token. */
  rotate?: boolean;
  /** Rotate even when the token was rotated within the last hour (an admin's "Rotate token"). */
  force?: boolean;
  /** Who rotates: the rotation is then recorded in the connection's change history. */
  actor?: SettingsActor;
}

/**
 * Rotates the connection's bot token (unless `rotate: false`) and re-checks its health,
 * storing both. Never throws for GitLab's errors: a failed check is answered as `ok: false`
 * (and logged).
 */
export async function maintainGitLabConnection(
  db: Database,
  connection: ScmConnection,
  options: GitLabMaintenanceOptions = {},
): Promise<GitLabMaintenance> {
  let rotation: GitLabRotationOutcome | null = null;
  let rotationProblem: GitLabProblem | null = null;
  try {
    let token = connectionCredentials<GitLabCredentials>(connection).token;
    if (options.rotate ?? true) {
      const rotated = await rotateToken(db, connection, options);
      ({ token, outcome: rotation, problem: rotationProblem } = rotated);
    }
    const repositories = await listConnectionRepositories(db, connection.id);
    const health = await checkGitLabConnection({
      baseUrl: connection.baseUrl,
      token,
      projects: repositories
        .filter((r) => r.reviewsEnabled && r.disconnectedAt === null)
        .map((r) => ({
          repositoryId: r.id,
          projectId: r.externalId,
          fullPath: r.fullPath,
          webhookId: r.webhookId,
        })),
    });
    if (rotationProblem) health.problems.unshift(rotationProblem);
    await setScmConnectionHealth(db, connection.id, health);
    return { ok: true, rotation, rotationProblem, health };
  } catch (error) {
    console.error(`Checking GitLab connection ${connection.id} (${connection.name}) failed`, error);
    if (rotationProblem) await keepHealthWith(db, connection, rotationProblem);
    return { ok: false, error, rotation, rotationProblem };
  }
}

/**
 * Rotates the connection's bot token under a row lock, writing the new token in the same
 * transaction (GitLab revokes the old one immediately). The token is re-read once the lock is
 * held: when it differs from the one listed, or was rotated within the last hour (unless
 * `force`), another run already rotated it (even one that finished before this run listed the
 * connection), so it isn't rotated again. Returns the token to use now and the rotation
 * problem to record, if any.
 */
async function rotateToken(
  db: Database,
  connection: ScmConnection,
  { force = false, actor }: GitLabMaintenanceOptions,
): Promise<{ token: string; outcome: GitLabRotationOutcome; problem: GitLabProblem | null }> {
  const listed = connectionCredentials<GitLabCredentials>(connection).token;
  // Set inside the transaction callback.
  const locked: { token: string; rotation: GitLabRotation | null } = {
    token: listed,
    rotation: null,
  };
  const update = (tx: Database) =>
    updateScmConnectionCredentials<GitLabCredentials>(tx, connection.id, async (credentials) => {
      locked.token = credentials.token;
      if (credentials.token !== listed || (!force && rotatedRecently(credentials))) return null;
      locked.rotation = await rotateGitLabToken({
        baseUrl: connection.baseUrl,
        token: credentials.token,
      });
      if (locked.rotation.status !== "rotated") return null;
      return { ...credentials, token: locked.rotation.token, rotatedAt: new Date().toISOString() };
    });
  try {
    if (actor) {
      await withSettingsChanges(
        db,
        actor,
        trackedConnection(connection.organizationId, connection.id),
        update,
      );
    } else {
      await update(db);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lost = locked.rotation?.status === "rotated";
    const name = `GitLab connection ${connection.id} (${connection.name})`;
    console.error(
      lost
        ? `Rotating the bot token of ${name} failed after GitLab revoked the old token: it must be reconnected`
        : `Rotating the bot token of ${name} failed`,
      error,
    );
    return {
      token: listed,
      outcome: "failed",
      problem: {
        code: "rotation_failed",
        message: lost
          ? `GitLab rotated the bot token but saving the new one failed (${message}). Connect GitLab again with a new token.`
          : `Rotating the bot token failed: ${message}`,
      },
    };
  }
  const { token, rotation } = locked;
  if (rotation?.status === "rotated")
    return { token: rotation.token, outcome: "rotated", problem: null };
  if (rotation?.status === "unsupported") {
    return {
      token,
      outcome: "unsupported",
      problem: {
        code: "rotation_unsupported",
        message:
          "This GitLab instance can't rotate the bot token automatically (no self-rotation endpoint). " +
          "Rotate it by hand before it expires.",
      },
    };
  }
  if (rotation?.status === "skipped") return { token, outcome: rotation.reason, problem: null };
  return { token, outcome: "recent", problem: null };
}

function rotatedRecently({ rotatedAt }: GitLabCredentials): boolean {
  if (!rotatedAt) return false;
  // A rotation stamped slightly in the future (another instance's clock is ahead) is recent too.
  const age = Date.now() - Date.parse(rotatedAt);
  return Math.abs(age) < ROTATION_INTERVAL_MS;
}

/** Records a rotation problem on top of the previous health when the check itself failed. */
async function keepHealthWith(
  db: Database,
  connection: ScmConnection,
  problem: GitLabProblem,
): Promise<void> {
  const previous = connection.health ?? {
    checkedAt: new Date().toISOString(),
    tokenExpiresAt: null,
    problems: [],
  };
  try {
    await setScmConnectionHealth(db, connection.id, {
      ...previous,
      problems: [problem, ...previous.problems.filter((p) => !ROTATION_PROBLEMS.has(p.code))],
    });
  } catch (error) {
    console.error(
      `Recording the rotation problem of GitLab connection ${connection.id} failed`,
      error,
    );
  }
}
