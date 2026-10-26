/**
 * Per-work-item state Omniralph keeps beside the tracker: a member's repository choice
 * ("Change repo…", which routing tries first, `apps/web/src/lib/routing/resolve.ts`) and the
 * actions taken on the item in Omniralph (its Activity).
 */
import { and, desc, eq, isNull } from "drizzle-orm";
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

/** Records an action taken on a work item in Omniralph. */
export async function recordWorkItemEvent(
  db: Pick<Database, "insert">,
  input: RecordWorkItemEventInput,
): Promise<WorkItemEvent> {
  const { detail = {}, ...values } = input;
  const [row] = await db
    .insert(workItemEvents)
    .values({ ...values, detail })
    .returning();
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
