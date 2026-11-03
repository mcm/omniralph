/**
 * Pull-request runs: a documentation check's confirmed updates committed to a
 * person's PR/MR (Update mode, update targets `same-repo`), started by
 * `respondToDocumentationCheck`. The run works on the PR/MR's existing head
 * branch and is bound to the head the check reviewed (its
 * `documentation_requests` row):
 *
 * - Its request job runs only while the branch is still at that head
 *   (`pullRequestRunHead`, asked of the code host); the job's payload carries
 *   it (`expectedHeadSha`), so the agent also refuses a moved branch, and
 *   `ship` pushes one normal commit on top of it. History rewrites are off.
 * - PR/MR changes the session asks for are never made: the PR/MR is a person's.
 * - A run whose updates weren't committed (the branch moved, or the job
 *   failed or committed nothing) fails, without a retry
 *   (`pullRequestRunOutcome`), and the PR/MR's documentation comment says the
 *   updates weren't applied (`documentationRunNotApplied`).
 */
import {
  getDocumentationRequestByRun,
  getReview,
  type Job,
  type RalphLane,
  type RalphRun,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import type { RalphRequestResult } from "@omniralph/shared";
import { postStickyComment } from "@/lib/sinks/sticky-comment";
import type { RalphDeps } from "./run";

const NOT_APPLIED = "The documentation updates weren't applied: ";

/** A failed pull-request run's error, for why its updates weren't applied (`reason`). */
export function notAppliedError(reason: string): string {
  return `${NOT_APPLIED}${reason}.`;
}

/** Why a failed pull-request run's updates weren't applied, from its error. */
export function notAppliedReason(error: string | null): string {
  if (error?.startsWith(NOT_APPLIED)) return error.slice(NOT_APPLIED.length).replace(/\.$/, "");
  return "Om's coding run failed";
}

/** Why the updates weren't applied when the branch moved (the comment's words). */
export function branchMovedReason(branch: string, headSha: string): string {
  return `the branch \`${branch}\` moved since the checked commit \`${headSha.slice(0, 12)}\``;
}

/**
 * The head a pull-request run's request job must start from (its
 * documentation request's), or why it can't run: the request is gone, or
 * the branch on the code host is no longer at that head.
 */
export async function pullRequestRunHead(
  deps: Pick<RalphDeps, "db" | "adapterFor">,
  run: Pick<RalphRun, "id">,
  found: { lane: RalphLane; repository: Repository; connection: ScmConnection },
): Promise<{ headSha: string } | { failed: string }> {
  const request = await getDocumentationRequestByRun(deps.db, run.id);
  if (!request) return { failed: "its documentation request is gone" };
  const { repository, connection, lane } = found;
  const head = await deps
    .adapterFor(deps.db, connection)
    .getBranchHead(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      lane.branch,
    );
  if (head !== request.headSha) return { failed: branchMovedReason(lane.branch, request.headSha) };
  return { headSha: request.headSha };
}

/**
 * Whether a pull-request run's finished request job applied the updates
 * (it pushed a commit), else why not: the branch moved (asked of the code
 * host), the job failed, or it committed nothing.
 */
export async function pullRequestRunOutcome(
  deps: Pick<RalphDeps, "db" | "adapterFor">,
  input: {
    job: Pick<Job, "status">;
    result: RalphRequestResult | null;
    lane: RalphLane | undefined;
    found: { repository: Repository; connection: ScmConnection } | null;
    expectedHeadSha: string | undefined;
  },
): Promise<{ applied: true } | { applied: false; reason: string }> {
  const { result, lane, found, expectedHeadSha } = input;
  if (result?.pushed === true) return { applied: true };
  if (lane && found && expectedHeadSha) {
    const head = await deps
      .adapterFor(deps.db, found.connection)
      .getBranchHead(
        { fullPath: found.repository.fullPath, externalId: found.repository.externalId },
        lane.branch,
      )
      .catch(() => expectedHeadSha);
    if (head !== expectedHeadSha) {
      return { applied: false, reason: branchMovedReason(lane.branch, expectedHeadSha) };
    }
  }
  if (!result || result.error) return { applied: false, reason: "Om's coding run failed" };
  return { applied: false, reason: "Om's coding run didn't commit any of them" };
}

/**
 * Says on the PR/MR's documentation comment that a pull-request run's
 * updates weren't applied (`reason`), unless a newer check of the PR/MR
 * already replaced the comment. Failures are logged.
 */
export async function documentationRunNotApplied(
  deps: Pick<RalphDeps, "db">,
  run: Pick<RalphRun, "id" | "organizationId">,
  reason: string,
): Promise<void> {
  try {
    const request = await getDocumentationRequestByRun(deps.db, run.id);
    const review = request?.reviewId ? await getReview(deps.db, request.reviewId) : null;
    if (!request || !review) return;
    await postStickyComment(
      deps.db,
      { taskId: review.taskId, organizationId: run.organizationId },
      review.id,
      { handoff: { status: "not_applied", paths: request.paths, reason }, later: true },
    );
  } catch (error) {
    console.error(
      `Saying ralph run ${run.id}'s documentation updates weren't applied failed`,
      error,
    );
  }
}
