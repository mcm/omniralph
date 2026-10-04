import type { Finding } from "@omniralph/shared";
import type { ReviewTask } from "../plan.js";

export type ReviewStopReason = "completed" | "budget_exhausted" | "rate_limited" | "error";

export interface TokenUsage {
  /** Every input token sent to the model, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
}

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
}

export interface ReviewProvider {
  review(request: ReviewRequest): Promise<TaskReviewResult>;
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
