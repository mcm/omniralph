/**
 * Client-safe parts of the Analytics screen: the window and repository filter in the URL,
 * the bucket each window uses, the response's dates as strings, and the labels, formats
 * and chart summaries the screen shows.
 */
import type {
  AnalyticsRange,
  AnalyticsRepository,
  RunAnalytics,
  RunAnalyticsBucket,
} from "@omniralph/db";

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

/** Client-safe copy of the DB's `RUN_ANALYTICS_BUCKETS`. */
export const RUN_ANALYTICS_BUCKETS = [
  "day",
  "week",
] as const satisfies readonly RunAnalyticsBucket[];

/** The bucket a window is charted by: days for 7 and 30 days, (UTC, Monday) weeks for 90. */
export function bucketFor(days: AnalyticsRange): RunAnalyticsBucket {
  return days === 90 ? "week" : "day";
}

/** `RunAnalytics` with its dates as ISO strings. */
export type RunAnalyticsData = Omit<RunAnalytics, "from" | "to"> & { from: string; to: string };

export function runAnalyticsData(analytics: RunAnalytics): RunAnalyticsData {
  return { ...analytics, from: analytics.from.toISOString(), to: analytics.to.toISOString() };
}

/**
 * What `GET /api/ui/analytics/runs` answers: the figures, every repository of the scope
 * (the filter's choices) and the filters as the server applied them (a repository outside
 * the scope is ignored: `repositoryId: null`).
 */
export type RunAnalyticsPayload = RunAnalyticsData & {
  repositories: AnalyticsRepository[];
  params: { days: AnalyticsRange; bucket: RunAnalyticsBucket; repositoryId: string | null };
};

/** A UTC day (`YYYY-MM-DD`) as a short axis label, e.g. "Oct 5". */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A week bucket (its Monday, `YYYY-MM-DD`), e.g. "Week of Oct 5". */
export function weekLabel(start: string): string {
  return `Week of ${dayLabel(start)}`;
}

/** A bucket's label: "Oct 5" for a day, "Week of Oct 5" for a week. */
export function bucketLabel(start: string, bucket: RunAnalyticsBucket): string {
  return bucket === "week" ? weekLabel(start) : dayLabel(start);
}

/** A 0–1 rate as a percentage, e.g. "37%" (one decimal under 10%). */
export function formatRate(rate: number): string {
  const percent = rate * 100;
  return `${percent > 0 && percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** US dollars with two decimals, e.g. "$1,234.50". */
export function formatUsd(amount: number): string {
  return usd.format(amount);
}

/**
 * Whether the response prices its tokens (`totals.costUsd`, set by Epic 12): only then does
 * the screen show the Cost tile, chart and columns.
 */
export function hasCost(response: { totals: { costUsd?: number } }): boolean {
  return typeof response.totals.costUsd === "number";
}

/** "Excludes 1 attempt with no list price", "Excludes 3 attempts with no list price". */
export function unpricedLabel(count: number): string {
  return `Excludes ${count} ${count === 1 ? "attempt" : "attempts"} with no list price`;
}

const DAY_MS = 86_400_000;

export interface ChartSummaryInput {
  /** What the chart shows, e.g. "Stories completed". */
  title: string;
  bucket: RunAnalyticsBucket;
  /** The window, as the response sends it (`to` exclusive). */
  from: string;
  to: string;
  points: readonly { start: string; value: number | null }[];
  format: (value: number) => string;
  /**
   * `total`: the window's sum and the highest bucket. `rate`: the window's overall rate
   * (null when nothing was rated) and the lowest bucket.
   */
  measure: { kind: "total" } | { kind: "rate"; overall: number | null };
}

/** Where a bucket sits in a sentence: "on Oct 12", "in the week of Oct 5". */
function atBucket(start: string, bucket: RunAnalyticsBucket): string {
  return bucket === "week" ? `in the week of ${dayLabel(start)}` : `on ${dayLabel(start)}`;
}

/**
 * A chart's one-sentence summary, its accessible name: "Stories completed per day, Sep 25
 * to Oct 24: 42 in total, most on Oct 12 (7)", or "Success rate per day, Sep 25 to Oct 24:
 * 96% overall, lowest on Oct 3 (80%)".
 */
export function chartSummary({
  title,
  bucket,
  from,
  to,
  points,
  format,
  measure,
}: ChartSummaryInput): string {
  const first = from.slice(0, 10);
  const last = new Date(Date.parse(to) - DAY_MS).toISOString().slice(0, 10);
  const head = `${title} per ${bucket}, ${dayLabel(first)} to ${dayLabel(last)}`;
  const valued = points.filter(
    (point): point is { start: string; value: number } => point.value !== null,
  );
  if (measure.kind === "rate") {
    if (measure.overall === null || valued.length === 0) return `${head}: no finished attempts`;
    const lowest = valued.reduce((low, point) => (point.value < low.value ? point : low));
    return `${head}: ${format(measure.overall)} overall, lowest ${atBucket(lowest.start, bucket)} (${format(lowest.value)})`;
  }
  const total = valued.reduce((sum, point) => sum + point.value, 0);
  if (total === 0) return `${head}: none`;
  const most = valued.reduce((high, point) => (point.value > high.value ? point : high));
  return `${head}: ${format(total)} in total, most ${atBucket(most.start, bucket)} (${format(most.value)})`;
}
