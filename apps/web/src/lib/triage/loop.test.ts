import { eq } from "drizzle-orm";
import {
  closeDb,
  createDb,
  getJob,
  getTriageRun,
  jobs,
  listRunIterations,
  organizations,
  runIterations,
  triageRuns,
  type Database,
  type Job,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import {
  RunSpecJobPayload,
  TriageCritiqueTriggerContext,
  TriageRound,
  type PlanCritiqueOutput,
  type QueryRunResult,
  type TriageOutcome,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type { IssueSummary } from "@omniralph/tracker";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriageDeps } from "./start";

vi.mock("server-only", () => ({}));

/** The gateway the loop applies its end with (it loads the organization's own). */
const gateway = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/tracker/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTrackerGateway: async () => gateway.current,
}));

const { PostgresDispatcher } = await import("@/lib/dispatch/dispatcher");
const { BUILTIN_PLAYBOOK_SOURCE } = await import("@/lib/playbooks");
const { jobHooks } = await import("@/lib/sinks");
const { withOpenQuestions } = await import("@/lib/ralph/start");
const { onTriageJobStarted } = await import("./apply");
const { latestLoop } = await import("./loop");
const { startTriage } = await import("./start");

const databaseAvailable = testDatabaseAvailable();

/** A Story in the task format whose done criterion the lint accepts. */
const STORY = [
  "I want you to export widgets as CSV, so that admins can share them.",
  "",
  "Build it by adding an export action to the widget list in `src/widgets/list.tsx`.",
  "",
  "Don't stop until:",
  "",
  "- The export action downloads the listed widgets as a CSV file",
].join("\n");

/** The same Story with an outcome after merge as its done criterion: the lint fails it. */
const STORY_WITH_OUTCOME = STORY.replace(
  "- The export action downloads the listed widgets as a CSV file",
  "- Users adopt the export within 2 days",
);

const draft = (overrides: Partial<TriageOutcome> = {}) => ({
  outcome: "prd",
  sizing: { size: "story", reason: "One focused session builds it." },
  title: "Export widgets as CSV",
  description: STORY,
  size: "S",
  openQuestions: [],
  stories: [],
  subIssueUpdates: [],
  featureEpics: [],
  bug: null,
  summary: "Wrote the story.",
  ...overrides,
});

const answered = (structured: unknown): QueryRunResult => ({
  outcome: "answered",
  answer: null,
  structured: structured as QueryRunResult["structured"],
  references: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 10,
});

const PASS: PlanCritiqueOutput = {
  verdict: "pass",
  notes: [
    { item: "story-sentence", ok: true, note: "Names who and why." },
    { item: "checkable-criteria", ok: true, note: "The criterion can be checked on the branch." },
  ],
  openQuestions: [],
};

const FAIL: PlanCritiqueOutput = {
  verdict: "fail",
  notes: [
    { item: "story-sentence", ok: true, note: "Names who and why." },
    {
      item: "checkable-criteria",
      ok: false,
      note: "No criterion can be checked on the branch: say what the export produces.",
    },
  ],
  openQuestions: ["Should the export include archived widgets?"],
};

describe.skipIf(!databaseAvailable)("triage as a loop", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let linear: FakeLinearGateway;
  let sessionSeq = 0;

  const deps = (): TriageDeps => ({
    db,
    organizationId: orgId,
    tracker: linear,
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => ({ getDefaultBranch: async () => "main" }) as unknown as ScmAdapter,
  });

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
    await db.delete(runIterations);
    await db.delete(triageRuns);
    await db.delete(jobs);
    linear = new FakeLinearGateway();
    gateway.current = linear;
  });

  const addIssue = () =>
    linear.add({
      identifier: "ENG-1",
      title: "csv export",
      description: "we need csv",
      stateType: "backlog",
      stateName: "Backlog",
    });

  /** Triage of `issue` started from a mention: its run and first round's worker job. */
  const triage = async (issue: IssueSummary) => {
    sessionSeq += 1;
    const sessionId = `loop-session-${sessionSeq}`;
    const started = await startTriage(
      { kind: "issue_mentioned", sessionId, issueId: issue.id, commentBody: "@omniralph /triage" },
      deps(),
    );
    if (started.status !== "queued") throw new Error(`not queued: ${started.status}`);
    return { sessionId, runId: started.run.id, jobId: started.jobId };
  };

  /** Finishes `jobId` with `result` through the job lifecycle (its sink, then the loop). */
  const finish = async (jobId: string, result: QueryRunResult): Promise<Job> => {
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
    const running = (await getJob(db, jobId))!;
    if (running.type === "triage.run") await onTriageJobStarted(db, running, deps());
    const [done] = await db
      .update(jobs)
      .set({ status: "completed", result: result as unknown as Record<string, unknown> })
      .where(eq(jobs.id, jobId))
      .returning();
    const hooks = (await jobHooks(done!, BUILTIN_PLAYBOOK_SOURCE))!;
    expect(hooks.isValidResult!(done!.result)).toBe(true);
    await hooks.onCompleted!(db, done!);
    return done!;
  };

  const iterations = (runId: string) => listRunIterations(db, { kind: "triage", id: runId });
  const round = async (runId: string, number: number) =>
    TriageRound.parse((await iterations(runId)).find((it) => it.number === number)!.details);

  /** The critic job the round's worker left, with its trigger context. */
  const critic = async (runId: string, number: number) => {
    const iteration = (await iterations(runId)).find((it) => it.number === number)!;
    expect(iteration.status).toBe("verifying");
    const job = (await getJob(db, iteration.verifierJobId!))!;
    const payload = RunSpecJobPayload.parse(job.payload);
    return { job, context: TriageCritiqueTriggerContext.parse(payload.trigger.context) };
  };

  /** The worker of the run's newest round: its job and trigger context. */
  const newestWorker = async (runId: string) => {
    const iteration = (await iterations(runId)).at(-1)!;
    const job = (await getJob(db, iteration.workerJobId!))!;
    return { iteration, job, context: RunSpecJobPayload.parse(job.payload).trigger.context };
  };

  const responses = (sessionId: string) =>
    linear.activities
      .filter((a) => a.sessionId === sessionId)
      .map((a) => ("body" in a.content ? a.content.body : ""));

  it("applies a draft that passes the lint and the critic on the first round", async () => {
    const issue = addIssue();
    const { sessionId, runId, jobId } = await triage(issue);

    await finish(jobId, answered(draft()));
    // Nothing is written to the tracker until the checks are done.
    expect(linear.issueUpdates).toEqual([]);
    expect(await round(runId, 1)).toMatchObject({
      draft: { title: "Export widgets as CSV", description: STORY, sizing: { size: "story" } },
      lint: { passed: true, problems: [] },
      critique: null,
    });
    const { job, context } = await critic(runId, 1);
    expect(job).toMatchObject({ type: "triage.critique-plan", taskId: "builtin:critique-plan" });
    expect(context).toMatchObject({
      invoker: { kind: "triage-run", id: runId },
      round: 1,
      critique: { size: "story", story: true, draft: { title: "Export widgets as CSV" } },
    });

    await finish(job.id, answered(PASS));
    expect(await iterations(runId)).toMatchObject([
      { number: 1, status: "done", verdict: "converged", outcome: "converged" },
    ]);
    expect(await round(runId, 1)).toMatchObject({ critique: { verdict: "pass" } });
    expect(await linear.getIssue(issue.id)).toMatchObject({
      title: "Export widgets as CSV",
      description: STORY,
      stateType: "unstarted",
    });
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "completed" });
    expect(responses(sessionId).at(-1)).toContain(
      "**Checks:** passed the work item lint and the plan critic in round 1 of 3",
    );
    expect(await withOpenQuestions(deps(), issue.id)).toBeNull();
  });

  it("revises a draft that fails a check with its findings, and applies the passing revision", async () => {
    const issue = addIssue();
    const { runId, jobId } = await triage(issue);

    await finish(jobId, answered(draft({ description: STORY_WITH_OUTCOME })));
    expect((await round(runId, 1)).lint).toEqual({
      passed: false,
      problems: [
        '"Users adopt the export within 2 days" is an outcome after merge or a metric, not evidence to check on the branch.',
      ],
    });
    // The critic still judges a draft the lint failed, so the next round gets both.
    await finish((await critic(runId, 1)).job.id, answered(FAIL));
    expect(linear.issueUpdates).toEqual([]);

    const second = await newestWorker(runId);
    expect(second.iteration).toMatchObject({ number: 2, status: "working" });
    expect(second.iteration.feedback).toContain('Lint: "Users adopt the export within 2 days"');
    expect(second.iteration.feedback).toContain(
      "Critic (checkable-criteria): No criterion can be checked on the branch",
    );
    expect(second.iteration.feedback).toContain(
      "Critic's open question: Should the export include archived widgets?",
    );
    expect(await getTriageRun(db, runId)).toMatchObject({
      status: "running",
      currentJobId: second.job.id,
    });
    // The next worker revises the previous draft with the checks' feedback.
    expect(second.context).toMatchObject({
      triageRunId: runId,
      issue: { identifier: "ENG-1" },
      previousResult: { description: STORY_WITH_OUTCOME, sizing: { size: "story" } },
      revision: { round: 2, maxRounds: 3, feedback: second.iteration.feedback },
    });

    await finish(second.job.id, answered(draft()));
    expect((await round(runId, 2)).lint.passed).toBe(true);
    await finish((await critic(runId, 2)).job.id, answered(PASS));

    expect(await iterations(runId)).toMatchObject([
      { number: 1, verdict: "continue", outcome: null },
      { number: 2, verdict: "converged", outcome: "converged" },
    ]);
    expect(await linear.getIssue(issue.id)).toMatchObject({
      description: STORY,
      stateType: "unstarted",
    });
    expect(linear.issueUpdates).toHaveLength(1);
  });

  it("turns what still fails at the cap into open questions, so the work item can't start", async () => {
    const issue = addIssue();
    const { sessionId, runId, jobId } = await triage(issue);

    let worker = jobId;
    for (const number of [1, 2, 3]) {
      await finish(
        worker,
        answered(draft({ description: STORY_WITH_OUTCOME, openQuestions: ["Which delimiter?"] })),
      );
      await finish((await critic(runId, number)).job.id, answered(FAIL));
      if (number < 3) worker = (await newestWorker(runId)).job.id;
    }

    expect(await iterations(runId)).toMatchObject([
      { number: 1, outcome: null },
      { number: 2, outcome: null },
      { number: 3, verdict: "continue", outcome: "max-iterations" },
    ]);
    const updated = await linear.getIssue(issue.id);
    expect(updated.stateType).toBe("backlog");
    const questions = updated.description.slice(updated.description.indexOf("## Open Questions"));
    expect(questions).toContain("1. Which delimiter?");
    expect(questions).toContain(
      'The work item lint still fails: "Users adopt the export within 2 days" is an outcome after merge or a metric, not evidence to check on the branch. Triage couldn\'t settle this in 3 rounds: what should the plan say?',
    );
    expect(questions).toContain(
      'The plan critic found "checkable-criteria" unmet: No criterion can be checked on the branch: say what the export produces. Triage couldn\'t settle this in 3 rounds: how should the plan address it?',
    );
    expect(questions).toContain("Should the export include archived widgets?");
    // The passing rubric item isn't a question.
    expect(questions).not.toContain("story-sentence");
    expect(await getTriageRun(db, runId)).toMatchObject({
      status: "completed",
      lastResult: { outcome: { openQuestions: expect.arrayContaining(["Which delimiter?"]) } },
    });
    expect(responses(sessionId).at(-1)).toContain(
      "**Checks:** not passed after 3 rounds; what's left is in the open questions",
    );
    // The open-questions flow keeps the work item from starting until a person answers.
    expect(await withOpenQuestions(deps(), issue.id)).toMatchObject({
      issue: { id: issue.id },
      epic: false,
    });
  });

  it("revises an unusable draft with why, without asking the critic", async () => {
    const issue = addIssue();
    const { runId, jobId } = await triage(issue);

    await finish(jobId, answered(draft({ description: "Just do the CSV thing." })));
    const first = await round(runId, 1);
    expect(first).toMatchObject({ draft: null, critique: null, lint: { passed: false } });
    expect(first.lint.problems[0]).toMatch(/task format/);
    const [iteration] = await iterations(runId);
    expect(iteration).toMatchObject({ status: "done", verdict: "continue", verifierJobId: null });
    expect((await newestWorker(runId)).iteration.feedback).toContain("Lint: ");
  });

  it("applies a Feature's recommendation without critiquing it", async () => {
    const issue = addIssue();
    const { runId, jobId } = await triage(issue);

    await finish(
      jobId,
      answered(
        draft({
          outcome: "unchanged",
          sizing: { size: "feature", reason: "Several epics, each its own pull request." },
          size: "XL",
          description: "Plan this as a feature: export first, then scheduling.",
          featureEpics: [
            { title: "CSV export", summary: "Export widgets." },
            { title: "Scheduled exports", summary: "Email them weekly." },
          ],
        }),
      ),
    );
    expect(await iterations(runId)).toMatchObject([
      { number: 1, verdict: "converged", outcome: "converged", verifierJobId: null },
    ]);
    expect(linear.comments.map((c) => c.body).join("\n")).toContain("**Plan this as a feature.**");
    expect(linear.issueUpdates).toEqual([]);
  });

  it("applies the draft with a question when the critic can't judge it", async () => {
    const issue = addIssue();
    const { runId, jobId } = await triage(issue);

    await finish(jobId, answered(draft()));
    await finish((await critic(runId, 1)).job.id, answered({ verdict: "maybe" }));

    expect(await iterations(runId)).toMatchObject([{ number: 1, outcome: "converged" }]);
    const updated = await linear.getIssue(issue.id);
    expect(updated.stateType).toBe("backlog");
    expect(updated.description).toContain(
      "The plan critic couldn't check this draft (The plan critic didn't answer with a critique, so the loop stops).",
    );
  });

  it("starts a new loop after the last one's rounds when a reply triages again", async () => {
    expect(
      latestLoop([
        { feedback: null },
        { feedback: "fix it" },
        { feedback: null },
        { feedback: "x" },
      ]),
    ).toEqual([{ feedback: null }, { feedback: "x" }]);

    const issue = addIssue();
    const { runId, jobId } = await triage(issue);
    await finish(jobId, answered(draft({ openQuestions: ["Which delimiter?"] })));
    await finish((await critic(runId, 1)).job.id, answered(PASS));
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "completed" });

    const { handleTriageReply } = await import("./reply");
    const run = (await getTriageRun(db, runId))!;
    await handleTriageReply(
      {
        kind: "session_prompted",
        sessionId: run.trackerSessionId,
        body: "Commas.",
        authorName: "Ada",
      },
      deps(),
    );
    const next = await newestWorker(runId);
    expect(next.iteration).toMatchObject({ number: 2, feedback: null, maxIterations: 4 });
    expect(next.context).toMatchObject({ reply: "Commas.", revision: null });
  });
});
