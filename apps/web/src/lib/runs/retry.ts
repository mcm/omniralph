import "server-only";
/**
 * `POST /api/ui/runs/{id}/retry`: checks the target against the run's detail (the same
 * `runActions` the detail shows) and retries an epic or request run, or one of an epic's
 * stories (`retryRalphRun`).
 */
import { getRunIndexEntry, type Database, type RunIndexEntry } from "@omniralph/db";
import { RALPH_REQUEST_JOB_TYPE } from "@omniralph/shared";
import { ApiRouteError } from "@/lib/api/handler";
import type { RunDetail, RunRetryTarget } from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { changeRequestTerm } from "@/lib/ralph/publish";
import { retryRalphRun, type RalphRetryTarget } from "@/lib/ralph/retry";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { RETRYABLE_ATTEMPT_STATUSES } from "./actions";
import { loadRunDetail } from "./detail";

export const RUN_BUSY_MESSAGE = "Om is already working on this run.";
const NOT_FOUND = "That run doesn't exist.";

/** Retries `run` for a user who is `organization.role` there; answers its detail afterwards. */
export async function retryRun(
  db: Database,
  run: RunIndexEntry,
  organization: ScopedOrganization,
  target: RunRetryTarget,
  retriedBy: string | undefined,
): Promise<RunDetail> {
  if (run.kind !== "epic" && run.kind !== "request") {
    throw new ApiRouteError(400, "Only epic and request runs can be retried.", "not_retryable");
  }
  const detail = await loadRunDetail(db, run, organization);
  if (!detail) throw ApiRouteError.notFound(NOT_FOUND);
  if (detail.attempts.some((a) => a.status === "queued" || a.status === "running")) {
    throw new ApiRouteError(409, RUN_BUSY_MESSAGE, "run_busy");
  }
  const ralphTarget = resolveTarget(detail, target);
  const result = await retryRalphRun(
    {
      db,
      organizationId: run.organizationId,
      linear: await getLinearGatewayOrDisconnected({ db, organizationId: run.organizationId }),
      dispatcher: getDispatcher(),
      adapterFor: scmAdapterFor,
    },
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
  // The index entry carries the run's status: read it again.
  const current = (await getRunIndexEntry(db, run.id)) ?? run;
  return (await loadRunDetail(db, current, organization)) ?? detail;
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
      if (!retry.attemptIds.includes(attempt.id)) {
        throw notRetryable(
          "Only the latest attempt of a step that failed, was canceled or expired can be retried.",
        );
      }
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
