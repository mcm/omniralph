/**
 * Client-safe parts of a review's views (Analytics, the chat tools, a review run's
 * findings): enum values, view-prop types and formatting. Server-side mapping lives in
 * `./history`.
 */
import type { FindingSeverity, ReviewStatus, ReviewTrigger } from "@omniralph/db";
import type { FeedbackReasonValue, ReviewDepth } from "@omniralph/shared";

/** Client-safe copies of the DB enums (the views can't import `@omniralph/db`). */
export const REVIEW_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "budget_exhausted",
  "skipped",
] as const satisfies readonly ReviewStatus[];
export const FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const satisfies readonly FindingSeverity[];

export interface ReviewRow {
  id: string;
  repository: { id: string; provider: "github" | "gitlab"; fullPath: string };
  prNumber: number;
  prTitle: string | null;
  /** The PR/MR on the code host. */
  prUrl: string;
  trigger: ReviewTrigger;
  status: ReviewStatus;
  /** The depth the review ran at; null for reviews from before depths were recorded. */
  depth: ReviewDepth | null;
  agent: { id: string; name: string } | null;
  findingCounts: Record<FindingSeverity, number>;
  tokensUsed: number;
  budget: number;
  durationMs: number | null;
  error: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

export interface FindingView {
  id: string;
  startLine: number;
  endLine: number;
  severity: FindingSeverity;
  category: string;
  title: string;
  body: string;
  suggestion: string | null;
  confidence: number;
  status: "open" | "dismissed" | "resolved" | "superseded" | "merged";
  /** The fresh review's finding that superseded this one. */
  supersededBy: { reviewId: string; findingId: string } | null;
  /** Dismissals (`@bot dismiss`, and older ones from the control panel), oldest first. */
  feedback: FeedbackView[];
}

export interface FeedbackView {
  id: string;
  /** `scm`: `@bot dismiss` in the PR/MR thread; `ui`: the control panel (history only). */
  source: "ui" | "scm";
  reason: FeedbackReasonValue;
  note: string | null;
  /** Who dismissed it: a control panel user, or a code-host login (`@name`). */
  actor: string;
  /** ISO timestamps. */
  createdAt: string;
  restoredAt: string | null;
  restoredBy: string | null;
}

export interface FileFindings {
  path: string;
  findings: FindingView[];
}

export interface ReviewDetailView {
  id: string;
  repository: { id: string; provider: "github" | "gitlab"; fullPath: string };
  prNumber: number;
  prTitle: string | null;
  prUrl: string;
  headSha: string;
  baseSha: string;
  trigger: ReviewTrigger;
  status: ReviewStatus;
  /** The depth the review ran at; null for reviews from before depths were recorded. */
  depth: ReviewDepth | null;
  model: string | null;
  agent: { id: string; name: string } | null;
  tokensIn: number;
  tokensOut: number;
  budget: number;
  durationMs: number | null;
  stopReason: string | null;
  error: string | null;
  skippedFiles: { path: string; reason: string }[];
  files: FileFindings[];
  findingCount: number;
  /** The newest later review of the same PR/MR and task (e.g. its re-run); null for the latest. */
  newerReview: { id: string; status: ReviewStatus; /** ISO timestamp. */ createdAt: string } | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** A duration such as "850 ms", "42 s" or "3 min 5 s". */
export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Token counts in compact form, e.g. "12.3k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
