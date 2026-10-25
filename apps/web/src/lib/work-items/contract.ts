/**
 * The `WorkItemTracker` contract: one test suite every adapter runs
 * (`describeWorkItemTrackerContract(makeTracker)`), over the adapter and a way to arrange
 * work items directly in its tracker (a fake of the tracker's API).
 */
import type { TrackerStateMapping } from "@omniralph/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  StateMappingError,
  WORK_ITEM_STATES,
  WorkItemNotFoundError,
  type TrackerWorkflowState,
  type WorkItem,
  type WorkItemStateCategory,
  type WorkItemTracker,
} from "./tracker";

/** A work item arranged in the tracker. */
export interface SeedWorkItem {
  teamId: string;
  title: string;
  state: WorkItemStateCategory;
  labels?: string[];
  projectId?: string;
  delegatedToOmniralph?: boolean;
}

/** An adapter under test and its tracker, empty but for two teams and a project. */
export interface WorkItemTrackerHarness {
  tracker: WorkItemTracker;
  /**
   * Two teams, each with a workflow state of every category; the second team's states are
   * its own (other IDs than the first's).
   */
  teams: [string, string];
  /** A project items can be in. */
  projectId: string;
  /** A ref no work item has. */
  missingRef: string;
  seed(input: SeedWorkItem): Promise<{ id: string; identifier: string }>;
  /** `blockerId` blocks `blockedId`. */
  block(blockerId: string, blockedId: string): Promise<void>;
  /** The ID of the team's label with this name, created when missing. */
  labelId(teamId: string, name: string): Promise<string>;
  /** The item's comments, oldest first. */
  comments(id: string): Promise<string[]>;
  isDelegatedToOmniralph(id: string): Promise<boolean>;
  /** Whether the tracker was asked to start Omniralph's triage of the item. */
  isTriageRequested(id: string): Promise<boolean>;
  /** Marks the item as having an active Omniralph run (the tracker's `hasActiveRun`). */
  setActiveRun(id: string): void;
  /** How many new Omniralph agent sessions were opened on the item. */
  sessionsOpened(id: string): Promise<number>;
}

const stateOf = (states: TrackerWorkflowState[], category: WorkItemStateCategory) => {
  const state = states.find((s) => s.category === category);
  if (!state) throw new Error(`The team has no ${category} state`);
  return state;
};

/** Every page of a listing, following `nextCursor`. */
async function allPages(
  tracker: WorkItemTracker,
  input: Omit<Parameters<WorkItemTracker["listCandidates"]>[0], "cursor">,
): Promise<{ items: WorkItem[]; pages: number }> {
  const items: WorkItem[] = [];
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    const page = await tracker.listCandidates({ ...input, ...(cursor && { cursor }) });
    items.push(...page.items);
    if (!page.nextCursor) return { items, pages };
    cursor = page.nextCursor;
  }
}

const identifiers = (items: WorkItem[]) => items.map((item) => item.identifier).sort();

export function describeWorkItemTrackerContract(
  makeTracker: () => WorkItemTrackerHarness | Promise<WorkItemTrackerHarness>,
): void {
  describe("WorkItemTracker contract", () => {
    let h: WorkItemTrackerHarness;
    let tracker: WorkItemTracker;
    let teamA: string;
    let teamB: string;

    beforeEach(async () => {
      h = await makeTracker();
      tracker = h.tracker;
      [teamA, teamB] = h.teams;
    });

    describe("get", () => {
      it("reads a work item by ID and by identifier", async () => {
        const seeded = await h.seed({
          teamId: teamA,
          title: "Add exports",
          state: "todo",
          labels: ["backend"],
          projectId: h.projectId,
        });
        const item = await tracker.get(seeded.id);
        expect(item).toMatchObject({
          tracker: tracker.kind,
          id: seeded.id,
          identifier: seeded.identifier,
          title: "Add exports",
          state: { category: "todo" },
          team: { id: teamA },
          project: { id: h.projectId },
          labels: ["backend"],
          parentId: null,
          readiness: "ready",
          blockedBy: [],
          blocked: false,
        });
        expect(item.url).toMatch(/^https:\/\//);
        expect(item.team.key).not.toBe("");
        expect(item.team.name).not.toBe("");
        expect(await tracker.get(seeded.identifier)).toEqual(item);
      });

      it("throws WorkItemNotFoundError for an unknown ref", async () => {
        await expect(tracker.get(h.missingRef)).rejects.toBeInstanceOf(WorkItemNotFoundError);
        await expect(tracker.get(h.missingRef)).rejects.toThrow(/^This work item/);
      });
    });

    describe("changes to an unknown ref", () => {
      it.each([
        ["update", (t: WorkItemTracker, ref: string) => t.update(ref, { title: "x" })],
        ["setState", (t: WorkItemTracker, ref: string) => t.setState(ref, "done")],
        ["cancel", (t: WorkItemTracker, ref: string) => t.cancel(ref, { comment: "x" })],
        ["startTriage", (t: WorkItemTracker, ref: string) => t.startTriage(ref)],
        ["delegateToOmniralph", (t: WorkItemTracker, ref: string) => t.delegateToOmniralph(ref)],
      ])("%s throws WorkItemNotFoundError", async (_name, change) => {
        await expect(change(tracker, h.missingRef)).rejects.toBeInstanceOf(WorkItemNotFoundError);
      });
    });

    describe("listCandidates", () => {
      it("pages through every match with a cursor, without repeats", async () => {
        const seeded = [];
        for (let i = 1; i <= 5; i += 1) {
          seeded.push(await h.seed({ teamId: teamA, title: `Item ${i}`, state: "todo" }));
        }
        const first = await tracker.listCandidates({ teamId: teamA, limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).toEqual(expect.any(String));
        const { items, pages } = await allPages(tracker, { teamId: teamA, limit: 2 });
        expect(pages).toBe(3);
        expect(identifiers(items)).toEqual(seeded.map((s) => s.identifier).sort());
        const all = await tracker.listCandidates({ teamId: teamA, limit: 50 });
        expect(all.items).toHaveLength(5);
        expect(all.nextCursor).toBeNull();
      });

      it("answers an empty page when nothing matches", async () => {
        expect(await tracker.listCandidates({ teamId: teamB, limit: 10 })).toEqual({
          items: [],
          nextCursor: null,
        });
      });

      it("filters by team, project, label, delegation and state", async () => {
        const plain = await h.seed({ teamId: teamA, title: "Plain", state: "todo" });
        const inProject = await h.seed({
          teamId: teamA,
          title: "In project",
          state: "backlog",
          projectId: h.projectId,
        });
        const labeled = await h.seed({
          teamId: teamA,
          title: "Labeled",
          state: "in_progress",
          labels: ["frontend"],
        });
        const delegated = await h.seed({
          teamId: teamB,
          title: "Delegated",
          state: "todo",
          delegatedToOmniralph: true,
        });
        const list = async (
          input: Omit<Parameters<WorkItemTracker["listCandidates"]>[0], "limit">,
        ) => identifiers((await allPages(tracker, { ...input, limit: 50 })).items);

        expect(await list({ teamId: teamA })).toEqual(
          [plain, inProject, labeled].map((s) => s.identifier).sort(),
        );
        expect(await list({ teamId: teamB })).toEqual([delegated.identifier]);
        expect(await list({ projectId: h.projectId })).toEqual([inProject.identifier]);
        expect(await list({ labelIds: [await h.labelId(teamA, "frontend")] })).toEqual([
          labeled.identifier,
        ]);
        expect(await list({ delegatedToOmniralph: true })).toEqual([delegated.identifier]);
        expect(await list({ delegatedToOmniralph: false })).toEqual(
          [plain, inProject, labeled].map((s) => s.identifier).sort(),
        );
        expect(await list({ states: ["todo"] })).toEqual(
          [plain, delegated].map((s) => s.identifier).sort(),
        );
        expect(await list({ states: ["backlog", "in_progress"], teamId: teamA })).toEqual(
          [inProject, labeled].map((s) => s.identifier).sort(),
        );
      });

      it("filters by each state", async () => {
        const byState = new Map<string, string>();
        for (const state of WORK_ITEM_STATES) {
          byState.set(state, (await h.seed({ teamId: teamA, title: state, state })).identifier);
        }
        for (const state of WORK_ITEM_STATES) {
          const page = await tracker.listCandidates({ states: [state], limit: 50 });
          expect(page.items.map((item) => item.identifier)).toEqual([byState.get(state)]);
          expect(page.items[0]!.state.category).toBe(state);
        }
      });
    });

    describe("readiness", () => {
      it("follows the default mapping: todo is ready, backlog needs refining, others are other", async () => {
        const todo = await h.seed({ teamId: teamA, title: "Todo", state: "todo" });
        const backlog = await h.seed({ teamId: teamA, title: "Backlog", state: "backlog" });
        const started = await h.seed({ teamId: teamA, title: "Started", state: "in_progress" });
        const done = await h.seed({ teamId: teamA, title: "Done", state: "done" });
        const triage = await h.seed({ teamId: teamA, title: "Triage", state: "triage" });
        expect((await tracker.get(todo.id)).readiness).toBe("ready");
        expect((await tracker.get(backlog.id)).readiness).toBe("needs_refining");
        expect((await tracker.get(started.id)).readiness).toBe("other");
        expect((await tracker.get(done.id)).readiness).toBe("other");
        expect((await tracker.get(triage.id)).readiness).toBe("other");
        const { items } = await allPages(tracker, { teamId: teamA, limit: 50 });
        expect(Object.fromEntries(items.map((item) => [item.title, item.readiness]))).toEqual({
          Todo: "ready",
          Backlog: "needs_refining",
          Started: "other",
          Done: "other",
          Triage: "other",
        });
      });

      it("uses a team's override instead of the types for that team only", async () => {
        const statesB = await tracker.listWorkflowStates(teamB);
        await tracker.setStateMapping({
          ready: { types: ["unstarted"] },
          needsRefining: { types: ["backlog"] },
          teams: {
            [teamB]: {
              ready: [stateOf(statesB, "in_progress").id],
              needsRefining: [stateOf(statesB, "todo").id],
            },
          },
        });
        const aTodo = await h.seed({ teamId: teamA, title: "A todo", state: "todo" });
        const aStarted = await h.seed({ teamId: teamA, title: "A started", state: "in_progress" });
        const bTodo = await h.seed({ teamId: teamB, title: "B todo", state: "todo" });
        const bStarted = await h.seed({ teamId: teamB, title: "B started", state: "in_progress" });
        const bBacklog = await h.seed({ teamId: teamB, title: "B backlog", state: "backlog" });
        expect((await tracker.get(aTodo.id)).readiness).toBe("ready");
        expect((await tracker.get(aStarted.id)).readiness).toBe("other");
        expect((await tracker.get(bTodo.id)).readiness).toBe("needs_refining");
        expect((await tracker.get(bStarted.id)).readiness).toBe("ready");
        expect((await tracker.get(bBacklog.id)).readiness).toBe("other");

        const ready = await allPages(tracker, { readiness: ["ready"], limit: 2 });
        expect(identifiers(ready.items)).toEqual([aTodo, bStarted].map((s) => s.identifier).sort());
        expect(ready.items.every((item) => item.readiness === "ready")).toBe(true);
        const refining = await allPages(tracker, { readiness: ["needs_refining"], limit: 50 });
        expect(identifiers(refining.items)).toEqual([bTodo.identifier]);
        const both = await allPages(tracker, {
          readiness: ["ready", "needs_refining"],
          limit: 50,
        });
        expect(identifiers(both.items)).toEqual(
          [aTodo, bStarted, bTodo].map((s) => s.identifier).sort(),
        );
      });

      it("filters by readiness with the default mapping, combined with other filters", async () => {
        const todo = await h.seed({ teamId: teamA, title: "Todo", state: "todo" });
        const backlog = await h.seed({ teamId: teamA, title: "Backlog", state: "backlog" });
        await h.seed({ teamId: teamA, title: "Started", state: "in_progress" });
        const otherTeam = await h.seed({ teamId: teamB, title: "B todo", state: "todo" });
        const list = async (
          input: Omit<Parameters<WorkItemTracker["listCandidates"]>[0], "limit">,
        ) => identifiers((await allPages(tracker, { ...input, limit: 50 })).items);
        expect(await list({ readiness: ["ready"] })).toEqual(
          [todo, otherTeam].map((s) => s.identifier).sort(),
        );
        expect(await list({ readiness: ["ready"], teamId: teamA })).toEqual([todo.identifier]);
        expect(await list({ readiness: ["needs_refining"] })).toEqual([backlog.identifier]);
        expect(await list({ readiness: ["ready"], states: ["backlog"] })).toEqual([]);
      });
    });

    describe("blockers", () => {
      it("lists open blockers only, in get and listCandidates", async () => {
        const blocked = await h.seed({ teamId: teamA, title: "Blocked", state: "todo" });
        const open = await h.seed({ teamId: teamA, title: "Open blocker", state: "in_progress" });
        const done = await h.seed({ teamId: teamA, title: "Done blocker", state: "done" });
        const canceled = await h.seed({ teamId: teamA, title: "Canceled", state: "canceled" });
        const free = await h.seed({ teamId: teamA, title: "Free", state: "todo" });
        await h.block(open.id, blocked.id);
        await h.block(done.id, blocked.id);
        await h.block(canceled.id, blocked.id);
        await h.block(done.id, free.id);

        const item = await tracker.get(blocked.id);
        expect(item.blocked).toBe(true);
        expect(item.blockedBy).toEqual([
          {
            ref: open.id,
            identifier: open.identifier,
            title: "Open blocker",
            state: { category: "in_progress", name: expect.any(String) },
          },
        ]);
        expect(await tracker.get(free.id)).toMatchObject({ blocked: false, blockedBy: [] });

        const { items } = await allPages(tracker, { readiness: ["ready"], limit: 50 });
        const byId = new Map(items.map((i) => [i.id, i]));
        expect(byId.get(blocked.id)).toMatchObject({ blocked: true, blockedBy: item.blockedBy });
        expect(byId.get(free.id)).toMatchObject({ blocked: false, blockedBy: [] });
      });
    });

    describe("create", () => {
      it("creates a work item with labels (created when missing), project and priority", async () => {
        const parent = await h.seed({ teamId: teamA, title: "Parent", state: "todo" });
        const item = await tracker.create({
          teamId: teamA,
          projectId: h.projectId,
          parentId: parent.id,
          title: "New item",
          description: "Details",
          labels: ["brand-new"],
          priority: 2,
        });
        expect(item).toMatchObject({
          title: "New item",
          description: "Details",
          team: { id: teamA },
          project: { id: h.projectId },
          parentId: parent.id,
          labels: ["brand-new"],
          priority: 2,
          blockedBy: [],
          blocked: false,
        });
        expect(await tracker.get(item.id)).toMatchObject({
          title: "New item",
          labels: ["brand-new"],
          parentId: parent.id,
        });
        await expect(h.labelId(teamA, "brand-new")).resolves.toEqual(expect.any(String));
      });

      it("creates a plain work item", async () => {
        const item = await tracker.create({ teamId: teamB, title: "Plain", description: "" });
        expect(item).toMatchObject({ project: null, parentId: null, labels: [] });
        expect((await tracker.get(item.identifier)).id).toBe(item.id);
      });
    });

    describe("update", () => {
      it("changes only the given fields and adds and removes labels", async () => {
        const seeded = await h.seed({
          teamId: teamA,
          title: "Old",
          state: "todo",
          labels: ["keep", "drop"],
        });
        await tracker.update(seeded.identifier, { title: "New", addLabels: ["added"] });
        expect(await tracker.get(seeded.id)).toMatchObject({ title: "New", priority: 0 });
        await tracker.update(seeded.id, {
          description: "Body",
          priority: 1,
          removeLabels: ["drop", "never-there"],
        });
        const item = await tracker.get(seeded.id);
        expect(item).toMatchObject({ title: "New", description: "Body", priority: 1 });
        expect([...item.labels].sort()).toEqual(["added", "keep"]);
      });
    });

    describe("setState", () => {
      it.each(WORK_ITEM_STATES)("moves a work item to %s", async (state) => {
        const seeded = await h.seed({ teamId: teamB, title: "Item", state: "triage" });
        await tracker.setState(seeded.identifier, state);
        expect((await tracker.get(seeded.id)).state.category).toBe(state);
      });

      it("moves a work item to the mapping's first state of a readiness", async () => {
        const ready = await h.seed({ teamId: teamA, title: "To ready", state: "triage" });
        await tracker.setState(ready.identifier, { readiness: "ready" });
        expect(await tracker.get(ready.id)).toMatchObject({
          state: { category: "todo" },
          readiness: "ready",
        });
        const refining = await h.seed({ teamId: teamA, title: "To refine", state: "todo" });
        await tracker.setState(refining.id, { readiness: "needs_refining" });
        expect(await tracker.get(refining.id)).toMatchObject({
          state: { category: "backlog" },
          readiness: "needs_refining",
        });
      });

      it("uses a team's override states first, and leaves an item that has the readiness", async () => {
        const statesB = await tracker.listWorkflowStates(teamB);
        const started = stateOf(statesB, "in_progress");
        await tracker.setStateMapping({
          ready: { types: ["unstarted"] },
          needsRefining: { types: ["backlog"] },
          teams: { [teamB]: { ready: [started.id], needsRefining: [stateOf(statesB, "todo").id] } },
        });
        const b = await h.seed({ teamId: teamB, title: "B", state: "backlog" });
        await tracker.setState(b.id, { readiness: "ready" });
        expect((await tracker.get(b.id)).state).toEqual({
          category: "in_progress",
          name: started.name,
        });
        const a = await h.seed({ teamId: teamA, title: "A", state: "todo" });
        const before = await tracker.get(a.id);
        await tracker.setState(a.id, { readiness: "ready" });
        expect((await tracker.get(a.id)).state).toEqual(before.state);
      });
    });

    describe("cancel", () => {
      it("cancels with a comment", async () => {
        const seeded = await h.seed({ teamId: teamA, title: "Item", state: "todo" });
        await tracker.cancel(seeded.identifier, { comment: "Not needed anymore." });
        expect((await tracker.get(seeded.id)).state.category).toBe("canceled");
        expect(await h.comments(seeded.id)).toEqual(["Not needed anymore."]);
      });

      it("cancels without a comment", async () => {
        const seeded = await h.seed({ teamId: teamA, title: "Item", state: "backlog" });
        await tracker.cancel(seeded.id);
        expect((await tracker.get(seeded.id)).state.category).toBe("canceled");
        expect(await h.comments(seeded.id)).toEqual([]);
      });
    });

    describe("startTriage", () => {
      it("asks for triage, once", async () => {
        const seeded = await h.seed({ teamId: teamA, title: "Item", state: "backlog" });
        expect(await h.isTriageRequested(seeded.id)).toBe(false);
        await tracker.startTriage(seeded.identifier);
        expect(await h.isTriageRequested(seeded.id)).toBe(true);
        await tracker.startTriage(seeded.id);
        expect(await h.isTriageRequested(seeded.id)).toBe(true);
      });
    });

    describe("delegateToOmniralph", () => {
      it("delegates the work item to Omniralph", async () => {
        const seeded = await h.seed({ teamId: teamA, title: "Item", state: "todo" });
        expect(await h.isDelegatedToOmniralph(seeded.id)).toBe(false);
        await tracker.delegateToOmniralph(seeded.identifier);
        expect(await h.isDelegatedToOmniralph(seeded.id)).toBe(true);
        const delegated = await tracker.listCandidates({ delegatedToOmniralph: true, limit: 10 });
        expect(delegated.items.map((i) => i.id)).toEqual([seeded.id]);
        expect(await h.sessionsOpened(seeded.id)).toBe(0);
      });

      it("opens a new session on an item already delegated to Omniralph with no active run", async () => {
        const seeded = await h.seed({
          teamId: teamA,
          title: "Item",
          state: "todo",
          delegatedToOmniralph: true,
        });
        await tracker.delegateToOmniralph(seeded.identifier);
        expect(await h.isDelegatedToOmniralph(seeded.id)).toBe(true);
        expect(await h.sessionsOpened(seeded.id)).toBe(1);
      });

      it("opens no session while Omniralph is working on the item", async () => {
        const seeded = await h.seed({
          teamId: teamA,
          title: "Item",
          state: "todo",
          delegatedToOmniralph: true,
        });
        h.setActiveRun(seeded.id);
        await tracker.delegateToOmniralph(seeded.id);
        expect(await h.isDelegatedToOmniralph(seeded.id)).toBe(true);
        expect(await h.sessionsOpened(seeded.id)).toBe(0);
      });
    });

    describe("state mapping", () => {
      it("starts with the default mapping", async () => {
        expect(await tracker.getStateMapping()).toEqual({
          ready: { types: ["unstarted"] },
          needsRefining: { types: ["backlog"] },
          teams: {},
        });
      });

      it("lists a team's workflow states with their categories", async () => {
        const states = await tracker.listWorkflowStates(teamB);
        for (const category of ["backlog", "todo", "in_progress", "done", "canceled"] as const) {
          expect(stateOf(states, category)).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            type: expect.any(String),
          });
        }
        const statesA = await tracker.listWorkflowStates(teamA);
        const idsA = new Set(statesA.map((s) => s.id));
        expect(states.filter((s) => idsA.has(s.id))).toEqual([]);
      });

      it("saves a valid mapping", async () => {
        const statesA = await tracker.listWorkflowStates(teamA);
        const mapping = {
          ready: { types: ["unstarted", "started"] },
          needsRefining: { types: ["triage", "backlog"] },
          teams: {
            [teamA]: {
              ready: [stateOf(statesA, "todo").id],
              needsRefining: [stateOf(statesA, "backlog").id],
            },
          },
        };
        expect(await tracker.setStateMapping(mapping)).toEqual(mapping);
        expect(await tracker.getStateMapping()).toEqual(mapping);
      });

      it("rejects invalid mappings with field errors, and keeps the saved one", async () => {
        const statesA = await tracker.listWorkflowStates(teamA);
        const statesB = await tracker.listWorkflowStates(teamB);
        const todoA = stateOf(statesA, "todo").id;
        const backlogA = stateOf(statesA, "backlog").id;
        const base: TrackerStateMapping = {
          ready: { types: ["unstarted"] },
          needsRefining: { types: ["backlog"] },
          teams: {},
        };
        const rejects = async (mapping: TrackerStateMapping, field: string) => {
          const error = await tracker.setStateMapping(mapping).catch((e: unknown) => e);
          expect(error).toBeInstanceOf(StateMappingError);
          expect(Object.keys((error as StateMappingError).fieldErrors)).toContain(field);
        };
        // A state of another team's workflow.
        await rejects(
          {
            ...base,
            teams: {
              [teamA]: { ready: [stateOf(statesB, "todo").id], needsRefining: [backlogA] },
            },
          },
          `teams.${teamA}.ready`,
        );
        // A state in both lists.
        await rejects(
          { ...base, teams: { [teamA]: { ready: [todoA], needsRefining: [todoA, backlogA] } } },
          `teams.${teamA}.needsRefining`,
        );
        await rejects(
          { ...base, needsRefining: { types: ["backlog", "unstarted"] } },
          "needsRefining.types",
        );
        // Empty lists.
        await rejects({ ...base, ready: { types: [] } }, "ready.types");
        await rejects(
          { ...base, teams: { [teamA]: { ready: [todoA], needsRefining: [] } } },
          `teams.${teamA}.needsRefining`,
        );
        // Types other than triage, backlog, unstarted and started.
        await rejects({ ...base, ready: { types: ["completed"] } }, "ready.types");
        await rejects({ ...base, needsRefining: { types: ["canceled"] } }, "needsRefining.types");
        expect(await tracker.getStateMapping()).toEqual(base);
      });
    });
  });
}
