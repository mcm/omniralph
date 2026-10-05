/**
 * Client-safe parts of the Analytics page: the window and repository filter
 * in the URL, view-prop types and chart labels.
 */
import type { Analytics, AnalyticsRange } from "@omniralph/db";

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
 * URL search params. A repository that isn't one of `repositoryIds` is ignored.
 */
export function parseAnalyticsParams(
  params: SearchParams,
  repositoryIds: readonly string[],
): AnalyticsParams {
  const days = Number(single(params.days));
  const repo = single(params.repo);
  return {
    days: (ANALYTICS_RANGES as readonly number[]).includes(days)
      ? (days as AnalyticsRange)
      : DEFAULT_ANALYTICS_RANGE,
    repositoryId: repo && repositoryIds.includes(repo) ? repo : null,
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

/** A UTC day (`YYYY-MM-DD`) as a short axis label, e.g. "Oct 5". */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Mean tokens per review across profiles, weighted by their review counts. */
export function overallAverageTokens(byProfile: Analytics["byProfile"]): number {
  const reviews = byProfile.reduce((sum, p) => sum + p.reviews, 0);
  if (reviews === 0) return 0;
  return Math.round(byProfile.reduce((sum, p) => sum + p.averageTokens * p.reviews, 0) / reviews);
}

/** A 0–1 rate as a percentage, e.g. "37%" (one decimal under 10%). */
export function formatRate(rate: number): string {
  const percent = rate * 100;
  return `${percent > 0 && percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}
