import type { DocumentationUpdate, Finding, TokenUsage } from "@omniralph/shared";
import type { ReviewTask } from "../plan.js";

export type ReviewStopReason = "completed" | "budget_exhausted" | "rate_limited" | "error";

/** Every input token sent to the model (cache reads and writes included), and the usage per model. */
export type { TokenUsage };

export interface ReviewRequest {
  task: ReviewTask;
  /** The assembled review prompt (diff, rubric, conventions). */
  prompt: string;
  /** The job's git worktree; exploration tools are confined to it. */
  cwd: string;
  /** Model ID or alias; undefined uses the Claude Code default. */
  model?: string;
  /** Whether the reviewer may read files beyond the diff (`Read`/`Grep`/`Glob`). */
  allowExploration: boolean;
  /**
   * The session's system prompt instead of `REVIEW_SYSTEM_PROMPT` (repair turn
   * included), e.g. a review task's agent prompt and output contract. It must
   * ask for the same JSON answer.
   */
  systemPrompt?: string;
  signal?: AbortSignal;
}

/** One task's result from a provider; `runReview` aggregates these into a `ReviewResult`. */
export interface TaskReviewResult {
  /** Valid findings inside the task's files and diff lines (partial unless `completed`). */
  findings: Finding[];
  usage: TokenUsage;
  stopReason: ReviewStopReason;
  /** Human-readable cause when `stopReason` is `error` or `rate_limited`. */
  error?: string;
  /** For `rate_limited`: how long to wait before retrying, when the provider knows. */
  retryAfterMs?: number;
  /** Items dropped by validation and by diff filtering. */
  discarded: { invalid: number; outsideDiff: number };
  /**
   * Ids (positions in the prompt's previous findings) the model re-checked
   * and found fixed. Only meaningful when `completed`.
   */
  fixedPrevious?: number[];
  /** The answer's optional `summary` (only from a valid, `completed` answer). */
  summary?: string;
  /** The answer's optional `documentationUpdates` (only from a valid, `completed` answer). */
  documentationUpdates?: DocumentationUpdate[];
}

export interface ReviewProvider {
  review(request: ReviewRequest): Promise<TaskReviewResult>;
}

/** A fresh session that checks a review pass's findings (see `@omniralph/shared`'s finding verification). */
export interface VerifyFindingsRequest {
  /** The assembled verification prompt, with the pass's findings quoted as data. */
  prompt: string;
  /** The verifier's system prompt (its persona and the untrusted-data notice). */
  systemPrompt: string;
  /** Checkout of the change's head; the read-only tools are confined to it. */
  cwd: string;
  model?: string;
  /** Token cap (input + output). */
  maxTokens: number;
  signal?: AbortSignal;
}

export interface VerifyFindingsOutcome {
  /**
   * `answered`: `output` is the answer's JSON object, unchecked (read it with
   * `applyFindingVerification`, which keeps the findings unverified when it
   * isn't a `FindingVerificationOutput`).
   */
  status: "answered" | "budget_exhausted" | "rate_limited" | "error";
  output: unknown;
  usage: TokenUsage;
  error?: string;
  retryAfterMs?: number;
}

export interface FindingVerifier {
  verifyFindings(request: VerifyFindingsRequest): Promise<VerifyFindingsOutcome>;
}

/** pino-compatible subset. */
export interface ReviewLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export const consoleLogger: ReviewLogger = {
  info: (data, message) => console.info(message, data),
  warn: (data, message) => console.warn(message, data),
};

export interface LearnRuleRequest {
  /** The assembled rule-generation prompt (`buildLearnRulePrompt`). */
  prompt: string;
  /** Working directory of the Claude Code process; the session has no tools. */
  cwd: string;
  model?: string;
  /** Token cap (input + output). */
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LearnRuleOutcome {
  /** `rule`: `rule` is set; `none`: nothing generalizable; `rejected`: unusable answer. */
  status: "rule" | "none" | "rejected" | "budget_exhausted" | "rate_limited" | "error";
  rule: string | null;
  usage: TokenUsage;
  error?: string;
  retryAfterMs?: number;
}

export interface RuleLearner {
  learnRule(request: LearnRuleRequest): Promise<LearnRuleOutcome>;
}

export interface ReplyRequest {
  /** The assembled prompt (`buildReplyPrompt`, `buildChatAskPrompt`). */
  prompt: string;
  /** Defaults to `REPLY_SYSTEM_PROMPT` (a finding thread reply). */
  systemPrompt?: string;
  /** Most turns while exploring; defaults to the provider's `maxReplyTurns`. */
  maxTurns?: number;
  /** The job's worktree at the review's head; the read-only tools are confined to it. */
  cwd: string;
  /** False when no checkout is available (`cwd` is then an empty directory). */
  allowExploration: boolean;
  model?: string;
  /** Token cap (input + output). */
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ReplyOutcome {
  /** `answered`: `answer` is set. */
  status: "answered" | "budget_exhausted" | "rate_limited" | "error";
  answer: string | null;
  usage: TokenUsage;
  error?: string;
  retryAfterMs?: number;
}

export interface QuestionAnswerer {
  answer(request: ReplyRequest): Promise<ReplyOutcome>;
}
