/**
 * Requests from a ralph PR/MR (ported from cyralph's `SessionManager.onReview`,
 * `session-manager.ts:389-515`): Omniralph's own review of the PR/MR, and a
 * person's `@bot fix` / `@bot` request on it, become requests on the run's
 * lane whose PR/MR it is.
 *
 * - A review run is acted on once it completed and was posted (no webhook,
 *   no polling): if the repository's `respondToReviewsAndCi` is on, the run isn't
 *   stopped and the review run wasn't seen yet, and it reviewed the PR/MR's
 *   current head, its open findings become one request. An older head's
 *   review run is recorded as handled and skipped; one without open findings does
 *   nothing; after its request playbook's `maxReviewRounds` the run leaves it for a person.
 * - A documentation check's confirmed updates (Update mode) become one
 *   request too (`respondToDocumentationCheck`), at most one per PR/MR head
 *   and `MAX_DOCUMENTATION_REQUESTS_PER_PULL_REQUEST` per PR/MR. On a
 *   person's PR/MR whose branch is in the repo (update targets `same-repo`),
 *   the request starts a coding run of origin `pull-request` on that branch
 *   instead (`lib/ralph/documentation-runs.ts` binds it to the checked head).
 * - Delivery is a reply's: into the running `ralph.request` job working in
 *   that lane (the heartbeat's live messages), else a pending request, run as
 *   a `ralph.request` job once nothing else runs (a finished run reopens). A
 *   running story agent never gets one: it may not push (FR-7).
 */
import {
  createRun,
  findLaneByPullRequest,
  getLane,
  getRun,
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
  getReview,
  insertDocumentationRequest,
  listDocumentationRequests,
  lockDocumentationRequests,
  reviewRunSuperseded,
  type DocumentationRequest,
  type Repository,
  type Review,
  type ScmConnection,
} from "@omniralph/db";
import {
  buildDocumentationRequest,
  buildReviewRequest,
  type ChangeRequestWord,
} from "@omniralph/ralph";
import { RALPH_REQUEST_JOB_TYPE } from "@omniralph/shared";
import { organizationPlaybooks } from "@/lib/playbooks";
import { roundLimits } from "./coding";
import { conversationFor } from "./conversation";
import { notAppliedReason } from "./documentation-runs";
import { scheduleRunSafetyCheck } from "./due";
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
      note: `${input.what}. Passing it to Om while it's working.`,
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
  if (!target || target.repository.disconnectedAt || !target.repository.codingEnabled) {
    return ignored("repository_unavailable");
  }
  if (!target.repository.respondToReviewsAndCi) return ignored("opted_out");
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
    const { maxReviewRounds } = await roundLimits(
      run,
      repository,
      organizationPlaybooks(deps.db, run.organizationId),
    );
    if (rounds >= maxReviewRounds) {
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
 * on its lane (a stopped or finished run resumes, as a tracker reply would
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

/** The most documentation requests one PR/MR gets; past it, a person finishes the docs. */
export const MAX_DOCUMENTATION_REQUESTS_PER_PULL_REQUEST = 3;

/**
 * What became of a documentation check's confirmed updates on a ralph PR/MR
 * (`respondToDocumentationCheck`); the documentation comment says so.
 */
export type DocumentationResponse =
  | {
      status: "ignored";
      reason:
        | "not_completed"
        | "no_updates"
        | "superseded"
        | "not_ralph"
        | "repository_unavailable"
        | "not_update_mode"
        | "run_over"
        | "closed"
        | "stale"
        /** A person's PR/MR, and the repo's update targets are Om's PRs/MRs only. */
        | "targets"
        /** A person's PR/MR from a fork: never committed to. */
        | "fork";
    }
  /**
   * Handed off as a request on the run's lane, or as the first request of a
   * new pull-request run on a person's PR/MR (now, or by an earlier check of
   * the same head; `runId` null when that run is gone).
   */
  | {
      status: "handed_off";
      paths: string[];
      delivery: PullRequestRequestDelivery | "earlier";
      runId: string | null;
    }
  /** The PR/MR already had `MAX_DOCUMENTATION_REQUESTS_PER_PULL_REQUEST` requests. */
  | { status: "limit"; requests: number }
  /** The files were all in the previous request: Om's commit for it didn't settle them. */
  | { status: "repeated"; paths: string[] }
  /** Handed off, but the coding run couldn't commit them (e.g. the branch moved): `reason` says why. */
  | { status: "not_applied"; paths: string[]; reason: string };

/** Whether a documentation response leaves the rest to a person. */
export const documentationNeedsPerson = (response: DocumentationResponse | null): boolean =>
  response?.status === "limit" || response?.status === "repeated";

/**
 * Hands a finished documentation check's confirmed updates (review
 * `reviewId`) to a coding run, when the repo's documentation check is in
 * Update mode. On a ralph PR/MR: one request on the run's lane (shipped by its
 * request session as a normal commit), recorded in `documentation_requests`.
 * On a person's PR/MR: a new pull-request run, when the repo's update targets
 * are `same-repo` and the PR/MR's branch is in the repo
 * (`startPullRequestDocumentationRun`); otherwise nothing (the comment only).
 * Nothing is requested for a stopped or failed run, a superseded check, a
 * head that is no longer the PR/MR's current head, a head that already has
 * a request (`handed_off` with delivery `earlier`), past
 * `MAX_DOCUMENTATION_REQUESTS_PER_PULL_REQUEST` (`limit`), or when every
 * file was in the PR/MR's previous request (`repeated`): the commit Om made
 * for a docs request never starts another for the same files.
 */
export async function respondToDocumentationCheck(
  deps: RalphDeps,
  reviewId: string,
): Promise<DocumentationResponse> {
  const ignored = (reason: Extract<DocumentationResponse, { status: "ignored" }>["reason"]) =>
    ({ status: "ignored", reason }) as const;
  const review = await getReview(deps.db, reviewId);
  if (!review || (review.status !== "completed" && review.status !== "budget_exhausted")) {
    return ignored("not_completed");
  }
  const updates = review.documentationUpdates ?? [];
  if (updates.length === 0) return ignored("no_updates");
  const reviewRun = review.reviewRunId ? await getReviewRun(deps.db, review.reviewRunId) : null;
  if (reviewRun && reviewRunSuperseded(reviewRun)) return ignored("superseded");
  const target = await getRepositoryWithConnection(deps.db, review.repositoryId);
  if (!target || target.repository.disconnectedAt || !target.repository.codingEnabled) {
    return ignored("repository_unavailable");
  }
  if (target.repository.documentationCheck !== "update") return ignored("not_update_mode");
  const found = await findLaneByPullRequest(deps.db, review.repositoryId, review.prNumber);
  if (!found) return startPullRequestDocumentationRun(deps, review, target);
  if (OVER.has(found.run.status)) return ignored("run_over");

  const { repository, connection } = target;
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const state = await deps
    .adapterFor(deps.db, connection)
    .getChangeRequestState(repo, review.prNumber);
  if (state.state !== "open") return ignored("closed");
  // An older head's check is out of date: the PR/MR has moved on.
  if (state.headSha !== review.headSha) return ignored("stale");
  const paths = updates.map((update) => update.path);
  const term = changeRequestTerm(repository.provider) as ChangeRequestWord;

  const outcome = await lockRun(deps.db, found.run.id, async (tx, run) => {
    const lane = await getLane(tx, found.lane.id);
    if (!lane || lane.prClosed) return ignored("not_ralph");
    if (OVER.has(run.status)) return ignored("run_over");
    await lockDocumentationRequests(tx, review.repositoryId, review.prNumber);
    const requests = await listDocumentationRequests(tx, review.repositoryId, review.prNumber);
    const limited = documentationRequestLimit(requests, review.headSha, paths);
    if (limited) {
      return limited.status === "handed_off"
        ? { ...limited, runId: limited.runId ?? run.id }
        : limited;
    }
    const added = await addLaneRequest(tx, run, lane, {
      text: buildDocumentationRequest({
        updates,
        prNumber: review.prNumber,
        prUrl: lane.prUrl ?? "",
        branch: lane.branch,
        term,
      }),
      author: null,
      what: `Omniralph's documentation check found ${plural(paths.length, "file")} to update on the ${term}`,
      trigger: "pr.review-findings",
    });
    if (!added) return ignored("run_over");
    const recorded = await insertDocumentationRequest(tx, {
      repositoryId: review.repositoryId,
      prNumber: review.prNumber,
      headSha: review.headSha,
      reviewId: review.id,
      ralphRunId: added.run.id,
      paths,
    });
    // The lock serializes the run's requests; a conflict here is another run's request.
    if (!recorded) throw new Error("documentation request recorded concurrently");
    await postActivity(
      conversationFor(run, deps),
      { type: "thought", body: added.note },
      {
        notice: true,
      },
    );
    return { status: "handed_off", paths, delivery: added.delivery, runId: added.run.id } as const;
  });
  if (!outcome) return ignored("not_ralph");
  if (outcome.status === "handed_off" && outcome.delivery === "started" && outcome.runId) {
    await advanceQuietly(deps, outcome.runId);
  }
  return outcome;
}

/**
 * What the PR/MR's earlier documentation requests (`requests`) leave for a
 * check of `headSha` that confirmed `paths`, or null when it gets a request:
 * the head's earlier request (`handed_off`, delivery `earlier`), the limit of
 * `MAX_DOCUMENTATION_REQUESTS_PER_PULL_REQUEST` (`limit`), or every file
 * already in the previous request (`repeated`).
 */
function documentationRequestLimit(
  requests: readonly DocumentationRequest[],
  headSha: string,
  paths: readonly string[],
): Extract<DocumentationResponse, { status: "handed_off" | "limit" | "repeated" }> | null {
  const earlier = requests.find((request) => request.headSha === headSha);
  if (earlier) {
    return {
      status: "handed_off",
      paths: earlier.paths,
      delivery: "earlier",
      runId: earlier.ralphRunId,
    };
  }
  if (requests.length >= MAX_DOCUMENTATION_REQUESTS_PER_PULL_REQUEST) {
    return { status: "limit", requests: requests.length };
  }
  const previous = requests.at(-1);
  if (previous && paths.every((path) => previous.paths.includes(path))) {
    return { status: "repeated", paths: [...paths] };
  }
  return null;
}

/** How a pull-request run says it was routed. */
export const ROUTED_BY_DOCUMENTATION_CHECK = "the documentation check";

/**
 * Commits a documentation check's confirmed updates to a person's PR/MR
 * (review `review`, a completed check in Update mode of a repo with Coding
 * on): when the repo's update targets are `same-repo`, the PR/MR is open at
 * the checked head and its branch is in the repo (not a fork), a new coding
 * run of origin `pull-request` on the PR/MR's head branch, whose first
 * request is the docs request, recorded in `documentation_requests` with the
 * checked head (the run is bound to it: `lib/ralph/documentation-runs.ts`).
 * The per-head and per-PR/MR limits are those of Om's PRs/MRs, under the
 * PR/MR's documentation-request lock.
 */
async function startPullRequestDocumentationRun(
  deps: RalphDeps,
  review: Review,
  target: { repository: Repository; connection: ScmConnection },
): Promise<DocumentationResponse> {
  const { repository, connection } = target;
  if (repository.documentationUpdateTargets !== "same-repo") {
    return { status: "ignored", reason: "targets" };
  }
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const pr = await deps.adapterFor(deps.db, connection).getChangeRequest(repo, review.prNumber);
  if (pr.state !== "open") return { status: "ignored", reason: "closed" };
  if (pr.headSha !== review.headSha) return { status: "ignored", reason: "stale" };
  if (pr.sameRepository !== true) return { status: "ignored", reason: "fork" };
  const updates = review.documentationUpdates ?? [];
  const paths = updates.map((update) => update.path);
  const term = changeRequestTerm(repository.provider) as ChangeRequestWord;

  const outcome = await deps.db.transaction(async (tx): Promise<DocumentationResponse> => {
    await lockDocumentationRequests(tx, review.repositoryId, review.prNumber);
    const requests = await listDocumentationRequests(tx, review.repositoryId, review.prNumber);
    const limited = documentationRequestLimit(requests, review.headSha, paths);
    if (limited) return limited;
    const { run } = await createRun(tx, {
      origin: "pull-request",
      organizationId: repository.organizationId,
      repositoryId: repository.id,
      routedBy: ROUTED_BY_DOCUMENTATION_CHECK,
      branch: pr.headRef,
      baseBranch: pr.baseRef,
      prUrl: pr.url,
    });
    await insertMessage(tx, {
      runId: run.id,
      kind: "request",
      text: buildDocumentationRequest({
        updates,
        prNumber: review.prNumber,
        prUrl: pr.url,
        branch: pr.headRef,
        term,
        personsBranch: true,
      }),
      author: null,
      trigger: "pr.review-findings",
    });
    const recorded = await insertDocumentationRequest(tx, {
      repositoryId: review.repositoryId,
      prNumber: review.prNumber,
      headSha: review.headSha,
      reviewId: review.id,
      ralphRunId: run.id,
      paths,
    });
    // The PR/MR's lock serializes its requests: a conflict here can't happen.
    if (!recorded) throw new Error("documentation request recorded concurrently");
    await scheduleRunSafetyCheck(run.id);
    return { status: "handed_off", paths, delivery: "started", runId: run.id };
  });
  if (outcome.status !== "handed_off" || outcome.delivery !== "started" || !outcome.runId) {
    return outcome;
  }
  await advanceQuietly(deps, outcome.runId);
  // It failed right away (e.g. the branch moved): the comment says so, not that Om is committing.
  const run = await getRun(deps.db, outcome.runId);
  if (run?.status === "failed") {
    return { status: "not_applied", paths, reason: notAppliedReason(run.error) };
  }
  return outcome;
}
