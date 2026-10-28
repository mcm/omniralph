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
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import {
  analyticsKeys,
  askKeys,
  backlogKeys,
  chatPlaybooksKey,
  connectionKeys,
  queryKeys,
  runsKeys,
  settingsHistoryKeys,
  type QueryArea,
  type QueryKeys,
} from "@/lib/api/keys";
import { playbookKeys } from "@/lib/api/playbook-keys";
import {
  SETTINGS_SECTIONS,
  type ChangeEvent,
  type ChangeEventOf,
  type ChangeEventResource,
  type SettingsSection,
  type UntrackedSettingsSection,
  type UserSettingsSection,
} from "./events";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /**
       * Live change events invalidate the query at most once per this many ms, the last
       * event of a burst delivered when its window ends (Analytics: 10 000).
       */
      liveThrottleMs?: number;
      /**
       * Runs whose `run` and `transcript` events (by `runId`) also invalidate the query, for
       * a view that follows runs outside its own keys (an Ask chat's asks in flight).
       */
      liveRunIds?: readonly string[];
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
  // Coding on or off, or a changed work item match, changes which items the Backlog lists; a
  // work item match makes a repo use the Linear tracker (Settings' connections count them).
  "repository.coding": (keys, id) => [
    ...repositoryKeys(keys, id),
    keys.backlog.all,
    connectionKeys(keys).list,
  ],
  // Pins show on the repository and on the agents it's pinned to.
  "repository.agents": (keys, id) => [...repositoryKeys(keys, id), keys.agents.all],
  "repository.ask": (keys, id) => repositoryKeys(keys, id),
  // Advanced › Playbooks shows the repos each playbook is bound to.
  "repository.playbooks": (keys, id) => [...repositoryKeys(keys, id), playbookKeys(keys).all],
  // The routing rules, and the tracker labels routing applies; the Backlog routes by them.
  routing_rules: (keys) => [
    keys.settings.detail("routing"),
    keys.settings.detail("tracker-labels"),
    keys.backlog.all,
  ],
  connection: (keys) => [keys.connections.all],
  organization: (keys) => [keys.organization.all],
  // Agents and repositories show the defaults they inherit.
  agent_defaults: (keys) => [
    keys.settings.detail("agent-defaults"),
    // The version agents should run decides which failed their update (the Fleet dot).
    keys.navIndicators.all,
    keys.settings.detail("host-tools"),
    keys.agents.all,
    keys.repositories.all,
  ],
  // Playbooks list each other (PR description playbooks); repos and chat settings bind them.
  playbooks: (keys) => [
    playbookKeys(keys).all,
    keys.repositories.all,
    keys.connections.detail("integrations"),
    chatPlaybooksKey(keys),
  ],
  // The playbooks chat runs (Advanced › Chat channel overrides), which playbooks list as users.
  chat_playbooks: (keys) => [
    chatPlaybooksKey(keys),
    playbookKeys(keys).all,
    keys.connections.detail("integrations"),
  ],
  // The user's own record (their theme): no query shows it, the shell applies it.
  profile: () => [],
  // The user's linked chat accounts (Settings › Linked chat accounts), in every organization.
  linked_accounts: (keys) => [keys.chatAccounts.all],
};

function isTrackedSection(
  section: SettingsSection | UntrackedSettingsSection | UserSettingsSection,
): section is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(section);
}

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
 * its repository's status on Repos. Analytics is invalidated by `run` events only (they
 * cover runs, stories, reviews and attempts, every figure it shows), and only its queries
 * whose scope covers the event's organization (`analyticsKeys(…).covering`).
 */
export const LIVE_INVALIDATIONS = {
  run: (event, keys) =>
    event.runId
      ? [
          keys.runs.lists,
          keys.runs.detail(event.runId),
          keys.inbox.all,
          ...analyticsKeys(keys).covering(event.organizationId),
          ...repositoryViews(keys),
          // A work item's detail shows its run (whether its PRD can be edited).
          backlogKeys(keys).details,
        ]
      : // System work (a repository sync, a cleanup) belongs to no run: its attempts count
        // in Analytics, and a failed repository sync is a problem of its repository.
        [...analyticsKeys(keys).covering(event.organizationId), ...repositoryViews(keys)],
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
    // The delivery's own detail and its connection's log (`ids` name both, and a replay's
    // original), never another connection's.
    ...event.ids.map((id) => keys.deliveries.detail(id)),
    // Connection health shows the latest deliveries; its problems are repositories' problems.
    keys.connections.all,
    // Settings' connections count each connection's failed deliveries not yet replayed.
    connectionKeys(keys).list,
    // The Settings and connection dots.
    keys.navIndicators.all,
    ...repositoryViews(keys),
    ...(event.runId ? [keys.runs.detail(event.runId)] : []),
  ],
  settings: (event, keys) => [
    ...SETTINGS_INVALIDATIONS[event.section](keys, event.subjectId),
    // An open change history (the info button) of the section.
    ...(isTrackedSection(event.section)
      ? [settingsHistoryKeys(keys).section(event.section, event.subjectId)]
      : []),
  ],
  agent: (event, keys) => [
    keys.agents.lists,
    ...event.ids.map((agentId) => keys.agents.detail(agentId)),
    // Agents offline or failing to update are Inbox problems, and the Fleet dot.
    keys.inbox.all,
    keys.navIndicators.all,
    // Repositories show their pinned agents' state and "No agent online".
    ...repositoryViews(keys),
    // The playbook editor offers the models and MCP servers agents report.
    playbookKeys(keys).formOptions,
  ],
  repository: (event, keys) => [
    keys.repositories.lists,
    ...event.ids.map((repositoryId) => keys.repositories.detail(repositoryId)),
    // A connection's setup and selectable repositories show which are connected.
    keys.connections.all,
    // Settings' connections count the repos using each.
    connectionKeys(keys).list,
    // The Runs screen's Repo filter lists the repositories.
    runsKeys(keys).filterOptionsAll,
    // An open change history of one of the repository's cards.
    ...event.ids.map((repositoryId) => settingsHistoryKeys(keys).subject(repositoryId)),
    // The Backlog lists work items that route to connected repos with Coding on.
    keys.backlog.all,
    // Advanced › Playbooks lists the repos bound to each playbook.
    playbookKeys(keys).all,
  ],
  connection: (_event, keys) => [
    keys.connections.all,
    // Settings' connections (its section nav and connection pages).
    connectionKeys(keys).list,
    // A disconnected connection's failed deliveries leave the Settings dot.
    keys.navIndicators.all,
    // A tracker connection's work item states (a save by another admin, a disconnect).
    connectionKeys(keys).stateMappings,
    // The chat connections whose channels Advanced › Chat channel overrides lists.
    chatPlaybooksKey(keys),
    // Connection health problems are repositories' problems.
    ...repositoryViews(keys),
    runsKeys(keys).filterOptionsAll,
    // A tracker connection's state mapping decides the Backlog's groups.
    keys.backlog.all,
  ],
  organization: (_event, keys) => [keys.organization.all],
  // The Backlog's list, counts and Up next, and the named items' details and share links.
  work_item: (event, keys) => [
    keys.backlog.all,
    ...event.ids.map((id) => backlogKeys(keys).detail(id)),
  ],
  // The viewer's chats lists (a chat's title and activity order them) and the named chats.
  chat: (event, keys) => [
    askKeys(keys).chatLists,
    ...event.ids.map((chatId) => askKeys(keys).chat(chatId)),
  ],
  // New or changed list prices change Cost: every run's detail and Analytics, nothing else.
  model_prices: (event, keys) => [
    [...keys.runs.all, "detail"],
    ...analyticsKeys(keys).covering(event.organizationId),
  ],
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
  "settingsHistory",
  // The add-repo sheet lists the connections of any organization the user is an admin of.
  "connections",
  // The Backlog lists every organization's work items, and opens any of them.
  "backlog",
  "workItems",
  // Fleet lists every organization's agents, and opens any of them, under the active one's keys.
  "agents",
  // The Fleet dot counts every organization's agents under "All organizations".
  "navIndicators",
  // Analytics under "All organizations" counts every organization's runs (`organization=all`).
  "analytics",
  // Ask lists the viewer's chats of every organization, and opens any of them.
  "ask",
];

/**
 * Areas whose queries show the user's own data across every organization they belong to
 * (their linked chat accounts), keyed by the active organization: an event on the user's
 * own channel reaches them from any of the user's organizations, in the scope or not.
 */
export const USER_WIDE_AREAS: readonly QueryArea[] = ["chatAccounts"];

/** `event`'s prefixes in the user-wide areas, under each organization of the scope. */
function userWideInvalidations(event: ChangeEvent, scope: ReadonlySet<string>): QueryKey[] {
  return [...scope].flatMap((organizationId) =>
    invalidationsIn(event, queryKeys(organizationId)).filter((prefix) =>
      USER_WIDE_AREAS.includes(prefix[1] as QueryArea),
    ),
  );
}

/**
 * The prefixes `event` invalidates in the cache of a scope: its own organization's keys,
 * plus, for the scope-wide areas (`SCOPE_WIDE_AREAS`), the same prefixes under every other
 * organization of the scope, since "All organizations" keys its Inbox, Runs, Repos and Fleet
 * queries by the active one (Repos also opens any organization's repo under the active one's
 * keys).
 */
export function scopeInvalidations(event: ChangeEvent, scope: ReadonlySet<string>): QueryKey[] {
  const prefixes = liveInvalidations(event);
  for (const organizationId of scope) {
    if (organizationId === event.organizationId) continue;
    prefixes.push(
      ...invalidationsIn(event, queryKeys(organizationId)).filter(
        (prefix) =>
          SCOPE_WIDE_AREAS.includes(prefix[1] as QueryArea) ||
          USER_WIDE_AREAS.includes(prefix[1] as QueryArea),
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

/** The run a `run` or `transcript` event of the scope is about, for `meta.liveRunIds`. */
function followedRunId(event: ChangeEvent, scope: ReadonlySet<string>): string | undefined {
  if (!scope.has(event.organizationId)) return undefined;
  if (event.resource !== "run" && event.resource !== "transcript") return undefined;
  return event.runId;
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
 * when it ends, so the last event of a burst is never lost. A query with `meta.liveRunIds`
 * is also invalidated by those runs' `run` and `transcript` events.
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
      // Another organization's event reaches only the user's own data (it came on their
      // own channel: the token grants no other organization's channel).
      const prefixes = scope.has(event.organizationId)
        ? scopeInvalidations(event, scope)
        : userWideInvalidations(event, scope);
      const cache = client.getQueryCache();
      const seen = new Set<string>();
      const visit = (query: Query) => {
        if (seen.has(query.queryHash)) return;
        seen.add(query.queryHash);
        const windowMs = query.meta?.liveThrottleMs;
        if (windowMs && windowMs > 0) throttle(query.queryHash, query.queryKey, windowMs);
        else invalidate(query.queryKey);
      };
      for (const prefix of prefixes) {
        for (const query of cache.findAll({ queryKey: prefix })) visit(query);
      }
      const runId = followedRunId(event, scope);
      if (runId) {
        for (const query of cache.getAll()) {
          if (query.meta?.liveRunIds?.includes(runId)) visit(query);
        }
      }
    },
    dispose() {
      for (const state of throttled.values()) clearTimeout(state.trailing);
      throttled.clear();
    },
  };
}
