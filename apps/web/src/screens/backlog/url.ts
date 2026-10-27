/** The Backlog's filters, from the URL (`?source=&repo=`, each a single choice). */
export interface BacklogFilters {
  /** A source's value (`workItemSourceValue`, e.g. `linear:project:<id>`); null for All. */
  source: string | null;
  /** A repository ID; null for All. */
  repo: string | null;
}

export const NO_BACKLOG_FILTERS: BacklogFilters = { source: null, repo: null };

/** Reads the Backlog filters from search params; empty values mean All, others are dropped. */
export function parseBacklogFilters(params: Pick<URLSearchParams, "get">): BacklogFilters {
  return {
    source: params.get("source") || null,
    repo: params.get("repo") || null,
  };
}

/** Whether any filter narrows the list. */
export function hasBacklogFilters(filters: BacklogFilters): boolean {
  return filters.source !== null || filters.repo !== null;
}

function search(filters: BacklogFilters): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.repo) params.set("repo", filters.repo);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The Backlog list's URL with `filters`: `/backlog?source=&repo=`. */
export function backlogHref(filters: BacklogFilters = NO_BACKLOG_FILTERS): string {
  return `/backlog${search(filters)}`;
}

/** A work item's URL on the Backlog, keeping the list's filters: `/backlog/{id}?source=&repo=`. */
export function backlogItemHref(
  workItemId: string,
  filters: BacklogFilters = NO_BACKLOG_FILTERS,
): string {
  return `/backlog/${encodeURIComponent(workItemId)}${search(filters)}`;
}
