/**
 * Client-safe links to the Runs screen: `/runs` (the unified run list) and `/runs/{id}`
 * (one run of any kind). Chat replies, Linear messages and redirects from the old Coding
 * pages (`/ralph`, `/coding`) all point here.
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

/** A run's page on the Runs screen. */
export function runHref(runId: string): string {
  return `${RUNS_PATH}/${runId}`;
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
