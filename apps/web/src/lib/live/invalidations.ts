/**
 * What each live change event invalidates: the client half of the change-event catalogue
 * (`./events.ts`). Every resource maps to the query-key prefixes (from `queryKeys`) of the
 * queries that show it, narrowed by the event's `ids`, `runId`, `section` and `subjectId`
 * where it has them, so one run's transcript growing refetches that transcript only.
 *
 * A screen that shows a resource keys its queries under these prefixes, and a new event
 * (or section) is mapped here; the map is exhaustive, so an unmapped resource fails
 * typecheck. Safe to import in the browser.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { queryKeys, runsKeys, type QueryArea, type QueryKeys } from "@/lib/api/keys";
import { playbookKeys } from "@/lib/api/playbook-keys";
import type {
  ChangeEvent,
  ChangeEventOf,
  ChangeEventResource,
  SettingsSection,
  UntrackedSettingsSection,
  UserSettingsSection,
} from "./events";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /**
       * Live change events invalidate the query at most once per this many ms, the last
       * event of a burst delivered when its window ends (Analytics: 10 000).
       */
      liveThrottleMs?: number;
    };
  }
}

type Invalidator<R extends ChangeEventResource> = (
  event: ChangeEventOf<R>,
  keys: QueryKeys,
) => QueryKey[];

/** Each settings section's queries (the event's `subjectId` is its subject, if it has one). */
const SETTINGS_INVALIDATIONS: Record<
  SettingsSection | UntrackedSettingsSection | UserSettingsSection,
  (keys: QueryKeys, subjectId: string | undefined) => QueryKey[]
> = {
  "repository.reviews": (keys, id) => repositoryKeys(keys, id),
  "repository.coding": (keys, id) => repositoryKeys(keys, id),
  // Pins show on the repository and on the agents it's pinned to.
  "repository.agents": (keys, id) => [...repositoryKeys(keys, id), keys.agents.all],
  "repository.ask": (keys, id) => repositoryKeys(keys, id),
  "repository.playbooks": (keys, id) => repositoryKeys(keys, id),
  // The routing rules, and the tracker labels routing applies.
  routing_rules: (keys) => [
    keys.settings.detail("routing"),
    keys.settings.detail("tracker-labels"),
  ],
  connection: (keys) => [keys.connections.all],
  organization: (keys) => [keys.organization.all],
  // Agents and repositories show the defaults they inherit.
  agent_defaults: (keys) => [
    keys.settings.detail("agent-defaults"),
    keys.settings.detail("host-tools"),
    keys.agents.all,
    keys.repositories.all,
  ],
  // Playbooks list each other (PR description playbooks); repos and chat settings bind them.
  playbooks: (keys) => [
    playbookKeys(keys).all,
    keys.repositories.all,
    keys.connections.detail("integrations"),
  ],
  // The user's own record (their theme): no query shows it, the shell applies it.
  profile: () => [],
};

function repositoryKeys(keys: QueryKeys, repositoryId: string | undefined): QueryKey[] {
  return repositoryId
    ? [keys.repositories.lists, keys.repositories.detail(repositoryId)]
    : [keys.repositories.all];
}

/**
 * Every repository's list and detail: their status (running work, problems) and pinned
 * agents' state follow runs, agents and connections, whose events don't name the repository.
 */
function repositoryViews(keys: QueryKeys): QueryKey[] {
  return [keys.repositories.lists, [...keys.repositories.all, "detail"]];
}

/**
 * Every resource's invalidations. A run is shown by Runs (`runs`), the Inbox, Analytics and
 * its repository's status on Repos.
 */
export const LIVE_INVALIDATIONS = {
  run: (event, keys) =>
    event.runId
      ? [
          keys.runs.lists,
          keys.runs.detail(event.runId),
          keys.inbox.all,
          keys.analytics.all,
          ...repositoryViews(keys),
        ]
      : // System work (a repository sync, a cleanup) belongs to no run: Analytics counts it,
        // and a failed repository sync is a problem of its repository.
        [keys.analytics.all, ...repositoryViews(keys)],
  transcript: (event, keys) =>
    event.runId
      ? [keys.transcripts.detail(event.runId)]
      : event.ids.map((jobId) => keys.transcripts.detail(jobId)),
  pull_request: (event, keys) =>
    event.runId
      ? [keys.runs.lists, keys.runs.detail(event.runId), keys.inbox.all]
      : [keys.runs.all, keys.inbox.all],
  inbox_state: (_event, keys) => [keys.inbox.all],
  webhook_event: (event, keys) => [
    keys.deliveries.all,
    // Connection health shows the latest deliveries; its problems are repositories' problems.
    keys.connections.all,
    ...repositoryViews(keys),
    ...(event.runId ? [keys.runs.detail(event.runId)] : []),
  ],
  settings: (event, keys) => SETTINGS_INVALIDATIONS[event.section](keys, event.subjectId),
  agent: (event, keys) => [
    keys.agents.lists,
    ...event.ids.map((agentId) => keys.agents.detail(agentId)),
    // Agents offline or failing to update are Inbox problems.
    keys.inbox.all,
    // Repositories show their pinned agents' state and "No agent online".
    ...repositoryViews(keys),
  ],
  repository: (event, keys) => [
    keys.repositories.lists,
    ...event.ids.map((repositoryId) => keys.repositories.detail(repositoryId)),
    // A connection's setup and selectable repositories show which are connected.
    keys.connections.all,
    // The Runs screen's Repo filter lists the repositories.
    runsKeys(keys).filterOptionsAll,
  ],
  connection: (_event, keys) => [
    keys.connections.all,
    // Connection health problems are repositories' problems.
    ...repositoryViews(keys),
    runsKeys(keys).filterOptionsAll,
  ],
  organization: (_event, keys) => [keys.organization.all],
} satisfies Record<ChangeEvent["resource"], Invalidator<never>> & {
  [R in ChangeEventResource]: Invalidator<R>;
};

/** The query-key prefixes `event` invalidates, in its organization's keys. */
export function liveInvalidations(event: ChangeEvent): QueryKey[] {
  return invalidationsIn(event, queryKeys(event.organizationId));
}

function invalidationsIn(event: ChangeEvent, keys: QueryKeys): QueryKey[] {
  const invalidate = LIVE_INVALIDATIONS[event.resource] as Invalidator<typeof event.resource>;
  return invalidate(event as never, keys);
}

/**
 * Areas whose queries cover the whole organization scope (`organization=all` under "All
 * organizations"), keyed by the active organization like every query: an event of any
 * organization in the scope reaches them.
 */
export const SCOPE_WIDE_AREAS: readonly QueryArea[] = [
  "inbox",
  "runs",
  "transcripts",
  "repositories",
];

/**
 * The prefixes `event` invalidates in the cache of a scope: its own organization's keys,
 * plus, for the scope-wide areas (`SCOPE_WIDE_AREAS`), the same prefixes under every other
 * organization of the scope, since "All organizations" keys its Inbox, Runs and Repos
 * queries by the active one (Repos also opens any organization's repo under the active one's
 * keys).
 */
export function scopeInvalidations(event: ChangeEvent, scope: ReadonlySet<string>): QueryKey[] {
  const prefixes = liveInvalidations(event);
  for (const organizationId of scope) {
    if (organizationId === event.organizationId) continue;
    prefixes.push(
      ...invalidationsIn(event, queryKeys(organizationId)).filter((prefix) =>
        SCOPE_WIDE_AREAS.includes(prefix[1] as QueryArea),
      ),
    );
  }
  return prefixes;
}

/**
 * Whether an event on the user's own channel changed the user's own record, which the
 * shell applies in place (it re-renders from the server): their theme or advanced
 * settings preference (`settings` section `profile`) or their memberships (`organization`).
 */
export function changesUserRecord(event: ChangeEvent): boolean {
  return (
    event.resource === "organization" ||
    (event.resource === "settings" && event.section === "profile")
  );
}

export interface LiveInvalidator {
  /** Invalidates the queries `event` affects, if its organization is in `scope`. */
  apply(event: ChangeEvent, scope: ReadonlySet<string>): void;
  /** Cancels pending trailing invalidations. */
  dispose(): void;
}

/**
 * Applies change events to `client`'s cache: each matching query is invalidated (active
 * ones refetch). A query with `meta.liveThrottleMs` is invalidated at most once per that
 * window: the first event at once, later ones in the window by one trailing invalidation
 * when it ends, so the last event of a burst is never lost.
 */
export function createLiveInvalidator(
  client: QueryClient,
  options: { now?: () => number } = {},
): LiveInvalidator {
  const now = options.now ?? Date.now;
  // Per throttled query (by hash): when it was last invalidated, and its trailing timer.
  const throttled = new Map<string, { last: number; trailing?: ReturnType<typeof setTimeout> }>();

  const invalidate = (queryKey: QueryKey) => {
    void client.invalidateQueries({ queryKey, exact: true });
  };

  const throttle = (queryHash: string, queryKey: QueryKey, windowMs: number) => {
    const state = throttled.get(queryHash);
    const at = now();
    if (!state || (at - state.last >= windowMs && !state.trailing)) {
      throttled.set(queryHash, { last: at });
      invalidate(queryKey);
      return;
    }
    if (state.trailing) return;
    state.trailing = setTimeout(
      () => {
        throttled.set(queryHash, { last: now() });
        invalidate(queryKey);
      },
      state.last + windowMs - at,
    );
  };

  return {
    apply(event, scope) {
      if (!scope.has(event.organizationId)) return;
      const cache = client.getQueryCache();
      const seen = new Set<string>();
      for (const prefix of scopeInvalidations(event, scope)) {
        for (const query of cache.findAll({ queryKey: prefix })) {
          if (seen.has(query.queryHash)) continue;
          seen.add(query.queryHash);
          const windowMs = query.meta?.liveThrottleMs;
          if (windowMs && windowMs > 0) throttle(query.queryHash, query.queryKey, windowMs);
          else invalidate(query.queryKey);
        }
      }
    },
    dispose() {
      for (const state of throttled.values()) clearTimeout(state.trailing);
      throttled.clear();
    },
  };
}
