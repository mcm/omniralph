import {
  connectionCredentials,
  listConnectionRepositories,
  listProviderScmConnections,
  setScmConnectionHealth,
} from "@omniralph/db";
import { checkGitLabConnection } from "@omniralph/scm";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";

/**
 * Vercel Cron (`vercel.json`, daily): checks every GitLab connection's bot
 * token and the webhooks of its enabled projects, and replaces the
 * connection's `health` with what it found. It never changes a webhook. A
 * connection whose check fails (e.g. GitLab unreachable) keeps its previous
 * health and is counted as failed.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const totals = { checked: 0, problems: 0, failed: 0 };
  for (const connection of await listProviderScmConnections(db, "gitlab")) {
    try {
      const { token } = connectionCredentials<{ token: string }>(connection);
      const repositories = await listConnectionRepositories(db, connection.id);
      const health = await checkGitLabConnection({
        baseUrl: connection.baseUrl,
        token,
        projects: repositories
          .filter((r) => r.enabled && r.disconnectedAt === null)
          .map((r) => ({
            repositoryId: r.id,
            projectId: r.externalId,
            fullPath: r.fullPath,
            webhookId: r.webhookId,
          })),
      });
      await setScmConnectionHealth(db, connection.id, health);
      totals.checked += 1;
      totals.problems += health.problems.length;
    } catch (error) {
      console.error(
        `Checking GitLab connection ${connection.id} (${connection.name}) failed`,
        error,
      );
      totals.failed += 1;
    }
  }
  return Response.json(totals);
}
