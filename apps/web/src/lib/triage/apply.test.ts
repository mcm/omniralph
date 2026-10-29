import { eq } from "drizzle-orm";
import {
  closeDb,
  createDb,
  createTriageRun,
  getJob,
  getTriageRun,
  insertJob,
  integrations,
  saveIntegration,
  setIntegrationStateMapping,
  jobs,
  organizations,
  setTriageRunJob,
  triageRuns,
  type Database,
  type Job,
} from "@omniralph/db";
import type { TriageAgentOutput } from "@omniralph/ralph";
import type { QueryRunResult, RunSpecJobPayload, TriageOutcome } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { BUILTIN_PLAYBOOK_SOURCE } from "@/lib/playbooks";
import { jobHooks } from "@/lib/sinks";
import type { IssueSummary } from "@/lib/linear/gateway";
import { loadEpic } from "@/lib/ralph/epic-loader";
import {
  applyTriageJob,
  onTriageJobCompleted,
  onTriageJobFinishedWithoutResult,
  onTriageJobStarted,
  openQuestionsComment,
  storyPlan,
  triagedDescription,
} from "./apply";

vi.mock("server-only", () => ({}));

/** The gateway the sink's hooks get (they load the organization's own). */
const gateway = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/linear/client", () => ({ getLinearGateway: async () => gateway.current }));

const databaseAvailable = testDatabaseAvailable();

const PRD = [
  "## Introduction",
  "",
  "Export widgets as CSV.",
  "",
  "## Quality Gates",
  "",
  "- `pnpm test` - Tests",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] It works",
].join("\n");

type Story = TriageAgentOutput["stories"][number];

const story = (title: string, overrides: Partial<Story> = {}): Story => ({
  title,
  body: `As a user, I want ${title.toLowerCase()}.\n\n## Acceptance Criteria\n\n- [ ] ${title} works`,
  priority: 2,
  dependsOn: [],
  manual: false,
  ...overrides,
});

const outcome = (overrides: Partial<TriageOutcome> = {}): TriageOutcome => ({
  outcome: "prd",
  size: "S",
  title: "Export widgets as CSV",
  description: PRD,
  openQuestions: [],
  stories: [],
  subIssueUpdates: [],
  ...overrides,
});

/** A `builtin:triage` run's result: the triage (`TriageAgentOutput`) is its structured output. */
const result = (overrides: Partial<TriageOutcome> = {}): QueryRunResult => ({
  outcome: "answered",
  answer: null,
  structured: { ...outcome(overrides), summary: "Sized it and wrote the PRD." },
  references: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 10,
});

describe("storyPlan", () => {
  it("orders stories, maps dependencies and blocks the validation story by every other", () => {
    const plan = storyPlan([
      story("First"),
      story("Second", { dependsOn: [0], manual: true, priority: 3 }),
      story("Third"),
      story("Validate functional requirements", { dependsOn: [1] }),
    ]);
    expect(plan.issues.map((i) => [i.title, i.subIssueSortOrder, i.priority, i.manual])).toEqual([
      ["First", 0, 2, false],
      ["Second", 1, 3, true],
      ["Third", 2, 2, false],
      ["Validate functional requirements", 3, 2, false],
    ]);
    expect(plan.relations).toEqual([
      { blocker: "story-0", blocked: "story-1" },
      { blocker: "story-0", blocked: "story-3" },
      { blocker: "story-1", blocked: "story-3" },
      { blocker: "story-2", blocked: "story-3" },
    ]);
  });
});

describe("triage texts", () => {
  it("appends the open questions to the description only when there are any", () => {
    expect(triagedDescription({ description: `${PRD}\n`, openQuestions: [] })).toBe(PRD);
    expect(triagedDescription({ description: PRD, openQuestions: ["Which format?"] })).toBe(
      `${PRD}\n\n## Open Questions\n\n1. Which format?`,
    );
  });

  it("mentions the creator by profile URL, else by name", () => {
    const url = "https://linear.app/acme/profiles/ada";
    expect(openQuestionsComment({ creator: { id: "u", name: "Ada", url } }, ["A?"])).toMatch(
      new RegExp(`^${url} triage left an open question`),
    );
    expect(openQuestionsComment({ creator: { id: "u", name: "Ada" } }, ["A?", "B?"])).toMatch(
      /^@Ada triage left 2 open questions[\s\S]*\n1\. A\?\n2\. B\?$/,
    );
    expect(openQuestionsComment({}, ["A?"])).toMatch(/^triage left/);
  });
});

describe.skipIf(!databaseAvailable)("applying triage results to Linear", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let linear: FakeLinearGateway;
  let sessionSeq = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(triageRuns);
    await db.delete(jobs);
    linear = new FakeLinearGateway();
    gateway.current = linear;
  });

  const deps = () => ({ db, linear });

  /** A triage run of `issue` whose current job completed with `jobResult`. */
  const completedJob = async (issue: IssueSummary, jobResult: unknown) => {
    sessionSeq += 1;
    const sessionId = `apply-session-${sessionSeq}`;
    const { run } = await createTriageRun(db, {
      organizationId: orgId,
      linearIssueId: issue.id,
      linearAgentSessionId: sessionId,
      trigger: "mention",
    });
    const payload: RunSpecJobPayload = {
      trigger: {
        kind: "linear.triage",
        context: {
          triageRunId: run.id,
          issue: { identifier: issue.identifier, title: issue.title },
        },
      },
    };
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "triage.run",
      taskType: "query",
      taskId: "builtin:triage",
      payload,
    });
    await setTriageRunJob(db, run.id, job.id);
    const [done] = await db
      .update(jobs)
      .set({ status: "completed", result: jobResult as Record<string, unknown> })
      .where(eq(jobs.id, job.id))
      .returning();
    return { run, job: done as Job, sessionId };
  };

  const addIssue = (overrides: Partial<IssueSummary> = {}) =>
    linear.add({
      title: "csv export",
      description: "we need csv",
      stateType: "backlog",
      stateName: "Backlog",
      creator: { id: "user-1", name: "Ada", url: "https://linear.app/acme/profiles/ada" },
      ...overrides,
    });

  const responses = (sessionId: string) =>
    linear.activities.filter((a) => a.sessionId === sessionId).map((a) => a.content);

  it("rewrites a single issue with no open questions and moves it to Todo", async () => {
    const issue = addIssue();
    const { run, job, sessionId } = await completedJob(issue, result());

    expect(await applyTriageJob(deps(), job)).toMatchObject({
      status: "applied",
      created: [],
      readiness: "ready",
    });
    const updated = await linear.getIssue(issue.id);
    expect(updated).toMatchObject({
      title: "Export widgets as CSV",
      description: PRD,
      stateType: "unstarted",
    });
    expect(linear.stateChanges).toEqual([{ issueId: issue.id, target: { id: "state-unstarted" } }]);
    expect(linear.comments).toEqual([]);
    const [response] = responses(sessionId);
    expect(response).toMatchObject({ type: "response" });
    expect(response && "body" in response && response.body).toMatch(
      /Size:\*\* S[\s\S]*Structure:\*\* single issue[\s\S]*Status:\*\* Ready to start[\s\S]*ENG-\d+ is ready to start\. Start it from the Backlog, or delegate it to Om again\.$/,
    );
    expect(await getTriageRun(db, run.id)).toMatchObject({
      status: "completed",
      lastResult: { summary: "Sized it and wrote the PRD." },
    });

    // A replayed result is applied once.
    await applyTriageJob(deps(), job);
    expect(linear.issueUpdates).toHaveLength(1);
    expect(responses(sessionId)).toHaveLength(1);
  });

  it("moves the issue through the integration's state mapping, team override first", async () => {
    linear.workflowStatesByTeam.set("team-1", [
      { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
      { id: "s-idea", name: "Idea", type: "backlog", position: 1 },
      { id: "s-todo", name: "Todo", type: "unstarted", position: 2 },
      { id: "s-selected", name: "Selected", type: "unstarted", position: 3 },
      { id: "s-started", name: "In Progress", type: "started", position: 4 },
    ]);
    await db.delete(integrations);
    const integration = await saveIntegration(
      db,
      {
        organizationId: orgId,
        provider: "linear",
        externalId: "workspace-1",
        name: "Acme",
        credentials: { accessToken: "t" },
        installedByUserId: null,
      },
      Buffer.alloc(32, 7),
    );
    if (integration === "other_organization") throw new Error("unexpected");
    await setIntegrationStateMapping(db, integration.id, {
      ready: { types: ["unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: { "team-1": { ready: ["s-selected"], needsRefining: ["s-idea"] } },
    });
    try {
      const ready = addIssue();
      const first = await completedJob(ready, result());
      expect(await applyTriageJob(deps(), first.job)).toMatchObject({ readiness: "ready" });
      expect(await linear.getIssue(ready.id)).toMatchObject({
        stateName: "Selected",
        stateId: "s-selected",
      });
      const last = responses(first.sessionId).at(-1);
      expect(last && "body" in last && last.body).toMatch(
        new RegExp(
          `\\n${ready.identifier} is ready to start\\. Start it from the Backlog, or delegate it to Om again\\.$`,
        ),
      );

      const refining = addIssue({ stateType: "unstarted", stateName: "Selected" });
      const second = await completedJob(refining, result({ openQuestions: ["Which?"] }));
      expect(await applyTriageJob(deps(), second.job)).toMatchObject({
        readiness: "needs_refining",
      });
      expect(await linear.getIssue(refining.id)).toMatchObject({ stateName: "Idea" });
    } finally {
      await db.delete(integrations);
    }
  });

  it("keeps an issue with open questions in Backlog and asks its creator", async () => {
    const issue = addIssue({ stateType: "unstarted", stateName: "Todo" });
    const questions = ["Which columns?", "Who can export?"];
    const { job, sessionId } = await completedJob(issue, result({ openQuestions: questions }));

    expect(await applyTriageJob(deps(), job)).toMatchObject({ readiness: "needs_refining" });
    const updated = await linear.getIssue(issue.id);
    expect(updated.description).toBe(
      `${PRD}\n\n## Open Questions\n\n1. Which columns?\n2. Who can export?`,
    );
    expect(updated.stateType).toBe("backlog");
    expect(linear.comments).toHaveLength(1);
    expect(linear.comments[0]).toMatchObject({ issueId: issue.id });
    expect(linear.comments[0]!.body).toMatch(
      /^https:\/\/linear\.app\/acme\/profiles\/ada [\s\S]*1\. Which columns\?\n2\. Who can export\?$/,
    );
    const body = JSON.stringify(responses(sessionId));
    expect(body).toContain("Status:** Needs refining");
    expect(body).toContain("Which columns?");
  });

  it("creates a new XL epic's sub-issues with priorities, relations and the manual label", async () => {
    const issue = addIssue({ projectName: "Widgets" });
    const stories = [
      story("Add the export endpoint", { priority: 1 }),
      story("Add the export button", { dependsOn: [0], priority: 2 }),
      story("Announce it", { manual: true, priority: 4 }),
      story("Validate functional requirements", { priority: 3 }),
    ];
    const { job, sessionId } = await completedJob(issue, result({ size: "XL", stories }));

    const applied = await applyTriageJob(deps(), job);
    expect(applied).toMatchObject({ status: "applied", readiness: "ready" });
    const children = await linear.getChildren(issue.id);
    expect(
      children.map((c) => [c.title, c.priority, c.subIssueSortOrder, c.labels, c.projectName]),
    ).toEqual([
      ["Add the export endpoint", 1, 0, [], "Widgets"],
      ["Add the export button", 2, 1, [], "Widgets"],
      ["Announce it", 4, 2, ["manual"], "Widgets"],
      ["Validate functional requirements", 3, 3, [], "Widgets"],
    ]);
    expect(children[0]!.description).toBe(stories[0]!.body);
    const [endpoint, button, announce, validation] = children;
    expect((await linear.getBlockers(button!.id)).map((b) => b.id)).toEqual([endpoint!.id]);
    expect(await linear.getBlockers(endpoint!.id)).toEqual([]);
    expect((await linear.getBlockers(validation!.id)).map((b) => b.id).sort()).toEqual(
      [endpoint!.id, button!.id, announce!.id].sort(),
    );
    expect((await linear.getIssue(issue.id)).stateType).toBe("unstarted");
    const body = JSON.stringify(responses(sessionId));
    expect(body).toContain("Size:** XL");
    expect(body).toContain(
      `epic with 4 new sub-issues: ${children.map((c) => c.identifier).join(", ")}`,
    );
  });

  it("leaves a triaged epic that ralph loads as-is, without materializing it again", async () => {
    const issue = addIssue();
    const stories = [
      story("Add the export endpoint", { priority: 1 }),
      story("Add the export button", { dependsOn: [0] }),
      story("Announce it", { manual: true }),
      story("Validate functional requirements", { priority: 3 }),
    ];
    const { job } = await completedJob(issue, result({ size: "L", stories }));
    await applyTriageJob(deps(), job);
    const issueCount = linear.issues.size;
    const updates = linear.issueUpdates.length;
    const [endpoint, button, announce, validation] = await linear.getChildren(issue.id);

    // A delegation of a never-run issue loads with `completePrd`: still nothing new.
    const loaded = await loadEpic(linear, issue.id, {
      completePrd: true,
      manualLabels: ["manual"],
    });
    expect(loaded).toMatchObject({ kind: "children", materialized: 0, root: { id: issue.id } });
    expect(linear.issues.size).toBe(issueCount);
    expect(linear.issueUpdates).toHaveLength(updates);
    expect(loaded.epic.description).toBe(PRD);
    expect(loaded.epic.qualityGates).not.toEqual([]);
    expect(
      loaded.epic.stories.map((s) => [s.title, s.priority, [...s.dependsOn].sort(), !!s.manual]),
    ).toEqual([
      ["Add the export endpoint", 1, [], false],
      ["Add the export button", 2, [endpoint!.id], false],
      ["Announce it", 2, [], true],
      [
        "Validate functional requirements",
        3,
        [endpoint!.id, button!.id, announce!.id].sort(),
        false,
      ],
    ]);
    expect(loaded.epic.stories[3]!.key).toBe(validation!.id);
  });

  it("creates no story sub-issues next to an epic's existing ones", async () => {
    const issue = addIssue();
    const existing = linear.add({ title: "Old story", parentId: issue.id, stateType: "backlog" });
    const { job, sessionId } = await completedJob(
      issue,
      result({ size: "XL", stories: [story("One"), story("Validate functional requirements")] }),
    );

    expect(await applyTriageJob(deps(), job)).toMatchObject({ status: "applied", created: [] });
    expect(await linear.getChildren(issue.id)).toEqual([
      expect.objectContaining({ id: existing.id }),
    ]);
    expect(linear.issueUpdates.map((u) => u.issueId)).toEqual([issue.id]);
    expect(JSON.stringify(responses(sessionId))).toContain("none created, the issue already has 1");
  });

  type Update = TriageAgentOutput["subIssueUpdates"][number];
  const update = (child: IssueSummary, overrides: Partial<Update> = {}): Update => ({
    id: child.id,
    title: `${child.title} (reformatted)`,
    body: `As a user, I want ${child.title}.\n\n## Acceptance Criteria\n\n- [ ] It works`,
    priority: 2,
    blockedBy: [],
    ...overrides,
  });

  it("reformats Backlog/Todo sub-issues, adds missing relations and the validation sub-issue", async () => {
    const issue = addIssue({ title: "Export widgets as CSV", projectName: "Widgets" });
    const child = (title: string, overrides: Partial<IssueSummary> = {}) =>
      linear.add({ title, parentId: issue.id, priority: 3, stateType: "backlog", ...overrides });
    const first = child("US-001: endpoint", { subIssueSortOrder: 0 });
    const second = child("US-002: button", { stateType: "unstarted", subIssueSortOrder: 1 });
    const third = child("Docs", { subIssueSortOrder: 2, description: "fine already" });
    const dropped = child("Dropped", { stateType: "canceled", subIssueSortOrder: 3 });
    await linear.createBlocksRelation(first.id, second.id);

    const updates = [
      update(first, { title: "Add the export endpoint", priority: 1 }),
      // The existing relation is kept, the missing one added; a canceled blocker is skipped.
      update(second, { blockedBy: [first.id, third.identifier, dropped.id] }),
    ];
    const { job, sessionId } = await completedJob(
      issue,
      result({ outcome: "reformat", size: "L", subIssueUpdates: updates }),
    );

    const applied = await applyTriageJob(deps(), job);
    expect(applied).toMatchObject({
      status: "applied",
      reformatted: [first.identifier, second.identifier],
      ignored: [],
      readiness: "ready",
    });
    expect(await linear.getIssue(issue.id)).toMatchObject({ description: PRD });
    expect(await linear.getIssue(first.id)).toMatchObject({
      title: "Add the export endpoint",
      description: updates[0]!.body,
      priority: 1,
    });
    expect(await linear.getIssue(second.id)).toMatchObject({
      title: "US-002: button (reformatted)",
      priority: 2,
      stateType: "unstarted",
    });
    expect(await linear.getIssue(third.id)).toMatchObject({
      title: "Docs",
      description: "fine already",
    });
    expect((await linear.getBlockers(second.id)).map((b) => b.id)).toEqual([first.id, third.id]);

    const children = await linear.getChildren(issue.id);
    expect(children.map((c) => c.id).slice(0, 4)).toEqual([
      first.id,
      second.id,
      third.id,
      dropped.id,
    ]);
    expect(children).toHaveLength(5);
    const validation = children[4]!;
    expect(validation).toMatchObject({
      title: "Validate functional requirements",
      parentId: issue.id,
      subIssueSortOrder: 4,
      projectName: "Widgets",
    });
    expect(validation.description).toContain("## Acceptance Criteria");
    expect((await linear.getBlockers(validation.id)).map((b) => b.id).sort()).toEqual(
      [first.id, second.id, third.id].sort(),
    );
    expect(applied).toMatchObject({ created: [{ id: validation.id }] });
    // Nothing canceled, deleted or reparented.
    expect(linear.stateChanges).toEqual([{ issueId: issue.id, target: { id: "state-unstarted" } }]);
    expect((await linear.getIssue(dropped.id)).stateType).toBe("canceled");

    const body = JSON.stringify(responses(sessionId));
    expect(body).toContain("reformatted");
    expect(body).toContain("epic with 4 existing sub-issues");
    expect(body).toContain(`Sub-issues reformatted:** ${first.identifier}, ${second.identifier}`);
    expect(body).toContain(`Validation sub-issue created:** ${validation.identifier}`);
  });

  it("keeps an existing validation sub-issue and ignores updates of foreign issues", async () => {
    const issue = addIssue();
    const own = linear.add({ title: "Story", parentId: issue.id, stateType: "backlog" });
    linear.add({
      title: "Validate functional requirements",
      parentId: issue.id,
      stateType: "backlog",
    });
    const foreign = linear.add({ title: "Someone else's", stateType: "backlog" });
    const updates = [
      update(own, { blockedBy: ["ENG-404"] }),
      update(foreign, { title: "Hijacked" }),
    ];
    const { job, sessionId } = await completedJob(
      issue,
      result({ outcome: "reformat", size: "L", subIssueUpdates: updates }),
    );

    const applied = await applyTriageJob(deps(), job);
    expect(applied).toMatchObject({
      status: "applied",
      created: [],
      reformatted: [own.identifier],
      ignored: [
        `blocker \`ENG-404\` of ${own.identifier} isn't a sibling sub-issue`,
        `\`${foreign.id}\` isn't a sub-issue of ${issue.identifier}`,
      ],
    });
    expect(await linear.getIssue(foreign.id)).toMatchObject({ title: "Someone else's" });
    expect(linear.issueUpdates.map((u) => u.issueId)).not.toContain(foreign.id);
    expect(await linear.getChildren(issue.id)).toHaveLength(2);
    expect(await linear.getBlockers(own.id)).toEqual([]);
    const body = JSON.stringify(responses(sessionId));
    expect(body).toContain("Ignored sub-issue updates:");
    expect(body).toContain(`isn't a sub-issue of ${issue.identifier}`);
  });

  it("changes nothing in a reformat when one sub-issue is started", async () => {
    const issue = addIssue();
    const todo = linear.add({ title: "Todo", parentId: issue.id, stateType: "unstarted" });
    linear.add({ title: "Busy", parentId: issue.id, stateType: "started", identifier: "ENG-77" });
    const { job, sessionId } = await completedJob(
      issue,
      result({ outcome: "reformat", size: "L", subIssueUpdates: [update(todo)] }),
    );

    expect(await applyTriageJob(deps(), job)).toEqual({
      status: "in_progress",
      issues: ["ENG-77"],
    });
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
    expect(await linear.getChildren(issue.id)).toHaveLength(2);
    expect(await linear.getBlockers(todo.id)).toEqual([]);
    expect(JSON.stringify(responses(sessionId))).toContain(
      "**ENG-77** is already in progress or done",
    );
  });

  it("applies only the state, open questions and response when unchanged", async () => {
    const issue = addIssue({
      title: "Export widgets",
      description: `${PRD}\n\n## Open Questions\n\n1. Old question?`,
    });
    const child = linear.add({ title: "Story", parentId: issue.id, stateType: "backlog" });
    const { job, sessionId } = await completedJob(
      issue,
      result({ outcome: "unchanged", size: "L", title: "A new title", openQuestions: ["New?"] }),
    );

    expect(await applyTriageJob(deps(), job)).toMatchObject({
      status: "applied",
      created: [],
      reformatted: [],
      readiness: "needs_refining",
    });
    expect(linear.issueUpdates).toEqual([
      { issueId: issue.id, input: { description: `${PRD}\n\n## Open Questions\n\n1. New?` } },
    ]);
    expect((await linear.getIssue(issue.id)).title).toBe("Export widgets");
    expect(await linear.getChildren(issue.id)).toEqual([expect.objectContaining({ id: child.id })]);
    expect(linear.stateChanges).toEqual([]); // already in Backlog
    expect(linear.comments).toHaveLength(1);
    expect(JSON.stringify(responses(sessionId))).toContain("already in the PRD format");

    // Once answered, the section goes and it moves to Todo, still without other changes.
    const again = addIssue({ description: `${PRD}\n\n## Open Questions\n\n1. Old?` });
    linear.issueUpdates = [];
    const second = await completedJob(again, result({ outcome: "unchanged" }));
    expect(await applyTriageJob(deps(), second.job)).toMatchObject({ readiness: "ready" });
    expect(linear.issueUpdates).toEqual([{ issueId: again.id, input: { description: PRD } }]);
    expect((await linear.getIssue(again.id)).stateType).toBe("unstarted");
  });

  it("changes nothing when work started while triage ran", async () => {
    const issue = addIssue();
    const { job, sessionId, run } = await completedJob(
      issue,
      result({ size: "L", stories: [story("One"), story("Validate functional requirements")] }),
    );
    // A sub-issue was added and started meanwhile.
    linear.add({
      title: "Started",
      parentId: issue.id,
      stateType: "started",
      identifier: "ENG-99",
    });
    // Canceled ones don't count.
    linear.add({ title: "Dropped", parentId: issue.id, stateType: "canceled" });

    expect(await applyTriageJob(deps(), job)).toEqual({
      status: "in_progress",
      issues: ["ENG-99"],
    });
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
    expect(linear.comments).toEqual([]);
    expect(await linear.getChildren(issue.id)).toHaveLength(2);
    const [response] = responses(sessionId);
    expect(response).toMatchObject({ type: "response" });
    expect(JSON.stringify(response)).toContain("**ENG-99** is already in progress or done");
    expect((await getTriageRun(db, run.id))?.status).toBe("stopped");
  });

  it("fails an invalid result without touching Linear", async () => {
    const issue = addIssue();
    // An XL prd without stories doesn't validate.
    const { job, sessionId, run } = await completedJob(issue, result({ size: "XL" }));

    await onTriageJobCompleted(db, job, deps());
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
    expect(linear.comments).toEqual([]);
    expect(linear.issues.size).toBe(1);
    const [error] = responses(sessionId);
    expect(error).toMatchObject({ type: "error" });
    expect(JSON.stringify(error)).toContain("size XL is an epic");
    expect((await getTriageRun(db, run.id))?.status).toBe("failed");
    // The run's page gets a plain sentence with a next step; the reply keeps the detail.
    const plain =
      "Om's PRD was incomplete, so nothing changed in Linear. Retry the triage, or add detail to the work item first.";
    expect(await getJob(db, job.id)).toMatchObject({ status: "failed", error: plain });
    expect((await getTriageRun(db, run.id))?.lastResult).toMatchObject({ error: plain });

    // Replayed: nothing more.
    await onTriageJobCompleted(db, job, deps());
    expect(responses(sessionId)).toHaveLength(1);
  });

  it("fails a run that ended without a result", async () => {
    const issue = addIssue();
    const { job, sessionId, run } = await completedJob(issue, {
      ...result(),
      outcome: "budget_exhausted",
      structured: null,
    });
    const problem = "the triage ended without a result (budget_exhausted)";
    expect(await applyTriageJob(deps(), job)).toEqual({ status: "invalid", problem });
    expect(linear.issueUpdates).toEqual([]);
    expect(responses(sessionId)[0]).toMatchObject({ type: "error" });
    expect((await getTriageRun(db, run.id))?.status).toBe("failed");
    // The run's page says what happened and what to do, without the outcome code.
    const error = "Om ran out of its token budget before the PRD was done. Retry the triage.";
    expect(await getJob(db, job.id)).toMatchObject({ status: "failed", error });
    expect((await getTriageRun(db, run.id))?.lastResult).toMatchObject({ error, outcome: null });
  });

  it("marks the run running when its job starts, and skips a job that isn't current", async () => {
    const issue = addIssue();
    const { job, run } = await completedJob(issue, result());
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    expect(await onTriageJobStarted(db, job, deps())).toEqual({ skip: false });
    expect((await getTriageRun(db, run.id))?.status).toBe("running");

    // Started before it was recorded on its run: it becomes the run's job.
    await setTriageRunJob(db, run.id, null);
    expect(await onTriageJobStarted(db, job, deps())).toEqual({ skip: false });
    expect((await getTriageRun(db, run.id))?.currentJobId).toBe(job.id);

    const { job: other } = await insertJob(db, {
      organizationId: orgId,
      type: "triage.run",
      taskType: "query",
      taskId: "builtin:triage",
      payload: job.payload,
    });
    await setTriageRunJob(db, run.id, other.id);
    expect(await onTriageJobStarted(db, job, deps())).toEqual({ skip: true, reason: "skipped" });
    expect((await getJob(db, job.id))?.status).toBe("skipped");
  });

  it("fails or stops the run when its job ends without a result", async () => {
    const issue = addIssue();
    const failed = await completedJob(issue, null);
    await onTriageJobFinishedWithoutResult(db, failed.job, "failed", "boom", deps());
    expect((await getTriageRun(db, failed.run.id))?.status).toBe("failed");
    expect(JSON.stringify(responses(failed.sessionId))).toContain("Triage failed: boom");

    const canceled = await completedJob(issue, null);
    await onTriageJobFinishedWithoutResult(db, canceled.job, "stopped", null, deps());
    expect((await getTriageRun(db, canceled.run.id))?.status).toBe("stopped");
    expect(responses(canceled.sessionId)).toEqual([
      { type: "response", body: "Triage was canceled. Nothing changed in Linear." },
    ]);
    expect(linear.issueUpdates).toEqual([]);
  });

  it("skips a job whose issue went in progress before it started, without a session", async () => {
    const issue = addIssue();
    const { job, run, sessionId } = await completedJob(issue, null);
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    linear.add({ identifier: "ENG-77", title: "Busy", parentId: issue.id, stateType: "started" });

    expect(await onTriageJobStarted(db, job, deps())).toEqual({ skip: true, reason: "skipped" });
    expect(await getJob(db, job.id)).toMatchObject({ status: "skipped" });
    expect((await getTriageRun(db, run.id))?.status).toBe("stopped");
    expect(JSON.stringify(responses(sessionId))).toContain("**ENG-77** is already in progress");
    expect(linear.issueUpdates).toEqual([]);
  });

  it("lets a job run when re-reading the issue fails", async () => {
    const issue = addIssue();
    const { job, run } = await completedJob(issue, null);
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    const failing = {
      getIssue: async () => {
        throw new Error("Linear is down");
      },
    } as unknown as FakeLinearGateway;
    expect(await onTriageJobStarted(db, job, { db, linear: failing })).toEqual({ skip: false });
    expect((await getTriageRun(db, run.id))?.status).toBe("running");
  });

  describe("the triage sink", () => {
    it("is the hooks of a builtin:triage job", async () => {
      const issue = addIssue();
      const { job, run, sessionId } = await completedJob(issue, result());
      const hooks = (await jobHooks(job, BUILTIN_PLAYBOOK_SOURCE))!;

      // The output must have the triage's shape; a well-formed triage `validateTriageOutput`
      // rejects is still accepted (and fails the run when applied).
      expect(hooks.isValidResult?.(result())).toBe(true);
      expect(hooks.isValidResult?.(result({ size: "XL" }))).toBe(true);
      expect(hooks.isValidResult?.({ ...result(), structured: { rule: "x" } })).toBe(false);
      expect(hooks.isValidResult?.({ ...result(), structured: null, answer: "PRD" })).toBe(false);

      await hooks.onCompleted!(db, job);
      expect(await getTriageRun(db, run.id)).toMatchObject({
        status: "completed",
        lastResult: { summary: "Sized it and wrote the PRD.", error: null },
      });
      expect(linear.issueUpdates).toHaveLength(1);
      // A replayed result applies nothing twice.
      await hooks.onCompleted!(db, job);
      expect(linear.issueUpdates).toHaveLength(1);
      expect(responses(sessionId)).toHaveLength(1);
    });

    it("starts, fails and cancels the run", async () => {
      const issue = addIssue();
      const started = await completedJob(issue, null);
      await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, started.job.id));
      expect(
        await (await jobHooks(started.job, BUILTIN_PLAYBOOK_SOURCE))!.onStarted!(
          db,
          started.job,
          "agent",
        ),
      ).toEqual({
        skip: false,
      });
      expect((await getTriageRun(db, started.run.id))?.status).toBe("running");

      await (await jobHooks(started.job, BUILTIN_PLAYBOOK_SOURCE))!.onFailed!(
        db,
        started.job,
        "boom",
      );
      expect((await getTriageRun(db, started.run.id))?.status).toBe("failed");
      expect(JSON.stringify(responses(started.sessionId))).toContain("Triage failed: boom");

      const canceled = await completedJob(issue, null);
      await (await jobHooks(canceled.job, BUILTIN_PLAYBOOK_SOURCE))!.onCanceled!(db, canceled.job);
      expect((await getTriageRun(db, canceled.run.id))?.status).toBe("stopped");
      expect(responses(canceled.sessionId)).toEqual([
        { type: "response", body: "Triage was canceled. Nothing changed in Linear." },
      ]);
    });
  });
});
