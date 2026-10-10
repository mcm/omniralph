import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDb,
  createDb,
  createTriageRun,
  getJob,
  getTriageRun,
  getTriageRunBySession,
  jobs,
  organizations,
  ralphRuns,
  runMigrations,
  triageRuns,
  type Database,
  type Job,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import type { TriageRunResult } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { handleLinearEvent, type HandledLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { IssueSummary } from "@/lib/linear/gateway";
import { onTriageJobCompleted, onTriageJobFinishedWithoutResult } from "./apply";
import { isOwnTriageSession, startLabelTriage, type TriageLabelEvent } from "./label";
import type { TriageDeps } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const PRD = [
  "## Introduction",
  "",
  "Rotate the keys.",
  "",
  "## Quality Gates",
  "",
  "- `pnpm test` - Tests",
].join("\n");

const RESULT: TriageRunResult = {
  summary: "Wrote the PRD.",
  error: null,
  outcome: {
    outcome: "prd",
    size: "S",
    title: "Rotate keys",
    description: PRD,
    openQuestions: [],
    stories: [],
    subIssueUpdates: [],
  },
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 10,
};

describe.skipIf(!dockerAvailable)("starting triage from the ralph:triage label", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let linear: FakeLinearGateway;
  let publisher: RecordingPublisher;

  const fakeAdapter = { getDefaultBranch: async () => "main" } as unknown as ScmAdapter;

  const deps = (): TriageDeps => ({
    db,
    organizationId: orgId,
    linear,
    dispatcher: new VercelQueuesDispatcher({ db, publisher }),
    adapterFor: () => fakeAdapter,
  });

  const handle = (event: HandledLinearEvent) =>
    handleLinearEvent(
      event,
      { db, organizationId: orgId, workspaceId: "ws-1" },
      {
        linear,
        dispatcher: new VercelQueuesDispatcher({ db, publisher }),
        adapterFor: () => fakeAdapter,
      },
    );

  /** An issue carrying the label, whose ID the fake knows. */
  const labeledIssue = async (overrides: Partial<IssueSummary> = {}) => {
    const issue = linear.add({
      title: "rotate keys",
      teamKey: "OPS",
      stateType: "backlog",
      labels: ["Ralph:Triage", "ops"],
      ...overrides,
    });
    const label =
      (await linear.findLabel(issue.teamId, "ralph:triage")) ??
      (await linear.createLabel(issue.teamId, "ralph:triage"));
    return { issue, labelId: label.id };
  };

  const labelEvent = (issue: IssueSummary, labelId: string): TriageLabelEvent => ({
    kind: "triage_label_added",
    issueId: issue.id,
    identifier: issue.identifier,
    labelId,
  });

  const labels = async (issueId: string) => (await linear.getIssue(issueId)).labels;

  /** The run's current job, finished with `result`. */
  const complete = async (jobId: string, result: unknown) => {
    const [done] = await db
      .update(jobs)
      .set({ status: "completed", result: result as Record<string, unknown> })
      .where(eq(jobs.id, jobId))
      .returning();
    return done as Job;
  };

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
    publisher = new RecordingPublisher();
  });

  it("opens an agent session and queues a label-triggered triage", async () => {
    const { issue, labelId } = await labeledIssue();

    await handle(labelEvent(issue, labelId));

    expect(linear.sessionsCreated).toEqual([{ issueId: issue.id, sessionId: "session-1" }]);
    const run = await getTriageRunBySession(db, "session-1");
    expect(run).toMatchObject({ linearIssueId: issue.id, trigger: "label", status: "queued" });
    const job = (await getJob(db, run!.currentJobId!))!;
    expect(job).toMatchObject({ capability: "triage", type: "triage.run" });
    expect(publisher.sent).toEqual([{ topic: `triage-jobs-org-${orgId}`, jobId: job.id }]);
    expect(linear.bodies("session-1", "thought")[0]).toContain(`Triaging **${issue.identifier}**`);
    // The label stays while triage runs.
    expect(linear.labelChanges).toEqual([]);

    // Linear's webhook for the session triage opened doesn't start a ralph run.
    await handle({ kind: "session_created", sessionId: "session-1", issueId: issue.id });
    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(publisher.sent).toHaveLength(1);
  });

  it("removes the label once the triage job completes", async () => {
    const { issue, labelId } = await labeledIssue();
    const started = await startLabelTriage(labelEvent(issue, labelId), deps());
    expect(started).toMatchObject({ status: "started", outcome: { status: "queued" } });
    const run = (await getTriageRunBySession(db, "session-1"))!;

    await onTriageJobCompleted(db, await complete(run.currentJobId!, RESULT), {
      db,
      linear,
    });

    expect((await getTriageRun(db, run.id))?.status).toBe("completed");
    expect(linear.stateChanges).toEqual([{ issueId: issue.id, target: { type: "unstarted" } }]);
    expect(linear.labelChanges).toEqual([{ issueId: issue.id, removed: [labelId] }]);
    expect(await labels(issue.id)).toEqual(["ops"]);
  });

  it("removes the label when the triage job fails", async () => {
    const { issue, labelId } = await labeledIssue();
    await startLabelTriage(labelEvent(issue, labelId), deps());
    const run = (await getTriageRunBySession(db, "session-1"))!;
    const job = (await getJob(db, run.currentJobId!))!;

    await onTriageJobFinishedWithoutResult(db, job, "failed", "boom", { db, linear });

    expect((await getTriageRun(db, run.id))?.status).toBe("failed");
    expect(linear.bodies("session-1", "error")[0]).toContain("Triage failed: boom");
    expect(linear.labelChanges).toEqual([{ issueId: issue.id, removed: [labelId] }]);
    expect(await labels(issue.id)).toEqual(["ops"]);
  });

  it("removes the label when the triage result is invalid", async () => {
    const { issue, labelId } = await labeledIssue();
    await startLabelTriage(labelEvent(issue, labelId), deps());
    const run = (await getTriageRunBySession(db, "session-1"))!;
    const invalid = { ...RESULT, error: "session failed", outcome: null };

    await onTriageJobCompleted(db, await complete(run.currentJobId!, invalid), { db, linear });

    expect((await getTriageRun(db, run.id))?.status).toBe("failed");
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.labelChanges).toEqual([{ issueId: issue.id, removed: [labelId] }]);
  });

  it("doesn't start another triage while the issue has a queued or running one", async () => {
    const { issue, labelId } = await labeledIssue();
    await startLabelTriage(labelEvent(issue, labelId), deps());

    const again = await startLabelTriage(labelEvent(issue, labelId), deps());
    expect(again).toMatchObject({ status: "already_running" });

    // Nor while a mention's triage runs.
    const other = await labeledIssue({ title: "other" });
    await createTriageRun(db, {
      organizationId: orgId,
      linearIssueId: other.issue.id,
      linearAgentSessionId: "mention-session",
      trigger: "mention",
    });
    expect(await startLabelTriage(labelEvent(other.issue, other.labelId), deps())).toMatchObject({
      status: "already_running",
    });

    expect(linear.sessionsCreated).toHaveLength(1);
    expect(publisher.sent).toHaveLength(1);
    expect(await db.select().from(triageRuns)).toHaveLength(2);
    expect(linear.labelChanges).toEqual([]);
  });

  it("changes nothing but the label for an issue in progress, and says why", async () => {
    const { issue, labelId } = await labeledIssue({ stateType: "started" });

    const outcome = await startLabelTriage(labelEvent(issue, labelId), deps());

    expect(outcome).toEqual({
      status: "started",
      sessionId: "session-1",
      outcome: { status: "in_progress", issues: [issue.identifier] },
    });
    expect(await db.select().from(jobs)).toEqual([]);
    expect(publisher.sent).toEqual([]);
    expect((await getTriageRunBySession(db, "session-1"))?.status).toBe("stopped");
    expect(linear.bodies("session-1", "response")[0]).toContain(
      `**${issue.identifier}** is already in progress or done`,
    );
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
    expect(linear.comments).toEqual([]);
    expect(linear.labelChanges).toEqual([{ issueId: issue.id, removed: [labelId] }]);
  });

  it("applies the guard to an epic with a done sub-issue", async () => {
    const { issue: epic, labelId } = await labeledIssue();
    const done = linear.add({ title: "Done", parentId: epic.id, stateType: "completed" });

    const outcome = await startLabelTriage(labelEvent(epic, labelId), deps());

    expect(outcome).toMatchObject({
      outcome: { status: "in_progress", issues: [done.identifier] },
    });
    expect(await db.select().from(jobs)).toEqual([]);
    expect(linear.labelChanges).toEqual([{ issueId: epic.id, removed: [labelId] }]);
  });

  it("frees the issue and removes the label when Linear won't open a session", async () => {
    const { issue, labelId } = await labeledIssue();
    linear.failures.set("createAgentSessionOnIssue", new Error("forbidden"));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});

    expect(await startLabelTriage(labelEvent(issue, labelId), deps())).toEqual({
      status: "session_failed",
      error: "forbidden",
    });
    const [run] = await db.select().from(triageRuns);
    expect(run?.status).toBe("failed");
    expect(publisher.sent).toEqual([]);
    expect(linear.labelChanges).toEqual([{ issueId: issue.id, removed: [labelId] }]);
  });

  it("recognizes the session triage opened before it is recorded", async () => {
    const { issue } = await labeledIssue();
    const own = (sessionId: string) =>
      isOwnTriageSession(db, orgId, { sessionId, issueId: issue.id });

    expect(await own("unknown")).toBe(false);
    const { run } = await createTriageRun(db, {
      organizationId: orgId,
      linearIssueId: issue.id,
      linearAgentSessionId: "pending-label:abc",
      trigger: "label",
    });
    expect(await own("session-9")).toBe(true);
    await db.delete(triageRuns).where(eq(triageRuns.id, run.id));

    // A mention's run doesn't claim other sessions on the issue.
    await createTriageRun(db, {
      organizationId: orgId,
      linearIssueId: issue.id,
      linearAgentSessionId: "mention-session",
      trigger: "mention",
    });
    expect(await own("session-9")).toBe(false);
    expect(await own("mention-session")).toBe(true);
  });
});
