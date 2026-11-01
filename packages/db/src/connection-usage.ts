/**
 * What uses an organization's connections, for Settings' connection pages: the repos on each
 * code-host connection and on each tracker, the deliveries that failed and weren't
 * replayed, and the chat identities linked per platform.
 */
import { and, count, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { chatIdentities, repositories, webhookEvents, workItemMatches } from "./schema.js";
import { WEBHOOK_EVENT_RETENTION_DAYS } from "./webhook-events.js";

type Executor = Pick<Database, "select">;
type WorkItemTrackerKind = (typeof workItemMatches.$inferSelect)["tracker"];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConnectionUsage {
  /** Connected (not disconnected) repos per code-host connection ID. */
  reposByScmConnection: Map<string, number>;
  /** Connected repos with a work item match, per tracker. */
  matchedReposByTracker: Map<WorkItemTrackerKind, number>;
  /**
   * Failed deliveries not yet replayed, per code-host connection or integration ID: rows
   * with outcome `failed`, received within the retention, that no row replays
   * (`replay_of_id`). A replay that fails again is itself such a row.
   */
  failedDeliveries: Map<string, number>;
  /** Linked chat identities per platform. */
  linkedAccounts: Map<"slack" | "discord", number>;
}

/** The unreplayed failed deliveries of `organizationId`, per connection or integration ID. */
export async function countUnreplayedFailedDeliveries(
  db: Executor,
  organizationId: string,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS);
  const source = sql<string>`coalesce(${webhookEvents.scmConnectionId}, ${webhookEvents.integrationId})`;
  const rows = await db
    .select({ source, failed: count() })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.organizationId, organizationId),
        eq(webhookEvents.outcome, "failed"),
        gte(webhookEvents.receivedAt, since),
        sql`not exists (select 1 from ${webhookEvents} as replay where replay.replay_of_id = ${webhookEvents.id})`,
      ),
    )
    .groupBy(source);
  return new Map(rows.map((row) => [row.source, Number(row.failed)]));
}

export async function getConnectionUsage(
  db: Executor,
  organizationId: string,
  now: Date = new Date(),
): Promise<ConnectionUsage> {
  const [repos, matched, failedDeliveries, identities] = await Promise.all([
    db
      .select({ connectionId: repositories.connectionId, repos: count() })
      .from(repositories)
      .where(
        and(eq(repositories.organizationId, organizationId), isNull(repositories.disconnectedAt)),
      )
      .groupBy(repositories.connectionId),
    db
      .select({ tracker: workItemMatches.tracker, repos: count() })
      .from(workItemMatches)
      .innerJoin(repositories, eq(repositories.id, workItemMatches.repositoryId))
      .where(
        and(
          eq(workItemMatches.organizationId, organizationId),
          isNull(repositories.disconnectedAt),
        ),
      )
      .groupBy(workItemMatches.tracker),
    countUnreplayedFailedDeliveries(db, organizationId, now),
    db
      .select({ platform: chatIdentities.platform, accounts: count() })
      .from(chatIdentities)
      .where(
        and(eq(chatIdentities.organizationId, organizationId), ne(chatIdentities.platform, "web")),
      )
      .groupBy(chatIdentities.platform),
  ]);
  return {
    reposByScmConnection: new Map(repos.map((row) => [row.connectionId, Number(row.repos)])),
    matchedReposByTracker: new Map(matched.map((row) => [row.tracker, Number(row.repos)])),
    failedDeliveries,
    linkedAccounts: new Map(
      identities.flatMap(({ platform, accounts }) =>
        platform === "web" ? [] : [[platform, Number(accounts)] as const],
      ),
    ),
  };
}
