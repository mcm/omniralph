import {
  addTokenUsage,
  isReviewDepth,
  LOOPED_REVIEW_CHECK_TYPES,
  REVIEW_DEPTHS,
  reviewPassLimits,
  type Finding,
  type ReviewCheckType,
  type ReviewPassContext,
  type ReviewPassRecord,
  type VerifierRun,
} from "@omniralph/shared";
import { planCheckPass, planChecks, type SkippedFile } from "../plan.js";
import { buildPrompt } from "../prompt.js";
import type {
  ReviewLogger,
  ReviewProvider,
  ReviewStopReason,
  TokenUsage,
  VerifyFindingsOutcome,
} from "../providers/types.js";
import {
  nextPassContext,
  passConverged,
  passFindings,
  settlePasses,
  type PassInput,
  type PassResult,
  type SettledPasses,
} from "../passes.js";
import {
  addTaskResult,
  emptyReviewSessions,
  makeSelfContained,
  prepareReview,
  type RunReviewInput,
} from "../runReview.js";
import { sameIssue } from "../sameIssue.js";
import { buildEvalVerifyRequest, type EvalVerifyRequest } from "./verify.js";

/** A provider for looped evals: it reviews passes and verifies their findings. */
export interface LoopedEvalProvider extends ReviewProvider {
  verifyFindings(request: EvalVerifyRequest): Promise<VerifyFindingsOutcome>;
}

/**
 * Why a check type stopped: a pass added no new confirmed finding after its
 * minimum passes (`converged`), it ran its depth's pass cap (`cap`), the
 * change has no file for it (`no_files`), or a pass stopped on an error or
 * rate limit (`failed`) or on the run's token cap (`aborted`).
 */
export type LoopedCheckStop = "converged" | "cap" | "no_files" | "failed" | "aborted";

/** One check type of a looped review. */
export interface LoopedCheckResult {
  checkType: ReviewCheckType;
  stop: LoopedCheckStop;
  /** Its passes, as a review records them (`reviews.passes`). */
  passes: ReviewPassRecord[];
  /** Findings it kept over every pass. */
  findings: number;
  /** Findings verification dropped over every pass. */
  dropped: number;
}

export interface LoopedReviewResult {
  /** Every check type's kept findings, merged (repeats across check types dropped) and self-contained. */
  findings: Finding[];
  usage: TokenUsage;
  skipped: SkippedFile[];
  /** The worst stop reason of the passes' sessions. */
  stopReason: ReviewStopReason;
  error?: string;
  checks: LoopedCheckResult[];
  /** Findings verification dropped over every check type. */
  dropped: number;
  /** Findings dropped in the merge as repeats of another check type's. */
  merged: number;
  /** The run's `maxTotalTokens` cut the review short. */
  capped: boolean;
}

export interface RunLoopedReviewInput extends Omit<RunReviewInput, "previousReview"> {
  /** `owner/repo` as the verifier's prompt names it. */
  repository: string;
}

export interface RunLoopedReviewDeps {
  provider: LoopedEvalProvider;
  logger: ReviewLogger;
  signal?: AbortSignal;
  /** Most tokens (input + output) the whole review may spend; each session gets at most what's left. */
  maxTotalTokens?: number;
}

const STOP_PRIORITY: Record<ReviewStopReason, number> = {
  completed: 0,
  budget_exhausted: 1,
  rate_limited: 2,
  error: 3,
};

const total = (usage: TokenUsage) => usage.inputTokens + usage.outputTokens;

/** A verifier session's outcome as the review's finding verification reads it. */
export function verifierRunOf(outcome: VerifyFindingsOutcome): VerifierRun {
  return outcome.status === "answered"
    ? { status: "answered", output: outcome.output }
    : {
        status: "failed",
        error: outcome.error ?? `The verifier stopped (${outcome.status})`,
        rateLimited: outcome.status === "rate_limited",
      };
}

/**
 * A looped review in process, as a review run does it with `builtin:review-pr`
 * and `builtin:verify-findings`: for each check type of the change
 * (`LOOPED_REVIEW_CHECK_TYPES`), passes planned by `planCheckPass` (one
 * session per group, each with its share of the depth's token cap), each
 * followed (when it reported findings and the depth verifies) by a fresh
 * verifier session. A check type stops once a pass adds no new confirmed
 * finding after its minimum passes, or at its depth's pass cap
 * (`reviewPassLimits`). The check types' kept findings are then merged:
 * a finding repeating another check type's (`sameIssue`) is dropped, the
 * deterministic stand-in for the review run's correlation. The profile's
 * `id` is the review depth.
 */
export async function runLoopedReview(
  input: RunLoopedReviewInput,
  deps: RunLoopedReviewDeps,
): Promise<LoopedReviewResult> {
  const { provider, logger } = deps;
  const { profile } = input.reviewConfig;
  if (!isReviewDepth(profile.id)) {
    throw new Error(`A looped review needs a review depth as its profile, got "${profile.id}"`);
  }
  const depth = REVIEW_DEPTHS[profile.id];
  const context = await prepareReview(input, logger);
  const pathExcludes = input.reviewConfig.pathExcludes;
  const checkPlan = planChecks(context.files, profile, { pathExcludes });

  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: ReviewStopReason = "completed";
  let error: string | undefined;
  let capped = false;
  const remaining = () =>
    deps.maxTotalTokens === undefined ? Infinity : deps.maxTotalTokens - total(usage);
  const worse = (reason: ReviewStopReason, message?: string) => {
    if (STOP_PRIORITY[reason] > STOP_PRIORITY[stopReason]) {
      stopReason = reason;
      error = message;
    }
  };

  const checks: LoopedCheckResult[] = [];
  const kept: Finding[][] = [];
  for (const checkType of LOOPED_REVIEW_CHECK_TYPES) {
    const limits = reviewPassLimits(depth.id, checkType);
    const inputs: PassInput<PassResult>[] = [];
    let settled: SettledPasses = { passes: [], findings: [], dropped: 0 };
    let pass: ReviewPassContext = { checkType, number: 1, confirmed: [], unreached: [] };
    let stop: LoopedCheckStop = "cap";

    passes: for (; pass.number <= limits.maxPasses; pass = nextPassContext(checkType, settled)) {
      const plan = planCheckPass(context.files, profile, pass, { pathExcludes });
      if (plan.tasks.length === 0) {
        stop = "no_files";
        break;
      }
      const sessions = emptyReviewSessions();
      for (const task of plan.tasks) {
        const left = remaining();
        if (left <= 0) {
          capped = true;
          stop = "aborted";
          break passes;
        }
        const budget = Math.min(task.budget, left);
        const prompt = buildPrompt({
          config: input.reviewConfig,
          files: task.files,
          changeRequest: input.changeRequest,
          conventions: context.conventions,
          hints: {
            hotspots: plan.checks.hotspots.filter((risk) =>
              task.files.some((file) => file.path === risk.path),
            ),
            complexityScore: plan.checks.complexityScore,
          },
          checkType,
          pass,
        });
        const result = await provider.review({
          task: { ...task, budget },
          prompt: prompt.text,
          cwd: input.cwd,
          model: profile.model ?? undefined,
          allowExploration: profile.allowRepoExploration,
          signal: deps.signal,
        });
        usage = addTokenUsage(usage, result.usage);
        addTaskResult(sessions, result, 0);
        if (result.stopReason === "budget_exhausted" && budget < task.budget) capped = true;
        if (result.stopReason !== "completed") break;
      }
      worse(sessions.stopReason, sessions.error);
      if (capped) {
        stop = "aborted";
        break;
      }
      if (sessions.stopReason === "error" || sessions.stopReason === "rate_limited") {
        stop = "failed";
        break;
      }

      const current: PassInput<PassResult> = {
        number: pass.number,
        result: {
          findings: sessions.findings,
          pass: { checkType, files: plan.files.map((file) => file.path) },
        },
        verifier: null,
      };
      if (depth.verifyFindings && sessions.findings.length > 0) {
        const request = buildEvalVerifyRequest({
          repository: input.repository,
          checkType,
          pass: pass.number,
          baseSha: input.baseSha,
          headSha: input.headSha,
          files: current.result.pass?.files ?? [],
          findings: passFindings(current).map((finding) => ({
            ...finding,
            suggestion: finding.suggestion ?? null,
          })),
          diff: plan.files,
          cwd: input.cwd,
          signal: deps.signal,
        });
        const left = remaining();
        const outcome: VerifyFindingsOutcome =
          left <= 0
            ? {
                status: "budget_exhausted",
                output: null,
                usage: { inputTokens: 0, outputTokens: 0 },
              }
            : await provider.verifyFindings({
                ...request,
                maxTokens: Math.min(request.maxTokens, left),
              });
        usage = addTokenUsage(usage, outcome.usage);
        if (outcome.status === "budget_exhausted" && left < request.maxTokens) capped = true;
        current.verifier = verifierRunOf(outcome);
        if (outcome.status !== "answered") {
          logger.warn(
            { checkType, pass: pass.number, status: outcome.status, error: outcome.error },
            "The verifier didn't answer; the pass's findings are kept unverified",
          );
        }
      }
      inputs.push(current);
      // Each settle re-reads every pass; only the newest pass's warnings are new.
      settled = settlePasses(inputs, { warn: () => {} });
      if (capped) {
        stop = "aborted";
        break;
      }
      const last = settled.passes.at(-1)!;
      if (passConverged(last, limits)) {
        stop = "converged";
        break;
      }
    }

    checks.push({
      checkType,
      stop,
      passes: settled.passes.map((settledPass) => settledPass.record),
      findings: settled.findings.length,
      dropped: settled.dropped,
    });
    kept.push(settled.findings);
    if (capped) break;
  }

  // The merge: each check type's findings, without repeats of an earlier check type's.
  const merged: Finding[] = [];
  let repeats = 0;
  for (const finding of kept.flat()) {
    if (merged.some((prior) => sameIssue(prior, finding))) repeats++;
    else merged.push(finding);
  }
  const findings = await makeSelfContained(merged, context.files, input, logger);
  return {
    findings,
    usage,
    skipped: checkPlan.skipped,
    stopReason,
    ...(error !== undefined ? { error } : {}),
    checks,
    dropped: checks.reduce((sum, check) => sum + check.dropped, 0),
    merged: repeats,
    capped,
  };
}
