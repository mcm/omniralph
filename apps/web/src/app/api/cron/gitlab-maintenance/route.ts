import {
  connectionCredentials,
  listConnectionRepositories,
  listProviderScmConnections,
  setScmConnectionHealth,
  updateScmConnectionCredentials,
  type Database,
  type ScmConnection,
} from "@omniralph/db";
import {
  checkGitLabConnection,
  rotateGitLabToken,
  type GitLabProblem,
  type GitLabRotation,
} from "@omniralph/scm";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";

interface GitLabCredentials extends Record<string, unknown> {
  token: string;
}

const ROTATION_PROBLEMS = new Set(["rotation_unsupported", "rotation_failed"]);

/**
 * Vercel Cron (`vercel.json`, daily): rotates every GitLab connection's bot
 * token (7-day expiry), then checks the token and the webhooks of its enabled
 * projects and replaces the connection's `health` with what it found. It never
 * changes a webhook. A connection whose check fails (e.g. GitLab unreachable)
 * keeps its previous health (plus any rotation problem) and is counted as
 * failed.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const totals = { rotated: 0, checked: 0, problems: 0, failed: 0 };
  for (const connection of await listProviderScmConnections(db, "gitlab")) {
    let rotationProblem: GitLabProblem | null = null;
    try {
      const rotation = await rotateToken(db, connection);
      rotationProblem = rotation.problem;
      if (rotation.rotated) totals.rotated += 1;
      const repositories = await listConnectionRepositories(db, connection.id);
      const health = await checkGitLabConnection({
        baseUrl: connection.baseUrl,
        token: rotation.token,
        projects: repositories
          .filter((r) => r.enabled && r.disconnectedAt === null)
          .map((r) => ({
            repositoryId: r.id,
            projectId: r.externalId,
            fullPath: r.fullPath,
            webhookId: r.webhookId,
          })),
      });
      if (rotationProblem) health.problems.unshift(rotationProblem);
      await setScmConnectionHealth(db, connection.id, health);
      totals.checked += 1;
      totals.problems += health.problems.length;
    } catch (error) {
      console.error(
        `Checking GitLab connection ${connection.id} (${connection.name}) failed`,
        error,
      );
      totals.failed += 1;
      if (rotationProblem) await keepHealthWith(db, connection, rotationProblem);
    }
  }
  return Response.json(totals);
}

/**
 * Rotates the connection's bot token under a row lock, writing the new token
 * in the same transaction (GitLab revokes the old one immediately). The token
 * is re-read once the lock is held: when it differs from the one listed, a
 * concurrent run already rotated it, so it isn't rotated again. Returns the
 * token to use now and the rotation problem to record, if any.
 */
async function rotateToken(
  db: Database,
  connection: ScmConnection,
): Promise<{ token: string; rotated: boolean; problem: GitLabProblem | null }> {
  const listed = connectionCredentials<GitLabCredentials>(connection).token;
  // Set inside the transaction callback.
  const locked: { token: string; rotation: GitLabRotation | null } = {
    token: listed,
    rotation: null,
  };
  try {
    await updateScmConnectionCredentials<GitLabCredentials>(
      db,
      connection.id,
      async (credentials) => {
        locked.token = credentials.token;
        if (credentials.token !== listed) return null;
        locked.rotation = await rotateGitLabToken({
          baseUrl: connection.baseUrl,
          token: credentials.token,
        });
        if (locked.rotation.status !== "rotated") return null;
        return { ...credentials, token: locked.rotation.token };
      },
    );
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
      rotated: false,
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
    return { token: rotation.token, rotated: true, problem: null };
  if (rotation?.status === "unsupported") {
    return {
      token,
      rotated: false,
      problem: {
        code: "rotation_unsupported",
        message:
          "This GitLab instance can't rotate the bot token automatically (no self-rotation endpoint). " +
          "Rotate it by hand before it expires.",
      },
    };
  }
  return { token, rotated: false, problem: null };
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
