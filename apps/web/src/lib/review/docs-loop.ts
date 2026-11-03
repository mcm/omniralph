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
  reviewRunSuperseded,
  saveReviewOutcome,
  type Database,
  type Job,
  type LoopRunRef,
  type RunIteration,
} from "@omniralph/db";
import {
  applyDocumentationVerification,
  DOCUMENTATION_VERIFICATION_JOB_TYPE,
  documentationCheckContext,
  documentationLoopVerdict,
  documentationUpdatesByFile,
  documentationVerificationContext,
  mergeDocumentationUpdates,
  MAX_REVIEW_SUMMARY_LENGTH,
  QueryRunResult,
  ReviewTaskResult,
  ReviewTriggerContext,
  RunSpecJobPayload,
  type DocumentationCheckContext,
  type DocumentationUpdate,
  type DocumentationVerification,
  type DroppedDocumentationUpdate,
  type VerifierRun,
} from "@omniralph/shared";
import { getPlaybookTask, organizationPlaybooks, taskJobInput } from "@/lib/playbooks";
import type { LoopExecutor, LoopVerdict } from "@/lib/runs/loop";
import { reviewPassJobKey, reviewVerifierJobKey } from "./job-review";
import { verifierRunOf } from "./verifier-run";

/**
 * The loop of a documentation check (`builtin:check-docs`, role `docs-check`):
 * one `reviews` row whose loop (run kind `review`, like a looped review's
 * check type) runs, per iteration:
 *
 * 1. a worker, a `review.task` job of the check whose trigger context
 *    carries `documentation` (its depth and scope, and from the second
 *    iteration on what earlier iterations confirmed and dropped), which
 *    reports `documentationUpdates`;
 * 2. a verifier, a `run.invoked` query job of the loop's verifier playbook
 *    (`builtin:verify-docs`) with the iteration's updates
 *    (`documentationVerificationContext`), which re-reads each file against
 *    the diff and confirms or rejects each update. An iteration that
 *    reported no update needs no verifier.
 *
 * The check stops once an iteration confirms no file that earlier ones
 * hadn't, its verifier couldn't verify, or at the documentation depth's
 * iteration cap (`documentationLoopLimits`, the loop's `maxIterations`).
 * When it ends, the review is saved with every confirmed update, one per
 * file, and no findings. The review loop adapter (`./loop.ts`) hands a
 * documentation check's loop to these functions.
 */

/** The verifier of a documentation check playbook that names none. */
export const DEFAULT_DOCUMENTATION_VERIFIER_ID = "builtin:verify-docs";

/** The check-type segment of a documentation check's job dedupe keys. */
const DOCUMENTATION_KEY = "docs";

/** The `documentation` of a review job's trigger context; null for any other review job. */
export function documentationOfJob(
  job: Pick<Job, "payload"> | null | undefined,
): DocumentationCheckContext | null {
  const payload = RunSpecJobPayload.safeParse(job?.payload);
  if (!payload.success) return null;
  const context = ReviewTriggerContext.safeParse(payload.data.trigger.context);
  return (context.success && context.data.documentation) || null;
}

/** An update of an iteration with the ID its verdict names. */
type IdentifiedUpdate = DocumentationUpdate & { id: string };

/** One iteration as its jobs left it. */
interface LoadedIteration {
  number: number;
  worker: Job;
  result: ReviewTaskResult;
  updates: IdentifiedUpdate[];
  verifierJob: Job | null;
  /** How its verifier ended; null when it had none (it reported nothing) or it runs. */
  verifier: VerifierRun | null;
}

/** The updates of a worker's result, one per file, each with an ID (`u1`, `u2`, …). */
function identifiedUpdates(result: ReviewTaskResult): IdentifiedUpdate[] {
  return documentationUpdatesByFile(result.documentationUpdates ?? []).map((update, index) => ({
    ...update,
    id: `u${index + 1}`,
  }));
}

/**
 * The iterations of `iterations` whose worker completed with a review
 * result, in order, up to the first one that didn't.
 */
async function loadIterations(
  db: LoopExecutor,
  iterations: readonly RunIteration[],
): Promise<LoadedIteration[]> {
  const loaded: LoadedIteration[] = [];
  for (const iteration of iterations) {
    const worker = iteration.workerJobId ? await getJob(asDb(db), iteration.workerJobId) : null;
    const result =
      worker?.status === "completed" ? ReviewTaskResult.safeParse(worker.result) : null;
    if (!worker || !result?.success) break;
    const verifierJob = iteration.verifierJobId
      ? await getJob(asDb(db), iteration.verifierJobId)
      : null;
    loaded.push({
      number: iteration.number,
      worker,
      result: result.data,
      updates: identifiedUpdates(result.data),
      verifierJob,
      verifier: verifierJob ? verifierRunOf(verifierJob) : null,
    });
  }
  return loaded;
}

/** What a check's iterations settled: every confirmed update (one per file) and every dropped one. */
export interface SettledDocumentation {
  confirmed: DocumentationUpdate[];
  dropped: DroppedDocumentationUpdate[];
  /** The last iteration's verification; null when it had nothing to verify. */
  last: Exclude<DocumentationVerification, { status: "retry" }> | null;
}

/**
 * Settles `iterations` in order: each one's verifier answer keeps the
 * updates it confirmed (`applyDocumentationVerification`) after what the
 * earlier ones confirmed. An iteration without a verifier answer keeps
 * nothing (a failed or unanswered verifier drops nothing either).
 */
export function settleDocumentation(
  iterations: readonly Pick<LoadedIteration, "updates" | "verifier">[],
): SettledDocumentation {
  let confirmed: DocumentationUpdate[] = [];
  const dropped: DroppedDocumentationUpdate[] = [];
  let last: SettledDocumentation["last"] = null;
  for (const iteration of iterations) {
    if (!iteration.verifier) {
      last = null;
      continue;
    }
    const verification = applyDocumentationVerification(
      iteration.updates,
      confirmed,
      iteration.verifier,
    );
    // A verifier the job queue retries finished only once its job did; here it didn't answer.
    last =
      verification.status === "retry"
        ? { status: "unverified", warning: "The documentation verifier hit a rate limit." }
        : verification;
    if (last.status !== "verified") continue;
    confirmed = mergeDocumentationUpdates(confirmed, last.confirmed);
    dropped.push(...last.dropped);
  }
  return { confirmed, dropped, last };
}

/** The verdict of an iteration that reported no update: nothing new, so the check stops. */
const NOTHING_REPORTED: LoopVerdict = {
  converged: true,
  summary: "No documentation update was reported.",
  findings: [],
};

/**
 * The worker of iteration `iteration` (the second or later) of a
 * documentation check: the first iteration's job again, told what earlier
 * iterations confirmed and dropped.
 */
export async function startDocumentationWorker(
  db: LoopExecutor,
  run: LoopRunRef,
  iteration: RunIteration,
  first: Job,
): Promise<string> {
  const payload = RunSpecJobPayload.parse(first.payload);
  const context = ReviewTriggerContext.parse(payload.trigger.context);
  if (!context.documentation) throw new Error(`Review ${run.id}'s first job isn't a docs check`);
  const iterations = await listRunIterations(db, run);
  const settled = settleDocumentation(
    await loadIterations(
      db,
      iterations.filter((it) => it.number < iteration.number),
    ),
  );
  const documentation = documentationCheckContext(context.documentation.depth, {
    iteration: iteration.number,
    confirmed: settled.confirmed,
    dropped: settled.dropped,
  });
  const { job } = await insertJob(asDb(db), {
    organizationId: first.organizationId,
    type: first.type,
    taskType: first.taskType,
    taskId: first.taskId,
    minAgentVersion: first.minAgentVersion,
    requiredInstallables: first.requiredInstallables,
    requiredHostTools: first.requiredHostTools,
    payload: {
      ...payload,
      trigger: { ...payload.trigger, context: { ...context, documentation } },
    },
    repositoryId: first.repositoryId,
    reviewRunId: first.reviewRunId,
    dedupeKey: documentationIterationJobKey(context, first.taskId, iteration.number),
    targetAgentId: first.repositoryId
      ? await pinnedAgentFor(asDb(db), first.organizationId, first.repositoryId)
      : null,
  });
  return job.id;
}

/**
 * Dedupe key of iteration `iteration` of a documentation check of a PR head
 * (a review pass key, so a newer push supersedes it with the head's other
 * review jobs).
 */
export function documentationIterationJobKey(
  context: Pick<ReviewTriggerContext, "repositoryId" | "prNumber" | "headSha">,
  taskId: string | null,
  iteration: number,
): string {
  return reviewPassJobKey(
    context.repositoryId,
    context.prNumber,
    context.headSha,
    taskId ?? "docs-check",
    DOCUMENTATION_KEY,
    iteration,
  );
}

/**
 * The verifier of an iteration of a documentation check: a run of the loop's
 * verifier playbook with the iteration's updates, in a checkout of the head.
 * An iteration that reported none settles at once (converged), as does one
 * whose verifier can't run (nothing of it is confirmed).
 */
export async function startDocumentationVerifier(
  db: LoopExecutor,
  run: LoopRunRef,
  iteration: RunIteration,
  worker: Job,
): Promise<string | { verdict: LoopVerdict }> {
  const result = ReviewTaskResult.safeParse(worker.result);
  if (!result.success) {
    return {
      verdict: {
        converged: true,
        summary: "The documentation check's result couldn't be read, so it stops.",
        findings: [],
      },
    };
  }
  const updates = identifiedUpdates(result.data);
  const review = await getReview(asDb(db), run.id);
  if (!review || updates.length === 0) return { verdict: NOTHING_REPORTED };
  const context = ReviewTriggerContext.parse(
    RunSpecJobPayload.parse(worker.payload).trigger.context,
  );
  if (!context.documentation) throw new Error(`Review ${run.id}'s job isn't a docs check`);
  const definitions = organizationPlaybooks(asDb(db), run.organizationId);
  const task = await getPlaybookTask(definitions, iteration.verifierPlaybookId);
  if (!task || task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return {
      verdict: documentationLoopVerdict({
        status: "unverified",
        warning: `${iteration.verifierPlaybookId} is not a documentation verifier, so nothing was confirmed.`,
      }),
    };
  }
  const verification = documentationVerificationContext({
    reviewRunId: review.reviewRunId ?? review.id,
    repository: context.repository,
    prNumber: context.prNumber,
    depth: context.documentation.depth,
    iteration: iteration.number,
    baseSha: context.baseSha,
    headSha: context.headSha,
    updates,
  });
  const { job } = await insertJob(asDb(db), {
    organizationId: run.organizationId,
    type: DOCUMENTATION_VERIFICATION_JOB_TYPE,
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
}

/**
 * The verdict of an iteration of a documentation check from its verifier's
 * answer: converged when it confirmed no file earlier iterations hadn't (or
 * couldn't verify), else the newly confirmed files as its findings.
 */
export async function judgeDocumentation(
  db: LoopExecutor,
  run: LoopRunRef,
  iteration: RunIteration,
  verifier: Job,
): Promise<LoopVerdict | null> {
  const iterations = (await listRunIterations(db, run)).filter(
    (it) => it.number <= iteration.number,
  );
  const loaded = await loadIterations(db, iterations);
  const current = loaded.at(-1);
  if (current?.number !== iteration.number) return null;
  const settled = settleDocumentation([
    ...loaded.slice(0, -1),
    { ...current, verifier: verifierRunOf(verifier) },
  ]);
  if (!settled.last) return NOTHING_REPORTED;
  return documentationLoopVerdict(settled.last);
}

/**
 * Saves the documentation check's review with every confirmed update and
 * no findings, or ends it: a first iteration that failed fails it (a
 * canceled one skips it), and a review whose run was superseded by a newer
 * push meanwhile is skipped with the run's reason. A run that settled
 * (its other reviews ended first) doesn't end the check. A later iteration that failed keeps
 * what the earlier ones confirmed.
 */
export async function finishDocumentation(
  db: LoopExecutor,
  run: LoopRunRef,
  iterations: readonly RunIteration[],
): Promise<void> {
  const review = await getReview(asDb(db), run.id);
  if (!review || (review.status !== "queued" && review.status !== "running")) return;
  const reviewRun = review.reviewRunId ? await getReviewRun(asDb(db), review.reviewRunId) : null;
  // Only a newer push ends the check: being summary-only, it may end after its run settled.
  if (reviewRun && reviewRunSuperseded(reviewRun)) {
    await finishReview(asDb(db), review.id, {
      status: "skipped",
      error: reviewRun.error ?? CANCELED_REVIEW_ERROR,
    });
    return;
  }
  const loaded = await loadIterations(db, iterations);
  const [first] = loaded;
  if (!first) {
    const firstWorkerId = iterations[0]?.workerJobId;
    const worker = firstWorkerId ? await getJob(asDb(db), firstWorkerId) : null;
    await finishReview(
      asDb(db),
      review.id,
      worker?.status === "canceled" || worker?.status === "skipped"
        ? { status: "skipped", error: CANCELED_REVIEW_ERROR }
        : {
            status: "failed",
            error: worker?.error ?? iterations[0]?.error ?? "The documentation check failed",
          },
    );
    return;
  }
  const settled = settleDocumentation(loaded);
  const verifierUsage = loaded.map((iteration) => {
    const answer = QueryRunResult.safeParse(iteration.verifierJob?.result);
    return answer.success
      ? { ...answer.data.usage, durationMs: answer.data.durationMs }
      : { inputTokens: 0, outputTokens: 0, durationMs: 0 };
  });
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  await saveReviewOutcome(asDb(db), review.id, {
    status: loaded.some((iteration) => iteration.result.stopReason === "budget_exhausted")
      ? "budget_exhausted"
      : "completed",
    tokensIn: sum([
      ...loaded.map((iteration) => iteration.result.usage.inputTokens),
      ...verifierUsage.map((usage) => usage.inputTokens),
    ]),
    tokensOut: sum([
      ...loaded.map((iteration) => iteration.result.usage.outputTokens),
      ...verifierUsage.map((usage) => usage.outputTokens),
    ]),
    durationMs: sum([
      ...loaded.map((iteration) => iteration.result.durationMs),
      ...verifierUsage.map((usage) => usage.durationMs),
    ]),
    skippedFiles: first.result.skipped,
    summary: documentationSummary(settled.confirmed),
    scope: first.result.scope,
    documentationUpdates: settled.confirmed,
    findings: [],
  });
}

/**
 * The check's summary, from what it confirmed (a worker's own summary may
 * name updates its verifier dropped).
 */
export function documentationSummary(confirmed: readonly DocumentationUpdate[]): string {
  if (confirmed.length === 0) return "No documentation changes needed for this change.";
  const files = confirmed.map((update) => `\`${update.path}\``).join(", ");
  return `${confirmed.length} documentation ${confirmed.length === 1 ? "file needs" : "files need"} updating: ${files}.`.slice(
    0,
    MAX_REVIEW_SUMMARY_LENGTH,
  );
}

/** The pool or a transaction as the `@omniralph/db` queries take it. */
function asDb(db: LoopExecutor): Database {
  return db as Database;
}
