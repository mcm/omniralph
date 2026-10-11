/**
 * Requests from a ralph PR/MR (ported from cyralph's `SessionManager.onReview`,
 * `session-manager.ts:389-515`): Omniralph's own review of the PR/MR, and a
 * person's `@bot fix` / `@bot` request on it, become requests on the run's
 * lane whose PR/MR it is.
 *
 * - A review run is acted on once it completed and was posted (no webhook,
 *   no polling): if the repository's `respondToReviews` is on, the run isn't
 *   stopped and the review run wasn't seen yet, and it reviewed the PR/MR's
 *   current head, its open findings become one request. An older head's
 *   review run is recorded as handled and skipped; one without open findings does
 *   nothing; after `maxReviewRounds` the run leaves it for a person.
 * - Delivery is a reply's: into the running `ralph.request` job working in
 *   that lane (the heartbeat's live messages), else a pending request, run as
 *   a `ralph.request` job once nothing else runs (a finished run reopens). A
 *   running story agent never gets one: it may not push (FR-7).
 */
import {
  findLaneByPullRequest,
  getLane,
  getRepositoryWithConnection,
  getReviewRun,
  getRunningRunJob,
  insertMessage,
  listActiveRunJobIds,
  listReviewRunFindings,
  lockRun,
  updateLane,
  updateRun,
  type RalphLane,
  type RalphMessageTrigger,
  type RalphRun,
  type RalphTransaction,
  getActiveRunOfSameOrigin,
} from "@omniralph/db";
import { buildReviewRequest, type ChangeRequestWord } from "@omniralph/ralph";
import { parseRalphSettings, RALPH_REQUEST_JOB_TYPE } from "@omniralph/shared";
import { roundLimits } from "./coding";
import { conversationFor } from "./conversation";
import { recordClosedPullRequest } from "./cleanup";
import { postActivity } from "./notify";
import { changeRequestTerm } from "./publish";
import { advanceRun, type AdvanceResult, type RalphDeps } from "./run";

/** How a request reached the run. */
export type PullRequestRequestDelivery =
  /** Stored for the `ralph.request` job working in the lane right now (live injection). */
  | "live"
  /** A pending request, run once the run's current job finishes. */
  | "queued"
  /** A pending request, and the run was advanced to run it. */
  | "started";

export type ReviewResponse =
  | {
      status: "ignored";
      reason:
        | "not_completed"
        | "not_ralph"
        | "repository_unavailable"
        | "opted_out"
        | "run_over"
        | "handled"
        | "closed";
    }
  /** It reviewed an older head: recorded as handled. */
  | { status: "stale" }
  | { status: "no_findings" }
  | { status: "round_limit"; rounds: number }
  | { status: PullRequestRequestDelivery; runId: string; findings: number };

export const OVER: ReadonlySet<RalphRun["status"]> = new Set(["stopped", "failed"]);

/** The lane's request target in `ralph_messages`: null for the main lane. */
const messageLaneId = (run: Pick<RalphRun, "repositoryId">, lane: RalphLane) =>
  lane.repositoryId === run.repositoryId ? null : lane.id;

/**
 * Adds a request to a lane (inside `lockRun`): to the running `ralph.request`
 * job working in that lane, else as a pending request. A completed or
 * stopped run is reopened (not while a newer run of the issue is under way:
 * null). Returns how it went and the note for the session, `<what>.` plus
 * cyralph's wording.
 */
export async function addLaneRequest(
  tx: RalphTransaction,
  run: RalphRun,
  lane: RalphLane,
  input: { text: string; author: string | null; what: string; trigger: RalphMessageTrigger },
): Promise<{ delivery: PullRequestRequestDelivery; run: RalphRun; note: string } | null> {
  let current = run;
  if (current.status === "completed" || current.status === "stopped") {
    const other = await getActiveRunOfSameOrigin(tx, current);
    if (other && other.id !== current.id) return null;
    current = (await updateRun(tx, current.id, { status: "pending", error: null })) ?? current;
  }
  const laneId = messageLaneId(current, lane);
  const job = await getRunningRunJob(tx, current.id, [RALPH_REQUEST_JOB_TYPE]);
  if (job && (job.repositoryId ?? current.repositoryId) === lane.repositoryId) {
    await insertMessage(tx, {
      runId: current.id,
      jobId: job.id,
      laneId,
      kind: "request",
      text: input.text,
      author: input.author,
      trigger: input.trigger,
    });
    return {
      delivery: "live",
      run: current,
      note: `${input.what}. Passing it to the agent that's working right now.`,
    };
  }
  await insertMessage(tx, {
    runId: current.id,
    laneId,
    kind: "request",
    text: input.text,
    author: input.author,
    trigger: input.trigger,
  });
  if ((await listActiveRunJobIds(tx, current.id)).length > 0) {
    return {
      delivery: "queued",
      run: current,
      note: `${input.what}. I'll work through it as soon as the current step finishes.`,
    };
  }
  return { delivery: "started", run: current, note: `${input.what}. Working through it.` };
}

/** Advances a run after a request was added, logging (not throwing) a failure: the reconcile cron retries. */
export async function advanceQuietly(
  deps: RalphDeps,
  runId: string,
): Promise<AdvanceResult | null> {
  try {
    return await advanceRun(runId, deps);
  } catch (error) {
    console.error(`Advancing ralph run ${runId} after a pull request request failed`, error);
    return null;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Acts on a completed Omniralph review run of a ralph PR/MR (see the module
 * comment), recording its ID in `lane.handledReviewIds`. Called once the
 * review run is posted (`finishReviewRun`).
 */
export async function respondToReview(
  deps: RalphDeps,
  reviewRunId: string,
): Promise<ReviewResponse> {
  const ignored = (reason: Extract<ReviewResponse, { status: "ignored" }>["reason"]) =>
    ({ status: "ignored", reason }) as const;
  const reviewRun = await getReviewRun(deps.db, reviewRunId);
  if (!reviewRun || reviewRun.status !== "completed") return ignored("not_completed");
  const found = await findLaneByPullRequest(deps.db, reviewRun.repositoryId, reviewRun.prNumber);
  if (!found) return ignored("not_ralph");
  const target = await getRepositoryWithConnection(deps.db, reviewRun.repositoryId);
  if (!target || target.repository.disconnectedAt || !target.repository.ralphEnabled) {
    return ignored("repository_unavailable");
  }
  const settings = parseRalphSettings(target.repository.ralphSettings);
  if (!settings.respondToReviews) return ignored("opted_out");
  if (OVER.has(found.run.status)) return ignored("run_over");
  if (found.lane.handledReviewIds.includes(reviewRun.id)) return ignored("handled");

  const { repository, connection } = target;
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const state = await deps
    .adapterFor(deps.db, connection)
    .getChangeRequestState(repo, reviewRun.prNumber);
  if (state.state !== "open") {
    await recordClosedPullRequest(deps, found.lane, state);
    return ignored("closed");
  }
  const findings = (await listReviewRunFindings(deps.db, reviewRun.id))
    .filter((f) => f.status === "open")
    .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const term = changeRequestTerm(repository.provider) as ChangeRequestWord;

  const outcome = await lockRun(deps.db, found.run.id, async (tx, run) => {
    const lane = await getLane(tx, found.lane.id);
    if (!lane || lane.prClosed) return ignored("not_ralph");
    if (OVER.has(run.status)) return ignored("run_over");
    if (lane.handledReviewIds.includes(reviewRun.id)) return ignored("handled");
    const handledReviewIds = [...lane.handledReviewIds, reviewRun.id];
    // A review run of an older commit is out of date: ralph has pushed since.
    if (reviewRun.headSha !== state.headSha) {
      await updateLane(tx, lane.id, { handledReviewIds });
      return { status: "stale" } as const;
    }
    if (findings.length === 0) {
      await updateLane(tx, lane.id, { handledReviewIds });
      return { status: "no_findings" } as const;
    }
    const rounds = lane.reviewRounds;
    if (rounds >= roundLimits(run, repository).maxReviewRounds) {
      await updateLane(tx, lane.id, { handledReviewIds });
      const busy = (await listActiveRunJobIds(tx, run.id)).length > 0;
      await postActivity(
        conversationFor(run, deps),
        {
          type: busy ? "thought" : "response",
          body: `Omniralph reviewed ${lane.prUrl} again. I've already worked through ${rounds} of its reviews on this ${term}, so I'm leaving this one for a person.`,
        },
        { notice: true },
      );
      return { status: "round_limit", rounds } as const;
    }
    const added = await addLaneRequest(tx, run, lane, {
      text: buildReviewRequest({
        findings,
        prNumber: reviewRun.prNumber,
        prUrl: lane.prUrl ?? "",
        branch: lane.branch,
        term,
      }),
      author: null,
      what: `Omniralph reviewed the ${term} with ${plural(findings.length, "finding")}`,
      trigger: "pr.review-findings",
    });
    if (!added) return ignored("run_over");
    await updateLane(tx, lane.id, { handledReviewIds, reviewRounds: rounds + 1 });
    await postActivity(
      conversationFor(run, deps),
      {
        type: "thought",
        body: added.note,
      },
      { notice: true },
    );
    return { status: added.delivery, runId: run.id, findings: findings.length } as const;
  });
  if (!outcome) return ignored("not_ralph");
  if (outcome.status === "started") await advanceQuietly(deps, outcome.runId);
  return outcome;
}

/** A ralph run's lane whose PR/MR this is (the newest run's), or null. */
export function findRalphPullRequest(
  deps: Pick<RalphDeps, "db">,
  repositoryId: string,
  prNumber: number,
): Promise<{ lane: RalphLane; run: RalphRun } | null> {
  return findLaneByPullRequest(deps.db, repositoryId, prNumber);
}

export type PullRequestCommentRequest =
  | { status: PullRequestRequestDelivery; run: RalphRun }
  /** The run failed, or a newer run of the issue is under way. */
  | { status: "run_over"; run: RalphRun };

/**
 * A person's `@bot fix` / `@bot` request on a ralph PR/MR becomes a request
 * on its lane (a stopped or finished run resumes, as a Linear reply would
 * resume it), with a note in the run's session.
 */
export async function addPullRequestCommentRequest(
  deps: RalphDeps,
  found: { lane: RalphLane; run: RalphRun },
  input: { text: string; author: string; term: string },
): Promise<PullRequestCommentRequest> {
  const outcome = await lockRun(deps.db, found.run.id, async (tx, run) => {
    const lane = (await getLane(tx, found.lane.id)) ?? found.lane;
    if (run.status === "failed") return { status: "run_over", run } as const;
    const added = await addLaneRequest(tx, run, lane, {
      text: input.text,
      author: input.author,
      what: `@${input.author} asked for changes on the ${input.term}`,
      trigger: "pr.fix-command",
    });
    if (!added) return { status: "run_over", run } as const;
    await postActivity(
      conversationFor(run, deps),
      {
        type: "thought",
        body: added.note,
      },
      { notice: true },
    );
    return { status: added.delivery, run: added.run } as const;
  });
  if (!outcome) return { status: "run_over", run: found.run };
  if (outcome.status === "started") await advanceQuietly(deps, outcome.run.id);
  return outcome;
}
