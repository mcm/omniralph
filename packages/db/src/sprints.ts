/**
 * Sprints: an organization's ordered queues of epics, each building in one repository. The
 * caller (`apps/web/src/lib/sprints`) checks that every work item is an epic and that the
 * order respects the epics' blocks relations; here a work item is kept in at most one active
 * sprint (`ACTIVE_SPRINT_STATUSES`), and only draft sprints are renamed, reordered or
 * deleted. Every write records a live `sprint` change, and a `work_item` change for the work
 * items that joined or left a sprint (the Backlog shows each item's sprint).
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { repositories, sprintEpics, sprints } from "./schema.js";
import type { WorkItemTracker } from "./work-item-matches.js";
import { workItemUrlId } from "./work-items.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Sprint = typeof sprints.$inferSelect;
export type SprintStatus = Sprint["status"];
export type SprintEpic = typeof sprintEpics.$inferSelect;
export type SprintEpicState = SprintEpic["state"];

/** The statuses whose sprint holds its epics: a work item is in at most one such sprint. */
export const ACTIVE_SPRINT_STATUSES = [
  "draft",
  "running",
  "paused",
] as const satisfies readonly SprintStatus[];

/** A sprint with its repository's full path and its epics in order. */
export interface SprintWithEpics extends Sprint {
  repositoryFullPath: string;
  epics: SprintEpic[];
}

/** One epic of a saved order: the work item, and its identifier and title as the tracker said. */
export interface SprintEpicInput {
  tracker: WorkItemTracker;
  externalId: string;
  identifier: string;
  title: string;
}

/** A work item already in another active sprint. */
export interface SprintEpicConflict {
  tracker: WorkItemTracker;
  externalId: string;
  sprintId: string;
  sprintName: string;
}

/** Serializes the organization's sprint saves, so two can't put one item in two sprints. */
async function lockSprints(tx: Transaction, organizationId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sprints:${organizationId}`}, 0))`,
  );
}

async function loadSprints(
  db: Pick<Database, "select">,
  organizationId: string,
  sprintId?: string,
): Promise<SprintWithEpics[]> {
  const rows = await db
    .select({ sprint: sprints, repositoryFullPath: repositories.fullPath })
    .from(sprints)
    .innerJoin(repositories, eq(repositories.id, sprints.repositoryId))
    .where(
      and(
        eq(sprints.organizationId, organizationId),
        sprintId ? eq(sprints.id, sprintId) : undefined,
      ),
    )
    .orderBy(desc(sprints.createdAt), desc(sprints.id));
  if (rows.length === 0) return [];
  const epics = await db
    .select()
    .from(sprintEpics)
    .where(
      inArray(
        sprintEpics.sprintId,
        rows.map((row) => row.sprint.id),
      ),
    )
    .orderBy(asc(sprintEpics.position));
  return rows.map(({ sprint, repositoryFullPath }) => ({
    ...sprint,
    repositoryFullPath,
    epics: epics.filter((epic) => epic.sprintId === sprint.id),
  }));
}

/** The organization's sprints, newest first, each with its epics in order. */
export async function listSprints(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<SprintWithEpics[]> {
  return loadSprints(db, organizationId);
}

/** One of the organization's sprints with its epics in order, or null. */
export async function getSprint(
  db: Pick<Database, "select">,
  organizationId: string,
  sprintId: string,
): Promise<SprintWithEpics | null> {
  const [sprint] = await loadSprints(db, organizationId, sprintId);
  return sprint ?? null;
}

/** The epics of `items` already in an active sprint other than `exceptSprintId`. */
async function activeSprintConflicts(
  tx: Pick<Database, "select">,
  organizationId: string,
  items: readonly SprintEpicInput[],
  exceptSprintId: string | null,
): Promise<SprintEpicConflict[]> {
  if (items.length === 0) return [];
  const rows = await tx
    .select({
      tracker: sprintEpics.tracker,
      externalId: sprintEpics.externalId,
      sprintId: sprints.id,
      sprintName: sprints.name,
    })
    .from(sprintEpics)
    .innerJoin(sprints, eq(sprints.id, sprintEpics.sprintId))
    .where(
      and(
        eq(sprintEpics.organizationId, organizationId),
        inArray(sprints.status, [...ACTIVE_SPRINT_STATUSES]),
        inArray(
          sprintEpics.externalId,
          items.map((item) => item.externalId),
        ),
        exceptSprintId ? ne(sprints.id, exceptSprintId) : undefined,
      ),
    );
  const order = new Map(items.map((item, index) => [`${item.tracker}:${item.externalId}`, index]));
  return rows
    .filter((row) => order.has(`${row.tracker}:${row.externalId}`))
    .sort(
      (a, b) =>
        order.get(`${a.tracker}:${a.externalId}`)! - order.get(`${b.tracker}:${b.externalId}`)!,
    );
}

/** Records a `work_item` change for each tracker's items in `items`. */
function recordItemChanges(
  tx: Transaction,
  organizationId: string,
  items: readonly Pick<SprintEpicInput, "tracker" | "externalId">[],
): void {
  if (items.length === 0) return;
  recordChange(tx, {
    resource: "work_item",
    ids: [...new Set(items.map((item) => workItemUrlId(item.tracker, item.externalId)))],
    organizationId,
  });
}

async function insertEpics(
  tx: Transaction,
  organizationId: string,
  sprintId: string,
  epics: readonly SprintEpicInput[],
): Promise<void> {
  if (epics.length === 0) return;
  await tx.insert(sprintEpics).values(
    epics.map((epic, position) => ({
      sprintId,
      organizationId,
      tracker: epic.tracker,
      externalId: epic.externalId,
      identifier: epic.identifier,
      title: epic.title,
      position,
    })),
  );
}

export interface CreateSprintInput {
  organizationId: string;
  repositoryId: string;
  name: string;
  mergeTogether: boolean;
  /** In the sprint's order, each work item once. */
  epics: readonly SprintEpicInput[];
  createdBy: string | null;
}

export type CreateSprintResult =
  | { status: "created"; sprint: SprintWithEpics }
  /** The repository isn't one of the organization's connected repositories. */
  | { status: "unknown_repository" }
  /** Some epics are in another active sprint; nothing was written. */
  | { status: "in_other_sprint"; conflicts: SprintEpicConflict[] };

/** Creates a draft sprint with `epics` in order, unless one is already in an active sprint. */
export async function createSprint(
  db: Database,
  input: CreateSprintInput,
): Promise<CreateSprintResult> {
  const { organizationId } = input;
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const [repository] = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.id, input.repositoryId),
          eq(repositories.organizationId, organizationId),
          isNull(repositories.disconnectedAt),
        ),
      );
    if (!repository) return { status: "unknown_repository" as const };
    const conflicts = await activeSprintConflicts(tx, organizationId, input.epics, null);
    if (conflicts.length > 0) return { status: "in_other_sprint" as const, conflicts };

    const [sprint] = await tx
      .insert(sprints)
      .values({
        organizationId,
        repositoryId: input.repositoryId,
        name: input.name,
        mergeTogether: input.mergeTogether,
        createdBy: input.createdBy,
      })
      .returning();
    await insertEpics(tx, organizationId, sprint!.id, input.epics);
    recordChange(tx, { resource: "sprint", ids: [sprint!.id], organizationId });
    recordItemChanges(tx, organizationId, input.epics);
    return {
      status: "created" as const,
      sprint: (await getSprint(tx, organizationId, sprint!.id))!,
    };
  });
}

export interface UpdateDraftSprintInput {
  organizationId: string;
  sprintId: string;
  name?: string;
  mergeTogether?: boolean;
  /** The sprint's whole new order, each work item once (replacing its epics). */
  epics?: readonly SprintEpicInput[];
}

export type UpdateDraftSprintResult =
  | { status: "updated"; sprint: SprintWithEpics }
  | { status: "not_found" }
  /** Only a draft sprint changes this way; nothing was written. */
  | { status: "not_draft"; sprint: SprintWithEpics }
  /** Some epics are in another active sprint; nothing was written. */
  | { status: "in_other_sprint"; conflicts: SprintEpicConflict[] };

/**
 * Renames a draft sprint, switches its merge-together option, or replaces its epics with a
 * new order (each only when given), unless it isn't a draft or a new epic is already in
 * another active sprint.
 */
export async function updateDraftSprint(
  db: Database,
  input: UpdateDraftSprintInput,
): Promise<UpdateDraftSprintResult> {
  const { organizationId, sprintId } = input;
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const current = await getSprint(tx, organizationId, sprintId);
    if (!current) return { status: "not_found" as const };
    if (current.status !== "draft") return { status: "not_draft" as const, sprint: current };

    if (input.epics) {
      const conflicts = await activeSprintConflicts(tx, organizationId, input.epics, sprintId);
      if (conflicts.length > 0) return { status: "in_other_sprint" as const, conflicts };
    }

    await tx
      .update(sprints)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.mergeTogether !== undefined && { mergeTogether: input.mergeTogether }),
        updatedAt: new Date(),
      })
      .where(eq(sprints.id, sprintId));
    if (input.epics) {
      await tx.delete(sprintEpics).where(eq(sprintEpics.sprintId, sprintId));
      await insertEpics(tx, organizationId, sprintId, input.epics);
      const key = (item: Pick<SprintEpicInput, "tracker" | "externalId">) =>
        `${item.tracker}:${item.externalId}`;
      const before = new Set(current.epics.map(key));
      const after = new Set(input.epics.map(key));
      recordItemChanges(tx, organizationId, [
        ...current.epics.filter((epic) => !after.has(key(epic))),
        ...input.epics.filter((epic) => !before.has(key(epic))),
      ]);
    }
    recordChange(tx, { resource: "sprint", ids: [sprintId], organizationId });
    return {
      status: "updated" as const,
      sprint: (await getSprint(tx, organizationId, sprintId))!,
    };
  });
}

export type DeleteDraftSprintResult =
  | { status: "deleted" }
  | { status: "not_found" }
  /** Only a draft sprint is deleted; nothing was written. */
  | { status: "not_draft"; sprint: SprintWithEpics };

/** Deletes a draft sprint and its epics; a started sprint is kept. */
export async function deleteDraftSprint(
  db: Database,
  organizationId: string,
  sprintId: string,
): Promise<DeleteDraftSprintResult> {
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const current = await getSprint(tx, organizationId, sprintId);
    if (!current) return { status: "not_found" as const };
    if (current.status !== "draft") return { status: "not_draft" as const, sprint: current };
    await tx.delete(sprints).where(eq(sprints.id, sprintId));
    recordChange(tx, { resource: "sprint", ids: [sprintId], organizationId });
    recordItemChanges(tx, organizationId, current.epics);
    return { status: "deleted" as const };
  });
}
