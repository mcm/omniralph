/**
 * What a person does to an epic from Omniralph's Inbox besides retrying it (`retry.ts`):
 *
 * - Start anyway: an epic waiting on blockers outside it ignores them from now on, as the
 *   "start anyway" reply does (`ignoreBlockers`, shared with `reply.ts`).
 * - Done or Skip on a manual story: its work item goes to the done or canceled state through
 *   the work item tracker, then the run advances as after the tracker's own state change
 *   (the story becomes `completed`, or `canceled`: done without work).
 *
 * The run's conversation gets a note naming the person, then the run advances.
 */
import {
  getRun,
  getStory,
  lockRun,
  updateRun,
  type RalphRun,
  type RalphTransaction,
} from "@omniralph/db";
import { workItemTrackerFor } from "@/lib/work-items/get-tracker";
import { conversationFor } from "./conversation";
import { errorMessage, postActivity } from "./notify";
import { advanceRun, type AdvanceResult, type RalphDeps } from "./run";

/** The note after "start anyway", from a reply or from Omniralph. */
export const START_ANYWAY_NOTE = "OK, I'll ignore the open blockers and start anyway.";

/**
 * "Start anyway" (inside `lockRun`): the epic ignores its outside blockers from now on and
 * stops waiting on them. The caller advances the run after the commit.
 */
export async function ignoreBlockers(tx: RalphTransaction, run: RalphRun): Promise<RalphRun> {
  return (await updateRun(tx, run.id, { ignoreBlockers: true, waitingOn: null })) ?? run;
}

const by = (name: string | undefined) => (name ? ` by ${name}` : "");

/** Advances the run after a committed change; a failure is left to the reconcile cron. */
async function advanceAfter(
  deps: RalphDeps,
  runId: string,
  what: string,
): Promise<AdvanceResult | null> {
  try {
    return await advanceRun(runId, deps);
  } catch (error) {
    console.error(`Advancing run ${runId} after ${what} failed`, error);
    return null;
  }
}

export type StartAnywayResult =
  | { status: "started"; run: RalphRun; advanced: AdvanceResult | null }
  /** The run is gone, or no longer an epic waiting on outside blockers. */
  | { status: "gone" };

/** Starts an epic waiting on outside blockers anyway, for `startedBy`. */
export async function startEpicAnyway(
  deps: RalphDeps,
  runId: string,
  startedBy: string | undefined,
): Promise<StartAnywayResult> {
  const run = await lockRun(deps.db, runId, async (tx, current) => {
    if (current.mode !== "epic" || current.status !== "waiting" || current.ignoreBlockers) {
      return null;
    }
    return ignoreBlockers(tx, current);
  });
  if (!run) return { status: "gone" };
  await postActivity(conversationFor(run, deps), {
    type: "thought",
    body: `Started anyway from Omniralph${by(startedBy)}: ${START_ANYWAY_NOTE}`,
  });
  return { status: "started", run, advanced: await advanceAfter(deps, runId, "start anyway") };
}

/** Done: the work item is done. Skip: it is done without work (canceled). */
export type ManualStoryOutcome = "done" | "skip";

export type ManualStoryResult =
  | { status: "finished"; advanced: AdvanceResult | null }
  /** The story or its run is gone, or the story is no longer manual. */
  | { status: "gone" }
  /** The work item's state couldn't be changed: nothing changed. */
  | { status: "failed"; message: string };

/**
 * Finishes a manual story of a waiting epic from Omniralph (Done or Skip, for `finishedBy`):
 * its work item moves to the done or canceled state, and the run advances, which reads
 * the new state (the story becomes `completed` or `canceled`) and goes on with the next story.
 */
export async function finishManualStory(
  deps: RalphDeps,
  storyId: string,
  outcome: ManualStoryOutcome,
  finishedBy: string | undefined,
): Promise<ManualStoryResult> {
  const story = await getStory(deps.db, storyId);
  if (!story || story.status !== "manual") return { status: "gone" };
  const run = await getRun(deps.db, story.runId);
  if (!run) return { status: "gone" };
  try {
    const tracker = await workItemTrackerFor({
      db: deps.db,
      organizationId: run.organizationId,
      gateway: deps.linear,
    });
    await tracker.setState(story.linearIssueId, outcome === "done" ? "done" : "canceled");
  } catch (error) {
    console.error(`Setting the state of ${story.identifier} failed`, error);
    return {
      status: "failed",
      message: `Couldn't ${outcome === "done" ? "complete" : "cancel"} ${story.identifier} in Linear: ${errorMessage(error)}`,
    };
  }
  await postActivity(conversationFor(run, deps), {
    type: "thought",
    body:
      outcome === "done"
        ? `**${story.identifier}** was marked done from Omniralph${by(finishedBy)}.`
        : `**${story.identifier}** was skipped from Omniralph${by(finishedBy)}: it's done without work.`,
  });
  return {
    status: "finished",
    advanced: await advanceAfter(deps, run.id, `finishing ${story.identifier}`),
  };
}
