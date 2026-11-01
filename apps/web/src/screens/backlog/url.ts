/**
 * The Backlog's filters and toggles, from the URL: `?source=&repo=` (each a single choice) and
 * `?blocked=show` / `?manual=show` (the Up next and Manual groups shown; absent means hidden).
 */
export interface BacklogFilters {
  /** A source's value (`workItemSourceValue`, e.g. `<tracker>:project:<id>`); null for All. */
  source: string | null;
  /** A repository ID; null for All. */
  repo: string | null;
  /** Whether the Up next group (blocked items) is shown (`?blocked=show`). */
  blocked: boolean;
  /** Whether the Manual group (manual tasks) is shown (`?manual=show`). */
  manual: boolean;
}

export const NO_BACKLOG_FILTERS: BacklogFilters = {
  source: null,
  repo: null,
  blocked: false,
  manual: false,
};

/** The value of `?blocked=` and `?manual=` that shows their group. */
const SHOW = "show";

/** Reads the Backlog filters from search params; empty values mean All, others are dropped. */
export function parseBacklogFilters(params: Pick<URLSearchParams, "get">): BacklogFilters {
  return {
    source: params.get("source") || null,
    repo: params.get("repo") || null,
    blocked: params.get("blocked") === SHOW,
    manual: params.get("manual") === SHOW,
  };
}

/** Whether any filter narrows the list. The Show blocked and Show manual toggles aren't filters. */
export function hasBacklogFilters(filters: BacklogFilters): boolean {
  return filters.source !== null || filters.repo !== null;
}

/** `filters` with Source and Repo back at All, keeping the Show blocked and Show manual toggles. */
export function clearBacklogFilters(filters: BacklogFilters): BacklogFilters {
  return { ...filters, source: null, repo: null };
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
  if (filters.blocked) params.set("blocked", SHOW);
  if (filters.manual) params.set("manual", SHOW);
  if (tab !== "prd") params.set("tab", tab);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The Backlog list's URL with `filters`: `/backlog?source=&repo=&blocked=&manual=`. */
export function backlogHref(filters: BacklogFilters = NO_BACKLOG_FILTERS): string {
  return `/backlog${search(filters)}`;
}

/**
 * A work item's URL on the Backlog, keeping the list's filters, with its tab (other than
 * PRD): `/backlog/{id}?source=&repo=&blocked=&manual=&tab=`.
 */
export function backlogItemHref(
  workItemId: string,
  filters: BacklogFilters = NO_BACKLOG_FILTERS,
  tab: WorkItemTab = "prd",
): string {
  return `/backlog/${encodeURIComponent(workItemId)}${search(filters, tab)}`;
}
