import { DEFAULT_TRACKER_STATE_MAPPING, type TrackerStateMapping } from "@omniralph/db";
import { describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { LinearGateway, WorkflowState } from "@/lib/linear/gateway";
import { describeWorkItemTrackerContract, type WorkItemTrackerAgent } from "./contract";

vi.mock("server-only", () => ({}));

const { LinearWorkItemTracker, LINEAR_STATE_TYPES, stateCategoryOf } = await import("./linear");
const { WORK_ITEM_STATES, WorkItemNotFoundError } = await import("./tracker");
const { fixtureLinearGateway } = await import("@/lib/linear/fixture-gateway");

const TYPE_OF_CATEGORY = { triage: "triage", ...LINEAR_STATE_TYPES } as const;

const statesFor = (prefix: string): WorkflowState[] =>
  [
    ["Triage", "triage"],
    ["Backlog", "backlog"],
    ["Todo", "unstarted"],
    ["In Progress", "started"],
    ["In Review", "started"],
    ["Done", "completed"],
    ["Canceled", "canceled"],
  ].map(([name, type], position) => ({
    id: `${prefix}-state-${position}`,
    name: name!,
    type: type!,
    position,
  }));

/** A Linear workspace with two teams (their own workflows) and a project, and its tracker. */
function linearAgent(
  options: { gateway?: (fake: FakeLinearGateway) => LinearGateway } = {},
): WorkItemTrackerAgent & { fake: FakeLinearGateway; saved: TrackerStateMapping[] } {
  const fake = new FakeLinearGateway();
  fake.teams = [
    { id: "team-a", key: "ENG", name: "Engineering" },
    { id: "team-b", key: "OPS", name: "Operations" },
  ];
  fake.workflowStatesByTeam.set("team-a", statesFor("a"));
  fake.workflowStatesByTeam.set("team-b", statesFor("b"));
  fake.projects = [{ id: "project-1", name: "Control panel" }];
  const saved: TrackerStateMapping[] = [];
  const activeRuns = new Set<string>();
  const tracker = new LinearWorkItemTracker({
    gateway: options.gateway?.(fake) ?? fake,
    integrationId: "integration-1",
    stateMapping: structuredClone(DEFAULT_TRACKER_STATE_MAPPING),
    saveStateMapping: async (mapping) => {
      saved.push(mapping);
    },
    hasActiveRun: async (issueId) => activeRuns.has(issueId),
    manualLabels: async () => ["needs-human"],
  });
  let seq = 0;
  let commentClock = Date.parse("2026-03-01T00:00:00.000Z");
  return {
    fake,
    saved,
    tracker,
    teams: ["team-a", "team-b"],
    projectId: "project-1",
    projectName: "Control panel",
    missingRef: "ENG-9999",
    async seed(input) {
      const team = fake.teams.find((t) => t.id === input.teamId)!;
      const type = TYPE_OF_CATEGORY[input.state];
      const state = fake.workflowStatesByTeam.get(team.id)!.find((s) => s.type === type)!;
      seq += 1;
      const issue = fake.add({
        identifier: `${team.key}-${seq}`,
        title: input.title,
        teamId: team.id,
        teamKey: team.key,
        stateType: state.type,
        stateName: state.name,
        labels: input.labels ?? [],
        description: input.description ?? "",
        ...(input.parentId && { parentId: input.parentId, subIssueSortOrder: seq }),
        ...(input.projectId && {
          projectId: input.projectId,
          projectName: fake.projects.find((p) => p.id === input.projectId)!.name,
        }),
      });
      for (const name of input.labels ?? []) {
        if (!(await fake.findLabel(team.id, name))) await fake.createLabel(team.id, name);
      }
      if (input.delegatedToOmniralph) {
        fake.delegations.push({ issueId: issue.id, delegateId: fake.viewer.id });
      }
      if (input.delegatedToOtherAgent) {
        fake.delegations.push({ issueId: issue.id, delegateId: "other-agent" });
      }
      return { id: issue.id, identifier: issue.identifier };
    },
    async block(blockerId, blockedId) {
      await fake.createBlocksRelation(blockerId, blockedId);
    },
    async labelId(teamId, name) {
      return ((await fake.findLabel(teamId, name)) ?? (await fake.createLabel(teamId, name))).id;
    },
    async comments(id) {
      return fake.comments.filter((c) => c.issueId === id).map((c) => c.body);
    },
    async addComment(id, { author, body }) {
      commentClock += 60_000;
      fake.commentsByIssue.set(id, [
        ...(fake.commentsByIssue.get(id) ?? []),
        { author, body, createdAt: new Date(commentClock).toISOString() },
      ]);
    },
    async touch(id) {
      fake.touch(id);
    },
    manualLabel: "needs-human",
    async isDelegatedToOmniralph(id) {
      return fake.delegateOf(id) === fake.viewer.id;
    },
    async isTriageRequested(id) {
      return fake.issues.get(id)!.labels.includes("coding:triage");
    },
    setActiveRun(id) {
      activeRuns.add(id);
    },
    async sessionsOpened(id) {
      return fake.sessionsCreated.filter((s) => s.issueId === id).length;
    },
  };
}

describeWorkItemTrackerContract(() => linearAgent());

/** A gateway that counts calls by method name. */
function counting(fake: FakeLinearGateway, calls: string[]): LinearGateway {
  return new Proxy(fake, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe("LinearWorkItemTracker", () => {
  it("maps every work item state to its Linear workflow state type", async () => {
    expect(LINEAR_STATE_TYPES).toEqual({
      backlog: "backlog",
      todo: "unstarted",
      in_progress: "started",
      done: "completed",
      canceled: "canceled",
    });
    const h = linearAgent();
    const { id } = await h.seed({ teamId: "team-a", title: "Item", state: "triage" });
    for (const state of WORK_ITEM_STATES) await h.tracker.setState(id, state);
    expect(h.fake.stateChanges).toEqual(
      WORK_ITEM_STATES.map((state) => ({
        issueId: id,
        target: { type: LINEAR_STATE_TYPES[state] },
      })),
    );
    // The team's first state of the type: Todo, In Progress (not In Review), ...
    await h.tracker.setState(id, "in_progress");
    expect(h.fake.issues.get(id)!.stateName).toBe("In Progress");
  });

  it("maps Linear state types back to categories", () => {
    expect(
      ["triage", "backlog", "unstarted", "started", "completed", "canceled", "odd"].map(
        stateCategoryOf,
      ),
    ).toEqual(["triage", "backlog", "todo", "in_progress", "done", "canceled", "backlog"]);
  });

  it("creates the triage label on the team when it is missing, and reuses it", async () => {
    const h = linearAgent();
    const first = await h.seed({ teamId: "team-a", title: "One", state: "backlog" });
    const second = await h.seed({ teamId: "team-a", title: "Two", state: "backlog" });
    await h.tracker.startTriage(first.identifier);
    expect(h.fake.labels).toEqual([
      { id: expect.any(String), name: "coding:triage", teamId: "team-a" },
    ]);
    const labelId = h.fake.labels[0]!.id;
    await h.tracker.startTriage(second.id);
    expect(h.fake.labels).toHaveLength(1);
    expect(h.fake.labelChanges).toEqual([
      { issueId: first.id, added: [labelId] },
      { issueId: second.id, added: [labelId] },
    ]);
  });

  it("doesn't label an issue that already asks for triage under the old name", async () => {
    const h = linearAgent();
    const { id } = await h.seed({
      teamId: "team-a",
      title: "Old",
      state: "backlog",
      labels: ["Ralph:Triage"],
    });
    await h.tracker.startTriage(id);
    expect(h.fake.labelChanges).toEqual([]);
  });

  it("delegates to the viewer (the app user), reading it once", async () => {
    const calls: string[] = [];
    const h = linearAgent({ gateway: (fake) => counting(fake, calls) });
    h.fake.viewer = { id: "omniralph-app", name: "Omniralph" };
    const one = await h.seed({ teamId: "team-a", title: "One", state: "todo" });
    const two = await h.seed({ teamId: "team-a", title: "Two", state: "todo" });
    await h.tracker.delegateToOmniralph(one.identifier);
    await h.tracker.delegateToOmniralph(two.id);
    expect(h.fake.delegations).toEqual([
      { issueId: one.id, delegateId: "omniralph-app" },
      { issueId: two.id, delegateId: "omniralph-app" },
    ]);
    expect(calls.filter((c) => c === "getViewer")).toHaveLength(1);
  });

  it("opens an agent session instead of delegating again when Omniralph is already the delegate", async () => {
    const h = linearAgent();
    const item = await h.seed({
      teamId: "team-a",
      title: "Again",
      state: "todo",
      delegatedToOmniralph: true,
    });
    const delegations = h.fake.delegations.length;
    await h.tracker.delegateToOmniralph(item.identifier);
    expect(h.fake.delegations).toHaveLength(delegations);
    expect(h.fake.sessionsCreated).toEqual([{ issueId: item.id, sessionId: "session-1" }]);
  });

  it("moves to the override state by ID, not by name", async () => {
    const h = linearAgent();
    const states = statesFor("a");
    // Two states named the same: only the ID tells them apart.
    states.splice(3, 0, { id: "a-selected", name: "Todo", type: "unstarted", position: 2.5 });
    h.fake.workflowStatesByTeam.set("team-a", states);
    await h.tracker.setStateMapping({
      ready: { types: ["unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: { "team-a": { ready: ["a-selected"], needsRefining: ["a-state-1"] } },
    });
    const item = await h.seed({ teamId: "team-a", title: "Item", state: "backlog" });
    await h.tracker.setState(item.id, { readiness: "ready" });
    expect(h.fake.stateChanges.at(-1)).toEqual({ issueId: item.id, target: { id: "a-selected" } });
    expect((await h.tracker.get(item.id)).readiness).toBe("ready");
  });

  it("says which readiness a team has no state for", async () => {
    const h = linearAgent();
    await h.tracker.setStateMapping({
      ready: { types: ["triage"] },
      needsRefining: { types: ["backlog"] },
      teams: {},
    });
    h.fake.workflowStatesByTeam.set(
      "team-a",
      statesFor("a").filter((s) => s.type !== "triage"),
    );
    const item = await h.seed({ teamId: "team-a", title: "Item", state: "backlog" });
    await expect(h.tracker.setState(item.id, { readiness: "ready" })).rejects.toThrow(
      /has no Ready to start state/,
    );
  });

  it("lists candidates with readiness and blockers in one gateway call per page", async () => {
    const calls: string[] = [];
    const h = linearAgent({ gateway: (fake) => counting(fake, calls) });
    const blocked = await h.seed({ teamId: "team-a", title: "Blocked", state: "todo" });
    for (let i = 0; i < 4; i += 1) {
      const blocker = await h.seed({ teamId: "team-b", title: `Blocker ${i}`, state: "todo" });
      await h.block(blocker.id, blocked.id);
    }
    calls.length = 0;
    const page = await h.tracker.listCandidates({
      readiness: ["ready", "needs_refining"],
      delegatedToOmniralph: false,
      limit: 50,
    });
    expect(page.items).toHaveLength(5);
    expect(page.items.find((i) => i.id === blocked.id)!.blockedBy).toHaveLength(4);
    expect(calls).toEqual(["getViewer", "listIssues"]);
    expect(h.fake.issueLists.at(-1)).toEqual({
      notDelegateId: "app-user",
      stateMatch: { types: ["unstarted", "backlog"], typesExceptTeamIds: [], ids: [] },
      first: 50,
    });
  });

  it("passes the team overrides' states to listIssues", async () => {
    const h = linearAgent();
    await h.tracker.setStateMapping({
      ready: { types: ["unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: { "team-b": { ready: ["b-state-3", "b-state-4"], needsRefining: ["b-state-2"] } },
    });
    await h.tracker.listCandidates({
      readiness: ["ready"],
      states: ["in_progress"],
      teamId: "team-b",
      projectId: "project-1",
      labelIds: ["label-1"],
      cursor: "2",
      limit: 500,
    });
    expect(h.fake.issueLists.at(-1)).toEqual({
      teamId: "team-b",
      projectId: "project-1",
      labelIds: ["label-1"],
      stateTypes: ["started"],
      stateMatch: {
        types: ["unstarted"],
        typesExceptTeamIds: ["team-b"],
        ids: ["b-state-3", "b-state-4"],
      },
      first: 50,
      after: "2",
    });
  });

  it("lists a page of candidates with their routing fields in one gateway call", async () => {
    const calls: string[] = [];
    const h = linearAgent({ gateway: (fake) => counting(fake, calls) });
    for (let i = 0; i < 3; i += 1) {
      await h.seed({ teamId: "team-a", title: `Item ${i}`, state: "todo" });
    }
    await h.seed({ teamId: "team-a", title: "In project", state: "todo", projectId: "project-1" });
    calls.length = 0;
    const page = await h.tracker.listCandidates({
      teamId: "team-a",
      withoutProject: true,
      withRoutingFields: true,
      readiness: ["ready", "needs_refining"],
      limit: 50,
    });
    expect(page.items.map((i) => i.title)).toEqual(["Item 0", "Item 1", "Item 2"]);
    expect(page.items.every((i) => i.routingFields?.issue.id === i.id)).toBe(true);
    // Nothing delegated: the app user isn't read.
    expect(calls).toEqual(["listIssues"]);
    expect(h.fake.issueLists.at(-1)).toMatchObject({ withoutProject: true, withRoutingFields: true });
  });

  it("reads the app user once to tell Omniralph's delegations from another agent's", async () => {
    const calls: string[] = [];
    const h = linearAgent({ gateway: (fake) => counting(fake, calls) });
    const om = await h.seed({ teamId: "team-a", title: "Om", state: "todo", delegatedToOmniralph: true });
    await h.seed({ teamId: "team-a", title: "Other", state: "todo", delegatedToOtherAgent: true });
    calls.length = 0;
    await h.tracker.listCandidates({ teamId: "team-a", limit: 50 });
    await h.tracker.get(om.id);
    expect(calls.filter((c) => c === "getViewer")).toHaveLength(1);
  });

  it("refuses a stale edit without writing to Linear", async () => {
    const h = linearAgent();
    const { id } = await h.seed({ teamId: "team-a", title: "T", state: "todo" });
    const read = await h.tracker.get(id);
    h.fake.touch(id);
    await expect(
      h.tracker.update(id, { description: "x", addLabels: ["new"] }, { ifUpdatedAt: read.updatedAt }),
    ).rejects.toThrow(/changed since it was read/);
    expect(h.fake.issueUpdates).toEqual([]);
    expect(h.fake.labelChanges).toEqual([]);
  });

  it("orders sub-issues by their sort order and marks manual ones by the default label", async () => {
    const fake = new FakeLinearGateway();
    const tracker = new LinearWorkItemTracker({
      gateway: fake,
      integrationId: "integration-1",
      stateMapping: structuredClone(DEFAULT_TRACKER_STATE_MAPPING),
      saveStateMapping: async () => undefined,
    });
    const parent = fake.add({ title: "Epic" });
    fake.add({ title: "Later", parentId: parent.id, subIssueSortOrder: 5 });
    fake.add({ title: "Unordered", parentId: parent.id });
    fake.add({ title: "Earlier", parentId: parent.id, subIssueSortOrder: -2, labels: ["Manual"] });
    expect(
      (await tracker.stories(parent.identifier)).map(({ title, manual }) => ({ title, manual })),
    ).toEqual([
      { title: "Earlier", manual: true },
      { title: "Later", manual: false },
      { title: "Unordered", manual: false },
    ]);
  });

  it("creates issues with labels by name, creating missing ones", async () => {
    const h = linearAgent();
    h.fake.labels = [{ id: "label-backend", name: "backend", teamId: null }];
    await h.tracker.create({
      teamId: "team-a",
      projectId: "project-1",
      title: "New",
      description: "Body",
      labels: ["Backend", "fresh"],
      priority: 3,
    });
    expect(h.fake.created).toEqual([
      {
        teamId: "team-a",
        projectId: "project-1",
        title: "New",
        description: "Body",
        labels: ["Backend", "fresh"],
        priority: 3,
      },
    ]);
    expect(h.fake.labels.map((l) => l.name)).toEqual(["backend", "fresh"]);
  });

  it("updates through updateIssue, addIssueLabels and removeIssueLabel", async () => {
    const h = linearAgent();
    h.fake.labels = [
      { id: "label-old", name: "old", teamId: null },
      { id: "label-new", name: "new", teamId: null },
    ];
    const { id } = await h.seed({ teamId: "team-a", title: "T", state: "todo", labels: ["old"] });
    await h.tracker.update(id, {
      title: "T2",
      priority: 2,
      addLabels: ["new"],
      removeLabels: ["old"],
    });
    expect(h.fake.issueUpdates).toEqual([{ issueId: id, input: { title: "T2", priority: 2 } }]);
    expect(h.fake.labelChanges).toEqual([
      { issueId: id, added: ["label-new"] },
      { issueId: id, removed: ["label-old"] },
    ]);
  });

  it("cancels through the canceled state and a comment", async () => {
    const h = linearAgent();
    const { id } = await h.seed({ teamId: "team-a", title: "T", state: "todo" });
    await h.tracker.cancel(id, { comment: "Duplicate of ENG-1." });
    expect(h.fake.stateChanges).toEqual([{ issueId: id, target: { type: "canceled" } }]);
    expect(h.fake.comments).toEqual([{ issueId: id, body: "Duplicate of ENG-1." }]);
  });

  it("maps only Linear's invalid input error to WorkItemNotFoundError", async () => {
    const h = linearAgent();
    await expect(h.tracker.get("ENG-404")).rejects.toThrow(
      new WorkItemNotFoundError("ENG-404").message,
    );
    h.fake.failures.set("getIssue", new Error("Linear is down"));
    await expect(h.tracker.get("ENG-404")).rejects.toThrow("Linear is down");
  });

  it("validates override states against each team's workflow, then saves", async () => {
    const calls: string[] = [];
    const h = linearAgent({ gateway: (fake) => counting(fake, calls) });
    const mapping = {
      ready: { types: ["unstarted", "unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: { "team-a": { ready: ["a-state-2"], needsRefining: ["a-state-1", "a-state-1"] } },
    };
    const saved = await h.tracker.setStateMapping(mapping);
    expect(saved).toEqual({
      ready: { types: ["unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: { "team-a": { ready: ["a-state-2"], needsRefining: ["a-state-1"] } },
    });
    expect(h.saved).toEqual([saved]);
    expect(calls).toEqual(["getWorkflowStates"]);
    // A team Linear doesn't have has no states.
    await expect(
      h.tracker.setStateMapping({
        ...mapping,
        teams: { "team-x": { ready: ["a-state-2"], needsRefining: ["a-state-1"] } },
      }),
    ).rejects.toMatchObject({
      fieldErrors: { "teams.team-x.ready": "This state isn't in the team's workflow." },
    });
    expect(h.saved).toHaveLength(1);
  });

  it("lists the fixture workspace's work items with readiness and blockers", async () => {
    const tracker = new LinearWorkItemTracker({
      gateway: fixtureLinearGateway(),
      integrationId: "fixture",
      stateMapping: DEFAULT_TRACKER_STATE_MAPPING,
      saveStateMapping: async () => undefined,
    });
    const { items } = await tracker.listCandidates({
      readiness: ["ready", "needs_refining"],
      limit: 50,
    });
    expect(
      items.map((i) => [i.identifier, i.readiness, i.blockedBy.map((b) => b.identifier)]),
    ).toEqual([
      ["FIX-101", "ready", []],
      ["FIX-102", "needs_refining", []],
      ["FIX-104", "ready", ["FIX-103"]],
      ["OPS-21", "needs_refining", []],
    ]);
    expect(items[0]).toMatchObject({
      team: { id: "fixture-team-fix", key: "FIX", name: "Fixtures" },
      project: { id: "fixture-project-1", name: "Control panel" },
    });
  });
});
