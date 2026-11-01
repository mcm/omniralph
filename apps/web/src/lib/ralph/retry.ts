/**
 * Retrying an epic or request run from Omniralph (`POST /api/ui/runs/{id}/retry`), and the
 * bare `/continue` reply both paths share (`continueRun`):
 *
 * - The run: what a bare `/continue` does (a stopped, failed or finished run resumes, the
 *   iteration cap starts over, unfinished stories get fresh attempts, a waiting PR/MR step
 *   is retried). A request run whose `ralph.request` attempt failed, was canceled or
 *   expired gets that attempt's last request back as a pending request first.
 * - One story: its attempts start over and it becomes the run's focus; a completed story is
 *   re-run (back to `pending`, its work item reopened), after which the PR/MR step runs
 *   again. Never when its lane's PR/MR is merged or closed.
 *
 * The run's conversation gets "Retried from Omniralph by {name}", then the run advances.
 */
import {
  getActiveRunOfSameOrigin,
  getJob,
  getMainLane,
  getLane,
  getStory,
  insertMessage,
  listActiveRunJobIds,
  listMessages,
  listStories,
  lockRun,
  updateRun,
  updateStory,
  getRepositoryWithConnection,
  type Job,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
} from "@omniralph/db";
import { RalphRequestPayload } from "@omniralph/shared";
import { workItemTrackerFor } from "@/lib/work-items/get-tracker";
import { dropKeepBranchCleanups } from "./cleanup";
import { ralphJobPayload } from "./coding";
import { conversationFor } from "./conversation";
import { freshAttempts } from "./messages";
import { errorMessage, postActivity, quietly } from "./notify";
import { changeRequestTerm } from "./publish";
import {
  advanceRun,
  FINISHED_RUN_STATUSES,
  publishPlan,
  type AdvanceResult,
  type RalphDeps,
} from "./run";

/** Job statuses after which an attempt is retried. */
const RETRYABLE_JOB_STATUSES = new Set<Job["status"]>(["failed", "canceled", "expired"]);

/**
 * A finished run (stopped, failed or completed) asked to work again becomes `pending`
 * (advancing it decides what's next; its next job recreates a removed worktree from the
 * kept branch, and its keep-branch cleanups that haven't started are dropped). An
 * unfinished run stays as it is. Null while another run of the issue (or chat thread) is
 * unfinished (it was delegated again).
 */
export async function resumeRun(tx: RalphTransaction, run: RalphRun): Promise<RalphRun | null> {
  if (!FINISHED_RUN_STATUSES.has(run.status)) return run;
  const other = await getActiveRunOfSameOrigin(tx, run);
  if (other && other.id !== run.id) return null;
  await dropKeepBranchCleanups(tx, run.id);
  return updateRun(tx, run.id, { status: "pending", error: null });
}

/**
 * A bare `/continue` (inside `lockRun`), from a reply or Omniralph's Retry: the run resumes
 * (`resumeRun`), its iteration cap starts over, and its unfinished stories get fresh
 * attempts (a waiting PR/MR step is retried). Null while a newer run of the issue is
 * unfinished. The caller advances the run after the commit.
 */
export async function continueRun(tx: RalphTransaction, run: RalphRun): Promise<RalphRun | null> {
  const resumed = await resumeRun(tx, run);
  if (!resumed) return null;
  const reset = (await updateRun(tx, resumed.id, { iterations: 0 })) ?? resumed;
  await freshAttempts(tx, reset);
  return reset;
}

/** The note for a reply or retry on an old run while a newer one is under way. */
export function newerRunMessage(run: Pick<RalphRun, "linearIdentifier" | "status">): string {
  return `A newer run of **${run.linearIdentifier}** is under way, so this ${run.status} run stays ${run.status}. Reply in that run's session instead.`;
}

/** What to retry. */
export type RalphRetryTarget =
  /** The run; `requestJobId`: a `ralph.request` attempt whose last request runs again. */
  | { kind: "run"; requestJobId?: string | null }
  /** One story of an epic (a completed one is re-run). */
  | { kind: "story"; storyId: string };

export type RalphRetryResult =
  /** `advanced` null: advancing failed (logged); the reconcile cron advances it later. */
  | { status: "retried"; run: RalphRun; advanced: AdvanceResult | null }
  | { status: "gone" }
  /** One of the run's jobs is queued or running. */
  | { status: "busy" }
  /** A newer run of the issue is unfinished. */
  | { status: "newer_run"; message: string }
  /** The story's lane PR/MR is merged or closed. */
  | { status: "refused"; message: string }
  /** The story's work item couldn't be reopened. */
  | { status: "failed"; message: string };

/**
 * Retries an epic or request run, or one story of an epic (see the module comment), for
 * `retriedBy`. Callers check what may be retried (`runActions`); this re-checks only what
 * can change meanwhile: a job started, a newer run, the story's PR/MR.
 */
export async function retryRalphRun(
  deps: RalphDeps,
  runId: string,
  target: RalphRetryTarget,
  retriedBy: string | undefined,
): Promise<RalphRetryResult> {
  const outcome = await lockRun(
    deps.db,
    runId,
    async (tx, run): Promise<Exclude<RalphRetryResult, { status: "retried" }> | RetriedRun> => {
      if ((await listActiveRunJobIds(tx, run.id)).length > 0) return { status: "busy" };
      if (target.kind === "story") return retryStory(deps, tx, run, target.storyId);
      if (target.requestJobId) await requeueRequest(deps, tx, run, target.requestJobId);
      const continued = await continueRun(tx, run);
      if (!continued) return { status: "newer_run", message: newerRunMessage(run) };
      return { status: "retried", run: continued, story: null };
    },
  );
  if (!outcome) return { status: "gone" };
  if (outcome.status !== "retried") return outcome;
  const by = retriedBy ? ` by ${retriedBy}` : "";
  const what = outcome.story ? ` **${outcome.story.identifier}**` : "";
  await postActivity(conversationFor(outcome.run, deps), {
    type: "thought",
    body: `Retried${what} from Omniralph${by}.`,
  });
  // The retry is committed: a failure to advance now (Linear down…) is left to the reconcile cron.
  let advanced: AdvanceResult | null = null;
  try {
    advanced = await advanceRun(runId, deps);
  } catch (error) {
    console.error(`Advancing run ${runId} after its retry failed`, error);
  }
  return { status: "retried", run: outcome.run, advanced };
}

type RetriedRun = { status: "retried"; run: RalphRun; story: RalphStory | null };

/**
 * One story's retry (inside `lockRun`): refused when its lane's PR/MR is merged or closed.
 * A completed (or canceled) story goes back to `pending` and its work item is reopened
 * (Linear's done state would complete it again); every story's attempts start over. The
 * story becomes the run's focus, and the run resumes with a fresh iteration cap.
 */
async function retryStory(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  storyId: string,
): Promise<RetriedRun | Exclude<RalphRetryResult, { status: "retried" }>> {
  const story = await getStory(tx, storyId);
  if (!story || story.runId !== run.id) return { status: "gone" };
  const lane = story.laneId ? await getLane(tx, story.laneId) : await getMainLane(tx, run);
  if (lane?.prMerged || lane?.prClosed) {
    const provider = (await getRepositoryWithConnection(deps.db, lane.repositoryId))?.repository
      .provider;
    const term = changeRequestTerm(provider ?? "github");
    return {
      status: "refused",
      message: `The ${term} for this story is already ${lane.prMerged ? "merged" : "closed"}.`,
    };
  }
  if (story.status === "completed" || story.status === "canceled") {
    // Reopened first (Linear's done state would complete it again): a failure changes nothing.
    try {
      const tracker = await workItemTrackerFor({
        db: deps.db,
        organizationId: run.organizationId,
        gateway: deps.tracker,
      });
      const item = await tracker.get(story.linearIssueId);
      if (item.state.category === "done" || item.state.category === "canceled") {
        await tracker.setState(story.linearIssueId, "in_progress");
      }
    } catch (error) {
      console.error(`Reopening ${story.identifier} failed`, error);
      return {
        status: "failed",
        message: `Couldn't reopen ${story.identifier} in Linear: ${errorMessage(error)}`,
      };
    }
  }
  const resumed = await resumeRun(tx, run);
  if (!resumed) return { status: "newer_run", message: newerRunMessage(run) };
  const reset = await updateStory(tx, story.id, {
    ...(story.status !== "running" && story.status !== "manual" && { status: "pending" }),
    attempts: 0,
    rounds: 0,
    roundMetrics: null,
  });
  const updated =
    (await updateRun(tx, run.id, {
      iterations: 0,
      focusStoryId: story.linearIssueId,
      waitingOn: null,
      error: null,
    })) ?? resumed;
  // The plan shows the story pending again.
  await quietly(`Posting the plan of run ${run.id}`, async () =>
    publishPlan(conversationFor(run, deps), await listStories(tx, run.id)),
  );
  return { status: "retried", run: updated, story: reset ?? story };
}

/**
 * A request run's failed, canceled or expired `ralph.request` attempt: its last request
 * becomes a pending request again (inside `lockRun`), unless it still is one (a canceled
 * job leaves its requests pending).
 */
async function requeueRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  jobId: string,
): Promise<void> {
  const job = await getJob(deps.db, jobId);
  if (!job || job.ralphRunId !== run.id || !RETRYABLE_JOB_STATUSES.has(job.status)) return;
  // Only what it asked for: the rest of the payload is rebuilt when the request runs again.
  const payload = RalphRequestPayload.pick({ requests: true, ship: true }).safeParse(
    ralphJobPayload(job),
  );
  const last = payload.success ? payload.data.requests.at(-1) : undefined;
  if (!last) return;
  const message = (await listMessages(tx, run.id)).find((m) => m.id === last.id);
  if (message && !message.consumedAt && !message.jobId) return;
  await insertMessage(tx, {
    runId: run.id,
    kind: "request",
    text: message?.text ?? last.text,
    laneId: message?.laneId ?? null,
    author: message?.author ?? null,
    ship: message?.ship ?? payload.data!.ship,
    trigger: message?.trigger ?? null,
  });
}
