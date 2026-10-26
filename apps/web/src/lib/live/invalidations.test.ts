import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeEvent } from "@/components/live/live-test-utils";
import { queryKeys } from "@/lib/api/keys";
import { playbookKeys } from "@/lib/api/playbook-keys";
import { CHANGE_RESOURCES, parseChangeEvent, type ChangeEvent } from "./events";
import {
  changesUserRecord,
  createLiveInvalidator,
  LIVE_INVALIDATIONS,
  liveInvalidations,
} from "./invalidations";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const RUN = "44444444-4444-4444-8444-444444444444";
const OTHER_RUN = "55555555-5555-4555-8555-555555555555";
const ID = "33333333-3333-4333-8333-333333333333";
const keys = queryKeys(ORG);
const playbooks = playbookKeys(keys);

const event = (fields: Partial<ChangeEvent> & { resource: ChangeEvent["resource"] }) =>
  changeEvent(ORG, fields);

describe("LIVE_INVALIDATIONS", () => {
  it("maps every resource in the catalogue", () => {
    expect(Object.keys(LIVE_INVALIDATIONS).sort()).toEqual([...CHANGE_RESOURCES].sort());
  });

  it("run: the run's detail and every list that shows runs", () => {
    expect(liveInvalidations(event({ resource: "run", runId: RUN }))).toEqual([
      keys.runs.lists,
      keys.runs.detail(RUN),
      keys.reviews.all,
      keys.triage.lists,
      keys.triage.detail(RUN),
      keys.jobs.all,
      keys.inbox.all,
      keys.analytics.all,
    ]);
  });

  it("run without a run (system work): attempts only", () => {
    expect(liveInvalidations(event({ resource: "run" }))).toEqual([
      keys.jobs.all,
      keys.analytics.all,
    ]);
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

  it("webhook_event: deliveries, connection health and the run it started", () => {
    expect(liveInvalidations(event({ resource: "webhook_event" }))).toEqual([
      keys.deliveries.all,
      keys.connections.all,
    ]);
    expect(liveInvalidations(event({ resource: "webhook_event", runId: RUN }))).toEqual([
      keys.deliveries.all,
      keys.connections.all,
      keys.runs.detail(RUN),
    ]);
  });

  it("settings: by section and subject", () => {
    const settings = (section: string, subjectId?: string) =>
      liveInvalidations(
        event({ resource: "settings", section, subjectId } as Partial<ChangeEvent> & {
          resource: "settings";
        }),
      );
    expect(settings("repository.reviews", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
    ]);
    expect(settings("repository.coding", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
    ]);
    expect(settings("repository.agents", ID)).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      keys.harnesses.all,
    ]);
    expect(settings("repository.coding")).toEqual([keys.repositories.all]);
    expect(settings("routing_rules")).toEqual([
      keys.settings.detail("routing"),
      keys.settings.detail("tracker-labels"),
    ]);
    expect(settings("connection", ID)).toEqual([keys.connections.all]);
    expect(settings("organization")).toEqual([keys.organization.all]);
    expect(settings("agent_defaults")).toEqual([
      keys.settings.detail("harness-defaults"),
      keys.settings.detail("host-tools"),
      keys.harnesses.all,
      keys.repositories.all,
    ]);
    expect(settings("profile")).toEqual([]);
  });

  it("settings: a playbook refetches every playbook query and the settings that bind playbooks", () => {
    expect(
      liveInvalidations(event({ resource: "settings", section: "playbooks", subjectId: ID })),
    ).toEqual([playbooks.all, keys.repositories.all, keys.connections.detail("integrations")]);
  });

  it("agent: the agents list and each agent", () => {
    expect(liveInvalidations(event({ resource: "agent", ids: [ID, RUN] }))).toEqual([
      keys.harnesses.lists,
      keys.harnesses.detail(ID),
      keys.harnesses.detail(RUN),
    ]);
  });

  it("repository: the list, each repository and the connections showing them", () => {
    expect(liveInvalidations(event({ resource: "repository" }))).toEqual([
      keys.repositories.lists,
      keys.repositories.detail(ID),
      keys.connections.all,
    ]);
  });

  it("connection: connections and the repositories list", () => {
    expect(liveInvalidations(event({ resource: "connection" }))).toEqual([
      keys.connections.all,
      keys.repositories.lists,
    ]);
  });

  it("organization: the organization's queries", () => {
    expect(liveInvalidations(event({ resource: "organization" }))).toEqual([keys.organization.all]);
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
      keys.harnesses.list(),
    );
    const invalidator = createLiveInvalidator(client);
    invalidator.apply(event({ resource: "transcript", runId: RUN }), scope);
    expect(invalidated()).toEqual([keys.transcripts.part(RUN, "attempt", { id: ID })]);

    invalidator.apply(event({ resource: "agent", ids: [ID] }), scope);
    expect(invalidated()).toEqual([
      keys.transcripts.part(RUN, "attempt", { id: ID }),
      keys.harnesses.list(),
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

  it("ignores an event for an organization outside the scope", () => {
    seed(queryKeys(OTHER_ORG).harnesses.list(), keys.harnesses.list());
    createLiveInvalidator(client).apply(
      changeEvent(OTHER_ORG, { resource: "agent", ids: [ID] }),
      scope,
    );
    expect(invalidated()).toEqual([]);
  });

  it("throttles a query with meta.liveThrottleMs: one leading and one trailing per window", async () => {
    vi.useFakeTimers();
    const throttledKey = keys.analytics.list({ days: 30 });
    client.getQueryCache().build(client, {
      queryKey: throttledKey,
      queryFn: async () => "analytics",
      meta: { liveThrottleMs: 10_000 },
    });
    client.getQueryCache().build(client, { queryKey: keys.jobs.list(), queryFn: async () => [] });
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
    expect(calls(keys.jobs.list())).toBe(5);

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
    const throttledKey = keys.analytics.list();
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
