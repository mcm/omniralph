/**
 * Per-work-item state Omniralph keeps beside the tracker: a member's repository choice
 * ("Change repo…", which routing tries first, `apps/web/src/lib/routing/resolve.ts`) and the
 * actions taken on the item in Omniralph (its Activity).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { repositories, workItemEvents, workItemOverrides } from "./schema.js";
import type { WorkItemTracker } from "./work-item-matches.js";

export type WorkItemOverride = typeof workItemOverrides.$inferSelect;
export type WorkItemEvent = typeof workItemEvents.$inferSelect;
export type WorkItemEventKind = WorkItemEvent["kind"];

/** A work item of an organization: its tracker and its ID there (a Linear issue ID). */
export interface WorkItemKey {
  organizationId: string;
  tracker: WorkItemTracker;
  externalId: string;
}

/**
 * The work item's ID in URLs and `work_item` change events: its tracker and its ID there,
 * `linear-<issue id>`.
 */
export function workItemUrlId(tracker: WorkItemTracker, externalId: string): string {
  return `${tracker}-${externalId}`;
}

/**
 * Records a live `work_item` change of the organization's items (by tracker ID), kept once
 * `db`'s transaction commits: the Backlog, its counts, Up next and the items' details change.
 */
export function recordWorkItemChange(
  db: unknown,
  input: { organizationId: string; tracker: WorkItemTracker; externalIds: readonly string[] },
): void {
  recordChange(db, {
    resource: "work_item",
    ids: [...new Set(input.externalIds)].map((id) => workItemUrlId(input.tracker, id)),
    organizationId: input.organizationId,
  });
}

const ofItem = (key: WorkItemKey) =>
  and(
    eq(workItemOverrides.organizationId, key.organizationId),
    eq(workItemOverrides.tracker, key.tracker),
    eq(workItemOverrides.externalId, key.externalId),
  );

/** The item's saved choice, or null when it has none. Its repository may be null (deleted). */
export async function getWorkItemOverride(
  db: Pick<Database, "select">,
  key: WorkItemKey,
): Promise<WorkItemOverride | null> {
  const [row] = await db.select().from(workItemOverrides).where(ofItem(key));
  return row ?? null;
}

/**
 * The saved choices of the organization's `externalIds` in one query: the chosen repository
 * ID (null when it was deleted) of each item that has a choice.
 */
export async function listWorkItemOverrides(
  db: Pick<Database, "select">,
  organizationId: string,
  tracker: WorkItemTracker,
  externalIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db
    .select({
      externalId: workItemOverrides.externalId,
      repositoryId: workItemOverrides.repositoryId,
    })
    .from(workItemOverrides)
    .where(
      and(
        eq(workItemOverrides.organizationId, organizationId),
        eq(workItemOverrides.tracker, tracker),
        inArray(workItemOverrides.externalId, [...new Set(externalIds)]),
      ),
    );
  return new Map(rows.map((row) => [row.externalId, row.repositoryId]));
}

export interface SetWorkItemRepositoryInput extends WorkItemKey {
  repositoryId: string;
  /** The member choosing it; null for a chat surface or Om. */
  userId: string | null;
}

/**
 * Saves (or replaces) the item's repository choice. Null when the repository isn't one of the
 * organization's connected repositories: nothing is saved. Whether its Coding is on is the
 * caller's check (routing turns a choice with Coding off into a manual route).
 */
export async function setWorkItemRepository(
  db: Pick<Database, "select" | "insert">,
  input: SetWorkItemRepositoryInput,
): Promise<WorkItemOverride | null> {
  const { organizationId, tracker, externalId, repositoryId, userId } = input;
  const [repository] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.id, repositoryId),
        eq(repositories.organizationId, organizationId),
        isNull(repositories.disconnectedAt),
      ),
    );
  if (!repository) return null;
  const now = new Date();
  const [saved] = await db
    .insert(workItemOverrides)
    .values({ organizationId, tracker, externalId, repositoryId, chosenBy: userId, chosenAt: now })
    .onConflictDoUpdate({
      target: [
        workItemOverrides.organizationId,
        workItemOverrides.tracker,
        workItemOverrides.externalId,
      ],
      set: { repositoryId, chosenBy: userId, chosenAt: now, updatedAt: now },
    })
    .returning();
  recordWorkItemChange(db, { organizationId, tracker, externalIds: [externalId] });
  return saved!;
}

/** Clears the item's choice ("Use the routing rules again"); whether it had one. */
export async function clearWorkItemRepository(
  db: Pick<Database, "delete">,
  key: WorkItemKey,
): Promise<boolean> {
  const deleted = await db
    .delete(workItemOverrides)
    .where(ofItem(key))
    .returning({ externalId: workItemOverrides.externalId });
  if (deleted.length > 0) {
    recordWorkItemChange(db, {
      organizationId: key.organizationId,
      tracker: key.tracker,
      externalIds: [key.externalId],
    });
  }
  return deleted.length > 0;
}

export interface RecordWorkItemEventInput extends WorkItemKey {
  kind: WorkItemEventKind;
  /** The member who acted; null for Om or a chat surface without a linked user. */
  actorUserId: string | null;
  /** The actor's name as Activity shows it ("Steve McMaster", "Om"). */
  actorName: string;
  /** Kind-specific details, e.g. `{ repository: "customer-portal" }`. */
  detail?: Record<string, unknown>;
}

/** Records an action taken on a work item in Omniralph (its Activity changes: a live change). */
export async function recordWorkItemEvent(
  db: Pick<Database, "insert">,
  input: RecordWorkItemEventInput,
): Promise<WorkItemEvent> {
  const { detail = {}, ...values } = input;
  const [row] = await db
    .insert(workItemEvents)
    .values({ ...values, detail })
    .returning();
  recordWorkItemChange(db, {
    organizationId: input.organizationId,
    tracker: input.tracker,
    externalIds: [input.externalId],
  });
  return row!;
}

/** The item's events, newest first (at most `limit`, default 200). */
export async function listWorkItemEvents(
  db: Pick<Database, "select">,
  key: WorkItemKey,
  limit = 200,
): Promise<WorkItemEvent[]> {
  return db
    .select()
    .from(workItemEvents)
    .where(
      and(
        eq(workItemEvents.organizationId, key.organizationId),
        eq(workItemEvents.tracker, key.tracker),
        eq(workItemEvents.externalId, key.externalId),
      ),
    )
    .orderBy(desc(workItemEvents.createdAt), desc(workItemEvents.id))
    .limit(limit);
}

/**
 * The newest run (by `created_at`) of each of the organization's Linear work items with
 * these IDs: a coding (epic or request) run or a triage run, by its run ID (`/runs/{id}`).
 * Items without a run are left out.
 */
export async function latestWorkItemRuns(
  db: Database,
  organizationId: string,
  externalIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(externalIds)];
  if (ids.length === 0) return new Map();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute<{ issue_id: string; run_id: string }>(sql`
    select distinct on (issue_id) issue_id, run_id from (
      select tracker_issue_id as issue_id, id as run_id, created_at from ralph_runs
        where organization_id = ${organizationId} and tracker_issue_id in (${list})
      union all
      select tracker_issue_id, id, created_at from triage_runs
        where organization_id = ${organizationId} and tracker_issue_id in (${list})
    ) runs
    order by issue_id, created_at desc, run_id desc`);
  return new Map(result.rows.map((r) => [r.issue_id, r.run_id]));
}
