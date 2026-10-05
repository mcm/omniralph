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
import { buildCaseRepo } from "./repo.js";
import { scoreCase, type FalsePositiveReason } from "./score.js";

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
}

export interface ProfileRun {
  profile: Pick<ReviewProfileConfig, "id" | "name" | "maxTokensPerReview"> & {
    model: string | null;
  };
  cases: CaseResult[];
}

export interface EvalRun {
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
  /** The real runs use `ClaudeAgentProvider`; tests pass a recorded one. */
  provider: ReviewProvider;
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
  const startedAt = now().toISOString();
  const run: EvalRun = {
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
      const budget = Math.min(profile.maxTokensPerReview, remaining);
      const result = await runCase(
        evalCase,
        { ...profile, maxTokensPerReview: budget },
        {
          provider: options.provider,
          logger,
          signal: options.signal,
        },
      );
      run.totalTokens += total(result.usage);
      // A capped budget shows as a budget stop, or as files the plan dropped to fit it.
      const cutByCap =
        budget < profile.maxTokensPerReview &&
        (result.stopReason === "budget_exhausted" ||
          result.skipped.some((s) => s.reason === "budget"));
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

async function runCase(
  evalCase: EvalCase,
  profile: ReviewProfileConfig,
  deps: { provider: ReviewProvider; logger: ReviewLogger; signal?: AbortSignal },
): Promise<CaseResult> {
  const started = performance.now();
  const repo = await buildCaseRepo(evalCase);
  try {
    const review = await runReview(
      {
        cwd: repo.dir,
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        reviewConfig: { profile, rules: [], pathExcludes: [] },
        changeRequest: { title: evalCase.pr.title, description: evalCase.pr.description ?? null },
      },
      deps,
    );
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
      durationMs: Math.round(performance.now() - started),
      truePositives: score.truePositives.length,
      falsePositives: score.falsePositives.length,
      falseNegatives: score.falseNegatives.length,
      findings: review.findings.flatMap((f) => verdicts.get(f) ?? []),
      missed: score.falseNegatives,
      skipped: review.skipped,
    };
  } catch (error) {
    deps.logger.warn({ caseId: evalCase.id, err: String(error) }, "Eval case failed");
    return {
      id: evalCase.id,
      clean: isCleanCase(evalCase),
      stopReason: "error",
      error: error instanceof Error ? error.message : String(error),
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: Math.round(performance.now() - started),
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      findings: [],
      missed: [],
      skipped: [],
    };
  } finally {
    await repo.cleanup();
  }
}
