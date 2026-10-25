/**
 * Client-safe parts of the Analytics page: the window and repository filter
 * in the URL, view-prop types and chart labels.
 */
import type {
  Analytics,
  AnalyticsRange,
  RalphAnalytics,
  RalphRunOutcome,
  RalphStoryOutcomes,
  RunAnalytics,
  RunAnalyticsBucket,
} from "@omniralph/db";
import { REVIEW_DEPTHS, type ReviewDepth } from "@omniralph/shared";
import { formatTokens } from "@/lib/reviews/display";

/** Client-safe copy of the DB's `ANALYTICS_RANGES`. */
export const ANALYTICS_RANGES = [7, 30, 90] as const satisfies readonly AnalyticsRange[];
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = 30;

export interface AnalyticsParams {
  days: AnalyticsRange;
  /** Null for all repositories. */
  repositoryId: string | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The window (`?days=7|30|90`, default 30) and repository (`?repo=<id>`) from
 * URL search params. A repository that isn't one of `repositoryIds` is ignored; without
 * `repositoryIds` (the page, before the server has checked it) any is kept.
 */
export function parseAnalyticsParams(
  params: SearchParams,
  repositoryIds?: readonly string[],
): AnalyticsParams {
  const days = Number(single(params.days));
  const repo = single(params.repo);
  return {
    days: (ANALYTICS_RANGES as readonly number[]).includes(days)
      ? (days as AnalyticsRange)
      : DEFAULT_ANALYTICS_RANGE,
    repositoryId: repo && (!repositoryIds || repositoryIds.includes(repo)) ? repo : null,
  };
}

/** `pathname` with the filters as search params (defaults omitted). */
export function analyticsHref(pathname: string, params: AnalyticsParams): string {
  const search = new URLSearchParams();
  if (params.days !== DEFAULT_ANALYTICS_RANGE) search.set("days", String(params.days));
  if (params.repositoryId) search.set("repo", params.repositoryId);
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** `Analytics` with its dates as ISO strings, so it can be passed to the view. */
export type AnalyticsData = Omit<Analytics, "from" | "to"> & { from: string; to: string };

export function analyticsData(analytics: Analytics): AnalyticsData {
  return { ...analytics, from: analytics.from.toISOString(), to: analytics.to.toISOString() };
}

/** `RalphAnalytics` with its dates as ISO strings, so it can be passed to the view. */
export type RalphAnalyticsData = Omit<RalphAnalytics, "from" | "to"> & { from: string; to: string };

export function ralphAnalyticsData(ralph: RalphAnalytics): RalphAnalyticsData {
  return { ...ralph, from: ralph.from.toISOString(), to: ralph.to.toISOString() };
}

/** Client-safe copy of the DB's `RUN_ANALYTICS_BUCKETS`. */
export const RUN_ANALYTICS_BUCKETS = [
  "day",
  "week",
] as const satisfies readonly RunAnalyticsBucket[];

/** `RunAnalytics` with its dates as ISO strings, as `/api/ui/analytics/runs` sends it. */
export type RunAnalyticsData = Omit<RunAnalytics, "from" | "to"> & { from: string; to: string };

export function runAnalyticsData(analytics: RunAnalytics): RunAnalyticsData {
  return { ...analytics, from: analytics.from.toISOString(), to: analytics.to.toISOString() };
}

/** Client-safe copy of the DB's `RALPH_RUN_OUTCOMES`, in chart order. */
export const RALPH_RUN_OUTCOMES = [
  "completed",
  "waiting",
  "stopped",
  "failed",
  "running",
] as const satisfies readonly RalphRunOutcome[];

export const RALPH_RUN_OUTCOME_LABELS: Record<RalphRunOutcome, string> = {
  completed: "Completed",
  waiting: "Waiting",
  stopped: "Stopped",
  failed: "Failed",
  running: "Running",
};

export type RalphStoryOutcome = keyof RalphStoryOutcomes;

/** Story outcomes in chart order. */
export const RALPH_STORY_OUTCOMES = [
  "firstAttempt",
  "afterRetries",
  "exhausted",
  "blocked",
] as const satisfies readonly RalphStoryOutcome[];

export const RALPH_STORY_OUTCOME_LABELS: Record<RalphStoryOutcome, string> = {
  firstAttempt: "First attempt",
  afterRetries: "After retries",
  exhausted: "Exhausted",
  blocked: "Blocked",
};

/**
 * One chart row per UTC day: ralph and review tokens (in + out) side by side,
 * the runs started that day by status, and those runs' story outcomes. Both
 * token series cover the same days.
 */
export function ralphDailyRows(
  ralph: Pick<RalphAnalyticsData, "daily">,
  reviews: Pick<AnalyticsData, "daily">,
): ({ day: string; ralphTokens: number; reviewTokens: number } & Record<
  RalphRunOutcome | RalphStoryOutcome,
  number
>)[] {
  const reviewTokens = new Map(reviews.daily.map((d) => [d.date, d.tokensIn + d.tokensOut]));
  return ralph.daily.map((d) => ({
    day: dayLabel(d.date),
    ralphTokens: d.tokensIn + d.tokensOut,
    reviewTokens: reviewTokens.get(d.date) ?? 0,
    ...d.runs,
    ...d.stories,
  }));
}

/** A UTC day (`YYYY-MM-DD`) as a short axis label, e.g. "Oct 5". */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Value-axis ticks of a count chart: whole numbers only. The chart picks its
 * ticks itself (0, 0.5, 1, 1.5 … when the counts are small); the fractional
 * ones are left unlabelled.
 */
export function countTick(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : "";
}

/** The widest `formatTokens` value ("12.3M"). */
const TOKEN_TICK_WIDTH = 5;

/**
 * A token-axis tick, padded at the start with figure spaces (a digit's width in the
 * mono tick face) to one width. Charts size their y axis to its widest tick, so stacked
 * token charts that use this share a plot area, and a day sits at the same x in each.
 */
export function tokenTick(value: number): string {
  return formatTokens(value).padStart(TOKEN_TICK_WIDTH, "\u2007");
}

/** A review depth's label; reviews from before depths were recorded have none. */
export function depthLabel(depth: ReviewDepth | null): string {
  return depth ? REVIEW_DEPTHS[depth].label : "Not recorded";
}

/** Mean tokens per review across depths, weighted by their review counts. */
export function overallAverageTokens(byDepth: Analytics["byDepth"]): number {
  const reviews = byDepth.reduce((sum, p) => sum + p.reviews, 0);
  if (reviews === 0) return 0;
  return Math.round(byDepth.reduce((sum, p) => sum + p.averageTokens * p.reviews, 0) / reviews);
}

/** A 0–1 rate as a percentage, e.g. "37%" (one decimal under 10%). */
export function formatRate(rate: number): string {
  const percent = rate * 100;
  return `${percent > 0 && percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** The noun after a false-positive count: "1 false positive", "2 false positives". */
export function falsePositivesNoun(count: number): string {
  return count === 1 ? "false positive" : "false positives";
}
