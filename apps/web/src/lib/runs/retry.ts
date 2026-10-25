import "server-only";
/**
 * `POST /api/ui/runs/{id}/retry`: checks the target against the run's detail (the same
 * `runActions` the detail shows) and retries the run: an epic or request run, or one of an
 * epic's stories (`retryRalphRun`); a review run on its PR's current head with its mode and
 * profile (`rerunOrganizationReview`); a triage run with a new attempt (`retryTriageRun`); an
 * ask with a copy of its last attempt (`retryChatAsk`). A review's, triage's or ask's attempt
 * is retried with its run. A review whose head is already queued or running answers that review
 * run with a `warning`, as the review Re-run does.
 */
import {
  getRunIndexEntry,
  type Database,
  type RunIndexEntry,
  getReviewRun,
  listReviewRunReviews,
} from "@omniralph/db";
import { CHAT_ASK_JOB_TYPE, RALPH_REQUEST_JOB_TYPE, TRIAGE_RUN_JOB_TYPE } from "@omniralph/shared";
import { ApiRouteError } from "@/lib/api/handler";
import type { RunDetail, RunRetryResult, RunRetryTarget } from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import { getDispatcher } from "@/lib/dispatch";
import { retryChatAsk } from "@/lib/chat/ask";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { changeRequestTerm } from "@/lib/ralph/publish";
import { retryRalphRun, type RalphRetryTarget } from "@/lib/ralph/retry";
import { rerunOrganizationReview } from "@/lib/reviews/manage";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { retryTriageRun } from "@/lib/triage/retry";
import { RETRYABLE_ATTEMPT_STATUSES } from "./actions";
import { loadRunDetail } from "./detail";
import { ralphDepsOf } from "./ralph-deps";

export const RUN_BUSY_MESSAGE = "Om is already working on this run.";
const NOT_FOUND = "That run doesn't exist.";

/**
 * Retries `run` for a user who is `organization.role` there; answers its detail afterwards
 * (a review's: the review run of the current head), with a `warning` when nothing new started.
 */
export async function retryRun(
  db: Database,
  run: RunIndexEntry,
  organization: ScopedOrganization,
  target: RunRetryTarget,
  retriedBy: string | undefined,
): Promise<RunRetryResult> {
  const detail = await loadRunDetail(db, run, organization);
  if (!detail) throw ApiRouteError.notFound(NOT_FOUND);
  if (detail.attempts.some((a) => a.status === "queued" || a.status === "running")) {
    throw new ApiRouteError(409, RUN_BUSY_MESSAGE, "run_busy");
  }
  let retried: RunIndexEntry;
  let warning: string | null = null;
  switch (run.kind) {
    case "epic":
    case "request":
      await retryRalph(db, run, resolveTarget(detail, target), retriedBy);
      retried = run;
      break;
    case "review":
      checkWholeRunTarget(detail, target);
      ({ entry: retried, warning } = await retryReview(db, run));
      break;
    case "triage":
      checkWholeRunTarget(detail, target);
      await retryTriage(db, run, detail, retriedBy);
      retried = run;
      break;
    case "ask":
      checkWholeRunTarget(detail, target);
      await retryAsk(db, run, detail);
      retried = run;
      break;
  }
  // The index entry carries the run's status: read it again.
  const current = (await getRunIndexEntry(db, retried.id)) ?? retried;
  const fresh =
    (await loadRunDetail(db, current, organization)) ??
    (current.id === run.id ? detail : notFound());
  return { ...fresh, warning };
}

const notFound = (): never => {
  throw ApiRouteError.notFound(NOT_FOUND);
};

async function retryRalph(
  db: Database,
  run: RunIndexEntry,
  ralphTarget: RalphRetryTarget,
  retriedBy: string | undefined,
): Promise<void> {
  const result = await retryRalphRun(
    await ralphDepsOf(db, run.organizationId),
    run.id,
    ralphTarget,
    retriedBy,
  );
  switch (result.status) {
    case "gone":
      throw ApiRouteError.notFound(NOT_FOUND);
    case "busy":
      throw new ApiRouteError(409, RUN_BUSY_MESSAGE, "run_busy");
    case "newer_run":
      throw new ApiRouteError(409, result.message, "newer_run");
    case "refused":
      throw new ApiRouteError(400, result.message, "not_retryable");
    case "failed":
      throw new ApiRouteError(502, result.message, "tracker_failed");
    case "retried":
      break;
  }
}

/**
 * Checks a target of a run retried as a whole (a review, triage or ask): the run itself, or
 * one of its attempts that can be retried. Such runs have no stories.
 */
function checkWholeRunTarget(detail: RunDetail, target: RunRetryTarget): void {
  const { retry } = detail.details.actions;
  switch (target.kind) {
    case "run":
      if (!retry.run)
        throw notRetryable(`This run is ${detail.status}, so there's nothing to retry.`);
      return;
    case "story":
      throw notRetryable("Only an epic's stories can be retried.");
    case "attempt": {
      if (!detail.attempts.some((a) => a.id === target.attemptId)) {
        throw ApiRouteError.notFound("That attempt doesn't exist.");
      }
      if (!retry.attemptIds.includes(target.attemptId)) throw attemptNotRetryable();
      return;
    }
  }
}

const attemptNotRetryable = () =>
  notRetryable(
    "Only the latest attempt of a step that failed, was canceled or expired can be retried.",
  );

/**
 * Re-runs a review run (all its passes and the correlation) on its PR's current head with the
 * run's mode and profile. Answers the new review run, or the one of that head already queued or
 * running with the warning that says so.
 */
async function retryReview(
  db: Database,
  run: RunIndexEntry,
): Promise<{ entry: RunIndexEntry; warning: string | null }> {
  const [reviewRun, passes] = await Promise.all([
    getReviewRun(db, run.id),
    listReviewRunReviews(db, run.id),
  ]);
  if (!reviewRun) throw ApiRouteError.notFound(NOT_FOUND);
  const pass = passes[0];
  if (!pass) throw notRetryable("This review has no passes to run again.");
  const result = await rerunOrganizationReview(db, getDispatcher(), run.organizationId, pass.id, {
    runMode: reviewRun.mode,
    depth: reviewRun.depth,
  });
  if (result.ok) {
    return { entry: (await getRunIndexEntry(db, result.reviewRunId)) ?? notFound(), warning: null };
  }
  if (result.activeReviewId) {
    // Legacy reviews' run IDs are their own.
    const active = await getRunIndexEntry(db, result.activeReviewRunId ?? result.activeReviewId);
    if (active) return { entry: active, warning: result.error };
    throw new ApiRouteError(409, result.error, "run_busy");
  }
  if (result.notFound) throw ApiRouteError.notFound(NOT_FOUND);
  throw notRetryable(result.error);
}

/** A new attempt of a triage run, repeating the reply of its last attempt. */
async function retryTriage(
  db: Database,
  run: RunIndexEntry,
  detail: RunDetail,
  retriedBy: string | undefined,
): Promise<void> {
  const last = detail.attempts.find((a) => a.type === TRIAGE_RUN_JOB_TYPE) ?? null;
  const result = await retryTriageRun(
    {
      db,
      organizationId: run.organizationId,
      linear: await getLinearGatewayOrDisconnected({ db, organizationId: run.organizationId }),
      dispatcher: getDispatcher(),
      adapterFor: scmAdapterFor,
    },
    run.id,
    last?.id ?? null,
    retriedBy,
  );
  switch (result.status) {
    case "queued":
      return;
    case "gone":
      throw ApiRouteError.notFound(NOT_FOUND);
    case "busy":
      throw new ApiRouteError(409, RUN_BUSY_MESSAGE, "run_busy");
    case "conflict":
      throw new ApiRouteError(
        409,
        "The work item is being triaged in another run right now.",
        "run_busy",
      );
    case "in_progress":
      throw notRetryable(
        `Triage only rewrites work items whose work hasn't started, and ${result.issues.join(", ")} ${result.issues.length === 1 ? "is" : "are"} already in progress or done.`,
      );
    case "query_disabled":
      throw notRetryable(
        `Query tasks are turned off for ${result.repository}, so triage can't run.`,
      );
    case "load_failed":
      throw new ApiRouteError(
        502,
        `Couldn't load the work item from Linear: ${result.error}`,
        "tracker_failed",
      );
    case "failed":
      throw new ApiRouteError(502, `Couldn't queue the triage: ${result.error}`, "retry_failed");
  }
}

/** A copy of an ask's last attempt, answered in the same thread. */
async function retryAsk(db: Database, run: RunIndexEntry, detail: RunDetail): Promise<void> {
  const last = detail.attempts.find((a) => a.type === CHAT_ASK_JOB_TYPE);
  if (!last) throw notRetryable("This question has no attempt to run again.");
  const result = await retryChatAsk(
    { db, dispatcher: getDispatcher() },
    { organizationId: run.organizationId, chatThreadRunId: run.id, jobId: last.id },
  );
  switch (result.status) {
    case "enqueued":
      return;
    case "not_found":
      throw notRetryable("This question has no attempt to run again.");
    case "duplicate":
      throw new ApiRouteError(409, RUN_BUSY_MESSAGE, "run_busy");
    case "unknown_repository":
      throw notRetryable("The repo this question was about is disconnected.");
    case "query_disabled":
      throw notRetryable(`Query tasks are turned off for ${result.repository.fullPath}.`);
  }
}

const notRetryable = (message: string) => new ApiRouteError(400, message, "not_retryable");

/** The `retryRalphRun` target for a request's target, or a 4xx when it can't be retried. */
function resolveTarget(detail: RunDetail, target: RunRetryTarget): RalphRetryTarget {
  const { retry } = detail.details.actions;
  switch (target.kind) {
    case "run": {
      if (!retry.run) {
        throw notRetryable(
          detail.kind === "epic" && detail.status === "completed"
            ? "This epic is finished: re-run one of its stories instead."
            : `This run is ${detail.status}, so there's nothing to retry.`,
        );
      }
      return { kind: "run", requestJobId: lastRequestAttemptId(detail) };
    }
    case "story": {
      const story = detail.steps.find((s) => s.kind === "story" && s.id === target.storyId);
      if (!story || story.kind !== "story") {
        throw ApiRouteError.notFound("That story doesn't exist.");
      }
      const lanes = detail.details.lanes;
      const lane = story.lane ? lanes.find((l) => l.id === story.lane!.id) : lanes[0];
      const pr = lane?.pullRequest;
      if (pr?.merged || pr?.closed) {
        throw notRetryable(
          `The ${changeRequestTerm(pr.provider)} for this story is already ${pr.merged ? "merged" : "closed"}.`,
        );
      }
      if (!retry.storyIds.includes(story.id)) {
        throw notRetryable(
          `${story.workItem.identifier} can't be retried while it's ${story.status} and the run is ${detail.status}.`,
        );
      }
      return { kind: "story", storyId: story.id };
    }
    case "attempt": {
      const attempt = detail.attempts.find((a) => a.id === target.attemptId);
      if (!attempt) throw ApiRouteError.notFound("That attempt doesn't exist.");
      if (!retry.attemptIds.includes(attempt.id)) throw attemptNotRetryable();
      // An epic's story attempt retries its story; any other attempt (the PR step…) the run.
      if (detail.kind === "epic") {
        const story = detail.steps.find((s) => s.kind === "story" && s.id === attempt.step);
        return story ? { kind: "story", storyId: story.id } : { kind: "run" };
      }
      return {
        kind: "run",
        requestJobId: attempt.type === RALPH_REQUEST_JOB_TYPE ? attempt.id : null,
      };
    }
  }
}

/** A request run's newest `ralph.request` attempt, when it failed, was canceled or expired. */
function lastRequestAttemptId(detail: RunDetail): string | null {
  if (detail.kind !== "request") return null;
  const last = detail.attempts.find((a) => a.type === RALPH_REQUEST_JOB_TYPE);
  return last && (RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(last.status)
    ? last.id
    : null;
}
