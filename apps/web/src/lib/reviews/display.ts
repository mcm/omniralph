/**
 * Client-safe parts of the review history pages: filter values, list URLs,
 * view-prop types and formatting. Server-side mapping lives in `./history`.
 */
import type { FindingSeverity, ReviewStatus, ReviewTrigger } from "@omniralph/db";
import type { FeedbackReasonValue } from "@omniralph/shared";

/** Client-safe copies of the DB enums (the views can't import `@omniralph/db`). */
export const REVIEW_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "budget_exhausted",
  "skipped",
] as const satisfies readonly ReviewStatus[];
export const REVIEW_TRIGGERS = [
  "webhook",
  "mention",
  "manual",
] as const satisfies readonly ReviewTrigger[];
export const FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const satisfies readonly FindingSeverity[];

export interface ReviewListParams {
  status: ReviewStatus | null;
  trigger: ReviewTrigger | null;
  /** 1-based. */
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | null {
  return (values as readonly string[]).includes(value ?? "") ? (value as T) : null;
}

/** The list's filters and page from URL search params; unknown values are ignored. */
export function parseReviewListParams(params: SearchParams): ReviewListParams {
  const page = Number(single(params.page));
  return {
    status: oneOf(REVIEW_STATUSES, single(params.status)),
    trigger: oneOf(REVIEW_TRIGGERS, single(params.trigger)),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** `pathname` with the filters and page as search params (defaults omitted). */
export function reviewListHref(pathname: string, params: ReviewListParams): string {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.trigger) search.set("trigger", params.trigger);
  if (params.page > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export interface ReviewRow {
  id: string;
  repository: { id: string; provider: "github" | "gitlab"; fullPath: string };
  prNumber: number;
  prTitle: string | null;
  /** The PR/MR on the code host. */
  prUrl: string;
  trigger: ReviewTrigger;
  status: ReviewStatus;
  profileName: string | null;
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
  status: "open" | "dismissed" | "resolved" | "superseded";
  /** The fresh review's finding that superseded this one. */
  supersededBy: { reviewId: string; findingId: string } | null;
  /** Dismissals from the control panel and `@bot dismiss`, oldest first. */
  feedback: FeedbackView[];
}

export interface FeedbackView {
  id: string;
  /** `ui`: control panel; `scm`: `@bot dismiss` in the PR/MR thread. */
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
  profileName: string | null;
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
