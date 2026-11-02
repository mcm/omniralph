import type { Finding } from "@omniralph/shared";
import type { SkippedFile } from "../plan.js";
import type { ReviewProfileConfig } from "../prompt.js";
import type {
  ReviewLogger,
  ReviewProvider,
  ReviewStopReason,
  TokenUsage,
} from "../providers/types.js";
import { runReview } from "../runReview.js";
import { isCleanCase, type EvalCase, type ExpectedFinding } from "./case.js";
import { runLoopedReview, type LoopedCheckResult, type LoopedEvalProvider } from "./looped.js";
import { buildCaseRepo, type CaseRepo } from "./repo.js";
import { scoreCase, type FalsePositiveReason } from "./score.js";

/**
 * How a case is reviewed: `single` is one review task over the whole diff
 * and rubric (`runReview`); `looped` runs the check-type passes, the finding
 * verifier and the merge (`runLoopedReview`) with the depth's pass caps.
 */
export const EVAL_STRATEGIES = ["single", "looped"] as const;
export type EvalStrategy = (typeof EVAL_STRATEGIES)[number];

/** What a looped review did with a case. */
export interface LoopedCaseDetail {
  /** Every check type of `LOOPED_REVIEW_CHECK_TYPES`, in order (those after a cap-aborted one are missing). */
  checks: LoopedCheckResult[];
  /** Findings verification dropped (rejected or unanswered): never reported. */
  dropped: number;
  /** Findings dropped in the merge as repeats of another check type's. */
  merged: number;
}

/** The finding fields a report keeps. */
export interface ReportedFinding {
  path: string;
  startLine: number;
  endLine: number;
  severity: Finding["severity"];
  category: Finding["category"];
  title: string;
  confidence: number;
}

export interface CaseResult {
  id: string;
  clean: boolean;
  /**
   * `aborted`: the run's `--max-total-tokens` cut this case short; it is
   * reported but left out of the metrics, like `error` and `rate_limited`.
   */
  stopReason: ReviewStopReason | "aborted";
  error?: string;
  usage: TokenUsage;
  durationMs: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  findings: (ReportedFinding & {
    verdict: "true_positive" | FalsePositiveReason;
    mustNotFlagNote?: string;
  })[];
  missed: ExpectedFinding[];
  /** Files the plan left out (e.g. over the budget). */
  skipped: SkippedFile[];
  /** Set for a looped review that ran (not for a case that failed before it). */
  looped?: LoopedCaseDetail;
}

export interface ProfileRun {
  profile: Pick<ReviewProfileConfig, "id" | "name" | "maxTokensPerReview"> & {
    model: string | null;
  };
  cases: CaseResult[];
}

export interface EvalRun {
  strategy: EvalStrategy;
  startedAt: string;
  finishedAt: string;
  /** `--max-total-tokens`, if any. */
  maxTotalTokens: number | null;
  totalTokens: number;
  /** Set when the run stopped early. */
  aborted: { reason: string } | null;
  profiles: ProfileRun[];
}

export interface RunEvalOptions {
  cases: readonly EvalCase[];
  profiles: readonly ReviewProfileConfig[];
  /** Default `single`. */
  strategy?: EvalStrategy;
  /**
   * The real runs use `ClaudeAgentProvider`; tests pass a recorded one. A
   * looped run also verifies findings with it.
   */
  provider: ReviewProvider & Partial<Pick<LoopedEvalProvider, "verifyFindings">>;
  /** Stop before the run's input + output tokens would go past this. */
  maxTotalTokens?: number;
  logger?: ReviewLogger;
  /** Progress callback after each case. */
  onCase?: (profileId: string, result: CaseResult) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

const quietLogger: ReviewLogger = { info: () => {}, warn: () => {} };

const total = (usage: TokenUsage) => usage.inputTokens + usage.outputTokens;

const reported = (f: Finding): ReportedFinding => ({
  path: f.path,
  startLine: f.startLine,
  endLine: f.endLine,
  severity: f.severity,
  category: f.category,
  title: f.title,
  confidence: f.confidence,
});

/**
 * Reviews every case with every profile through the real `runReview`
 * (full diff, no rules, no previous review) and scores the findings.
 * With `maxTotalTokens`, each case's budget is capped at what is left; a case
 * cut short by that cap (`aborted`, left out of the metrics), or no tokens
 * left, ends the run.
 */
export async function runEval(options: RunEvalOptions): Promise<EvalRun> {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? quietLogger;
  const strategy = options.strategy ?? "single";
  const provider = options.provider;
  if (strategy === "looped" && !provider.verifyFindings) {
    throw new Error("A looped eval needs a provider that verifies findings");
  }
  const startedAt = now().toISOString();
  const run: EvalRun = {
    strategy,
    startedAt,
    finishedAt: startedAt,
    maxTotalTokens: options.maxTotalTokens ?? null,
    totalTokens: 0,
    aborted: null,
    profiles: [],
  };

  outer: for (const profile of options.profiles) {
    const profileRun: ProfileRun = {
      profile: {
        id: profile.id,
        name: profile.name,
        model: profile.model ?? null,
        maxTokensPerReview: profile.maxTokensPerReview,
      },
      cases: [],
    };
    run.profiles.push(profileRun);
    for (const evalCase of options.cases) {
      if (options.signal?.aborted) {
        run.aborted = { reason: "Interrupted" };
        break outer;
      }
      const remaining =
        options.maxTotalTokens === undefined ? Infinity : options.maxTotalTokens - run.totalTokens;
      if (remaining <= 0) {
        run.aborted = {
          reason: `--max-total-tokens ${options.maxTotalTokens} reached before ${profile.id}/${evalCase.id}`,
        };
        break outer;
      }
      const deps = { logger, signal: options.signal };
      let result: CaseResult;
      let cutByCap: boolean;
      if (strategy === "looped") {
        // Each pass may spend the depth's cap; the run's cap limits the whole case.
        const looped = await runLoopedCase(evalCase, profile, {
          ...deps,
          provider: provider as LoopedEvalProvider,
          ...(remaining !== Infinity && { maxTotalTokens: remaining }),
        });
        result = looped.result;
        cutByCap = looped.capped;
      } else {
        const budget = Math.min(profile.maxTokensPerReview, remaining);
        result = await runCase(
          evalCase,
          { ...profile, maxTokensPerReview: budget },
          { ...deps, provider },
        );
        // A capped budget shows as a budget stop, or as files the plan dropped to fit it.
        cutByCap =
          budget < profile.maxTokensPerReview &&
          (result.stopReason === "budget_exhausted" ||
            result.skipped.some((s) => s.reason === "budget"));
      }
      run.totalTokens += total(result.usage);
      if (cutByCap) result.stopReason = "aborted";
      profileRun.cases.push(result);
      options.onCase?.(profile.id, result);
      if (cutByCap) {
        run.aborted = {
          reason: `--max-total-tokens ${options.maxTotalTokens} reached during ${profile.id}/${evalCase.id}`,
        };
        break outer;
      }
    }
  }
  run.finishedAt = now().toISOString();
  return run;
}

/** A case's findings scored, as a result. */
function scoredResult(
  evalCase: EvalCase,
  review: {
    findings: Finding[];
    stopReason: ReviewStopReason;
    error?: string;
    usage: TokenUsage;
    skipped: SkippedFile[];
  },
  durationMs: number,
): CaseResult {
  const score = scoreCase(review.findings, evalCase);
  const verdicts = new Map<Finding, CaseResult["findings"][number]>();
  for (const tp of score.truePositives) {
    verdicts.set(tp.finding, { ...reported(tp.finding), verdict: "true_positive" });
  }
  for (const fp of score.falsePositives) {
    verdicts.set(fp.finding, {
      ...reported(fp.finding),
      verdict: fp.reason,
      ...(fp.mustNotFlag ? { mustNotFlagNote: fp.mustNotFlag.note } : {}),
    });
  }
  return {
    id: evalCase.id,
    clean: isCleanCase(evalCase),
    stopReason: review.stopReason,
    ...(review.error !== undefined ? { error: review.error } : {}),
    usage: review.usage,
    durationMs,
    truePositives: score.truePositives.length,
    falsePositives: score.falsePositives.length,
    falseNegatives: score.falseNegatives.length,
    findings: review.findings.flatMap((f) => verdicts.get(f) ?? []),
    missed: score.falseNegatives,
    skipped: review.skipped,
  };
}

/** A case whose review threw: reported, never scored. */
function failedResult(evalCase: EvalCase, error: unknown, durationMs: number): CaseResult {
  return {
    id: evalCase.id,
    clean: isCleanCase(evalCase),
    stopReason: "error",
    error: error instanceof Error ? error.message : String(error),
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    findings: [],
    missed: [],
    skipped: [],
  };
}

/** Runs `review` in a fresh repo of the case, scoring what it returns. */
async function inCaseRepo<T>(
  evalCase: EvalCase,
  logger: ReviewLogger,
  review: (repo: CaseRepo) => Promise<T>,
  toResult: (value: T, durationMs: number) => CaseResult,
): Promise<{ result: CaseResult; value: T | undefined }> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const repo = await buildCaseRepo(evalCase);
  try {
    const value = await review(repo);
    return { result: toResult(value, elapsed()), value };
  } catch (error) {
    logger.warn({ caseId: evalCase.id, err: String(error) }, "Eval case failed");
    return { result: failedResult(evalCase, error, elapsed()), value: undefined };
  } finally {
    await repo.cleanup();
  }
}

async function runCase(
  evalCase: EvalCase,
  profile: ReviewProfileConfig,
  deps: { provider: ReviewProvider; logger: ReviewLogger; signal?: AbortSignal },
): Promise<CaseResult> {
  const { result } = await inCaseRepo(
    evalCase,
    deps.logger,
    (repo) =>
      runReview(
        {
          cwd: repo.dir,
          baseSha: repo.baseSha,
          headSha: repo.headSha,
          reviewConfig: { profile, rules: [], pathExcludes: [] },
          changeRequest: { title: evalCase.pr.title, description: evalCase.pr.description ?? null },
        },
        deps,
      ),
    (review, durationMs) => scoredResult(evalCase, review, durationMs),
  );
  return result;
}

/** A case reviewed by a looped review; `capped` when `maxTotalTokens` cut it short. */
async function runLoopedCase(
  evalCase: EvalCase,
  profile: ReviewProfileConfig,
  deps: {
    provider: LoopedEvalProvider;
    logger: ReviewLogger;
    signal?: AbortSignal;
    maxTotalTokens?: number;
  },
): Promise<{ result: CaseResult; capped: boolean }> {
  const { result, value } = await inCaseRepo(
    evalCase,
    deps.logger,
    (repo) =>
      runLoopedReview(
        {
          cwd: repo.dir,
          baseSha: repo.baseSha,
          headSha: repo.headSha,
          repository: `evals/${evalCase.id}`,
          reviewConfig: { profile, rules: [], pathExcludes: [] },
          changeRequest: { title: evalCase.pr.title, description: evalCase.pr.description ?? null },
        },
        deps,
      ),
    (review, durationMs) => ({
      ...scoredResult(evalCase, review, durationMs),
      looped: { checks: review.checks, dropped: review.dropped, merged: review.merged },
    }),
  );
  return { result, capped: value?.capped ?? false };
}
