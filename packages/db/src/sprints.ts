/**
 * Sprints: an organization's ordered queues of epics, each building in one repository. The
 * caller (`apps/web/src/lib/sprints`) checks that every work item is an epic and that the
 * order respects the epics' blocks relations; here a work item is kept in at most one active
 * sprint (`ACTIVE_SPRINT_STATUSES`), and only draft sprints are renamed, reordered or
 * deleted. Every write records a live `sprint` change, and a `work_item` change for the work
 * items that joined or left a sprint (the Backlog shows each item's sprint).
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { ralphLanes, ralphRuns, repositories, sprintEpics, sprints } from "./schema.js";
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
  repositoryProvider: (typeof repositories.$inferSelect)["provider"];
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
    .select({
      sprint: sprints,
      repositoryFullPath: repositories.fullPath,
      repositoryProvider: repositories.provider,
    })
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
  return rows.map(({ sprint, repositoryFullPath, repositoryProvider }) => ({
    ...sprint,
    repositoryFullPath,
    repositoryProvider,
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

/** Every organization's running sprints (ID and organization), oldest first. */
export async function listRunningSprints(
  db: Pick<Database, "select">,
): Promise<{ id: string; organizationId: string }[]> {
  return db
    .select({ id: sprints.id, organizationId: sprints.organizationId })
    .from(sprints)
    .where(eq(sprints.status, "running"))
    .orderBy(asc(sprints.createdAt), asc(sprints.id));
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
    }
    // The Backlog shows each epic's sprint name and position: a new order or name changes
    // every epic that was or is in the sprint.
    if (input.epics || (input.name !== undefined && input.name !== current.name)) {
      recordItemChanges(tx, organizationId, [...current.epics, ...(input.epics ?? [])]);
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

// ── Running a sprint ─────────────────────────────────────────────────────

/** The statuses of a started sprint that isn't over: its epics' merges still count. */
export const STARTED_SPRINT_STATUSES = [
  "running",
  "paused",
] as const satisfies readonly SprintStatus[];

export type SprintTransitionResult =
  | { status: "updated"; sprint: SprintWithEpics }
  | { status: "not_found" }
  /** The sprint's status doesn't allow the change; nothing was written. */
  | { status: "wrong_status"; sprint: SprintWithEpics }
  /** A sprint without epics doesn't start; nothing was written. */
  | { status: "empty"; sprint: SprintWithEpics };

/**
 * Moves the sprint from one of `from` to `to` under the organization's sprint lock, after
 * `apply` (in the same transaction), and records a live `sprint` change.
 */
async function transitionSprint(
  db: Database,
  organizationId: string,
  sprintId: string,
  from: readonly SprintStatus[],
  to: SprintStatus,
  set: { pausedReason?: string | null } = {},
  apply?: (tx: Transaction, sprint: SprintWithEpics) => Promise<SprintTransitionResult | void>,
): Promise<SprintTransitionResult> {
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const current = await getSprint(tx, organizationId, sprintId);
    if (!current) return { status: "not_found" as const };
    if (!from.includes(current.status)) {
      return { status: "wrong_status" as const, sprint: current };
    }
    const refused = await apply?.(tx, current);
    if (refused) return refused;
    await tx
      .update(sprints)
      .set({ status: to, ...set, updatedAt: new Date() })
      .where(eq(sprints.id, sprintId));
    recordChange(tx, { resource: "sprint", ids: [sprintId], organizationId });
    return {
      status: "updated" as const,
      sprint: (await getSprint(tx, organizationId, sprintId))!,
    };
  });
}

/** Starts a draft sprint that has epics: it becomes `running` (its first epic starts next). */
export async function startSprint(
  db: Database,
  organizationId: string,
  sprintId: string,
): Promise<SprintTransitionResult> {
  return transitionSprint(
    db,
    organizationId,
    sprintId,
    ["draft"],
    "running",
    { pausedReason: null },
    async (_tx, sprint) =>
      sprint.epics.length === 0 ? { status: "empty" as const, sprint } : undefined,
  );
}

/**
 * Pauses a running sprint with `reason`: no new epic starts; running ones carry on. With
 * `alsoPaused`, a paused sprint takes the new reason.
 */
export async function pauseSprint(
  db: Database,
  organizationId: string,
  sprintId: string,
  reason: string,
  options: { alsoPaused?: boolean } = {},
): Promise<SprintTransitionResult> {
  return transitionSprint(
    db,
    organizationId,
    sprintId,
    options.alsoPaused ? STARTED_SPRINT_STATUSES : ["running"],
    "paused",
    { pausedReason: reason },
  );
}

/**
 * Ends a started sprint whose work all landed (a merge-together sprint's PR merged): it is
 * `done`, and its epics' work items leave it.
 */
export async function finishSprint(
  db: Database,
  organizationId: string,
  sprintId: string,
): Promise<SprintTransitionResult> {
  return transitionSprint(
    db,
    organizationId,
    sprintId,
    STARTED_SPRINT_STATUSES,
    "done",
    { pausedReason: null },
    async (tx, sprint) => recordItemChanges(tx, organizationId, sprint.epics),
  );
}

/**
 * Records the sprint PR/MR Om opened from a merge-together sprint's branch (replacing one that
 * closed without merging). Answers the sprint, or null when it is gone.
 */
export async function setSprintPullRequest(
  db: Database,
  organizationId: string,
  sprintId: string,
  pullRequest: { number: number; url: string },
): Promise<SprintWithEpics | null> {
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const updated = await tx
      .update(sprints)
      .set({
        sprintPrNumber: pullRequest.number,
        sprintPrUrl: pullRequest.url,
        updatedAt: new Date(),
      })
      .where(and(eq(sprints.id, sprintId), eq(sprints.organizationId, organizationId)))
      .returning({ id: sprints.id });
    if (updated.length === 0) return null;
    recordChange(tx, { resource: "sprint", ids: [sprintId], organizationId });
    return getSprint(tx, organizationId, sprintId);
  });
}

/** The started (running or paused) sprint whose sprint PR/MR is `prNumber` in the repository. */
export async function findSprintByPullRequest(
  db: Pick<Database, "select">,
  repositoryId: string,
  prNumber: number,
): Promise<Sprint | null> {
  const [row] = await db
    .select()
    .from(sprints)
    .where(
      and(
        eq(sprints.repositoryId, repositoryId),
        eq(sprints.sprintPrNumber, prNumber),
        inArray(sprints.status, [...STARTED_SPRINT_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resumes a paused sprint: it runs again, its reason is cleared and each stalled epic is
 * queued again, so it is retried first.
 */
export async function resumeSprint(
  db: Database,
  organizationId: string,
  sprintId: string,
): Promise<SprintTransitionResult> {
  return transitionSprint(
    db,
    organizationId,
    sprintId,
    ["paused"],
    "running",
    { pausedReason: null },
    async (tx, sprint) => {
      const stalled = sprint.epics.filter((epic) => epic.state === "stalled");
      if (stalled.length === 0) return;
      await tx
        .update(sprintEpics)
        .set({ state: "queued", updatedAt: new Date() })
        .where(
          inArray(
            sprintEpics.id,
            stalled.map((epic) => epic.id),
          ),
        );
      recordItemChanges(tx, organizationId, stalled);
    },
  );
}

/** Cancels a started sprint: no epic starts any more; running ones are left alone. */
export async function cancelSprint(
  db: Database,
  organizationId: string,
  sprintId: string,
): Promise<SprintTransitionResult> {
  return transitionSprint(
    db,
    organizationId,
    sprintId,
    STARTED_SPRINT_STATUSES,
    "canceled",
    {},
    async (tx, sprint) => recordItemChanges(tx, organizationId, sprint.epics),
  );
}

/**
 * Records the branch a merge-together sprint's epics' PRs target, unless one is recorded
 * already (that one is kept). Answers the sprint, or null when it is gone.
 */
export async function setSprintBranch(
  db: Database,
  organizationId: string,
  sprintId: string,
  branch: string,
): Promise<SprintWithEpics | null> {
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const updated = await tx
      .update(sprints)
      .set({ sprintBranch: branch, updatedAt: new Date() })
      .where(
        and(
          eq(sprints.id, sprintId),
          eq(sprints.organizationId, organizationId),
          isNull(sprints.sprintBranch),
        ),
      )
      .returning({ id: sprints.id });
    if (updated.length > 0) {
      recordChange(tx, { resource: "sprint", ids: [sprintId], organizationId });
    }
    return getSprint(tx, organizationId, sprintId);
  });
}

export type ClaimNextSprintEpicResult =
  /** The sprint isn't running, or one of its epics is running or stalled: nothing starts. */
  | { status: "idle"; sprint: SprintWithEpics | null }
  /** The next queued epic, now `running`: the caller starts it. */
  | { status: "claimed"; sprint: SprintWithEpics; epic: SprintEpic }
  /**
   * Every epic merged: the sprint is `done`, or, merging together, stays `running` until its
   * sprint PR lands.
   */
  | { status: "all_merged"; sprint: SprintWithEpics };

/**
 * The next epic of a running sprint to start: its first queued epic once none is running or
 * stalled, marked `running` under the sprint lock so it starts once. With every epic merged
 * the sprint is done (unless it merges together).
 */
export async function claimNextSprintEpic(
  db: Database,
  organizationId: string,
  sprintId: string,
): Promise<ClaimNextSprintEpicResult> {
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const sprint = await getSprint(tx, organizationId, sprintId);
    if (!sprint || sprint.status !== "running") return { status: "idle" as const, sprint };
    if (sprint.epics.some((epic) => epic.state === "running" || epic.state === "stalled")) {
      return { status: "idle" as const, sprint };
    }
    const next = sprint.epics.find((epic) => epic.state === "queued");
    if (!next) {
      if (!sprint.mergeTogether) {
        await tx
          .update(sprints)
          .set({ status: "done", pausedReason: null, updatedAt: new Date() })
          .where(eq(sprints.id, sprintId));
        recordChange(tx, { resource: "sprint", ids: [sprintId], organizationId });
        recordItemChanges(tx, organizationId, sprint.epics);
      }
      return {
        status: "all_merged" as const,
        sprint: (await getSprint(tx, organizationId, sprintId))!,
      };
    }
    const [epic] = await tx
      .update(sprintEpics)
      .set({ state: "running", updatedAt: new Date() })
      .where(eq(sprintEpics.id, next.id))
      .returning();
    recordChange(tx, { resource: "sprint", ids: [sprintId], organizationId });
    recordItemChanges(tx, organizationId, [next]);
    return {
      status: "claimed" as const,
      sprint: (await getSprint(tx, organizationId, sprintId))!,
      epic: epic!,
    };
  });
}

/** A work item's epic in a started sprint (running or paused), with that sprint. */
export interface StartedSprintEpic {
  sprint: Sprint;
  epic: SprintEpic;
}

/** The work item's epic in a running or paused sprint of the organization, or null. */
export async function findStartedSprintEpic(
  db: Pick<Database, "select">,
  organizationId: string,
  tracker: WorkItemTracker,
  externalId: string,
): Promise<StartedSprintEpic | null> {
  const [row] = await db
    .select({ sprint: sprints, epic: sprintEpics })
    .from(sprintEpics)
    .innerJoin(sprints, eq(sprints.id, sprintEpics.sprintId))
    .where(
      and(
        eq(sprintEpics.organizationId, organizationId),
        eq(sprintEpics.tracker, tracker),
        eq(sprintEpics.externalId, externalId),
        inArray(sprints.status, [...STARTED_SPRINT_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type SprintEpicChangeResult =
  | { status: "updated"; sprint: SprintWithEpics; epic: SprintEpic }
  /** The epic is gone, or isn't in one of the expected states; nothing was written. */
  | { status: "unchanged" };

/**
 * Moves one epic of a sprint from one of `from` to `state`; a `pause` reason also pauses its
 * sprint while it is running or paused (the reason replacing an earlier one). Records live
 * `sprint` and `work_item` changes.
 */
export async function setSprintEpicState(
  db: Database,
  input: {
    organizationId: string;
    epicId: string;
    from: readonly SprintEpicState[];
    state: SprintEpicState;
    pause?: string;
  },
): Promise<SprintEpicChangeResult> {
  const { organizationId } = input;
  return db.transaction(async (tx) => {
    await lockSprints(tx, organizationId);
    const [current] = await tx
      .select()
      .from(sprintEpics)
      .where(and(eq(sprintEpics.id, input.epicId), eq(sprintEpics.organizationId, organizationId)));
    if (!current || !input.from.includes(current.state)) return { status: "unchanged" as const };
    const [epic] = await tx
      .update(sprintEpics)
      .set({ state: input.state, updatedAt: new Date() })
      .where(eq(sprintEpics.id, current.id))
      .returning();
    if (input.pause !== undefined) {
      await tx
        .update(sprints)
        .set({ status: "paused", pausedReason: input.pause, updatedAt: new Date() })
        .where(
          and(
            eq(sprints.id, current.sprintId),
            inArray(sprints.status, [...STARTED_SPRINT_STATUSES]),
          ),
        );
    }
    recordChange(tx, { resource: "sprint", ids: [current.sprintId], organizationId });
    recordItemChanges(tx, organizationId, [current]);
    return {
      status: "updated" as const,
      sprint: (await getSprint(tx, organizationId, current.sprintId))!,
      epic: epic!,
    };
  });
}

/** A work item's place in an active sprint (the Backlog's sprint chip). */
export interface ActiveSprintPlace {
  organizationId: string;
  tracker: WorkItemTracker;
  externalId: string;
  sprintId: string;
  sprintName: string;
  /** 0-based. */
  position: number;
  /** How many epics the sprint holds. */
  epicCount: number;
}

/** The epics of the organizations' active sprints (`ACTIVE_SPRINT_STATUSES`), each with its sprint. */
export async function listActiveSprintPlaces(
  db: Pick<Database, "select">,
  organizationIds: readonly string[],
): Promise<ActiveSprintPlace[]> {
  if (organizationIds.length === 0) return [];
  const rows = await db
    .select({
      organizationId: sprintEpics.organizationId,
      tracker: sprintEpics.tracker,
      externalId: sprintEpics.externalId,
      sprintId: sprints.id,
      sprintName: sprints.name,
      position: sprintEpics.position,
    })
    .from(sprintEpics)
    .innerJoin(sprints, eq(sprints.id, sprintEpics.sprintId))
    .where(
      and(
        inArray(sprintEpics.organizationId, [...organizationIds]),
        inArray(sprints.status, [...ACTIVE_SPRINT_STATUSES]),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.sprintId, (counts.get(row.sprintId) ?? 0) + 1);
  return rows.map((row) => ({ ...row, epicCount: counts.get(row.sprintId)! }));
}

/** One PR/MR of a sprint epic's run. */
export interface SprintEpicPullRequest {
  number: number;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  /** The branch it targets. */
  baseBranch: string;
}

/** The latest run of a sprint epic, with the PRs/MRs its lanes opened. */
export interface SprintEpicProgress {
  runId: string;
  status: typeof ralphRuns.$inferSelect.status;
  /** The work item's identifier, title and tracker URL when the run started. */
  identifier: string | null;
  title: string | null;
  url: string | null;
  /** The provider of the run's repository (its PRs/MRs' host), null before it has one. */
  repositoryProvider: (typeof repositories.$inferSelect)["provider"] | null;
  pullRequests: SprintEpicPullRequest[];
}

/**
 * The latest tracker run of each of the work items `externalIds` of the organization's
 * tracker `tracker`, with its lanes' PRs/MRs in lane order, by external ID. Items with no run
 * are left out.
 */
export async function listSprintEpicProgress(
  db: Pick<Database, "select">,
  organizationId: string,
  tracker: WorkItemTracker,
  externalIds: readonly string[],
): Promise<Map<string, SprintEpicProgress>> {
  const progress = new Map<string, SprintEpicProgress>();
  if (externalIds.length === 0) return progress;
  const runs = await db
    .select({
      id: ralphRuns.id,
      issueId: ralphRuns.trackerIssueId,
      status: ralphRuns.status,
      identifier: ralphRuns.trackerIdentifier,
      title: ralphRuns.trackerTitle,
      url: ralphRuns.trackerUrl,
      repositoryProvider: repositories.provider,
    })
    .from(ralphRuns)
    .leftJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        eq(ralphRuns.origin, "tracker"),
        eq(ralphRuns.trackerProvider, tracker),
        inArray(ralphRuns.trackerIssueId, [...externalIds]),
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id));
  for (const run of runs) {
    if (run.issueId === null || progress.has(run.issueId)) continue;
    progress.set(run.issueId, {
      runId: run.id,
      status: run.status,
      identifier: run.identifier,
      title: run.title,
      url: run.url,
      repositoryProvider: run.repositoryProvider,
      pullRequests: [],
    });
  }
  if (progress.size === 0) return progress;
  const byRun = new Map([...progress.values()].map((entry) => [entry.runId, entry]));
  const lanes = await db
    .select({
      runId: ralphLanes.runId,
      prNumber: ralphLanes.prNumber,
      prUrl: ralphLanes.prUrl,
      prDraft: ralphLanes.prDraft,
      prMerged: ralphLanes.prMerged,
      prClosed: ralphLanes.prClosed,
      baseBranch: ralphLanes.baseBranch,
    })
    .from(ralphLanes)
    .where(and(inArray(ralphLanes.runId, [...byRun.keys()]), isNotNull(ralphLanes.prNumber)))
    .orderBy(asc(ralphLanes.createdAt), asc(ralphLanes.id));
  for (const lane of lanes) {
    if (lane.prNumber === null || lane.prUrl === null) continue;
    byRun.get(lane.runId)?.pullRequests.push({
      number: lane.prNumber,
      url: lane.prUrl,
      state: lane.prMerged ? "merged" : lane.prClosed ? "closed" : lane.prDraft ? "draft" : "open",
      baseBranch: lane.baseBranch,
    });
  }
  return progress;
}
