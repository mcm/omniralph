import "server-only";
import {
  claimNextSprintEpic,
  findStartedSprintEpic,
  getRun,
  getRunByIssue,
  getSprint,
  isTrackerRun,
  listLanes,
  listRunningSprints,
  setSprintEpicState,
  type Database,
  type RalphLane,
  type RalphRun,
  type TrackerRun,
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

/** How a started run's PRs/MRs stand for its epic. */
type PullRequestsOutcome = "stalled" | "merged" | "open";

/**
 * Settles the epic from its run's PRs/MRs: one closed without merging stalls the epic and
 * pauses its sprint; once every one merged the epic merged (even while its sprint is paused,
 * or after it stalled), and a running sprint starts its next epic. Otherwise they're open.
 */
async function settlePullRequests(
  deps: SprintRunDeps,
  run: TrackerRun<RalphRun>,
  epic: SprintEpic,
): Promise<PullRequestsOutcome> {
  const { db, organizationId } = deps;
  const lanes = await pullRequestLanes(db, run.id);
  if (lanes.some((l) => l.prClosed && !l.prMerged)) {
    await stallEpic(db, organizationId, run.trackerProvider, run.trackerIssueId, (e) =>
      pullRequestClosedReason(e.identifier),
    );
    return "stalled";
  }
  if (lanes.length === 0 || !lanes.every((l) => l.prMerged)) return "open";
  const merged = await setSprintEpicState(db, {
    organizationId,
    epicId: epic.id,
    from: ["running", "stalled"],
    state: "merged",
  });
  if (merged.status === "updated" && merged.sprint.status === "running") {
    await advanceSprint(deps, merged.sprint.id);
  }
  return "merged";
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
    await settlePullRequests(deps, run, found.epic);
  });
}

/**
 * How long a sprint's running epic may go without a run of its own before the sprint check
 * gives up on it: the agent session webhook starts the run seconds after Om delegates it.
 */
export const SPRINT_EPIC_START_STALE_MS = 30 * 60_000;

/** The pause reason of an epic Om claimed whose run never began. */
export const runNeverBeganReason = (identifier: string) =>
  `Om started ${identifier}, but its run never began.`;
/** The pause reason of an epic whose run completed without opening a PR. */
export const noPullRequestReason = (identifier: string) =>
  `${identifier}'s run finished without opening a PR.`;

/**
 * Whether the epic's latest run is the one its claim (at `claimedAt`) started or adopted: an
 * unfinished one, one that changed since, or a completed one waiting for its PRs to merge
 * (`startEpic` adopts those). Any other finished run is the earlier attempt a retry replaces.
 */
async function isEpicRun(db: Database, run: RalphRun, claimedAt: number): Promise<boolean> {
  if (!FINISHED.has(run.status)) return true;
  if (Math.max(run.createdAt.getTime(), run.updatedAt.getTime()) >= claimedAt) return true;
  if (run.status !== "completed") return false;
  const lanes = await pullRequestLanes(db, run.id);
  return lanes.length > 0 && !lanes.some((lane) => lane.prClosed && !lane.prMerged);
}

/** What the sprint check did with one running sprint. */
export type SprintCheckResult =
  /** It isn't running any more, or its running epic's run is working or its PR is open. */
  | "ok"
  /** Its running epic's run hasn't begun yet, but it's still early. */
  | "starting"
  /** No epic was running or stalled: the next one was started (a merge whose start was lost). */
  | "advanced"
  /** Its running epic's PRs had merged (a missed merge hook): the next one was started. */
  | "merged"
  /** Its running epic stalled and the sprint paused (a missed hook, or a run that never began). */
  | "paused";

/**
 * Checks a running sprint for hooks that never ran (the sprint check of the
 * `sprint-check` cron). With no epic running or stalled, its next epic starts. Its running
 * epic, claimed (`claimNextSprintEpic`) before Om delegated it in the tracker, stalls and
 * pauses the sprint when no run of it began within `SPRINT_EPIC_START_STALE_MS` (Om died
 * before delegating it, or the agent session webhook never came), when its run failed or was
 * stopped, when its completed run opened no PR or one closed without merging; once its PRs
 * all merged, the epic merged and the next starts. A finished run from before the epic was
 * claimed (the attempt a retry replaces) isn't its run.
 */
export async function checkSprint(
  deps: SprintRunDeps,
  sprintId: string,
  now = new Date(),
): Promise<SprintCheckResult> {
  const { db, organizationId } = deps;
  const sprint = await getSprint(db, organizationId, sprintId);
  if (!sprint || sprint.status !== "running") return "ok";
  if (sprint.epics.some((epic) => epic.state === "stalled")) return "ok";
  const epic = sprint.epics.find((e) => e.state === "running");
  if (!epic) {
    // Every epic merged, merging together: it waits for its sprint PR.
    if (sprint.mergeTogether && sprint.epics.every((e) => e.state === "merged")) return "ok";
    await advanceSprint(deps, sprintId);
    return "advanced";
  }
  const claimedAt = epic.updatedAt.getTime();
  const latest = await getRunByIssue(db, organizationId, epic.externalId);
  const run =
    latest && isTrackerRun(latest) && (await isEpicRun(db, latest, claimedAt)) ? latest : null;
  const stall = async (reason: string): Promise<SprintCheckResult> => {
    const stalled = await setSprintEpicState(db, {
      organizationId,
      epicId: epic.id,
      from: ["running"],
      state: "stalled",
      pause: reason,
    });
    return stalled.status === "updated" ? "paused" : "ok";
  };
  if (!run) {
    if (now.getTime() - claimedAt < SPRINT_EPIC_START_STALE_MS) return "starting";
    return stall(runNeverBeganReason(epic.identifier));
  }
  switch (run.status) {
    case "failed":
      return stall(runFailedReason(epic.identifier, run.error));
    case "stopped":
      return stall(runStoppedReason(epic.identifier));
    case "completed": {
      const outcome = await settlePullRequests(deps, run, epic);
      if (outcome === "merged") return "merged";
      if (outcome === "stalled") return "paused";
      if ((await pullRequestLanes(db, run.id)).length === 0) {
        return stall(noPullRequestReason(epic.identifier));
      }
      return "ok";
    }
    default:
      return "ok";
  }
}

/** The sprint check's counts over every organization's running sprints. */
export interface SprintCheckTotals {
  checked: number;
  advanced: number;
  merged: number;
  paused: number;
  failed: number;
}

/**
 * The sprint check over every organization's running sprints (`checkSprint`), each
 * organization with its tracker loaded on first use. Failures are logged and counted.
 */
export async function checkRunningSprints(
  db: Database,
  depsFor: (organizationId: string) => SprintRunDeps,
  now = new Date(),
): Promise<SprintCheckTotals> {
  const totals: SprintCheckTotals = { checked: 0, advanced: 0, merged: 0, paused: 0, failed: 0 };
  const deps = new Map<string, SprintRunDeps>();
  for (const { id, organizationId } of await listRunningSprints(db)) {
    let organization = deps.get(organizationId);
    if (!organization) {
      organization = depsFor(organizationId);
      deps.set(organizationId, organization);
    }
    try {
      const result = await checkSprint(organization, id, now);
      totals.checked += 1;
      if (result === "advanced" || result === "merged" || result === "paused") {
        totals[result] += 1;
      }
    } catch (error) {
      totals.failed += 1;
      console.error(`Checking sprint ${id} failed`, error);
    }
  }
  return totals;
}
