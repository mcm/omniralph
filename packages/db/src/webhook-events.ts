/**
 * The webhook delivery log (`webhook_events`): every verified code-host and Linear
 * delivery that resolved to an organization, with its outcome, kept for
 * `WEBHOOK_EVENT_RETENTION_DAYS`. Recording a delivery publishes a `webhook_event`
 * change (the event's and its connection's IDs) on the organization's channel.
 */
import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import type { RunKind } from "./run-index.js";
import {
  integrations,
  organizations,
  repositories,
  scmConnections,
  users,
  webhookEvents,
} from "./schema.js";
import type { WebhookProvider } from "./webhooks.js";

/** How long deliveries are kept (`prune-webhook-deliveries` cron). */
export const WEBHOOK_EVENT_RETENTION_DAYS = 14;

/** A body over this many bytes is recorded without its payload (`payload_truncated`). */
export const WEBHOOK_EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;

/** Rows `pruneWebhookEvents` deletes per statement. */
export const WEBHOOK_EVENT_PRUNE_BATCH = 1_000;

export const WEBHOOK_EVENT_OUTCOMES = webhookEvents.outcome.enumValues;
export type WebhookEventOutcome = (typeof WEBHOOK_EVENT_OUTCOMES)[number];

type Executor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

/** Where a delivery came in: a code-host connection or a tracker integration. */
export type WebhookEventSource = { scmConnectionId: string } | { integrationId: string };

/** The run a delivery started or updated. */
export interface WebhookEventRun {
  id: string;
  kind: RunKind;
}

export interface NewWebhookEvent {
  organizationId: string;
  provider: WebhookProvider;
  source: WebhookEventSource;
  repositoryId?: string | null;
  deliveryId?: string | null;
  event: string;
  /** The raw body as received: kept parsed, or dropped when it's over the size limit. */
  rawBody: string;
  outcome: WebhookEventOutcome;
  reasonCode?: string | null;
  reason?: string | null;
  run?: WebhookEventRun | null;
  replayOfId?: string | null;
  replayedBy?: string | null;
}

export interface WebhookEventOutcomeUpdate {
  outcome: WebhookEventOutcome;
  reasonCode?: string | null;
  reason?: string | null;
  run?: WebhookEventRun | null;
}

const sourceId = (source: WebhookEventSource) =>
  "scmConnectionId" in source ? source.scmConnectionId : source.integrationId;

/** The payload as stored: the parsed body, or null with `payloadTruncated` past the limit. */
export function webhookEventPayload(rawBody: string): {
  payload: unknown;
  payloadTruncated: boolean;
} {
  if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_EVENT_PAYLOAD_MAX_BYTES) {
    return { payload: null, payloadTruncated: true };
  }
  try {
    return { payload: JSON.parse(rawBody) as unknown, payloadTruncated: false };
  } catch {
    return { payload: null, payloadTruncated: true };
  }
}

/** Records a delivery and its outcome; returns the new row's ID. */
export async function recordWebhookEvent(db: Executor, input: NewWebhookEvent): Promise<string> {
  const { payload, payloadTruncated } = webhookEventPayload(input.rawBody);
  const [row] = await db
    .insert(webhookEvents)
    .values({
      organizationId: input.organizationId,
      provider: input.provider,
      scmConnectionId: "scmConnectionId" in input.source ? input.source.scmConnectionId : null,
      integrationId: "integrationId" in input.source ? input.source.integrationId : null,
      repositoryId: input.repositoryId ?? null,
      deliveryId: input.deliveryId ?? null,
      event: input.event,
      payload,
      payloadTruncated,
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      reason: input.reason ?? null,
      runId: input.run?.id ?? null,
      runKind: input.run?.kind ?? null,
      replayOfId: input.replayOfId ?? null,
      replayedBy: input.replayedBy ?? null,
    })
    .returning({ id: webhookEvents.id });
  // A replay changes the original's detail too (its list of replays).
  recordChange(db, {
    resource: "webhook_event",
    ids: [row!.id, ...(input.replayOfId ? [input.replayOfId] : []), sourceId(input.source)],
    organizationId: input.organizationId,
    runId: input.run?.id ?? null,
  });
  return row!.id;
}

/**
 * Sets the outcome of a recorded delivery whose work finished after the response (a
 * Linear event's handler, a deferred `@bot` command): what it did, or why it failed.
 */
export async function updateWebhookEventOutcome(
  db: Executor,
  id: string,
  update: WebhookEventOutcomeUpdate,
): Promise<void> {
  const rows = await db
    .update(webhookEvents)
    .set({
      outcome: update.outcome,
      reasonCode: update.reasonCode ?? null,
      reason: update.reason ?? null,
      ...(update.run !== undefined && {
        runId: update.run?.id ?? null,
        runKind: update.run?.kind ?? null,
      }),
    })
    .where(eq(webhookEvents.id, id))
    .returning({
      organizationId: webhookEvents.organizationId,
      scmConnectionId: webhookEvents.scmConnectionId,
      integrationId: webhookEvents.integrationId,
      runId: webhookEvents.runId,
    });
  const row = rows[0];
  if (!row) return;
  recordChange(db, {
    resource: "webhook_event",
    ids: [id, (row.scmConnectionId ?? row.integrationId)!],
    organizationId: row.organizationId,
    runId: row.runId,
  });
}

/** A delivery in the log, without its payload. */
export interface WebhookEventSummary {
  id: string;
  organizationId: string;
  organizationName: string;
  provider: WebhookProvider;
  scmConnectionId: string | null;
  integrationId: string | null;
  repository: { id: string; provider: "github" | "gitlab"; fullPath: string } | null;
  deliveryId: string | null;
  event: string;
  outcome: WebhookEventOutcome;
  reasonCode: string | null;
  reason: string | null;
  run: WebhookEventRun | null;
  replayOfId: string | null;
  /** Who replayed it (a replay's row), while that user exists. */
  replayedBy: { id: string; name: string | null } | null;
  payloadTruncated: boolean;
  /** UTC ISO to the microsecond (the cursor's precision). */
  receivedAt: string;
}

/** A delivery with its payload. */
export interface WebhookEventDetail extends WebhookEventSummary {
  payload: unknown;
}

export interface WebhookEventCursor {
  receivedAt: string;
  id: string;
}

export interface WebhookEventListFilter {
  source: WebhookEventSource;
  outcomes?: readonly WebhookEventOutcome[];
  cursor?: WebhookEventCursor | null;
  limit: number;
}

const receivedAtIso = sql<string>`to_char(${webhookEvents.receivedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const summaryColumns = {
  id: webhookEvents.id,
  organizationId: webhookEvents.organizationId,
  organizationName: organizations.name,
  provider: webhookEvents.provider,
  scmConnectionId: webhookEvents.scmConnectionId,
  integrationId: webhookEvents.integrationId,
  repositoryId: repositories.id,
  repositoryProvider: repositories.provider,
  repositoryFullPath: repositories.fullPath,
  deliveryId: webhookEvents.deliveryId,
  event: webhookEvents.event,
  outcome: webhookEvents.outcome,
  reasonCode: webhookEvents.reasonCode,
  reason: webhookEvents.reason,
  runId: webhookEvents.runId,
  runKind: webhookEvents.runKind,
  replayOfId: webhookEvents.replayOfId,
  replayedById: users.id,
  replayedByName: users.name,
  payloadTruncated: webhookEvents.payloadTruncated,
  receivedAt: receivedAtIso,
};

interface SummaryRow extends Omit<WebhookEventSummary, "repository" | "run" | "replayedBy"> {
  replayedById: string | null;
  replayedByName: string | null;
  repositoryId: string | null;
  repositoryProvider: "github" | "gitlab" | null;
  repositoryFullPath: string | null;
  runId: string | null;
  runKind: RunKind | null;
}

function summary(row: SummaryRow): WebhookEventSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    provider: row.provider,
    scmConnectionId: row.scmConnectionId,
    integrationId: row.integrationId,
    repository:
      row.repositoryId && row.repositoryProvider && row.repositoryFullPath
        ? {
            id: row.repositoryId,
            provider: row.repositoryProvider,
            fullPath: row.repositoryFullPath,
          }
        : null,
    deliveryId: row.deliveryId,
    event: row.event,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    reason: row.reason,
    run: row.runId && row.runKind ? { id: row.runId, kind: row.runKind } : null,
    replayOfId: row.replayOfId,
    replayedBy: row.replayedById ? { id: row.replayedById, name: row.replayedByName } : null,
    payloadTruncated: row.payloadTruncated,
    receivedAt: row.receivedAt,
  };
}

/**
 * A page of a connection's deliveries, newest first, after `cursor`
 * (`(received_at, id)`); `next` is the cursor of the following page, null on the last.
 */
export async function listWebhookEvents(
  db: Executor,
  filter: WebhookEventListFilter,
): Promise<{ events: WebhookEventSummary[]; next: WebhookEventCursor | null }> {
  const where: SQL[] = [
    "scmConnectionId" in filter.source
      ? eq(webhookEvents.scmConnectionId, filter.source.scmConnectionId)
      : eq(webhookEvents.integrationId, filter.source.integrationId),
  ];
  if (filter.outcomes?.length) where.push(inArray(webhookEvents.outcome, [...filter.outcomes]));
  if (filter.cursor) {
    where.push(
      sql`(${webhookEvents.receivedAt}, ${webhookEvents.id}) < (${filter.cursor.receivedAt}::timestamptz, ${filter.cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select(summaryColumns)
    .from(webhookEvents)
    .innerJoin(organizations, eq(organizations.id, webhookEvents.organizationId))
    .leftJoin(repositories, eq(repositories.id, webhookEvents.repositoryId))
    .leftJoin(users, eq(users.id, webhookEvents.replayedBy))
    .where(and(...where))
    .orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id))
    .limit(filter.limit + 1);
  const page = rows.slice(0, filter.limit).map(summary);
  const last = page.at(-1);
  return {
    events: page,
    next: rows.length > filter.limit && last ? { receivedAt: last.receivedAt, id: last.id } : null,
  };
}

/** A delivery of any organization by ID (the caller checks membership), or null. */
export async function getWebhookEvent(
  db: Executor,
  id: string,
): Promise<WebhookEventDetail | null> {
  const [row] = await db
    .select({ ...summaryColumns, payload: webhookEvents.payload })
    .from(webhookEvents)
    .innerJoin(organizations, eq(organizations.id, webhookEvents.organizationId))
    .leftJoin(repositories, eq(repositories.id, webhookEvents.repositoryId))
    .leftJoin(users, eq(users.id, webhookEvents.replayedBy))
    .where(eq(webhookEvents.id, id))
    .limit(1);
  if (!row) return null;
  return { ...summary(row), payload: row.payload };
}

/** A delivery's replays, newest first. */
export async function listWebhookEventReplays(
  db: Executor,
  id: string,
): Promise<WebhookEventSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(webhookEvents)
    .innerJoin(organizations, eq(organizations.id, webhookEvents.organizationId))
    .leftJoin(repositories, eq(repositories.id, webhookEvents.repositoryId))
    .leftJoin(users, eq(users.id, webhookEvents.replayedBy))
    .where(eq(webhookEvents.replayOfId, id))
    .orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id));
  return rows.map(summary);
}

/**
 * The organization of a delivery log's connection (any organization's: the caller checks
 * membership): a code-host connection, or a Linear integration. Null when there's none.
 */
export async function getWebhookEventSourceOrganizationId(
  db: Executor,
  source: WebhookEventSource,
): Promise<string | null> {
  const [row] =
    "scmConnectionId" in source
      ? await db
          .select({ organizationId: scmConnections.organizationId })
          .from(scmConnections)
          .where(eq(scmConnections.id, source.scmConnectionId))
          .limit(1)
      : await db
          .select({ organizationId: integrations.organizationId })
          .from(integrations)
          .where(
            and(eq(integrations.id, source.integrationId), eq(integrations.provider, "linear")),
          )
          .limit(1);
  return row?.organizationId ?? null;
}

/**
 * Deletes deliveries received before `before`, `WEBHOOK_EVENT_PRUNE_BATCH` rows per
 * statement (on `webhook_events_received_at_idx`); returns how many went.
 */
export async function pruneWebhookEvents(
  db: Executor,
  before: Date,
  batchSize = WEBHOOK_EVENT_PRUNE_BATCH,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await db
      .delete(webhookEvents)
      .where(
        inArray(
          webhookEvents.id,
          db
            .select({ id: webhookEvents.id })
            .from(webhookEvents)
            .where(lt(webhookEvents.receivedAt, before))
            .limit(batchSize),
        ),
      )
      .returning({ id: webhookEvents.id });
    total += deleted.length;
    if (deleted.length < batchSize) return total;
  }
}
