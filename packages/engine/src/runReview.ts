import type { Finding } from "@omniralph/shared";
import { dedupeFindings } from "./dedupe.js";
import { parseDiff, type DiffFile } from "./diff.js";
import { diff, isAncestor, showFile } from "./git.js";
import { planReview, type ReviewPlan, type SkippedFile } from "./plan.js";
import {
  buildPrompt,
  MAX_PREVIOUS_FINDINGS,
  type ChangeRequestText,
  type IncrementalScope,
  type ReviewConfig,
} from "./prompt.js";
import { ClaudeAgentProvider } from "./providers/claude-agent.js";
import { hunkLineSets } from "./providers/findings-output.js";
import { isCiWorkflowPath } from "./rubric/index.js";
import {
  downgradeSuggestion,
  stripCrossReferences,
  undefinedSuggestionVariables,
} from "./selfContained.js";
import { alignSuggestionRange } from "./suggestionRange.js";
import {
  consoleLogger,
  type ReviewLogger,
  type ReviewProvider,
  type ReviewStopReason,
  type TaskReviewResult,
  type TokenUsage,
} from "./providers/types.js";

/** Repo conventions file, read from the base commit only. */
export const CONVENTIONS_PATH = "CLAUDE.md";

export interface PreviousReview {
  /** Head commit the last complete review covered; null = review the full diff. */
  headSha: string | null;
  /**
   * Findings of earlier reviews of this PR that are still open. The review
   * drops new findings that repeat them, and re-checks them (with their
   * title and body, when given) to report the fixed ones.
   */
  openFindings?: readonly (Pick<Finding, "path" | "startLine" | "endLine" | "category"> &
    Partial<Pick<Finding, "title" | "body">>)[];
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
  /**
   * Indexes into `previousReview.openFindings` of the open findings the
   * model re-checked and found fixed at the head: every task answered
   * "fixed" and completed, and no new finding raised it again.
   */
  fixedOpenFindings: number[];
}

/** Picks the commit range to review: the new commits only when possible. */
export async function resolveScope(
  input: Pick<RunReviewInput, "cwd" | "baseSha" | "headSha" | "previousReview" | "gitEnv">,
): Promise<ReviewScope> {
  const { cwd, baseSha, headSha, previousReview } = input;
  if (!previousReview?.headSha) return { mode: "full", baseSha, headSha };
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

const location = (f: Finding) => ({ path: f.path, startLine: f.startLine, endLine: f.endLine });

/**
 * Each finding is posted as its own comment, so it must stand alone: drop
 * sentences pointing at other findings, fit a suggestion's range to the lines
 * it actually replaces (or drop the suggestion), and turn a workflow
 * suggestion that uses a variable nothing defines (an incomplete one-click
 * fix) into body text.
 */
export async function makeSelfContained(
  findings: readonly Finding[],
  diffFiles: readonly DiffFile[],
  input: Pick<RunReviewInput, "cwd" | "headSha" | "gitEnv">,
  logger: ReviewLogger,
): Promise<Finding[]> {
  const files = new Map<string, Promise<string | undefined>>();
  const headFile = (path: string) => {
    let file = files.get(path);
    if (!file) {
      file = showFile(input.cwd, input.headSha, path, input.gitEnv);
      files.set(path, file);
    }
    return file;
  };
  const hunks = new Map(diffFiles.map((file) => [file.path, hunkLineSets(file)]));
  const result: Finding[] = [];
  for (const raw of findings) {
    let finding = stripCrossReferences(raw);
    if (finding !== raw) logger.info(location(finding), "Removed references to other findings");
    const text = finding.suggestion !== undefined ? await headFile(finding.path) : undefined;
    if (text !== undefined) {
      const aligned = alignSuggestionRange(finding, text, hunks.get(finding.path) ?? []);
      if (aligned.kind === "extended") {
        logger.info(
          { ...location(aligned.finding), suggestedRange: aligned.from },
          "Suggestion repeats lines next to its range; extended the range over them",
        );
      } else if (aligned.kind === "dropped") {
        logger.info(
          location(finding),
          "Suggestion repeats lines outside its diff hunk; dropped the suggestion",
        );
      }
      finding = aligned.finding;
    }
    if (text !== undefined && finding.suggestion !== undefined && isCiWorkflowPath(finding.path)) {
      const missing = undefinedSuggestionVariables(finding, text);
      if (missing.length > 0) {
        logger.info(
          { ...location(finding), variables: missing },
          "Suggestion uses undefined variables; moved it into the body",
        );
        finding = downgradeSuggestion(finding, missing);
      }
    }
    result.push(finding);
  }
  return result;
}

const STOP_PRIORITY: Record<ReviewStopReason, number> = {
  completed: 0,
  budget_exhausted: 1,
  rate_limited: 2,
  error: 3,
};

/** What a review's sessions work on: `prepareReview`'s output. */
export interface ReviewContext {
  scope: ReviewScope;
  /** The diff of the scope's range. */
  files: DiffFile[];
  plan: ReviewPlan;
  /** `CLAUDE.md` from the base commit, if any. */
  conventions: string | undefined;
  /** Set when only the commits since the previous review are reviewed. */
  incremental: IncrementalScope | undefined;
}

/**
 * The context step of a review: picks the scope (`resolveScope`), diffs it,
 * plans the review with the repository's path excludes and reads
 * `CLAUDE.md` from the base commit.
 */
export async function prepareReview(
  input: Pick<
    RunReviewInput,
    "cwd" | "baseSha" | "headSha" | "reviewConfig" | "previousReview" | "gitEnv"
  >,
  logger: ReviewLogger,
): Promise<ReviewContext> {
  const scope = await resolveScope(input);
  if (scope.mode === "full" && scope.fallbackFrom) {
    logger.info(
      { previousHeadSha: scope.fallbackFrom, headSha: scope.headSha },
      "Previous review head is not an ancestor of the head (force-push?); reviewing the full diff",
    );
  }
  const files = parseDiff(await diff(input.cwd, scopeRange(scope), input.gitEnv));
  const plan = planReview(files, input.reviewConfig.profile, {
    pathExcludes: input.reviewConfig.pathExcludes,
  });
  const conventions = await showFile(input.cwd, input.baseSha, CONVENTIONS_PATH, input.gitEnv);
  const incremental =
    scope.mode === "incremental" ? { fromSha: scope.fromSha, headSha: scope.headSha } : undefined;
  return { scope, files, plan, conventions, incremental };
}

/** The sessions' results of a review so far, aggregated by `addTaskResult`. */
export interface ReviewSessions {
  usage: TokenUsage;
  /** Findings dropped by validation and diff filtering. */
  discarded: { invalid: number; outsideDiff: number };
  findings: Finding[];
  /** How many sessions answered "fixed", per previous finding id. */
  fixedVotes: Map<number, number>;
  /** Sessions run. */
  tasksRun: number;
  /** The worst stop reason, with its error and retry delay. */
  stopReason: ReviewStopReason;
  error?: string;
  retryAfterMs?: number;
  /** The sessions' `summary` answers, in order. */
  summaries: string[];
}

export function emptyReviewSessions(): ReviewSessions {
  return {
    usage: { inputTokens: 0, outputTokens: 0 },
    discarded: { invalid: 0, outsideDiff: 0 },
    findings: [],
    fixedVotes: new Map(),
    tasksRun: 0,
    stopReason: "completed",
    summaries: [],
  };
}

/** Adds one session's result to `sessions`; `openFindings` is how many previous findings it re-checked. */
export function addTaskResult(
  sessions: ReviewSessions,
  result: TaskReviewResult,
  openFindings: number,
): void {
  sessions.usage.inputTokens += result.usage.inputTokens;
  sessions.usage.outputTokens += result.usage.outputTokens;
  sessions.discarded.invalid += result.discarded.invalid;
  sessions.discarded.outsideDiff += result.discarded.outsideDiff;
  sessions.findings.push(...result.findings);
  sessions.tasksRun++;
  for (const id of new Set(result.fixedPrevious ?? [])) {
    if (id < Math.min(openFindings, MAX_PREVIOUS_FINDINGS)) {
      sessions.fixedVotes.set(id, (sessions.fixedVotes.get(id) ?? 0) + 1);
    }
  }
  if (result.summary !== undefined) sessions.summaries.push(result.summary);
  if (STOP_PRIORITY[result.stopReason] > STOP_PRIORITY[sessions.stopReason]) {
    sessions.stopReason = result.stopReason;
    sessions.error = result.error;
    sessions.retryAfterMs = result.retryAfterMs;
  }
}

/** The findings `finishReview` keeps, and what it dropped and resolved. */
export interface FinishedReview {
  findings: Finding[];
  /** See `ReviewResult.fixedOpenFindings`. */
  fixedOpenFindings: number[];
  /** Findings dropped as duplicates of open previous findings. */
  duplicate: number;
}

/**
 * The finish step of a review: makes the sessions' findings self-contained
 * (`makeSelfContained`), drops the ones that repeat an open previous finding
 * (`dedupeFindings`) and applies the fixed-vote rule: a previous finding is
 * fixed only when every session completed and answered "fixed" for it, and
 * no new finding raised it again.
 */
export async function finishReview(
  input: Pick<RunReviewInput, "cwd" | "headSha" | "gitEnv" | "previousReview">,
  context: Pick<ReviewContext, "files">,
  sessions: ReviewSessions,
  logger: ReviewLogger,
): Promise<FinishedReview> {
  const openFindings = input.previousReview?.openFindings ?? [];
  const checked = await makeSelfContained(sessions.findings, context.files, input, logger);
  const deduped = dedupeFindings(checked, openFindings);
  // Fixed only when every task completed and each one answered "fixed": any
  // "open" (or no answer) keeps the finding open.
  const repeated = new Set(deduped.repeated);
  const fixed =
    sessions.stopReason === "completed"
      ? [...sessions.fixedVotes]
          .filter(([id, votes]) => votes === sessions.tasksRun && !repeated.has(id))
          .map(([id]) => id)
      : [];
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
    findings: deduped.findings,
    fixedOpenFindings: fixed.sort((a, b) => a - b),
    duplicate: deduped.suppressed.length,
  };
}

/**
 * Reviews `baseSha...headSha` (or only the commits since `previousReview`):
 * diff → plan → for each task: prompt → provider → aggregate → dedupe. The
 * previous review's open findings are re-checked along the way.
 * Pure git + model work; posting results to the code host is the caller's job.
 */
export async function runReview(
  input: RunReviewInput,
  deps: RunReviewDeps = {},
): Promise<ReviewResult> {
  const logger = deps.logger ?? consoleLogger;
  const provider = deps.provider ?? new ClaudeAgentProvider({ logger });
  const { profile } = input.reviewConfig;

  const context = await prepareReview(input, logger);
  const { plan } = context;
  const openFindings = input.previousReview?.openFindings ?? [];
  const sessions = emptyReviewSessions();

  for (const task of plan.tasks) {
    if (task.files.length === 0) continue;
    const used = sessions.usage.inputTokens + sessions.usage.outputTokens;
    const remaining = profile.maxTokensPerReview - used;
    if (remaining <= 0) {
      sessions.stopReason = "budget_exhausted";
      break;
    }
    const prompt = buildPrompt({
      config: input.reviewConfig,
      files: task.files,
      changeRequest: input.changeRequest,
      conventions: context.conventions,
      hints: { hotspots: plan.hotspots, complexityScore: plan.complexityScore },
      incremental: context.incremental,
      previousFindings: openFindings,
    });
    const result = await provider.review({
      task: { ...task, budget: Math.min(task.budget, remaining) },
      prompt: prompt.text,
      cwd: input.cwd,
      model: profile.model ?? undefined,
      allowExploration: profile.allowRepoExploration,
      signal: deps.signal,
    });
    addTaskResult(sessions, result, openFindings.length);
    if (result.stopReason !== "completed") break;
  }

  const finished = await finishReview(input, context, sessions, logger);
  return {
    profile: { id: profile.id, name: profile.name },
    budget: profile.maxTokensPerReview,
    findings: finished.findings,
    usage: sessions.usage,
    skipped: plan.skipped,
    stopReason: sessions.stopReason,
    ...(sessions.error !== undefined ? { error: sessions.error } : {}),
    ...(sessions.retryAfterMs !== undefined ? { retryAfterMs: sessions.retryAfterMs } : {}),
    scope: context.scope,
    discarded: { ...sessions.discarded, duplicate: finished.duplicate },
    fixedOpenFindings: finished.fixedOpenFindings,
  };
}
