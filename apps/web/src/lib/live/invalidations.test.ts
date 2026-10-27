import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeEvent } from "@/components/live/live-test-utils";
import {
  analyticsKeys,
  backlogKeys,
  chatPlaybooksKey,
  connectionKeys,
  inboxKeys,
  queryKeys,
  runsKeys,
  settingsHistoryKeys,
} from "@/lib/api/keys";
import { playbookKeys } from "@/lib/api/playbook-keys";
import {
  CHANGE_RESOURCES,
  parseChangeEvent,
  SETTINGS_SECTIONS,
  UNTRACKED_SETTINGS_SECTIONS,
  USER_SETTINGS_SECTIONS,
  type ChangeEvent,
} from "./events";
import {
  changesUserRecord,
  createLiveInvalidator,
  LIVE_INVALIDATIONS,
  liveInvalidations,
  scopeInvalidations,
} from "./invalidations";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const RUN = "44444444-4444-4444-8444-444444444444";
const OTHER_RUN = "55555555-5555-4555-8555-555555555555";
const ID = "33333333-3333-4333-8333-333333333333";
const keys = queryKeys(ORG);
const playbooks = playbookKeys(keys);
const history = settingsHistoryKeys(keys);
const backlog = backlogKeys(keys);
/** Analytics queries covering ORG: its own and the `all` ones. */
const analyticsOfOrg = analyticsKeys(keys).covering(ORG);

/** Every repository's list and detail (their status follows runs, agents and connections). */
const repositoryViews = [keys.repositories.lists, [...keys.repositories.all, "detail"]];

const event = (fields: Partial<ChangeEvent> & { resource: ChangeEvent["resource"] }) =>
  changeEvent(ORG, fields);

describe("LIVE_INVALIDATIONS", () => {
  it("maps every resource in the catalogue", () => {
    expect(Object.keys(LIVE_INVALIDATIONS).sort()).toEqual([...CHANGE_RESOURCES].sort());
  });

  it("run: the run's detail, every list that shows runs, the repositories' status and work item details", () => {
    expect(liveInvalidations(event({ resource: "run", runId: RUN }))).toEqual([
      keys.runs.lists,
      keys.runs.detail(RUN),
      keys.inbox.all,
      ...analyticsOfOrg,
      ...repositoryViews,
      backlog.details,
    ]);
  });

  it("run without a run (system work): Analytics and the repositories' status (sync problems)", () => {
    expect(liveInvalidations(event({ resource: "run" }))).toEqual([
      ...analyticsOfOrg,
      ...repositoryViews,
    ]);
  });

  it("no resource but run invalidates Analytics (a transcript changes no figure)", () => {
    const events: ChangeEvent[] = CHANGE_RESOURCES.filter(
      (resource) => resource !== "run" && resource !== "settings",
    ).flatMap((resource) => [
      event({ resource, runId: RUN, ids: [ID] }),
      event({ resource, ids: [ID] }),
    ]);
    for (const section of [
      ...SETTINGS_SECTIONS,
      ...UNTRACKED_SETTINGS_SECTIONS,
      ...USER_SETTINGS_SECTIONS,
    ]) {
      events.push(event({ resource: "settings", section, subjectId: ID }));
    }
    expect(events.map((e) => e.resource)).toContain("transcript");
    for (const changed of events) {
      for (const prefix of scopeInvalidations(changed, new Set([ORG, OTHER_ORG]))) {
        expect(prefix[1], `${changed.resource}`).not.toBe("analytics");
      }
    }
  });

  it("transcript: only that run's transcript", () => {
    expect(liveInvalidations(event({ resource: "transcript", runId: RUN }))).toEqual([
      keys.transcripts.detail(RUN),
    ]);
    expect(liveInvalidations(event({ resource: "transcript", ids: [ID] }))).toEqual([
      keys.transcripts.detail(ID),
    ]);
  });

  it("pull_request: the run and the lists and inbox that show it", () => {
    expect(liveInvalidations(event({ resource: "pull_request", runId: RUN }))).toEqual([
      keys.runs.lists,
      keys.runs.detail(RUN),
      keys.inbox.all,
    ]);
    expect(liveInvalidations(event({ resource: "pull_request" }))).toEqual([
      keys.runs.all,
      keys.inbox.all,
    ]);
  });

  it("inbox_state: the inbox", () => {
    expect(
      liveInvalidations(event({ resource: "inbox_state", ids: [`failed:${RUN}:${ID}`] })),
    ).toEqual([keys.inbox.all]);
  });

  it("webhook_event: its connection's deliveries, connection health, Settings' failed counts and dots and the run it started", () => {
    const CONNECTION = "66666666-6666-4666-8666-666666666666";
    expect(liveInvalidations(event({ resource: "webhook_event", ids: [ID, CONNECTION] }))).toEqual([
      keys.deliveries.detail(ID),
      keys.deliveries.detail(CONNECTION),
      keys.connections.all,
      connectionKeys(keys).list,
      keys.navIndicators.all,
      ...repositoryViews,
    ]);
    expect(liveInvalidations(event({ resource: "webhook_event", ids: [ID], runId: RUN }))).toEqual([
      keys.deliveries.detail(ID),
      keys.connections.all,
      connectionKeys(keys).list,
      keys.navIndicators.all,
      ...repositoryViews,
      keys.runs.detail(RUN),
    ]);
  });

  it("settings: by section and subject, with the section's open change history", () => {
    const settings = (section: string, subjectId?: string) =>
      liveInvalidations(
        event({ resource: "settings", section, subjectId } as Partial<ChangeEvent> & {
          resource: "settings";
        }),
      );
    expect(settings("repository.reviews", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      history.section("repository.reviews", ID),
    ]);
    expect(settings("repository.coding", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      keys.backlog.all,
      connectionKeys(keys).list,
      history.section("repository.coding", ID),
    ]);
    expect(settings("repository.agents", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      keys.agents.all,
      history.section("repository.agents", ID),
    ]);
    expect(settings("repository.ask", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      history.section("repository.ask", ID),
    ]);
    // A binding change shows on Advanced › Playbooks' list and details.
    expect(settings("repository.playbooks", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      playbookKeys(keys).all,
      history.section("repository.playbooks", ID),
    ]);
    expect(settings("repository.coding")).toEqual([
      keys.repositories.all,
      keys.backlog.all,
      connectionKeys(keys).list,
      history.section("repository.coding", undefined),
    ]);
    expect(settings("routing_rules")).toEqual([
      keys.settings.detail("routing"),
      keys.settings.detail("tracker-labels"),
      keys.backlog.all,
      history.section("routing_rules", undefined),
    ]);
    expect(settings("connection", ID)).toEqual([
      keys.connections.all,
      history.section("connection", ID),
    ]);
    expect(settings("organization")).toEqual([
      keys.organization.all,
      history.section("organization", undefined),
    ]);
    // The version policy decides which agents failed their update (the Fleet dot).
    expect(settings("agent_defaults")).toEqual([
      keys.settings.detail("agent-defaults"),
      keys.navIndicators.all,
      keys.settings.detail("host-tools"),
      keys.agents.all,
      keys.repositories.all,
      history.section("agent_defaults", undefined),
    ]);
    expect(settings("profile")).toEqual([]);
    expect(settings("linked_accounts")).toEqual([keys.chatAccounts.all]);
  });

  it("settings: a playbook refetches every playbook query and the settings that bind playbooks", () => {
    expect(
      liveInvalidations(event({ resource: "settings", section: "playbooks", subjectId: ID })),
    ).toEqual([
      playbooks.all,
      keys.repositories.all,
      keys.connections.detail("integrations"),
      chatPlaybooksKey(keys),
    ]);
  });

  it("settings: the playbooks chat runs refetch Chat channel overrides and the playbooks naming chat", () => {
    for (const subjectId of [undefined, ID]) {
      expect(
        liveInvalidations(event({ resource: "settings", section: "chat_playbooks", subjectId })),
      ).toEqual([chatPlaybooksKey(keys), playbooks.all, keys.connections.detail("integrations")]);
    }
  });

  it("agent: the agents list, each agent, the Inbox (offline agents), the Fleet dot, the repositories' agents and the playbook editor's options", () => {
    expect(liveInvalidations(event({ resource: "agent", ids: [ID, RUN] }))).toEqual([
      keys.agents.lists,
      keys.agents.detail(ID),
      keys.agents.detail(RUN),
      keys.inbox.all,
      keys.navIndicators.all,
      ...repositoryViews,
      playbookKeys(keys).formOptions,
    ]);
  });

  it("repository: the list, each repository, the connections, the Runs Repo filter and the Backlog showing them", () => {
    expect(liveInvalidations(event({ resource: "repository" }))).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      keys.connections.all,
      connectionKeys(keys).list,
      runsKeys(keys).filterOptionsAll,
      history.subject(ID),
      keys.backlog.all,
      playbookKeys(keys).all,
    ]);
  });

  it("connection: connections, Settings' connections, dots and state mappings, the repositories' list and details, the Runs Repo filter and the Backlog (state mapping)", () => {
    expect(liveInvalidations(event({ resource: "connection" }))).toEqual([
      keys.connections.all,
      connectionKeys(keys).list,
      keys.navIndicators.all,
      connectionKeys(keys).stateMappings,
      chatPlaybooksKey(keys),
      ...repositoryViews,
      runsKeys(keys).filterOptionsAll,
      keys.backlog.all,
    ]);
  });

  it("work_item: the Backlog's list, counts and Up next, and each named item's detail", () => {
    const ids = [`linear-${ID}`, `linear-${RUN}`];
    const prefixes = liveInvalidations(event({ resource: "work_item", ids }));
    expect(prefixes).toEqual([keys.backlog.all, backlog.detail(ids[0]!), backlog.detail(ids[1]!)]);
    const under = (key: QueryKey) =>
      prefixes.some((prefix) => prefix.every((part, i) => key[i] === part));
    for (const key of [
      backlog.list({ source: "linear:project:p1", repo: ID }, "all"),
      backlog.counts(ORG),
      backlog.upNext("all"),
      keys.workItems.part(ids[0]!, "share-links"),
    ]) {
      expect(under(key)).toBe(true);
    }
    expect(under(backlog.detail(`linear-${OTHER_RUN}`))).toBe(false);
    expect(under(keys.runs.lists)).toBe(false);
  });

  it("organization: the organization's queries", () => {
    expect(liveInvalidations(event({ resource: "organization" }))).toEqual([keys.organization.all]);
  });

  it("never reaches a story's diff: a commit's diff doesn't change", () => {
    const diff = runsKeys(keys).diff(RUN, ID, "c0ffee");
    const reaches = (prefix: QueryKey) => prefix.every((part, i) => diff[i] === part);
    const events: ChangeEvent[] = [ORG, OTHER_ORG].flatMap((org) =>
      CHANGE_RESOURCES.filter((resource) => resource !== "settings").flatMap((resource) => [
        changeEvent(org, { resource, runId: RUN, ids: [ID] }),
        changeEvent(org, { resource, ids: [ID] }),
      ]),
    );
    for (const changed of events) {
      const prefixes = scopeInvalidations(changed, new Set([ORG, OTHER_ORG]));
      expect(prefixes.filter(reaches), changed.resource).toEqual([]);
    }
  });

  it("keys an event by its own organization", () => {
    expect(liveInvalidations(changeEvent(OTHER_ORG, { resource: "organization" }))).toEqual([
      queryKeys(OTHER_ORG).organization.all,
    ]);
  });
});

describe("changesUserRecord", () => {
  it("is the user's theme or memberships", () => {
    expect(changesUserRecord(event({ resource: "organization" }))).toBe(true);
    expect(changesUserRecord(event({ resource: "settings", section: "profile" }))).toBe(true);
    expect(changesUserRecord(event({ resource: "settings", section: "organization" }))).toBe(false);
    expect(changesUserRecord(event({ resource: "settings", section: "linked_accounts" }))).toBe(
      false,
    );
    expect(changesUserRecord(event({ resource: "inbox_state", ids: ["manual_story:1"] }))).toBe(
      false,
    );
  });
});

describe("events with an unknown version", () => {
  it("don't parse, so they are ignored", () => {
    expect(parseChangeEvent({ ...event({ resource: "agent" }), v: 2 })).toBeNull();
    expect(parseChangeEvent(event({ resource: "agent" }))).not.toBeNull();
  });
});

describe("createLiveInvalidator", () => {
  let client: QueryClient;
  const scope = new Set([ORG]);

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  });
  afterEach(() => {
    vi.useRealTimers();
    client.clear();
  });

  const seed = (...queryKeysToSeed: QueryKey[]) => {
    for (const queryKey of queryKeysToSeed) client.setQueryData(queryKey, "data");
  };
  const invalidated = () =>
    client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => query.queryKey);

  it("invalidates exactly the mapped queries and leaves the others", () => {
    seed(
      keys.transcripts.part(RUN, "attempt", { id: ID }),
      keys.transcripts.detail(OTHER_RUN),
      keys.runs.detail(RUN),
      keys.agents.list(),
    );
    const invalidator = createLiveInvalidator(client);
    invalidator.apply(event({ resource: "transcript", runId: RUN }), scope);
    expect(invalidated()).toEqual([keys.transcripts.part(RUN, "attempt", { id: ID })]);

    invalidator.apply(event({ resource: "agent", ids: [ID] }), scope);
    expect(invalidated()).toEqual([
      keys.transcripts.part(RUN, "attempt", { id: ID }),
      keys.agents.list(),
    ]);
  });

  it("a playbook save refetches playbook queries, not other settings", () => {
    seed(playbooks.list, playbooks.detail(ID), keys.settings.detail("routing"));
    const invalidator = createLiveInvalidator(client);
    invalidator.apply(
      event({ resource: "settings", section: "playbooks", ids: [ID], subjectId: ID }),
      scope,
    );
    expect(invalidated()).toEqual([playbooks.list, playbooks.detail(ID)]);
  });

  it("under All organizations, reaches the active organization's Inbox and Runs queries", () => {
    const active = queryKeys(ORG);
    const feed = inboxKeys(active).feed("needs-you", "all");
    const counts = inboxKeys(active).counts("all");
    seed(feed, counts, active.runs.detail(RUN), active.agents.list(), active.settings.detail("x"));
    const both = new Set([ORG, OTHER_ORG]);
    const invalidator = createLiveInvalidator(client);
    invalidator.apply(changeEvent(OTHER_ORG, { resource: "run", runId: RUN }), both);
    expect(invalidated()).toEqual([feed, counts, active.runs.detail(RUN)]);
    invalidator.apply(
      changeEvent(OTHER_ORG, { resource: "inbox_state", ids: ["manual_story:1"] }),
      both,
    );
    // Fleet lists every organization's agents under the active one's keys; settings stay theirs.
    invalidator.apply(changeEvent(OTHER_ORG, { resource: "agent", ids: [ID] }), both);
    expect(invalidated()).toContainEqual(active.agents.list());
    invalidator.apply(
      changeEvent(OTHER_ORG, { resource: "settings", section: "organization" }),
      both,
    );
    expect(invalidated()).not.toContainEqual(active.settings.detail("x"));
  });

  it("scopeInvalidations adds only the scope-wide areas of the other organizations", () => {
    const other = changeEvent(OTHER_ORG, { resource: "agent", ids: [ID] });
    expect(scopeInvalidations(other, new Set([OTHER_ORG]))).toEqual(liveInvalidations(other));
    expect(scopeInvalidations(other, new Set([ORG, OTHER_ORG]))).toEqual([
      ...liveInvalidations(other),
      keys.agents.lists,
      keys.agents.detail(ID),
      keys.inbox.all,
      // Under "All organizations" the Fleet dot counts the other organization's agents.
      keys.navIndicators.all,
      ...repositoryViews,
    ]);
    // The add-repo sheet keys another organization's connections by the active one.
    const connection = changeEvent(OTHER_ORG, { resource: "connection", ids: [ID] });
    expect(scopeInvalidations(connection, new Set([ORG, OTHER_ORG]))).toContainEqual(
      keys.connections.all,
    );
    // Settings lists the active organization's connections only.
    expect(scopeInvalidations(connection, new Set([ORG, OTHER_ORG]))).not.toContainEqual(
      connectionKeys(keys).list,
    );
  });

  it("ignores an event for an organization outside the scope", () => {
    seed(queryKeys(OTHER_ORG).agents.list(), keys.agents.list());
    createLiveInvalidator(client).apply(
      changeEvent(OTHER_ORG, { resource: "agent", ids: [ID] }),
      scope,
    );
    expect(invalidated()).toEqual([]);
  });

  it("reaches the user's linked chat accounts from any of their organizations, and nothing else", () => {
    const linked = (organizationId: string) =>
      changeEvent(organizationId, { resource: "settings", section: "linked_accounts" });
    seed(keys.chatAccounts.list(), keys.agents.list(), queryKeys(OTHER_ORG).chatAccounts.list());
    const invalidator = createLiveInvalidator(client);
    // A link in an organization outside the scope (on the user's own channel).
    invalidator.apply(linked(OTHER_ORG), scope);
    expect(invalidated()).toEqual([keys.chatAccounts.list()]);
    client.clear();
    seed(keys.chatAccounts.list(), keys.agents.list());
    // Other resources of an organization outside the scope still reach nothing.
    invalidator.apply(changeEvent(OTHER_ORG, { resource: "agent", ids: [ID] }), scope);
    invalidator.apply(
      changeEvent(OTHER_ORG, { resource: "settings", section: "profile", ids: [ID] }),
      scope,
    );
    expect(invalidated()).toEqual([]);
    invalidator.apply(linked(ORG), scope);
    expect(invalidated()).toEqual([keys.chatAccounts.list()]);
  });

  it("refetches the Analytics queries whose scope covers the run event's organization", () => {
    const analytics = analyticsKeys(keys);
    const own = analytics.list({ days: 30, repositoryId: null, organization: ORG });
    const ownRepo = analytics.list({ days: 7, repositoryId: ID, organization: ORG });
    const all = analytics.list({ days: 90, repositoryId: null, organization: "all" });
    const otherOnly = analytics.list({ days: 30, repositoryId: null, organization: OTHER_ORG });
    seed(own, ownRepo, all, otherOnly);
    const invalidator = createLiveInvalidator(client);
    invalidator.apply(event({ resource: "run", runId: RUN }), scope);
    expect(invalidated()).toEqual([own, ownRepo, all]);

    // Under All organizations, another organization's run reaches the `all` queries only.
    client.clear();
    seed(own, all, otherOnly);
    const both = new Set([ORG, OTHER_ORG]);
    invalidator.apply(changeEvent(OTHER_ORG, { resource: "run", runId: OTHER_RUN }), both);
    expect(invalidated()).toEqual([all, otherOnly]);

    // A transcript growing changes no figure.
    client.clear();
    seed(own, all);
    invalidator.apply(event({ resource: "transcript", runId: RUN }), scope);
    expect(invalidated()).toEqual([]);
    invalidator.dispose();
  });

  it("throttles a query with meta.liveThrottleMs: one leading and one trailing per window", async () => {
    vi.useFakeTimers();
    const throttledKey = analyticsKeys(keys).list({
      days: 30,
      repositoryId: null,
      organization: ORG,
    });
    client.getQueryCache().build(client, {
      queryKey: throttledKey,
      queryFn: async () => "analytics",
      meta: { liveThrottleMs: 10_000 },
    });
    client.getQueryCache().build(client, { queryKey: keys.runs.list(), queryFn: async () => [] });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const invalidator = createLiveInvalidator(client);
    const calls = (queryKey: QueryKey) =>
      invalidate.mock.calls.filter(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey),
      ).length;

    // A burst of 5 run events, 1s apart.
    for (let i = 0; i < 5; i++) {
      invalidator.apply(event({ resource: "run", runId: RUN }), scope);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(calls(throttledKey)).toBe(1);
    expect(calls(keys.runs.list())).toBe(5);

    // The trailing invalidation delivers the burst's last event when the window ends.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls(throttledKey)).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls(throttledKey)).toBe(2);

    // A quiet window later, the next event goes at once again.
    invalidator.apply(event({ resource: "run", runId: RUN }), scope);
    expect(calls(throttledKey)).toBe(3);
    invalidator.dispose();
  });

  it("drops a pending trailing invalidation on dispose", async () => {
    vi.useFakeTimers();
    const throttledKey = analyticsKeys(keys).list({
      days: 30,
      repositoryId: null,
      organization: "all",
    });
    client.getQueryCache().build(client, {
      queryKey: throttledKey,
      queryFn: async () => "analytics",
      meta: { liveThrottleMs: 10_000 },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const invalidator = createLiveInvalidator(client);
    invalidator.apply(event({ resource: "run", runId: RUN }), scope);
    invalidator.apply(event({ resource: "run", runId: RUN }), scope);
    invalidator.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
