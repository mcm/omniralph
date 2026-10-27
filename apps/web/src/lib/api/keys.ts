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
  "backlog",
  "chatAccounts",
  "connections",
  "deliveries",
  "diffs",
  "agents",
  "inbox",
  "navIndicators",
  "organization",
  "repositories",
  "runs",
  "settings",
  "settingsHistory",
  "transcripts",
  "workItems",
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
 * Query keys of Analytics (`GET /api/ui/analytics/runs`): one per window, repository and
 * organization scope (`all`, or an organization's id). A `run` change event of an
 * organization invalidates the queries covering it (`covering`): those of that organization
 * and the `all` ones, never another single organization's. `analytics` is a scope-wide area,
 * so under "All organizations" every organization's run events reach the active one's keys.
 */
export function analyticsKeys(keys: QueryKeys) {
  return {
    all: keys.analytics.all,
    list: (params: { days: number; repositoryId: string | null; organization: string }) =>
      keys.analytics.list(params),
    /** Prefixes of every query whose scope includes `organizationId`. */
    covering: (organizationId: string): QueryKey[] => [
      keys.analytics.list({ organization: organizationId }),
      keys.analytics.list({ organization: "all" }),
    ],
  };
}

/**
 * Query keys of a connection's webhook delivery log (`GET /api/ui/connections/{scm|linear}/
 * {id}/deliveries`): one list per outcome filter (all its pages), under the connection's
 * key, which a `webhook_event` change event naming the connection invalidates.
 */
export function deliveryKeys(keys: QueryKeys) {
  return {
    all: keys.deliveries.all,
    /** Every filter and page of one connection's log. */
    connection: (connectionId: string) => keys.deliveries.detail(connectionId),
    list: (connectionId: string, filter: string) =>
      keys.deliveries.part(connectionId, "list", { filter }),
  };
}

/**
 * The query key of the Fleet and Settings nav dots (`GET /api/ui/nav-indicators`), keyed by
 * organization scope: Fleet counts the scope's agents, Settings the active organization's
 * deliveries. Its own scope-wide area, which `agent`, `webhook_event`, `connection` and the
 * version policy's events invalidate.
 */
export function navIndicatorsKey(keys: QueryKeys, scope: string): QueryKey {
  return keys.navIndicators.detail(scope);
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

/**
 * Query keys of a settings section's change history (`GET /api/ui/settings-history`),
 * subject first (a repository or connection ID, `none` for organization-wide sections), so
 * a `repository` event reaches its repository's histories and a `settings` event its
 * section's. Scope-wide: a repository of another organization keeps its history under the
 * active organization's keys.
 */
export function settingsHistoryKeys(keys: QueryKeys) {
  const subjectKey = (subject: string | undefined) => subject ?? "none";
  return {
    all: keys.settingsHistory.all,
    subject: (subject: string | undefined): QueryKey => [
      ...keys.settingsHistory.all,
      subjectKey(subject),
    ],
    section: (section: string, subject: string | undefined): QueryKey => [
      ...keys.settingsHistory.all,
      subjectKey(subject),
      section,
    ],
    history: (
      section: string,
      subject: string | undefined,
      organization: string | undefined,
    ): QueryKey => [
      ...keys.settingsHistory.all,
      subjectKey(subject),
      section,
      { organization: organization ?? null },
    ],
  };
}

/**
 * Query keys of the Backlog (`/api/ui/backlog/**`), keyed by organization scope: a list per
 * filters, the counts (the nav count), Up next and New work item's repos, all under `keys.backlog.all`, which a
 * `work_item` change event invalidates. A work item's detail and its parts (share links) sit
 * under `keys.workItems.detail(id)` (`id` = the work item URL ID, `linear-<issue id>`).
 */
export function backlogKeys(keys: QueryKeys) {
  return {
    all: keys.backlog.all,
    lists: keys.backlog.lists,
    list: (filters: { source?: string | null; repo?: string | null }, scope: string) =>
      keys.backlog.list({
        source: filters.source ?? "",
        repo: filters.repo ?? "",
        organization: scope,
      }),
    counts: (scope: string) => [...keys.backlog.all, "counts", { organization: scope }] as QueryKey,
    upNext: (scope: string) =>
      [...keys.backlog.all, "up-next", { organization: scope }] as QueryKey,
    /** New work item's repos (`GET /api/ui/work-items/targets`). */
    targets: (scope: string) =>
      [...keys.backlog.all, "targets", { organization: scope }] as QueryKey,
    detail: (id: string) => keys.workItems.detail(id),
    /** Every work item's detail. */
    details: [...keys.workItems.all, "detail"] as QueryKey,
  };
}

/**
 * Query keys of Settings' connections (`GET /api/ui/connections`): the active organization's
 * only, so they sit in the `settings` area, which (unlike `connections`) is not scope-wide:
 * a `connection` event of the organization refetches them, another organization's doesn't.
 */
export function connectionKeys(keys: QueryKeys) {
  return {
    list: keys.settings.detail("connections"),
    /**
     * Every tracker connection's work item state mapping (Linear's connection page), apart
     * from the list so a delivery or repository event (which refetch the list) doesn't call
     * the tracker for its workflow states.
     */
    stateMappings: keys.settings.detail("tracker-state-mapping"),
    stateMapping: (integrationId: string) =>
      keys.settings.part("tracker-state-mapping", integrationId),
  };
}

/**
 * The query key of Advanced › Chat channel overrides (`GET /api/ui/integrations/chat-tasks`):
 * the active organization's chat playbooks and channel overrides, in the `settings` area (not
 * scope-wide). A `chat_playbooks` settings event refetches it, and so do playbook saves (the
 * names it shows) and `connection` events (the chat connections it lists).
 */
export function chatPlaybooksKey(keys: QueryKeys) {
  return keys.settings.detail("chat-playbooks");
}

/**
 * Query keys of the active organization's settings (`GET /api/ui/organization`): its name,
 * members, invitations and domains. An `organization` event of the organization refetches
 * them; the shell's organization name follows their cached answer (`LiveCurrentUser`).
 */
export function organizationKeys(keys: QueryKeys) {
  return {
    settings: keys.organization.detail("settings"),
  };
}
