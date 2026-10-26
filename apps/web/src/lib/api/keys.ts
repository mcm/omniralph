import type { QueryKey } from "@tanstack/react-query";

/**
 * Areas of the panel with their own queries. A mutation invalidates an area's `all` key
 * to refetch every list and detail of it. Transcripts are their own area, keyed by run
 * (`transcripts.detail(runId)`), so a run's live changes don't refetch its transcript.
 * Diffs are their own area too, which no change event invalidates: a commit's diff never
 * changes.
 */
export const QUERY_AREAS = [
  "analytics",
  "chatAccounts",
  "connections",
  "deliveries",
  "diffs",
  "agents",
  "inbox",
  "jobs",
  "organization",
  "repositories",
  "reviews",
  "runs",
  "settings",
  "transcripts",
  "triage",
] as const;
export type QueryArea = (typeof QUERY_AREAS)[number];

/** List filters and pagination, as read from the URL's search params. */
export type ListParams = Record<string, string | number | boolean | null | undefined>;

export interface AreaKeys {
  /** Prefix of every key of the area: invalidates its lists and details. */
  all: QueryKey;
  /** Prefix of the area's lists: invalidates every filter and page. */
  lists: QueryKey;
  /** One list: a filter and page. */
  list: (params?: ListParams) => QueryKey;
  /** One entity (an agent, a run, …). */
  detail: (id: string) => QueryKey;
  /** A sub-resource of one entity (an agent's runs, a repository's rules tab, …). */
  part: (id: string, part: string, params?: ListParams) => QueryKey;
}

export type QueryKeys = { [area in QueryArea]: AreaKeys } & {
  /** Every query of the organization. */
  all: QueryKey;
};

/**
 * The query-key factory: every key the panel uses comes from here and starts with the
 * active organization's id, so one organization's data is never served from another's
 * cache (and `QueryProvider` drops the other organizations' queries on a switch).
 * Keys nest by prefix: `[org, area]` ⊃ `[org, area, "list"]` ⊃ `[org, area, "list", params]`,
 * and `[org, area, "detail", id]` ⊃ `[org, area, "detail", id, part, params]`, so
 * invalidating a shorter key refetches everything under it.
 */
export function queryKeys(organizationId: string): QueryKeys {
  const area = (name: QueryArea): AreaKeys => ({
    all: [organizationId, name],
    lists: [organizationId, name, "list"],
    list: (params = {}) => [organizationId, name, "list", params],
    detail: (id) => [organizationId, name, "detail", id],
    part: (id, part, params = {}) => [organizationId, name, "detail", id, part, params],
  });
  return {
    all: [organizationId],
    ...(Object.fromEntries(QUERY_AREAS.map((name) => [name, area(name)])) as {
      [name in QueryArea]: AreaKeys;
    }),
  };
}

/**
 * Query keys of the Inbox (`/api/ui/inbox/**`), keyed by organization scope (`all`, or an
 * organization's id; `useScopeParam`): a feed per tab, and the tab counts. Every Inbox
 * query sits under `keys.inbox.all`, which the live data layer invalidates.
 */
export function inboxKeys(keys: QueryKeys) {
  return {
    all: keys.inbox.all,
    feeds: keys.inbox.lists,
    feed: (tab: string, scope: string) => keys.inbox.list({ tab, organization: scope }),
    counts: (scope: string) => [...keys.inbox.all, "counts", { organization: scope }] as QueryKey,
  };
}

/**
 * Query keys of the Runs screen's lists (`/api/ui/runs`), keyed by organization scope: a
 * list per filters (all its pages), and the filters' options. Every list sits under
 * `keys.runs.lists`, which a `run` change event invalidates; a run's detail, Session and
 * findings sit under `keys.runs.detail(id)`. A story's diff is keyed by its commit in the
 * `diffs` area, out of every change event's reach.
 */
export function runsKeys(keys: QueryKeys) {
  return {
    all: keys.runs.all,
    lists: keys.runs.lists,
    list: (
      filters: {
        kind: readonly string[];
        status: readonly string[];
        repository: readonly string[];
      },
      scope: string,
    ) =>
      keys.runs.list({
        kind: filters.kind.join(","),
        status: filters.status.join(","),
        repository: filters.repository.join(","),
        organization: scope,
      }),
    filterOptions: (scope: string) =>
      [...keys.runs.all, "filter-options", { organization: scope }] as QueryKey,
    filterOptionsAll: [...keys.runs.all, "filter-options"] as QueryKey,
    diff: (runId: string, stepId: string, commit: string) =>
      keys.diffs.part(runId, "story", { step: stepId, commit }),
  };
}
