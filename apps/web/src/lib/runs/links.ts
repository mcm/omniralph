/**
 * Client-safe links to the Runs screen: `/runs` (the unified run list) and `/runs/{id}`
 * (one run of any kind, optionally on a step, attempt and tab). Chat replies, tracker
 * messages, rules' source findings and every other link to a run point here.
 */
import type { RunKind, RunStatus } from "@omniralph/db";

/** The Runs screen's list. */
export const RUNS_PATH = "/runs";

/** The Runs screen's filters, as `GET /api/ui/runs` takes them (`kind`, `status`, `repository` repeat). */
export interface RunListLinkFilter {
  kind?: readonly RunKind[];
  status?: readonly RunStatus[];
  /** One repository (a chat tool's filter). */
  repositoryId?: string | null;
  /** Any of these repositories (`repository` repeats). */
  repository?: readonly string[];
}

/** What a run's page opens on: a step, one of its attempts and a step panel tab. */
export interface RunLinkState {
  step?: string | null;
  attempt?: string | null;
  tab?: "transcript" | "diff" | "findings" | "attempts" | null;
}

/** A run's page on the Runs screen: `/runs/{id}?step=&attempt=&tab=` (empty ones omitted). */
export function runHref(runId: string, state: RunLinkState = {}): string {
  const search = new URLSearchParams();
  for (const key of ["step", "attempt", "tab"] as const) {
    const value = state[key];
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return `${RUNS_PATH}/${runId}${query ? `?${query}` : ""}`;
}

/** The Runs screen's list with `filter` as search params (empty filters omitted). */
export function runListHref(filter: RunListLinkFilter = {}): string {
  const search = new URLSearchParams();
  for (const kind of filter.kind ?? []) search.append("kind", kind);
  for (const status of filter.status ?? []) search.append("status", status);
  const repositories = [
    ...(filter.repositoryId ? [filter.repositoryId] : []),
    ...(filter.repository ?? []),
  ];
  for (const repository of new Set(repositories)) search.append("repository", repository);
  const query = search.toString();
  return query ? `${RUNS_PATH}?${query}` : RUNS_PATH;
}
