import "server-only";
import {
  CANCELED_REVIEW_ERROR,
  finishReview,
  getJob,
  getReview,
  getReviewRun,
  insertJob,
  listRunIterations,
  pinnedAgentFor,
  recordReviewPasses,
  saveReviewOutcome,
  type Database,
  type Job,
  type LoopRunRef,
  type NewJobInput,
  type Review,
  type RunIteration,
} from "@omniralph/db";
import {
  documentationLoopLimits,
  FINDING_VERIFICATION_JOB_TYPE,
  findingVerificationContext,
  MAX_REVIEW_SUMMARY_LENGTH,
  QueryRunResult,
  REVIEW_DEPTHS,
  ReviewTaskResult,
  reviewPassLimits,
  reviewTriggerContext,
  RunSpecJobPayload,
  type DocumentationDepth,
  type ReviewCheckType,
  type ReviewDepth,
  type ReviewPassContext,
} from "@omniralph/shared";
import type { Playbook } from "@omniralph/tasks";
import type { JobDispatcher } from "@/lib/dispatch";
import { syncJobsDueFromPostgres } from "@/lib/dispatch/due";
import { getPlaybookTask, organizationPlaybooks, taskJobInput } from "@/lib/playbooks";
import {
  registerLoopAdapter,
  startLoop,
  type LoopAdapter,
  type LoopExecutor,
  type LoopVerdict,
} from "@/lib/runs/loop";
import {
  DEFAULT_DOCUMENTATION_VERIFIER_ID,
  documentationOfJob,
  finishDocumentation,
  judgeDocumentation,
  startDocumentationVerifier,
  startDocumentationWorker,
} from "./docs-loop";
import { reviewPassJobKey, reviewVerifierJobKey } from "./job-review";
import { onDocumentationCheckForRalph } from "@/lib/ralph/jobs";
import { postStickyComment } from "@/lib/sinks/sticky-comment";
import { fixedFindingIds, settleReviewRunOf } from "./jobs";
import {
  nextPassContext,
  passConverged,
  passFindings,
  settlePasses,
  unreachedText,
  type PassInput,
  type SettledPass,
} from "./passes";
import { verifierRunOf } from "./verifier-run";

export { verifierRunOf };

/**
 * Looped reviews (ADR 0013): a review task whose playbook names a finding
 * verifier (`loop.verifierPlaybookId`, `builtin:verify-findings` for
 * `builtin:review-pr`) runs as one `reviews` row per check type, each a loop
 * of the run loop driver (`run_iterations.run_kind` `review`, `run_id` the
 * review). Each iteration is a pass:
 *
 * 1. The worker is a `review.task` job of the review task whose trigger
 *    context carries the pass (`ReviewTriggerContext.pass`): the agent plans
 *    the change's check types (`planChecks`) and reviews this check type's
 *    files with its rubric sections. Its result is kept on the job; the
 *    `review` sink doesn't save it.
 * 2. The verifier is a `run.invoked` query job of the loop's verifier
 *    playbook with the pass's findings (`findingVerificationContext`), its
 *    answer read by `judge` instead of its `run-result` sink. A pass that
 *    reported nothing, or a depth that doesn't verify, needs no verifier.
 * 3. The pass's confirmed findings that no earlier pass confirmed are new:
 *    the check type stops once a pass adds none and it ran its minimum
 *    passes (security at Deep runs two), or at its depth's pass cap (the
 *    loop's `maxIterations`). Otherwise the next pass reviews the areas the
 *    verifier said weren't reached, told what was confirmed so far.
 *
 * When the loop ends, `finish` saves the review with every confirmed finding
 * (rejected and unanswered ones are dropped and counted on the review, never
 * posted), and once that committed the review run settles as before: the
 * findings of all check types are merged by the run's correlation and posted
 * as one review.
 *
 * A documentation check (`builtin:check-docs`, its jobs' trigger context has
 * a `documentation`) is one review whose loop runs on the same adapter: its
 * iterations verify `documentationUpdates` instead of findings
 * (`./docs-loop.ts`), capped by the documentation depth.
 */

/** The verifier of a looped review playbook that names none. */
export const DEFAULT_REVIEW_VERIFIER_ID = "builtin:verify-findings";

/** The loop run of a looped review (one check type of a review task). */
export function reviewLoopRun(review: Pick<Review, "id">, organizationId: string): LoopRunRef {
  return { kind: "review", id: review.id, organizationId };
}

/** The first pass of a check type: nothing confirmed or unreached yet. */
export function firstPass(checkType: ReviewCheckType): ReviewPassContext {
  return { checkType, number: 1, confirmed: [], unreached: [] };
}

/**
 * Starts the loop of review `review` (one check type of a looped review
 * task): its first iteration, whose worker is `jobInput` (a `review.task`
 * job of the first pass), inserted in the loop's transaction so the job is
 * never claimed before its iteration exists. The pass cap is the depth's
 * `maxPasses`. A job of the same dedupe key that is already active comes
 * back with `created: false`, and nothing is started. The job is then made
 * claimable and its agents woken.
 */
export async function startReviewLoop(
  db: Database,
  dispatcher: JobDispatcher,
  review: Pick<Review, "id">,
  playbook: Pick<Playbook, "role" | "loop">,
  depth: ReviewDepth,
  jobInput: NewJobInput,
): Promise<{ job: Job; created: boolean }> {
  return startLoopOfReview(db, dispatcher, review, playbook, jobInput, {
    defaultVerifierId: DEFAULT_REVIEW_VERIFIER_ID,
    maxIterations: REVIEW_DEPTHS[depth].maxPasses,
  });
}

/**
 * Starts the loop of documentation check review `review` (a run of a
 * `docs-check` playbook, e.g. `builtin:check-docs`): its first iteration,
 * whose worker is `jobInput` (a `review.task` job whose trigger context has
 * the depth's `documentation`). The iteration cap is the documentation
 * depth's (`documentationLoopLimits`); the verifier is the playbook's
 * (`builtin:verify-docs` when it names none). As `startReviewLoop` otherwise.
 */
export async function startDocumentationCheckLoop(
  db: Database,
  dispatcher: JobDispatcher,
  review: Pick<Review, "id">,
  playbook: Pick<Playbook, "role" | "loop">,
  depth: DocumentationDepth,
  jobInput: NewJobInput,
): Promise<{ job: Job; created: boolean }> {
  return startLoopOfReview(db, dispatcher, review, playbook, jobInput, {
    defaultVerifierId: DEFAULT_DOCUMENTATION_VERIFIER_ID,
    ...documentationLoopLimits(depth),
  });
}

async function startLoopOfReview(
  db: Database,
  dispatcher: JobDispatcher,
  review: Pick<Review, "id">,
  playbook: Pick<Playbook, "role" | "loop">,
  jobInput: NewJobInput,
  options: { defaultVerifierId: string; maxIterations: number },
): Promise<{ job: Job; created: boolean }> {
  let dispatched: { job: Job; created: boolean } | undefined;
  try {
    await startLoop(
      db,
      reviewLoopRun(review, jobInput.organizationId),
      {
        ...playbook,
        loop: {
          ...playbook.loop,
          verifierPlaybookId: playbook.loop?.verifierPlaybookId ?? options.defaultVerifierId,
        },
      },
      {
        limits: { maxIterations: options.maxIterations },
        startWorker: async (tx) => {
          const target = jobInput.repositoryId
            ? await pinnedAgentFor(asDb(tx), jobInput.organizationId, jobInput.repositoryId)
            : null;
          dispatched = await insertJob(asDb(tx), { ...jobInput, targetAgentId: target });
          // An active job of the same pass: roll the iteration back.
          if (!dispatched.created) throw new DuplicatePass();
          return dispatched.job.id;
        },
      },
    );
  } catch (error) {
    if (!(error instanceof DuplicatePass)) throw error;
  }
  if (!dispatched) throw new Error(`The loop of review ${review.id} started no job`);
  if (dispatched.created) await dispatcher.republish(dispatched.job.id);
  return dispatched;
}

class DuplicatePass extends Error {
  constructor() {
    super("An active job of the same review pass exists");
  }
}

/** The pool or a transaction as the `@omniralph/db` queries take it. */
function asDb(db: LoopExecutor): Database {
  return db as Database;
}

/** One pass as its jobs left it, with what its jobs spent. */
interface LoadedPass extends PassInput {
  worker: Job;
  verifierJob: Job | null;
}

/**
 * The passes of `iterations` whose worker completed with a review result,
 * in order, up to the first one that didn't.
 */
async function loadPasses(
  db: LoopExecutor,
  iterations: readonly RunIteration[],
): Promise<LoadedPass[]> {
  const passes: LoadedPass[] = [];
  for (const iteration of iterations) {
    const worker = iteration.workerJobId ? await getJob(asDb(db), iteration.workerJobId) : null;
    const result =
      worker?.status === "completed" ? ReviewTaskResult.safeParse(worker.result) : null;
    if (!worker || !result?.success) break;
    const verifierJob = iteration.verifierJobId
      ? await getJob(asDb(db), iteration.verifierJobId)
      : null;
    passes.push({
      number: iteration.number,
      result: result.data,
      verifier: verifierJob ? verifierRunOf(verifierJob) : null,
      worker,
      verifierJob,
    });
  }
  return passes;
}

/** Whether the pass's check type has no file in the change (nothing was reviewed). */
function reviewedNothing(result: ReviewTaskResult): boolean {
  return result.pass !== undefined && result.pass.files.length === 0;
}

/**
 * Settles `current` after the review's earlier passes: records every pass
 * on the review, and returns the iteration's verdict: converged when the
 * pass added no newly confirmed finding and ran the check type's minimum
 * (or reviewed nothing), with the areas it didn't reach for the next pass.
 */
async function settleIteration(
  db: LoopExecutor,
  run: LoopRunRef,
  iteration: RunIteration,
  current: PassInput,
): Promise<LoopVerdict> {
  const review = await getReview(asDb(db), run.id);
  const earlier = await loadPasses(
    db,
    (await listRunIterations(db, run)).filter((it) => it.number < iteration.number),
  );
  const settled = settlePasses([...earlier, current], { warn: logWarning(run) });
  if (review) {
    await recordReviewPasses(asDb(db), review.id, {
      records: settled.passes.map((pass) => pass.record),
      droppedFindings: settled.dropped,
    });
  }
  const pass = settled.passes.at(-1)!;
  const limits = reviewPassLimits(review?.depth ?? "standard", review?.checkType ?? "");
  return {
    converged: reviewedNothing(current.result) || passConverged(pass, limits),
    summary: passSummary(pass, reviewedNothing(current.result)),
    findings: pass.unreached.map(unreachedText),
  };
}

function logWarning(run: LoopRunRef) {
  return (message: string, details: Record<string, unknown>) =>
    console.warn(message, { reviewId: run.id, ...details });
}

/** What a pass did, as the iteration's summary. */
function passSummary(pass: SettledPass, reviewedNothing: boolean): string {
  if (reviewedNothing)
    return "The change has no file for this check type, so nothing was reviewed.";
  const { record } = pass;
  const counts = `Pass ${record.number} reported ${record.reported} ${record.reported === 1 ? "finding" : "findings"}: ${record.confirmed} confirmed (${record.new} new), ${record.dropped} dropped by verification.`;
  const note =
    record.verification === "unverified"
      ? " The verifier didn't check them, so they are kept unverified."
      : "";
  return [`${counts}${note}`, record.summary].filter(Boolean).join("\n\n");
}

const reviewLoopAdapter: LoopAdapter = {
  /** A pass after the first: the first pass's job again, with what earlier passes left. */
  async startWorker(db, run, iteration) {
    const iterations = await listRunIterations(db, run);
    const firstJobId = iterations[0]?.workerJobId;
    const first = firstJobId ? await getJob(asDb(db), firstJobId) : null;
    if (!first) throw new Error(`Review ${run.id} has no first pass job`);
    if (documentationOfJob(first)) return startDocumentationWorker(db, run, iteration, first);
    const payload = RunSpecJobPayload.parse(first.payload);
    const context = reviewTriggerContext(first.payload);
    if (!context.pass) throw new Error(`Review ${run.id}'s first job isn't a looped pass`);
    const settled = settlePasses(
      await loadPasses(
        db,
        iterations.filter((it) => it.number < iteration.number),
      ),
    );
    const pass = { ...nextPassContext(context.pass.checkType, settled), number: iteration.number };
    const { job } = await insertJob(asDb(db), {
      organizationId: first.organizationId,
      type: first.type,
      taskType: first.taskType,
      taskId: first.taskId,
      minAgentVersion: first.minAgentVersion,
      requiredInstallables: first.requiredInstallables,
      requiredHostTools: first.requiredHostTools,
      payload: { ...payload, trigger: { ...payload.trigger, context: { ...context, pass } } },
      repositoryId: first.repositoryId,
      reviewRunId: first.reviewRunId,
      dedupeKey: reviewPassJobKey(
        context.repositoryId,
        context.prNumber,
        context.headSha,
        first.taskId ?? "review",
        pass.checkType,
        pass.number,
      ),
      targetAgentId: first.repositoryId
        ? await pinnedAgentFor(asDb(db), first.organizationId, first.repositoryId)
        : null,
    });
    return job.id;
  },

  /**
   * The pass's verifier: a run of the loop's verifier playbook with the
   * pass's findings, in a checkout of the head. A pass that reported nothing,
   * reviewed nothing, or whose depth doesn't verify settles at once.
   */
  async startVerifier(db, run, iteration, worker) {
    if (documentationOfJob(worker)) {
      return startDocumentationVerifier(db, run, iteration, worker);
    }
    const result = ReviewTaskResult.safeParse(worker.result);
    if (!result.success) {
      return {
        verdict: {
          converged: true,
          summary: "The pass's result couldn't be read, so the check type stops.",
          findings: [],
        },
      };
    }
    const current: PassInput = { number: iteration.number, result: result.data, verifier: null };
    const review = await getReview(asDb(db), run.id);
    const verifies = REVIEW_DEPTHS[review?.depth ?? "standard"].verifyFindings;
    if (!review || result.data.findings.length === 0 || !verifies) {
      return { verdict: await settleIteration(db, run, iteration, current) };
    }
    const definitions = organizationPlaybooks(asDb(db), run.organizationId);
    const task = await getPlaybookTask(definitions, iteration.verifierPlaybookId);
    if (!task || task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
      // Not a verifier that can run: the pass's findings are kept unverified.
      return {
        verdict: await settleIteration(db, run, iteration, {
          ...current,
          verifier: {
            status: "failed",
            error: `${iteration.verifierPlaybookId} is not a finding verifier`,
            rateLimited: false,
          },
        }),
      };
    }
    const context = reviewTriggerContext(worker.payload);
    const verification = findingVerificationContext({
      reviewRunId: review.reviewRunId ?? review.id,
      repository: context.repository,
      prNumber: context.prNumber,
      checkType: context.pass?.checkType ?? review.checkType ?? "review",
      pass: iteration.number,
      baseSha: context.baseSha,
      headSha: context.headSha,
      files: result.data.pass?.files ?? [],
      findings: passFindings(current).map((finding) => ({
        ...finding,
        suggestion: finding.suggestion ?? null,
      })),
    });
    const { job } = await insertJob(asDb(db), {
      organizationId: run.organizationId,
      type: FINDING_VERIFICATION_JOB_TYPE,
      ...(await taskJobInput(definitions, task, {
        trigger: { kind: "run.invoked", context: verification },
        repositoryId: context.repositoryId,
        ref: context.headSha,
      })),
      reviewRunId: review.reviewRunId,
      dedupeKey: reviewVerifierJobKey(
        context.repositoryId,
        context.prNumber,
        context.headSha,
        review.id,
        iteration.number,
      ),
      targetAgentId: await pinnedAgentFor(asDb(db), run.organizationId, context.repositoryId),
    });
    return job.id;
  },

  /** The pass's verdict from its verifier's answer (a failed answer keeps the findings unverified). */
  async judge(db, run, iteration, verifier) {
    const worker = iteration.workerJobId ? await getJob(asDb(db), iteration.workerJobId) : null;
    if (documentationOfJob(worker)) return judgeDocumentation(db, run, iteration, verifier);
    const result = ReviewTaskResult.safeParse(worker?.result);
    if (!result.success) return null;
    return settleIteration(db, run, iteration, {
      number: iteration.number,
      result: result.data,
      verifier: verifierRunOf(verifier),
    });
  },

  /**
   * Saves the review with every pass's confirmed findings, or ends it: a
   * first pass that failed fails it (a canceled one skips it), a check type
   * with no file in the change skips it, and a review whose run was
   * superseded meanwhile is skipped with the run's reason.
   */
  async finish(db, run, end) {
    const firstWorkerJobId = end.iterations[0]?.workerJobId;
    const firstWorker = firstWorkerJobId ? await getJob(asDb(db), firstWorkerJobId) : null;
    if (documentationOfJob(firstWorker)) return finishDocumentation(db, run, end.iterations);
    const review = await getReview(asDb(db), run.id);
    if (!review || (review.status !== "queued" && review.status !== "running")) return;
    const reviewRun = review.reviewRunId ? await getReviewRun(asDb(db), review.reviewRunId) : null;
    if (reviewRun && reviewRun.status !== "queued" && reviewRun.status !== "running") {
      await finishReview(asDb(db), review.id, {
        status: "skipped",
        error: reviewRun.error ?? CANCELED_REVIEW_ERROR,
      });
      return;
    }
    const passes = await loadPasses(db, end.iterations);
    const [first] = passes;
    if (!first) {
      const firstWorkerId = end.iterations[0]?.workerJobId;
      const worker = firstWorkerId ? await getJob(asDb(db), firstWorkerId) : null;
      await finishReview(
        asDb(db),
        review.id,
        worker?.status === "canceled" || worker?.status === "skipped"
          ? { status: "skipped", error: CANCELED_REVIEW_ERROR }
          : {
              status: "failed",
              error: worker?.error ?? end.iterations[0]?.error ?? "The review pass failed",
            },
      );
      return;
    }
    if (reviewedNothing(first.result)) {
      await finishReview(asDb(db), review.id, {
        status: "skipped",
        error: `The change has no file for the ${review.checkType ?? "check"} check type.`,
      });
      return;
    }
    const settled = settlePasses(passes, { warn: logWarning(run) });
    const verifierUsage = passes.map((pass) => {
      const answer = QueryRunResult.safeParse(pass.verifierJob?.result);
      return answer.success
        ? { ...answer.data.usage, durationMs: answer.data.durationMs }
        : { inputTokens: 0, outputTokens: 0, durationMs: 0 };
    });
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    await saveReviewOutcome(asDb(db), review.id, {
      status: first.result.stopReason === "budget_exhausted" ? "budget_exhausted" : "completed",
      tokensIn: sum([
        ...passes.map((pass) => pass.result.usage.inputTokens),
        ...verifierUsage.map((usage) => usage.inputTokens),
      ]),
      tokensOut: sum([
        ...passes.map((pass) => pass.result.usage.outputTokens),
        ...verifierUsage.map((usage) => usage.outputTokens),
      ]),
      durationMs: sum([
        ...passes.map((pass) => pass.result.durationMs),
        ...verifierUsage.map((usage) => usage.durationMs),
      ]),
      skippedFiles: first.result.skipped,
      summary: passesSummary(passes.map((pass) => pass.result.summary)),
      scope: first.result.scope,
      // The first pass re-checked the earlier open findings over the check type's files.
      fixedFindingIds: fixedFindingIds(reviewTriggerContext(first.worker.payload), first.result),
      passes: {
        records: settled.passes.map((pass) => pass.record),
        droppedFindings: settled.dropped,
      },
      findings: settled.findings.map((finding) => ({
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
        body: finding.body,
        suggestion: finding.suggestion ?? null,
        confidence: finding.confidence,
      })),
    });
  },

  /**
   * Makes the loop's new jobs claimable, and settles the review run once
   * the review ended (its correlation, then one posted review). A
   * documentation check that ended first hands its confirmed updates to the
   * PR/MR's coding run in Update mode (`onDocumentationCheckForRalph`), then
   * is posted as its sticky comment (`postStickyComment`), which says what
   * was handed off; a failure to post is logged, not retried.
   */
  async afterCommit(db, run) {
    const last = (await listRunIterations(db, run)).at(-1);
    await syncJobsDueFromPostgres(
      db,
      [last?.workerJobId, last?.verifierJobId].filter((id): id is string => Boolean(id)),
    );
    const review = await getReview(db, run.id);
    if (!review || review.status === "queued" || review.status === "running") return;
    await settleReviewRunOf(db, review.id);
    if (review.documentationUpdates === null) return;
    // Update mode on a ralph PR/MR: the confirmed updates go to its run first, so the comment can say so.
    const handoff = await onDocumentationCheckForRalph(db, review.id);
    try {
      await postStickyComment(
        db,
        { taskId: review.taskId, organizationId: run.organizationId },
        review.id,
        { handoff },
      );
    } catch (error) {
      console.error("failed to post the documentation check's comment", {
        reviewId: review.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

/** The passes' summaries as the review's (capped); null without any. */
function passesSummary(summaries: readonly (string | undefined)[]): string | null {
  const summary = summaries
    .map((s) => s?.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!summary) return null;
  return summary.length <= MAX_REVIEW_SUMMARY_LENGTH
    ? summary
    : summary.slice(0, MAX_REVIEW_SUMMARY_LENGTH);
}

registerLoopAdapter("review", reviewLoopAdapter);
