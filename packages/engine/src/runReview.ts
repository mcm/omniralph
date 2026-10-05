import type { Finding } from "@omniralph/shared";
import { dedupeFindings } from "./dedupe.js";
import { parseDiff } from "./diff.js";
import { diff, isAncestor, showFile } from "./git.js";
import { planReview, type SkippedFile } from "./plan.js";
import {
  buildPrompt,
  type ChangeRequestText,
  type IncrementalScope,
  type ReviewConfig,
} from "./prompt.js";
import { ClaudeAgentProvider } from "./providers/claude-agent.js";
import {
  consoleLogger,
  type ReviewLogger,
  type ReviewProvider,
  type ReviewStopReason,
  type TokenUsage,
} from "./providers/types.js";

/** Repo conventions file, read from the base commit only. */
export const CONVENTIONS_PATH = "CLAUDE.md";

export interface PreviousReview {
  /** Head commit the previous review covered. */
  headSha: string;
  /** Findings of earlier reviews of this PR that are still open. */
  openFindings?: readonly Pick<Finding, "path" | "startLine" | "endLine" | "category">[];
}

export interface RunReviewInput {
  /** Git worktree of the repo with `baseSha` and `headSha` available. */
  cwd: string;
  baseSha: string;
  headSha: string;
  reviewConfig: ReviewConfig;
  changeRequest: ChangeRequestText;
  previousReview?: PreviousReview;
  /**
   * Environment for git commands (default `process.env`). Agents pass one
   * that configures their credential helper, since diffing a blobless clone
   * fetches blobs on demand.
   */
  gitEnv?: NodeJS.ProcessEnv;
}

export interface RunReviewDeps {
  /** Defaults to a `ClaudeAgentProvider` (host Claude Code login). */
  provider?: ReviewProvider;
  logger?: ReviewLogger;
  signal?: AbortSignal;
}

export type ReviewScope =
  | {
      mode: "full";
      baseSha: string;
      headSha: string;
      /** Set when a previous head is not in the new head's history (force-push or rebase). */
      fallbackFrom?: string;
    }
  | { mode: "incremental"; fromSha: string; headSha: string };

export interface ReviewResult {
  profile: { id: string; name: string };
  /** The profile's `maxTokensPerReview`. */
  budget: number;
  findings: Finding[];
  usage: TokenUsage;
  skipped: SkippedFile[];
  stopReason: ReviewStopReason;
  error?: string;
  retryAfterMs?: number;
  scope: ReviewScope;
  /** Findings dropped by validation, diff filtering and dedupe. */
  discarded: { invalid: number; outsideDiff: number; duplicate: number };
}

/** Picks the commit range to review: the new commits only when possible. */
export async function resolveScope(input: RunReviewInput): Promise<ReviewScope> {
  const { cwd, baseSha, headSha, previousReview } = input;
  if (!previousReview) return { mode: "full", baseSha, headSha };
  if (await isAncestor(cwd, previousReview.headSha, headSha, input.gitEnv)) {
    return { mode: "incremental", fromSha: previousReview.headSha, headSha };
  }
  return { mode: "full", baseSha, headSha, fallbackFrom: previousReview.headSha };
}

function scopeRange(scope: ReviewScope): string {
  return scope.mode === "incremental"
    ? `${scope.fromSha}..${scope.headSha}`
    : `${scope.baseSha}...${scope.headSha}`;
}

const STOP_PRIORITY: Record<ReviewStopReason, number> = {
  completed: 0,
  budget_exhausted: 1,
  rate_limited: 2,
  error: 3,
};

/**
 * Reviews `baseSha...headSha` (or only the commits since `previousReview`):
 * diff → plan → for each task: prompt → provider → aggregate → dedupe.
 * Pure git + model work; posting results to the code host is the caller's job.
 */
export async function runReview(
  input: RunReviewInput,
  deps: RunReviewDeps = {},
): Promise<ReviewResult> {
  const logger = deps.logger ?? consoleLogger;
  const provider = deps.provider ?? new ClaudeAgentProvider({ logger });
  const { profile } = input.reviewConfig;

  const scope = await resolveScope(input);
  if (scope.mode === "full" && scope.fallbackFrom) {
    logger.info(
      { previousHeadSha: scope.fallbackFrom, headSha: scope.headSha },
      "Previous review head is not an ancestor of the head (force-push?); reviewing the full diff",
    );
  }
  const files = parseDiff(await diff(input.cwd, scopeRange(scope), input.gitEnv));
  const plan = planReview(files, profile, { pathExcludes: input.reviewConfig.pathExcludes });
  const conventions = await showFile(input.cwd, input.baseSha, CONVENTIONS_PATH, input.gitEnv);
  const incremental: IncrementalScope | undefined =
    scope.mode === "incremental" ? { fromSha: scope.fromSha, headSha: scope.headSha } : undefined;

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const discarded = { invalid: 0, outsideDiff: 0, duplicate: 0 };
  const collected: Finding[] = [];
  let stopReason: ReviewStopReason = "completed";
  let error: string | undefined;
  let retryAfterMs: number | undefined;

  for (const task of plan.tasks) {
    if (task.files.length === 0) continue;
    const remaining = profile.maxTokensPerReview - usage.inputTokens - usage.outputTokens;
    if (remaining <= 0) {
      stopReason = "budget_exhausted";
      break;
    }
    const prompt = buildPrompt({
      config: input.reviewConfig,
      files: task.files,
      changeRequest: input.changeRequest,
      conventions,
      hints: { hotspots: plan.hotspots, complexityScore: plan.complexityScore },
      incremental,
    });
    const result = await provider.review({
      task: { ...task, budget: Math.min(task.budget, remaining) },
      prompt: prompt.text,
      cwd: input.cwd,
      model: profile.model ?? undefined,
      allowExploration: profile.allowRepoExploration,
      signal: deps.signal,
    });

    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    discarded.invalid += result.discarded.invalid;
    discarded.outsideDiff += result.discarded.outsideDiff;
    collected.push(...result.findings);
    if (STOP_PRIORITY[result.stopReason] > STOP_PRIORITY[stopReason]) {
      stopReason = result.stopReason;
      error = result.error;
      retryAfterMs = result.retryAfterMs;
    }
    if (result.stopReason !== "completed") break;
  }

  const deduped = dedupeFindings(collected, input.previousReview?.openFindings);
  discarded.duplicate = deduped.suppressed.length;
  if (deduped.suppressed.length > 0) {
    logger.info(
      {
        findings: deduped.suppressed.map((f) => ({
          path: f.path,
          startLine: f.startLine,
          endLine: f.endLine,
          category: f.category,
        })),
      },
      "Suppressed duplicate findings",
    );
  }

  return {
    profile: { id: profile.id, name: profile.name },
    budget: profile.maxTokensPerReview,
    findings: deduped.findings,
    usage,
    skipped: plan.skipped,
    stopReason,
    ...(error !== undefined ? { error } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    scope,
    discarded,
  };
}
