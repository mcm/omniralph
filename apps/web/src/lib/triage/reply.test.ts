import { eq } from "drizzle-orm";
import {
  closeDb,
  createDb,
  createRun,
  getJob,
  getRun,
  getTriageRun,
  jobs,
  organizations,
  ralphRuns,
  runMigrations,
  triageRuns,
  type Database,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import { triageTemplateContext } from "@omniralph/ralph";
import {
  RunSpecJobPayload,
  type QueryRunResult,
  type TriageOutcome,
  type TriageRunResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { handleLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { IssueSummary } from "@/lib/linear/gateway";
import {
  onTriageJobCompleted,
  onTriageJobFinishedWithoutResult,
  onTriageJobStarted,
} from "./apply";
import { handleTriageReply, type SessionPromptedEvent } from "./reply";
import { startTriage, type TriageDeps } from "./start";

vi.mock("server-only", () => ({}));

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const PRD = [
  "## Introduction",
  "",
  "Export widgets.",
  "",
  "## Quality Gates",
  "",
  "- `pnpm test`",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] It works",
].join("\n");

const outcome = (overrides: Partial<TriageOutcome> = {}): TriageOutcome => ({
  outcome: "prd",
  size: "S",
  title: "Export widgets",
  description: PRD,
  openQuestions: [],
  stories: [],
  subIssueUpdates: [],
  ...overrides,
});

const result = (overrides: Partial<TriageOutcome> = {}): TriageRunResult => ({
  summary: "Wrote the PRD.",
  error: null,
  outcome: outcome(overrides),
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 10,
});

/** `result` as the run's `QueryRunResult` (the triage is its structured output). */
const asQueryResult = (result: TriageRunResult): QueryRunResult => ({
  outcome: "answered",
  answer: null,
  structured: { ...result.outcome, summary: result.summary },
  references: [],
  usage: result.usage,
  durationMs: result.durationMs,
});

/** A previous triage as the next run's trigger context holds it. */
const previousContext = (previous: TriageOutcome | null) =>
  triageTemplateContext({
    issue: { identifier: "X-1", title: "", description: "", stateType: "backlog" },
    previousResult: previous,
  }).previousResult;

describe.skipIf(!dockerAvailable)("continuing triage from session replies", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let linear: FakeLinearGateway;
  let sessionSeq = 0;

  const deps = (): TriageDeps => ({
    db,
    organizationId: orgId,
    linear,
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => ({ getDefaultBranch: async () => "main" }) as unknown as ScmAdapter,
  });

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
    await db.delete(ralphRuns);
    linear = new FakeLinearGateway();
  });

  /** An issue triaged from a mention: its run and queued job. */
  const mentioned = async (issue: IssueSummary) => {
    sessionSeq += 1;
    const sessionId = `reply-session-${sessionSeq}`;
    const started = await startTriage(
      { kind: "session_created", sessionId, issueId: issue.id, commentBody: "@omniralph /triage" },
      deps(),
    );
    if (started.status !== "queued") throw new Error(`not queued: ${started.status}`);
    return { sessionId, runId: started.run.id, jobId: started.jobId };
  };

  const prompt = (sessionId: string, body: string, signal?: string): SessionPromptedEvent => ({
    kind: "session_prompted",
    sessionId,
    body,
    ...(signal && { signal }),
    authorName: "Ada",
  });

  /** Runs the job on a (pretend) agent. */
  const startJob = async (jobId: string) => {
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
    await onTriageJobStarted(db, (await getJob(db, jobId))!, deps());
  };

  /** Completes the job with `jobResult` and applies it. */
  const completeJob = async (jobId: string, jobResult: TriageRunResult) => {
    await db
      .update(jobs)
      .set({ status: "completed", result: asQueryResult(jobResult) })
      .where(eq(jobs.id, jobId));
    await onTriageJobCompleted(db, (await getJob(db, jobId))!, deps());
  };

  const triageJobs = async () =>
    (await db.select().from(jobs)).filter((j) => j.type === "triage.run");

  /** The trigger context of a queued `builtin:triage` run. */
  const payloadOf = async (jobId: string) =>
    RunSpecJobPayload.parse((await getJob(db, jobId))!.payload).trigger.context;

  it("triages an idle run again with the reply, the issue's current content and the last result", async () => {
    const issue = linear.add({ identifier: "ENG-1", title: "Export", stateType: "backlog" });
    const { sessionId, runId, jobId } = await mentioned(issue);
    await startJob(jobId);
    const first = result({ openQuestions: ["Which format? A. CSV B. JSON"] });
    await completeJob(jobId, first);
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "completed" });
    const described = (await linear.getIssue(issue.id)).description;
    expect(described).toContain("## Open Questions");

    const handled = await handleTriageReply(prompt(sessionId, "1: CSV"), deps());
    expect(handled).toMatchObject({ kind: "retriage", outcome: { status: "queued" } });
    const all = await triageJobs();
    expect(all).toHaveLength(2);
    const next = all.find((j) => j.id !== jobId)!;
    expect(await getTriageRun(db, runId)).toMatchObject({
      status: "queued",
      currentJobId: next.id,
      pendingReply: null,
    });
    const payload = await payloadOf(next.id);
    expect(payload).toMatchObject({
      triageRunId: runId,
      reply: "1: CSV",
      previousResult: previousContext(first.outcome),
      issue: { identifier: "ENG-1", title: "Export widgets", description: described },
    });
    expect(linear.bodies(sessionId, "thought")).toContain(
      "Got it. Triaging again with your reply…",
    );

    // The new job's answers drop the question: the issue moves to Todo.
    await startJob(next.id);
    await completeJob(next.id, result());
    expect((await linear.getIssue(issue.id)).description).not.toContain("## Open Questions");
    expect(linear.stateChanges.at(-1)).toMatchObject({ target: { type: "unstarted" } });
  });

  it("keeps replies sent while a job runs and starts the next job when it finishes", async () => {
    const issue = linear.add({ identifier: "ENG-2", title: "Export", stateType: "backlog" });
    const { sessionId, runId, jobId } = await mentioned(issue);
    await startJob(jobId);

    expect(await handleTriageReply(prompt(sessionId, "1: CSV"), deps())).toEqual({
      kind: "pending",
    });
    expect(await handleTriageReply(prompt(sessionId, "@omniralph 2: owners only"), deps())).toEqual(
      { kind: "pending" },
    );
    expect(await triageJobs()).toHaveLength(1);
    expect(await getTriageRun(db, runId)).toMatchObject({
      status: "running",
      currentJobId: jobId,
      pendingReply: "1: CSV\n\n2: owners only",
    });
    expect(linear.bodies(sessionId, "thought").at(-1)).toMatch(/still running/);

    const first = result({ openQuestions: ["Which format?", "Who can export?"] });
    await completeJob(jobId, first);
    const next = (await triageJobs()).find((j) => j.id !== jobId)!;
    expect(next).toBeDefined();
    expect(await payloadOf(next.id)).toMatchObject({
      reply: "1: CSV\n\n2: owners only",
      previousResult: previousContext(first.outcome),
    });
    expect(await getTriageRun(db, runId)).toMatchObject({
      status: "queued",
      currentJobId: next.id,
      pendingReply: null,
    });
  });

  it("starts the next job with a pending reply after a failed job too", async () => {
    const issue = linear.add({ identifier: "ENG-3", title: "Export", stateType: "backlog" });
    const { sessionId, runId, jobId } = await mentioned(issue);
    await startJob(jobId);
    await handleTriageReply(prompt(sessionId, "Use CSV"), deps());
    await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, jobId));
    await onTriageJobFinishedWithoutResult(
      db,
      (await getJob(db, jobId))!,
      "failed",
      "boom",
      deps(),
    );

    const next = (await triageJobs()).find((j) => j.id !== jobId)!;
    expect(await payloadOf(next.id)).toMatchObject({ reply: "Use CSV", previousResult: null });
    expect(await getTriageRun(db, runId)).toMatchObject({
      status: "queued",
      currentJobId: next.id,
    });
  });

  it("stops a running job on the stop signal and drops pending replies", async () => {
    const issue = linear.add({ identifier: "ENG-4", title: "Export", stateType: "backlog" });
    const { sessionId, runId, jobId } = await mentioned(issue);
    await startJob(jobId);
    await handleTriageReply(prompt(sessionId, "Use CSV"), deps());

    expect(await handleTriageReply(prompt(sessionId, "", "stop"), deps())).toEqual({
      kind: "stop",
      canceled: true,
    });
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "stopped", pendingReply: null });
    expect(await getJob(db, jobId)).toMatchObject({ status: "running", cancelRequested: true });
    expect(linear.bodies(sessionId, "response").at(-1)).toMatch(/^Stopped \(requested by Ada\)/);

    // The agent reports the cancel: nothing else happens.
    const before = linear.activities.length;
    await db.update(jobs).set({ status: "canceled" }).where(eq(jobs.id, jobId));
    await onTriageJobFinishedWithoutResult(db, (await getJob(db, jobId))!, "stopped", null, deps());
    expect(linear.activities).toHaveLength(before);
    expect(await triageJobs()).toHaveLength(1);
    expect(linear.issueUpdates).toEqual([]);

    // A reply afterwards triages again.
    expect(await handleTriageReply(prompt(sessionId, "Go on"), deps())).toMatchObject({
      kind: "retriage",
    });
  });

  it("cancels a queued job on a typed stop", async () => {
    const issue = linear.add({ identifier: "ENG-5", title: "Export", stateType: "backlog" });
    const { sessionId, runId, jobId } = await mentioned(issue);
    expect(await handleTriageReply(prompt(sessionId, "stop"), deps())).toMatchObject({
      kind: "stop",
    });
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "stopped" });
    expect(await getJob(db, jobId)).toMatchObject({ status: "canceled" });
    // Stopping again: nothing to stop.
    expect(await handleTriageReply(prompt(sessionId, "stop"), deps())).toEqual({
      kind: "not_running",
    });
  });

  it("doesn't triage again while another session triages the issue", async () => {
    const issue = linear.add({ identifier: "ENG-6", title: "Export", stateType: "backlog" });
    const first = await mentioned(issue);
    await startJob(first.jobId);
    await completeJob(first.jobId, result({ openQuestions: ["Which?"] }));
    await mentioned(issue);
    expect(await handleTriageReply(prompt(first.sessionId, "CSV"), deps())).toEqual({
      kind: "conflict",
    });
    expect(await getTriageRun(db, first.runId)).toMatchObject({ status: "completed" });
  });

  it("refuses to triage again once work on the issue started", async () => {
    const issue = linear.add({ identifier: "ENG-7", title: "Export", stateType: "backlog" });
    const { sessionId, runId, jobId } = await mentioned(issue);
    await startJob(jobId);
    await completeJob(jobId, result({ openQuestions: ["Which?"] }));
    linear.issues.get(issue.id)!.stateType = "started";
    expect(await handleTriageReply(prompt(sessionId, "CSV"), deps())).toMatchObject({
      kind: "retriage",
      outcome: { status: "in_progress" },
    });
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "stopped" });
    expect(await triageJobs()).toHaveLength(1);
  });

  it("routes replies by session: triage sessions to triage, others to ralph as before", async () => {
    const issue = linear.add({ identifier: "ENG-8", title: "Export", stateType: "backlog" });
    const { sessionId, runId } = await mentioned(issue);
    const { run: ralph } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: "other-issue",
      linearIdentifier: "ENG-99",
      linearAgentSessionId: "ralph-session",
      kind: "single",
      repositoryId: null,
      status: "pending",
    });
    const context = { db, organizationId: orgId, workspaceId: "ws-1" };
    const { dispatcher, adapterFor } = deps();

    await handleLinearEvent(prompt("ralph-session", "", "stop"), context, {
      linear,
      dispatcher,
      adapterFor,
    });
    expect((await getRun(db, ralph.id))?.status).toBe("stopped");
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "queued" });

    await handleLinearEvent(prompt(sessionId, "", "stop"), context, {
      linear,
      dispatcher,
      adapterFor,
    });
    expect(await getTriageRun(db, runId)).toMatchObject({ status: "stopped" });
    expect(await handleTriageReply(prompt("ralph-session", "hello"), deps())).toBeNull();
  });
});
