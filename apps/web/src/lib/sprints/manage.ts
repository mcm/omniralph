import "server-only";
import {
  cancelSprint as cancelSprintRow,
  createSprint as createSprintRow,
  deleteDraftSprint,
  getSprint,
  listSprints,
  pauseSprint as pauseSprintRow,
  resumeSprint as resumeSprintRow,
  startSprint as startSprintRow,
  updateDraftSprint,
  type SprintTransitionResult,
  workItemUrlId,
  type Database,
  type SprintEpicConflict,
  type SprintEpicInput,
  type SprintWithEpics,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import type { OrgUser } from "@/lib/auth/session";
import type {
  CreateSprintBody,
  SavedSprint,
  SprintActionName,
  SprintList,
  SprintRow,
  UpdateSprintBody,
} from "@/lib/api/sprints";
import { userDisplayName } from "@/lib/user-display";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import { parseWorkItemId, trackerFailedMessage } from "@/lib/work-items/item";
import { lazyTrackerGateway } from "@/lib/tracker/client";
import {
  advanceSprint,
  mergeRunningSprintEpic,
  pausedByReason,
  sprintRunDeps,
  type SprintRunDeps,
} from "./run";
import {
  TrackerNotConnectedError,
  WorkItemNotFoundError,
  type WorkItem,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";

/**
 * Sprints: what the `/api/ui/sprints/**` handlers load and change, in the user's active
 * organization (the handlers check the role). A sprint holds epics only: work items with
 * sub-issues that aren't features, and standalone tasks (an epic of one). Its order never
 * puts an epic before an epic that blocks it, and a work item is in at most one active sprint.
 */

export const SPRINT_NOT_FOUND_MESSAGE = "That sprint doesn't exist.";
const NOT_A_WORK_ITEM = "That isn't a work item of your tracker.";
const TRACKER_NOT_CONNECTED = "Connect a tracker before adding epics to a sprint.";

/** The organization's tracker for checking epics; a missing tracker answers 400. */
export type SprintTrackerLoader = (organizationId: string) => Promise<WorkItemTracker>;

const defaultTracker =
  (db: Database): SprintTrackerLoader =>
  (organizationId) =>
    getWorkItemTracker({ db, organizationId });

function sprintRow(sprint: SprintWithEpics): SprintRow {
  return {
    id: sprint.id,
    name: sprint.name,
    repository: { id: sprint.repositoryId, fullPath: sprint.repositoryFullPath },
    mergeTogether: sprint.mergeTogether,
    status: sprint.status,
    pausedReason: sprint.pausedReason,
    sprintBranch: sprint.sprintBranch,
    epics: sprint.epics.map((epic) => ({
      workItemId: workItemUrlId(epic.tracker, epic.externalId),
      identifier: epic.identifier,
      title: epic.title,
      position: epic.position,
      state: epic.state,
    })),
    createdAt: sprint.createdAt.toISOString(),
    updatedAt: sprint.updatedAt.toISOString(),
  };
}

/** The organization's sprints, newest first. */
export async function loadSprintList(db: Database, user: OrgUser): Promise<SprintList> {
  const sprints = await listSprints(db, user.organization.id);
  return { sprints: sprints.map(sprintRow) };
}

/** One sprint of the organization; another organization's or an unknown ID is 404. */
export async function loadSprint(db: Database, user: OrgUser, id: string): Promise<SprintRow> {
  const sprint = isUuid(id) ? await getSprint(db, user.organization.id, id) : null;
  if (!sprint) throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
  return sprintRow(sprint);
}

const isUuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** A 400 naming the epics' problems, field by field (`epics.<index>`), the first as the message. */
function invalidEpics(problems: Map<number, string>, code = "invalid_epic"): ApiRouteError {
  const fieldErrors = Object.fromEntries(
    [...problems].map(([index, message]) => [`epics.${index}`, message]),
  );
  return new ApiRouteError(400, [...problems.values()][0]!, code, fieldErrors);
}

/** Why `item` can't be a sprint's epic, or null when it can. */
async function epicProblem(tracker: WorkItemTracker, item: WorkItem): Promise<string | null> {
  if (item.state.category === "done" || item.state.category === "canceled") {
    return `${item.identifier} is ${item.state.category === "done" ? "done" : "canceled"}: only open epics can join a sprint.`;
  }
  if (item.kind !== null) {
    // A task: one on its own is an epic of one, one in an epic builds with that epic.
    return item.parentId
      ? `${item.identifier} is a task in an epic: add its epic to the sprint instead.`
      : null;
  }
  const feature = await tracker.feature(item.id);
  return feature
    ? `${item.identifier} is a feature: add each of its epics to the sprint instead.`
    : null;
}

/**
 * The order's first epic placed before an epic that blocks it, as a refusal naming both;
 * null when every blocker in the sprint comes first. Blockers outside the sprint don't count.
 */
function orderProblem(items: readonly WorkItem[]): ApiRouteError | null {
  const position = new Map(items.map((item, index) => [item.id, index]));
  for (const [index, item] of items.entries()) {
    for (const blocker of item.blockedBy) {
      const at = position.get(blocker.ref);
      if (at === undefined || at < index) continue;
      const message =
        `${item.identifier} is blocked by ${items[at]!.identifier}: ` +
        `move ${items[at]!.identifier} before ${item.identifier}.`;
      return new ApiRouteError(400, message, "blocked_order", { [`epics.${index}`]: message });
    }
  }
  return null;
}

/**
 * The work items `ids` (URL IDs) as a sprint's epics, in order, read from the organization's
 * tracker: 400 when one isn't a work item, isn't an epic or is over, or when the order puts
 * an epic before one that blocks it; 502 when the tracker fails.
 */
async function resolveEpics(
  loadTracker: SprintTrackerLoader,
  organizationId: string,
  ids: readonly string[],
): Promise<SprintEpicInput[]> {
  if (ids.length === 0) return [];
  const problems = new Map<number, string>();
  const parsed = ids.map((id, index) => {
    const found = parseWorkItemId(id);
    if (!found) problems.set(index, NOT_A_WORK_ITEM);
    return found;
  });
  if (problems.size > 0) throw invalidEpics(problems);

  let tracker: WorkItemTracker;
  try {
    tracker = await loadTracker(organizationId);
  } catch (error) {
    if (error instanceof TrackerNotConnectedError) {
      throw new ApiRouteError(400, TRACKER_NOT_CONNECTED, "tracker_not_connected");
    }
    throw error;
  }

  let failed = false;
  const items = await Promise.all(
    parsed.map(async (ref, index): Promise<WorkItem | null> => {
      if (ref!.tracker !== tracker.kind) {
        problems.set(index, NOT_A_WORK_ITEM);
        return null;
      }
      try {
        const item = await tracker.get(ref!.externalId);
        // A ref may be an identifier too: only the item's own ID names it.
        if (item.id !== ref!.externalId) {
          problems.set(index, NOT_A_WORK_ITEM);
          return null;
        }
        const problem = await epicProblem(tracker, item);
        if (problem) problems.set(index, problem);
        return item;
      } catch (error) {
        if (error instanceof WorkItemNotFoundError || error instanceof TrackerNotConnectedError) {
          problems.set(index, NOT_A_WORK_ITEM);
        } else {
          console.error(`Reading sprint epic ${ids[index]} failed`, error);
          failed = true;
        }
        return null;
      }
    }),
  );
  if (failed) {
    throw new ApiRouteError(502, trackerFailedMessage(tracker.kind), "tracker_failed");
  }
  if (problems.size > 0) {
    throw invalidEpics(new Map([...problems].sort(([a], [b]) => a - b)));
  }
  const epics = items as WorkItem[];
  const refusal = orderProblem(epics);
  if (refusal) throw refusal;
  return epics.map((item) => ({
    tracker: item.tracker,
    externalId: item.id,
    identifier: item.identifier,
    title: item.title,
  }));
}

/** A 409 naming each epic already in another active sprint, and that sprint. */
function inOtherSprint(
  epics: readonly SprintEpicInput[],
  conflicts: readonly SprintEpicConflict[],
): ApiRouteError {
  const fieldErrors: Record<string, string> = {};
  const messages: string[] = [];
  for (const conflict of conflicts) {
    const index = epics.findIndex(
      (epic) => epic.tracker === conflict.tracker && epic.externalId === conflict.externalId,
    );
    const message = `${epics[index]!.identifier} is already in the sprint “${conflict.sprintName}”: a work item is in one sprint at a time.`;
    fieldErrors[`epics.${index}`] = message;
    messages.push(message);
  }
  return new ApiRouteError(409, messages[0]!, "in_other_sprint", fieldErrors);
}

const notDraft = (sprint: SprintWithEpics) =>
  new ApiRouteError(
    409,
    `“${sprint.name}” is ${sprint.status}: only a draft sprint can be changed or deleted.`,
    "not_draft",
  );

export interface SprintDeps {
  db: Database;
  /** The organization's tracker (default: its connected one). */
  loadTracker?: SprintTrackerLoader;
}

/** Creates a draft sprint in one of the organization's repos (admins). */
export async function createSprint(
  deps: SprintDeps,
  user: OrgUser,
  body: Required<CreateSprintBody>,
): Promise<SavedSprint> {
  const organizationId = user.organization.id;
  const epics = await resolveEpics(
    deps.loadTracker ?? defaultTracker(deps.db),
    organizationId,
    body.epics,
  );
  const result = await createSprintRow(deps.db, {
    organizationId,
    repositoryId: body.repositoryId,
    name: body.name,
    mergeTogether: body.mergeTogether,
    epics,
    createdBy: user.id,
  });
  switch (result.status) {
    case "unknown_repository":
      throw new ApiRouteError(400, "Choose one of your connected repos.", "unknown_repository", {
        repositoryId: "Choose one of your connected repos.",
      });
    case "in_other_sprint":
      throw inOtherSprint(epics, result.conflicts);
    case "created":
      return { ok: true, sprint: sprintRow(result.sprint) };
  }
}

/** Renames a draft sprint, switches merge together or saves its order (admins). */
export async function updateSprint(
  deps: SprintDeps,
  user: OrgUser,
  id: string,
  body: UpdateSprintBody,
): Promise<SavedSprint> {
  const organizationId = user.organization.id;
  if (!isUuid(id)) throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
  // Refuse a started sprint before reading the tracker.
  const current = await getSprint(deps.db, organizationId, id);
  if (!current) throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
  if (current.status !== "draft") throw notDraft(current);

  const epics = body.epics
    ? await resolveEpics(deps.loadTracker ?? defaultTracker(deps.db), organizationId, body.epics)
    : undefined;
  const result = await updateDraftSprint(deps.db, {
    organizationId,
    sprintId: id,
    ...(body.name !== undefined && { name: body.name }),
    ...(body.mergeTogether !== undefined && { mergeTogether: body.mergeTogether }),
    ...(epics && { epics }),
  });
  switch (result.status) {
    case "not_found":
      throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
    case "not_draft":
      throw notDraft(result.sprint);
    case "in_other_sprint":
      throw inOtherSprint(epics!, result.conflicts);
    case "updated":
      return { ok: true, sprint: sprintRow(result.sprint) };
  }
}

/** Deletes a draft sprint (admins); a started one is refused (409). */
export async function deleteSprint(db: Database, user: OrgUser, id: string): Promise<{ ok: true }> {
  if (!isUuid(id)) throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
  const result = await deleteDraftSprint(db, user.organization.id, id);
  switch (result.status) {
    case "not_found":
      throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
    case "not_draft":
      throw notDraft(result.sprint);
    case "deleted":
      return { ok: true };
  }
}

/** The statuses each action starts from, as the refusal of another status says them. */
const ACTION_FROM: Record<SprintActionName, string> = {
  start: "only a draft sprint can be started",
  pause: "only a running sprint can be paused",
  resume: "only a paused sprint can be resumed",
  cancel: "only a running or paused sprint can be canceled",
};

/** The saved sprint of a status change, or the API's refusal of it. */
function transitioned(result: SprintTransitionResult, action: SprintActionName): SprintWithEpics {
  switch (result.status) {
    case "not_found":
      throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
    case "wrong_status":
      throw new ApiRouteError(
        409,
        `“${result.sprint.name}” is ${result.sprint.status}: ${ACTION_FROM[action]}.`,
        "wrong_status",
      );
    case "empty":
      throw new ApiRouteError(400, "Add an epic before starting the sprint.", "empty");
    case "updated":
      return result.sprint;
  }
}

/**
 * Start, Pause, Resume or Cancel (admins). Starting a draft with epics runs it and starts its
 * first epic as Start epic does; resuming a paused sprint queues its stalled epic again and
 * starts it. A refused start pauses the sprint with the reason, which the answer shows.
 * Pausing starts no new epic; canceling ends the sprint, leaving running epics alone.
 */
export async function runSprintAction(
  deps: SprintDeps,
  user: OrgUser,
  id: string,
  action: SprintActionName,
): Promise<SavedSprint> {
  const organizationId = user.organization.id;
  if (!isUuid(id)) throw ApiRouteError.notFound(SPRINT_NOT_FOUND_MESSAGE);
  const actor = { userId: user.id, name: userDisplayName(user) };
  let sprint: SprintWithEpics;
  switch (action) {
    case "start":
      sprint = transitioned(await startSprintRow(deps.db, organizationId, id), action);
      break;
    case "resume":
      sprint = transitioned(await resumeSprintRow(deps.db, organizationId, id), action);
      break;
    case "pause":
      sprint = transitioned(
        await pauseSprintRow(deps.db, organizationId, id, pausedByReason(actor.name)),
        action,
      );
      return { ok: true, sprint: sprintRow(sprint) };
    case "cancel":
      sprint = transitioned(await cancelSprintRow(deps.db, organizationId, id), action);
      return { ok: true, sprint: sprintRow(sprint) };
  }
  const loadTracker = deps.loadTracker ?? defaultTracker(deps.db);
  const runDeps: SprintRunDeps = {
    ...sprintRunDeps({
      db: deps.db,
      organizationId,
      tracker: lazyTrackerGateway({ db: deps.db, organizationId }),
    }),
    loadTracker: () => loadTracker(organizationId),
  };
  await advanceSprint(runDeps, sprint.id, actor);
  // A resumed sprint's epic whose PR got clean while it was paused merges now.
  if (action === "resume") await mergeRunningSprintEpic(runDeps, sprint.id);
  return { ok: true, sprint: sprintRow((await getSprint(deps.db, organizationId, id)) ?? sprint) };
}
