import "server-only";
import {
  claimNextSprintEpic,
  findStartedSprintEpic,
  getRun,
  getRunByIssue,
  isTrackerRun,
  listLanes,
  setSprintEpicState,
  type Database,
  type RalphLane,
  type RalphRun,
  type SprintEpic,
  type SprintEpicState,
  type WorkItemTracker as TrackerKind,
} from "@omniralph/db";
import type { TrackerGateway } from "@omniralph/tracker";
import type { StartOutcome } from "@/lib/ralph/start";
import type { WorkItemActor } from "@/lib/work-items/actions";
import { workItemTrackerFor } from "@/lib/work-items/get-tracker";
import type { WorkItemTracker } from "@/lib/work-items/tracker";

/**
 * Running a sprint: each epic starts through the Backlog's Start epic (`startWorkItem`, with
 * its refusals), the first when the sprint starts and each next one once the one before it
 * merged. An epic whose start is refused (by Start epic, or by the run's own start checks in
 * the agent session webhook), whose run fails or is stopped, or whose PR closes without
 * merging stalls, and pauses its sprint with the reason; resuming queues it again, so it is
 * retried first. A paused or canceled sprint starts nothing; a merge still counts while it is
 * paused.
 */

/** Who starts the epics after the first: Om. */
export const SPRINT_ACTOR: WorkItemActor = { userId: null, name: "Om" };

export interface SprintRunDeps {
  db: Database;
  organizationId: string;
  /** The organization's work item tracker. */
  loadTracker: () => Promise<WorkItemTracker>;
}

/** The sprint deps of a tracker webhook or ralph handler that holds the tracker's gateway. */
export function sprintRunDeps(deps: {
  db: Database;
  organizationId: string;
  tracker: TrackerGateway;
}): SprintRunDeps {
  return {
    db: deps.db,
    organizationId: deps.organizationId,
    loadTracker: () =>
      workItemTrackerFor({
        db: deps.db,
        organizationId: deps.organizationId,
        gateway: deps.tracker,
      }),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The pause reason of an epic Om didn't start (`why`: the refusal). */
export const notStartedReason = (identifier: string, why: string) =>
  `Om didn't start ${identifier}: ${why}`;
/** The pause reason of an epic whose run failed. */
export const runFailedReason = (identifier: string, error: string | null) =>
  `${identifier}'s run failed${error ? `: ${error}` : "."}`;
/** The pause reason of an epic whose run a person stopped. */
export const runStoppedReason = (identifier: string) => `${identifier}'s run was stopped.`;
/** The pause reason of an epic whose PR closed without merging. */
export const pullRequestClosedReason = (identifier: string) =>
  `${identifier}'s PR was closed without merging.`;
/** The pause reason of a sprint a person paused. */
export const pausedByReason = (name: string) => `Paused by ${name}.`;

/** Why a delegation needing refining went to triage instead of a run. */
export const NEEDS_REFINING_WHY = "it needs refining, so Om is triaging it.";

/**
 * Why the agent session webhook didn't start a delegated work item's run, or null when it
 * started (or a run already works on it).
 */
export function startRefusal(outcome: StartOutcome): string | null {
  switch (outcome.status) {
    case "load_failed":
      return `Om couldn't load it (${outcome.error}).`;
    case "open_questions":
      return `the PRD of ${outcome.identifier} still has open questions.`;
    case "feature":
      return `${outcome.identifier} is a feature: add its epics instead.`;
    case "relations":
      return "its blocks relations break the dependency rules.";
    case "blocked_labels":
      return `it has a blocked label (${outcome.labels.join(", ")}).`;
    case "unroutable":
      return "no repo has Coding on.";
    case "manual":
      return `it routes to ${outcome.repository}, which has Coding off.`;
    case "failed":
      return outcome.error;
    default:
      return null;
  }
}

/** How starting an epic went. */
type EpicStart =
  /** It was delegated to Om, or a run of it is already working (or waits for its PR's merge). */
  | { kind: "started" }
  /** Its run's PRs all merged already. */
  | { kind: "merged" }
  | { kind: "refused"; why: string };

/** The run's lanes that opened a PR/MR. */
async function pullRequestLanes(db: Database, runId: string): Promise<RalphLane[]> {
  return (await listLanes(db, runId)).filter((lane) => lane.prNumber !== null);
}

const FINISHED: ReadonlySet<RalphRun["status"]> = new Set(["completed", "failed", "stopped"]);

/**
 * Starts one epic the way Start epic does. An unfinished run of it already works on it; a
 * completed run whose PRs merged means the epic merged, one whose PRs are open waits for
 * their merge; any other finished run is started again (a retry).
 */
async function startEpic(
  deps: SprintRunDeps,
  epic: SprintEpic,
  actor: WorkItemActor,
): Promise<EpicStart> {
  const { db, organizationId } = deps;
  const previous = await getRunByIssue(db, organizationId, epic.externalId);
  if (previous && !FINISHED.has(previous.status)) return { kind: "started" };
  if (previous?.status === "completed") {
    const lanes = await pullRequestLanes(db, previous.id);
    if (lanes.length > 0 && lanes.every((lane) => lane.prMerged)) return { kind: "merged" };
    if (lanes.length > 0 && !lanes.some((lane) => lane.prClosed && !lane.prMerged)) {
      return { kind: "started" };
    }
  }
  // Loaded on first use: the ralph modules reporting merges and stalls import this one, and
  // Start epic's module brings the API route stack (sessions, auth) with it.
  const [{ startWorkItem }, { ApiRouteError }] = await Promise.all([
    import("@/lib/work-items/actions"),
    import("@/lib/api/handler"),
  ]);
  try {
    const tracker = await deps.loadTracker();
    const item = await tracker.get(epic.externalId);
    await startWorkItem(
      db,
      {
        organization: { id: organizationId },
        tracker,
        item,
        key: { organizationId, tracker: epic.tracker, externalId: epic.externalId },
      },
      actor,
      { retry: previous !== null },
    );
    return { kind: "started" };
  } catch (error) {
    if (!(error instanceof ApiRouteError)) {
      console.error(`Starting sprint epic ${epic.identifier} failed`, error);
    }
    return { kind: "refused", why: errorText(error) };
  }
}

/** The most epics one advance walks past (each already merged): a sprint's most epics. */
const MAX_STEPS = 50;

/**
 * Starts the running sprint's next queued epic, unless one is running or stalled: an epic
 * already merged is marked so and the next one tried; a refusal stalls it and pauses the
 * sprint. With every epic merged the sprint is done (or, merging together, waits for its
 * sprint PR). `actor`: who started it (Om, unless a person started or resumed the sprint).
 */
export async function advanceSprint(
  deps: SprintRunDeps,
  sprintId: string,
  actor: WorkItemActor = SPRINT_ACTOR,
): Promise<void> {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const claim = await claimNextSprintEpic(deps.db, deps.organizationId, sprintId);
    if (claim.status !== "claimed") return;
    const { epic } = claim;
    const started = await startEpic(deps, epic, actor);
    if (started.kind === "started") return;
    if (started.kind === "refused") {
      await setSprintEpicState(deps.db, {
        organizationId: deps.organizationId,
        epicId: epic.id,
        from: ["running"],
        state: "stalled",
        pause: notStartedReason(epic.identifier, started.why),
      });
      return;
    }
    await setSprintEpicState(deps.db, {
      organizationId: deps.organizationId,
      epicId: epic.id,
      from: ["running"],
      state: "merged",
    });
  }
}

/**
 * Stalls the work item's running epic in a started sprint and pauses that sprint with
 * `reason` (given the epic). Nothing when the item isn't a running sprint epic.
 */
async function stallEpic(
  db: Database,
  organizationId: string,
  tracker: TrackerKind,
  issueId: string,
  reason: (epic: SprintEpic) => string,
  from: readonly SprintEpicState[] = ["running"],
): Promise<void> {
  const found = await findStartedSprintEpic(db, organizationId, tracker, issueId);
  if (!found || !from.includes(found.epic.state)) return;
  await setSprintEpicState(db, {
    organizationId,
    epicId: found.epic.id,
    from,
    state: "stalled",
    pause: reason(found.epic),
  });
}

/** Logs a failure of a sprint hook: a sprint never breaks the run or webhook it follows. */
async function quietly(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`${what} failed`, error);
  }
}

/**
 * The agent session webhook didn't start a delegated work item's run (`why`: the refusal,
 * e.g. its PRD still has open questions): its running sprint epic stalls and pauses its sprint.
 */
export async function sprintEpicStartRefused(
  deps: { db: Database; organizationId: string; tracker: Pick<TrackerGateway, "provider"> },
  issueId: string,
  why: string,
): Promise<void> {
  await quietly(`Pausing the sprint of ${issueId} after its start was refused`, () =>
    stallEpic(deps.db, deps.organizationId, deps.tracker.provider, issueId, (epic) =>
      notStartedReason(epic.identifier, why),
    ),
  );
}

/** A run ended without its work merging (it failed, or a person stopped it): its epic stalls. */
export async function sprintEpicRunEnded(
  deps: { db: Database; organizationId: string },
  run: RalphRun,
): Promise<void> {
  if (!isTrackerRun(run) || (run.status !== "failed" && run.status !== "stopped")) return;
  await quietly(`Pausing the sprint of ${run.trackerIdentifier} after its run ended`, () =>
    stallEpic(deps.db, deps.organizationId, run.trackerProvider, run.trackerIssueId, (epic) =>
      run.status === "failed"
        ? runFailedReason(epic.identifier, run.error)
        : runStoppedReason(epic.identifier),
    ),
  );
}

/**
 * A run's PR/MR was seen closed (`recordClosedPullRequest`). Closed without merging: its
 * running epic stalls and pauses the sprint. Merged, once every PR/MR of the run merged: the
 * epic merged (even while its sprint is paused, or after it stalled), and a running sprint
 * starts its next epic.
 */
export async function sprintEpicPullRequestClosed(
  deps: SprintRunDeps,
  lane: Pick<RalphLane, "runId">,
): Promise<void> {
  const { db, organizationId } = deps;
  await quietly(`Advancing the sprint of ralph run ${lane.runId}`, async () => {
    const run = await getRun(db, lane.runId);
    if (!run || !isTrackerRun(run)) return;
    const found = await findStartedSprintEpic(
      db,
      organizationId,
      run.trackerProvider,
      run.trackerIssueId,
    );
    if (!found) return;
    const lanes = await pullRequestLanes(db, run.id);
    if (lanes.some((l) => l.prClosed && !l.prMerged)) {
      await stallEpic(db, organizationId, run.trackerProvider, run.trackerIssueId, (epic) =>
        pullRequestClosedReason(epic.identifier),
      );
      return;
    }
    if (!lanes.every((l) => l.prMerged)) return;
    const merged = await setSprintEpicState(db, {
      organizationId,
      epicId: found.epic.id,
      from: ["running", "stalled"],
      state: "merged",
    });
    if (merged.status === "updated" && merged.sprint.status === "running") {
      await advanceSprint(deps, merged.sprint.id);
    }
  });
}
