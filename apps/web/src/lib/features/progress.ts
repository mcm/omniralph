import "server-only";
import {
  listFeatureEpics,
  listSprintEpicProgress,
  unifiedRunStatus,
  workItemUrlId,
  type Database,
  type FeatureEpic,
  type SprintEpicProgress,
} from "@omniralph/db";
import type { FeatureEpicProgress, FeatureProgress, FeatureRollup } from "@/lib/api/features";
import type { OrgUser } from "@/lib/auth/session";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import {
  TrackerNotConnectedError,
  WorkItemNotFoundError,
  type WorkItem,
  type WorkItemStory,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";
import { requireFeature } from "./manage";

/**
 * How far along a feature is (`GET /api/ui/features/{id}/progress`): each of its epics with
 * its state and stories in the tracker, its latest run and that run's PRs/MRs, and the
 * roll-up of epics and stories done. The tracker is read live (the client refetches on
 * `work_item`, `run`, `pull_request` and `feature` events); when it can't be read, the
 * epics still list with their runs and PRs, and `trackerProblem` says why states are missing.
 */

export const TRACKER_NOT_CONNECTED_PROBLEM =
  "Connect a tracker to see each epic's state and stories.";
export const TRACKER_READ_PROBLEM =
  "Couldn't read the tracker, so some epics' states and stories are missing. Try again in a moment.";

/** How many epics are read from the tracker at a time. */
const TRACKER_CONCURRENCY = 4;

export interface FeatureProgressDeps {
  db: Database;
  /** The organization's tracker (tests; default: its connected one). */
  tracker?: (organizationId: string) => Promise<WorkItemTracker>;
}

/** What the tracker said about one epic: the item and its stories, or nothing. */
type TrackerRead =
  | { kind: "found"; item: WorkItem; stories: WorkItemStory[] }
  /** The tracker doesn't have it (anymore), or it isn't the connected tracker's. */
  | { kind: "missing" }
  | { kind: "failed" };

async function readEpics(
  tracker: WorkItemTracker,
  epics: readonly FeatureEpic[],
): Promise<TrackerRead[]> {
  const read = async (epic: FeatureEpic): Promise<TrackerRead> => {
    if (epic.tracker !== tracker.kind) return { kind: "missing" };
    try {
      const item = await tracker.get(epic.externalId);
      return { kind: "found", item, stories: await tracker.stories(item.id) };
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) return { kind: "missing" };
      // Disconnected since: said once for the whole feature.
      if (error instanceof TrackerNotConnectedError) throw error;
      console.warn(`Couldn't read the feature epic ${epic.externalId} from the tracker`, error);
      return { kind: "failed" };
    }
  };
  const reads: TrackerRead[] = [];
  for (let i = 0; i < epics.length; i += TRACKER_CONCURRENCY) {
    reads.push(...(await Promise.all(epics.slice(i, i + TRACKER_CONCURRENCY).map(read))));
  }
  return reads;
}

/** A tracker item's stories done and in all, canceled ones left out (PRD stories never done). */
export function storyCounts(stories: readonly WorkItemStory[]): { done: number; total: number } {
  const counted = stories.filter((story) => story.state?.category !== "canceled");
  return {
    done: counted.filter((story) => story.state?.category === "done").length,
    total: counted.length,
  };
}

/**
 * Epics done and in all, and their stories done and in all. A canceled epic counts in
 * neither; an epic whose state is unknown counts in all but not as done.
 */
export function featureRollup(epics: readonly FeatureEpicProgress[]): FeatureRollup {
  const counted = epics.filter((epic) => epic.state?.category !== "canceled");
  return {
    epicsDone: counted.filter((epic) => epic.state?.category === "done").length,
    epicsTotal: counted.length,
    storiesDone: counted.reduce((sum, epic) => sum + (epic.stories?.done ?? 0), 0),
    storiesTotal: counted.reduce((sum, epic) => sum + (epic.stories?.total ?? 0), 0),
  };
}

function epicProgress(
  epic: FeatureEpic,
  run: SprintEpicProgress | undefined,
  read: TrackerRead | undefined,
): FeatureEpicProgress {
  const found = read?.kind === "found" ? read : null;
  const host = run?.repositoryProvider ?? null;
  return {
    workItemId: workItemUrlId(epic.tracker, epic.externalId),
    identifier: found?.item.identifier ?? run?.identifier ?? null,
    title: found?.item.title ?? run?.title ?? null,
    url: found?.item.url ?? run?.url ?? null,
    state: found ? found.item.state : null,
    stories: found ? storyCounts(found.stories) : null,
    run: run ? { id: run.runId, status: unifiedRunStatus("epic", run.status) } : null,
    pullRequests: host
      ? (run?.pullRequests ?? []).map(({ number, url, state }) => ({ number, url, state, host }))
      : [],
  };
}

/** The feature's progress; another organization's or an unknown feature is 404. */
export async function loadFeatureProgress(
  deps: FeatureProgressDeps,
  user: OrgUser,
  featureId: string,
): Promise<FeatureProgress> {
  const { db } = deps;
  const organizationId = user.organization.id;
  await requireFeature(db, user, featureId);
  const epics = await listFeatureEpics(db, organizationId, featureId);
  if (epics.length === 0) {
    return { epics: [], rollup: featureRollup([]), trackerProblem: null };
  }

  const runs = new Map<string, SprintEpicProgress>();
  for (const tracker of new Set(epics.map((epic) => epic.tracker))) {
    const ids = epics.filter((epic) => epic.tracker === tracker).map((epic) => epic.externalId);
    for (const [externalId, run] of await listSprintEpicProgress(
      db,
      organizationId,
      tracker,
      ids,
    )) {
      runs.set(workItemUrlId(tracker, externalId), run);
    }
  }

  let reads: TrackerRead[] = [];
  let trackerProblem: string | null = null;
  try {
    const tracker = await (
      deps.tracker ?? ((id) => getWorkItemTracker({ db, organizationId: id }))
    )(organizationId);
    reads = await readEpics(tracker, epics);
    if (reads.some((read) => read.kind === "failed")) trackerProblem = TRACKER_READ_PROBLEM;
  } catch (error) {
    if (!(error instanceof TrackerNotConnectedError)) throw error;
    trackerProblem = TRACKER_NOT_CONNECTED_PROBLEM;
  }

  const rows = epics.map((epic, index) =>
    epicProgress(epic, runs.get(workItemUrlId(epic.tracker, epic.externalId)), reads[index]),
  );
  return { epics: rows, rollup: featureRollup(rows), trackerProblem };
}
