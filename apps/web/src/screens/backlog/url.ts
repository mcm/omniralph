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

/** The work item detail's tabs (`?tab=`); PRD, the first, is the default and not in the URL. */
export const WORK_ITEM_TABS = ["prd", "stories", "activity"] as const;
export type WorkItemTab = (typeof WORK_ITEM_TABS)[number];

/** The detail's tab from search params: PRD unless `?tab=` names another one. */
export function parseWorkItemTab(params: Pick<URLSearchParams, "get">): WorkItemTab {
  const tab = params.get("tab");
  return WORK_ITEM_TABS.find((value) => value === tab) ?? "prd";
}

function search(filters: BacklogFilters, tab: WorkItemTab = "prd"): string {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.repo) params.set("repo", filters.repo);
  if (tab !== "prd") params.set("tab", tab);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The Backlog list's URL with `filters`: `/backlog?source=&repo=`. */
export function backlogHref(filters: BacklogFilters = NO_BACKLOG_FILTERS): string {
  return `/backlog${search(filters)}`;
}

/**
 * A work item's URL on the Backlog, keeping the list's filters, with its tab (other than
 * PRD): `/backlog/{id}?source=&repo=&tab=`.
 */
export function backlogItemHref(
  workItemId: string,
  filters: BacklogFilters = NO_BACKLOG_FILTERS,
  tab: WorkItemTab = "prd",
): string {
  return `/backlog/${encodeURIComponent(workItemId)}${search(filters, tab)}`;
}

/** The search param that opens the New work item sheet on the Backlog (`?new=1`). */
export const NEW_WORK_ITEM_PARAM = "new";

/** Whether the URL opens the New work item sheet. */
export function isNewWorkItemOpen(params: Pick<URLSearchParams, "get">): boolean {
  return params.get(NEW_WORK_ITEM_PARAM) === "1";
}

/**
 * Where New work item goes from `pathname` and `search`: on a Backlog page, the same URL with
 * `?new=1` (keeping the filters and the open item); anywhere else, `/backlog?new=1`.
 */
export function newWorkItemHref(pathname: string, search: string): string {
  const onBacklog = pathname === "/backlog" || pathname.startsWith("/backlog/");
  const params = new URLSearchParams(onBacklog ? search : "");
  params.set(NEW_WORK_ITEM_PARAM, "1");
  return `${onBacklog ? pathname : "/backlog"}?${params.toString()}`;
}

/** The URL with the New work item sheet closed: `?new=` removed. */
export function closedNewWorkItemHref(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(NEW_WORK_ITEM_PARAM);
  const text = params.toString();
  return text ? `${pathname}?${text}` : pathname;
}
