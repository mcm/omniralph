import { RUN_KINDS, RUN_STATUSES, type RunRow } from "@/lib/api/runs";
import { runListHref } from "@/lib/runs/hrefs";

type RunKind = RunRow["kind"];
type RunStatus = RunRow["status"];

/** The Runs screen's filters, from the URL (`?kind=&status=&repository=`, each repeatable). */
export interface RunFilters {
  kind: RunKind[];
  status: RunStatus[];
  /** Repository IDs. */
  repository: string[];
}

export const NO_RUN_FILTERS: RunFilters = { kind: [], status: [], repository: [] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const known = <T extends string>(values: readonly T[], wanted: readonly string[]): T[] => {
  const set = new Set(wanted);
  return values.filter((value) => set.has(value));
};

/**
 * Reads the Runs filters from search params: known kinds and statuses (in their canonical
 * order) and repository IDs, each once. `page`, unknown parameters and unknown values are
 * dropped.
 */
export function parseRunFilters(params: Pick<URLSearchParams, "getAll">): RunFilters {
  return {
    kind: known(RUN_KINDS, params.getAll("kind")),
    status: known(RUN_STATUSES, params.getAll("status")),
    repository: [...new Set(params.getAll("repository").filter((id) => UUID.test(id)))],
  };
}

/** Whether any filter narrows the list. */
export function hasRunFilters(filters: RunFilters): boolean {
  return filters.kind.length + filters.status.length + filters.repository.length > 0;
}

/** The Runs list's URL with `filters`. */
export function runFiltersHref(filters: RunFilters): string {
  return runListHref(filters);
}

/** A run's URL on the Runs screen, keeping the rail's filters. */
export function runInListHref(runId: string, filters: RunFilters): string {
  const list = runListHref(filters);
  const query = list.indexOf("?");
  return `/runs/${runId}${query === -1 ? "" : list.slice(query)}`;
}
