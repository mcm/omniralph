import { eq } from "drizzle-orm";
import {
  closeDb,
  createDb,
  createTriageRun,
  getJob,
  getTriageRun,
  insertJob,
  jobs,
  organizations,
  runMigrations,
  setTriageRunJob,
  triageRuns,
  type Database,
  type Job,
} from "@omniralph/db";
import type { TriageAgentOutput } from "@omniralph/ralph";
import type { TriageOutcome, TriageRunPayload, TriageRunResult } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { IssueSummary } from "@/lib/linear/gateway";
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

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const PRD = [
  "## Introduction",
  "",
  "Export widgets as CSV.",
  "",
  "## Quality Gates",
  "",
  "- `pnpm test` - Tests",
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

const result = (overrides: Partial<TriageOutcome> = {}): TriageRunResult => ({
  summary: "Sized it and wrote the PRD.",
  error: null,
  outcome: outcome(overrides),
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

describe.skipIf(!dockerAvailable)("applying triage results to Linear", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let linear: FakeLinearGateway;
  let sessionSeq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(triageRuns);
    await db.delete(jobs);
    linear = new FakeLinearGateway();
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
    const payload: TriageRunPayload = {
      triageRunId: run.id,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        stateType: "backlog",
        creator: null,
        url: null,
      },
      comments: [],
      children: [],
      blockers: [],
      repository: null,
      reply: null,
      previousResult: null,
    };
    const { job } = await insertJob(db, {
      organizationId: orgId,
      capability: "triage",
      type: "triage.run",
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
      stateType: "unstarted",
    });
    const updated = await linear.getIssue(issue.id);
    expect(updated).toMatchObject({
      title: "Export widgets as CSV",
      description: PRD,
      stateType: "unstarted",
    });
    expect(linear.stateChanges).toEqual([{ issueId: issue.id, target: { type: "unstarted" } }]);
    expect(linear.comments).toEqual([]);
    const [response] = responses(sessionId);
    expect(response).toMatchObject({ type: "response" });
    expect(response && "body" in response && response.body).toMatch(
      /Size:\*\* S[\s\S]*Structure:\*\* single issue[\s\S]*Status:\*\* Todo[\s\S]*No open questions/,
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

  it("keeps an issue with open questions in Backlog and asks its creator", async () => {
    const issue = addIssue({ stateType: "unstarted", stateName: "Todo" });
    const questions = ["Which columns?", "Who can export?"];
    const { job, sessionId } = await completedJob(issue, result({ openQuestions: questions }));

    expect(await applyTriageJob(deps(), job)).toMatchObject({ stateType: "backlog" });
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
    expect(body).toContain("Status:** Backlog");
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
    expect(applied).toMatchObject({ status: "applied", stateType: "unstarted" });
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
    expect(await getJob(db, job.id)).toMatchObject({ status: "failed" });

    // Replayed: nothing more.
    await onTriageJobCompleted(db, job, deps());
    expect(responses(sessionId)).toHaveLength(1);
  });

  it("fails a result that reports the session's error", async () => {
    const issue = addIssue();
    const { job, sessionId, run } = await completedJob(issue, {
      ...result(),
      outcome: null,
      error: "the session ended without a result",
    });
    expect(await applyTriageJob(deps(), job)).toEqual({
      status: "invalid",
      problem: "the session ended without a result",
    });
    expect(linear.issueUpdates).toEqual([]);
    expect(responses(sessionId)[0]).toMatchObject({ type: "error" });
    expect((await getTriageRun(db, run.id))?.status).toBe("failed");
  });

  it("marks the run running when its job starts, and skips a job that isn't current", async () => {
    const issue = addIssue();
    const { job, run } = await completedJob(issue, result());
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    expect(await onTriageJobStarted(db, job)).toEqual({ skip: false });
    expect((await getTriageRun(db, run.id))?.status).toBe("running");

    // Started before it was recorded on its run: it becomes the run's job.
    await setTriageRunJob(db, run.id, null);
    expect(await onTriageJobStarted(db, job)).toEqual({ skip: false });
    expect((await getTriageRun(db, run.id))?.currentJobId).toBe(job.id);

    const { job: other } = await insertJob(db, {
      organizationId: orgId,
      capability: "triage",
      type: "triage.run",
      payload: job.payload,
    });
    await setTriageRunJob(db, run.id, other.id);
    expect(await onTriageJobStarted(db, job)).toEqual({ skip: true, reason: "skipped" });
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
});
