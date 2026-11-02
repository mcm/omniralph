import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createTriageRun,
  getTriageRun,
  jobs,
  organizations,
  ralphRuns,
  triageRuns,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { triageTemplateContext } from "@omniralph/ralph";
import { RunSpecJobPayload, type TriageOutcome, type TriageRunResult } from "@omniralph/shared";
import type { LinearGateway } from "@omniralph/tracker/linear";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runTriageAnswersResultSchema, type RunTriageAnswersRequest } from "@/lib/api/runs";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  linear: undefined as unknown as LinearGateway,
  dispatcher: undefined as unknown,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => state.dispatcher }));
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLinearGateway: async () => state.linear,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const answersRoute = await import("@/app/api/ui/runs/[id]/triage/answers/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = {
  id: "member-1",
  role: "member",
  name: "Mo Member",
  email: null,
  image: null,
};

/** `POST /api/ui/runs/{id}/triage/answers` with `body` as JSON. */
async function answersRequest(id: string, body: unknown) {
  const response = await answersRoute.POST(
    new Request("http://localhost/api/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as { kind?: string; error?: string },
  };
}

const QUESTIONS = ["Which currency do invoices use?", "Who can export?", "Which file format?"];

const outcome = (openQuestions: string[]): TriageOutcome => ({
  outcome: "prd",
  size: "S",
  title: "Billing export",
  description: "## Introduction\n\nExport invoices.",
  openQuestions,
  stories: [],
  subIssueUpdates: [],
});

const result = (openQuestions: string[]): TriageRunResult => ({
  summary: "Wrote the PRD.",
  error: null,
  outcome: outcome(openQuestions),
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 10,
});

/** A previous triage as the next job's trigger context holds it. */
const previousContext = (previous: TriageOutcome) =>
  triageTemplateContext({
    tracker: { name: "Linear", conventionsFile: "LINEAR.md" },
    issue: { identifier: "X-1", title: "", description: "", stateType: "backlog" },
    previousResult: previous,
  }).previousResult;

/** Answers 3 then 1 (out of order), leaving 2 unanswered. */
const ANSWERS: RunTriageAnswersRequest = {
  answers: [
    { index: 2, question: QUESTIONS[2]!, answer: "CSV" },
    { index: 0, question: QUESTIONS[0]!, answer: "  EUR, and USD\nfor US customers  " },
  ],
};

const COMPOSED = [
  "Answers to the open questions, from Omniralph by Mo Member:",
  "1. Which currency do invoices use?\n   EUR, and USD\n   for US customers",
  "3. Which file format?\n   CSV",
].join("\n\n");

describe.skipIf(!databaseAvailable)("POST /api/ui/runs/{id}/triage/answers", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repositoryId: string;
  let linear: FakeLinearGateway;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
    const github = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "1",
      credentials: {},
    }))!;
    repositoryId = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(triageRuns);
    await db.delete(ralphRuns);
    state.user = member;
    state.orgId = orgId;
    linear = new FakeLinearGateway();
    state.linear = linear;
    state.dispatcher = new PostgresDispatcher({ db });
  });

  /** A triage run of a Backlog issue in `status`, whose last result left `openQuestions`. */
  async function triageRun(
    status: "queued" | "running" | "completed" | "failed" | "stopped",
    openQuestions: string[] = QUESTIONS,
  ) {
    const issue = linear.add({ identifier: "ENG-80", title: "Export", description: "Rough." });
    await linear.setIssueState(issue.id, { type: "backlog" });
    session += 1;
    const { run } = await createTriageRun(db, {
      organizationId: orgId,
      trackerIssueId: issue.id,
      trackerSessionId: `answers-session-${session}`,
      trigger: "mention",
    });
    await db
      .update(triageRuns)
      .set({ status, lastResult: result(openQuestions) })
      .where(eq(triageRuns.id, run.id));
    return { run, issue };
  }

  const triageJobs = async () =>
    (await db.select().from(jobs)).filter((j) => j.type === "triage.run");

  it("triages a finished run again with one reply that names the sender, after noting it in the session", async () => {
    const { run } = await triageRun("completed");
    const { status, body } = await answersRequest(run.id, ANSWERS);
    expect(status).toBe(200);
    expect(runTriageAnswersResultSchema.parse(body)).toEqual({ kind: "retriage" });

    const [job, ...more] = await triageJobs();
    expect(more).toEqual([]);
    expect(RunSpecJobPayload.parse(job!.payload).trigger.context).toMatchObject({
      triageRunId: run.id,
      reply: COMPOSED,
      previousResult: previousContext(outcome(QUESTIONS)),
    });
    expect(await getTriageRun(db, run.id)).toMatchObject({
      status: "queued",
      currentJobId: job!.id,
      pendingReply: null,
    });
    const thoughts = linear.bodies(run.trackerSessionId, "thought");
    expect(thoughts[0]).toBe(COMPOSED);
    expect(thoughts).toContain("Got it. Triaging again with your reply…");
  });

  it("still triages again when the session note can't be posted", async () => {
    const { run } = await triageRun("completed");
    vi.spyOn(linear.sessions, "createActivity").mockRejectedValueOnce(new Error("Linear is down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { status, body } = await answersRequest(run.id, ANSWERS);
    expect(status).toBe(200);
    expect(body).toEqual({ kind: "retriage" });
    expect(linear.bodies(run.trackerSessionId, "thought")).not.toContain(COMPOSED);
    const [job] = await triageJobs();
    expect(RunSpecJobPayload.parse(job!.payload).trigger.context).toMatchObject({
      reply: COMPOSED,
    });
  });

  it("keeps the answers for the next job while a job runs", async () => {
    const { run } = await triageRun("running");
    const { status, body } = await answersRequest(run.id, ANSWERS);
    expect(status).toBe(200);
    expect(body).toEqual({ kind: "pending" });
    expect(await triageJobs()).toEqual([]);
    expect(await getTriageRun(db, run.id)).toMatchObject({
      status: "running",
      pendingReply: COMPOSED,
    });
  });

  it("refuses the answers while another triage of the issue is active, and changes nothing", async () => {
    const { run, issue } = await triageRun("completed");
    const { run: other } = await createTriageRun(db, {
      organizationId: orgId,
      trackerIssueId: issue.id,
      trackerSessionId: "answers-session-other",
      trigger: "label",
    });
    expect(other.id).not.toBe(run.id);
    const { status, body } = await answersRequest(run.id, ANSWERS);
    expect(status).toBe(409);
    expect(body.error).toMatch(/being triaged in another run/);
    expect(await triageJobs()).toEqual([]);
    expect(await getTriageRun(db, run.id)).toMatchObject({
      status: "completed",
      pendingReply: null,
    });
  });

  it("refuses answers to questions that changed since they were read", async () => {
    const { run } = await triageRun("completed");
    const { status, body } = await answersRequest(run.id, {
      answers: [{ index: 1, question: "Who may export?", answer: "Owners" }],
    });
    expect(status).toBe(409);
    expect(body.error).toBe("The open questions changed. Reload them and answer again.");
    expect(await triageJobs()).toEqual([]);
    expect(linear.bodies(run.trackerSessionId, "thought")).toEqual([]);
  });

  it("refuses invalid answers", async () => {
    const { run } = await triageRun("completed");
    const answer = (index: number, text: string) => ({
      index,
      question: QUESTIONS[index] ?? "Gone?",
      answer: text,
    });
    for (const body of [
      {},
      { answers: [] },
      { answers: [answer(0, "   ")] },
      { answers: [answer(0, "x".repeat(4001))] },
      { answers: [answer(0, "EUR"), answer(0, "USD")] },
      { answers: [answer(3, "Out of range")] },
      { answers: [answer(-1, "Negative")] },
      { answers: [{ ...answer(0, "EUR"), index: 0.5 }] },
    ]) {
      expect((await answersRequest(run.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    // 4000 characters is the limit.
    expect((await answersRequest(run.id, { answers: [answer(0, "x".repeat(4000))] })).status).toBe(
      200,
    );
  });

  it("refuses a triage without open questions, and runs of other kinds", async () => {
    const { run } = await triageRun("completed", []);
    expect(await answersRequest(run.id, ANSWERS)).toMatchObject({
      status: 400,
      body: { error: "This triage has no open questions to answer." },
    });
    const { run: epic } = await createRun(db, {
      organizationId: orgId,
      trackerIssueId: "issue-epic",
      trackerIdentifier: "ENG-1",
      trackerTitle: "Epic",
      trackerUrl: "https://linear.app/acme/issue/ENG-1/epic",
      trackerSessionId: "session-epic",
      kind: "children",
      repositoryId,
      branch: "eng-1",
      baseBranch: "main",
    });
    expect(await answersRequest(epic.id, ANSWERS)).toMatchObject({
      status: 400,
      body: { error: "Only a triage's open questions can be answered." },
    });
  });

  it("is not found outside the user's organizations", async () => {
    const { run } = await triageRun("completed");
    const [other] = await db.insert(organizations).values({ name: "Beta" }).returning();
    state.orgId = other!.id;
    state.user = { ...member, id: "outsider" };
    expect((await answersRequest(run.id, ANSWERS)).status).toBe(404);
    expect(await triageJobs()).toEqual([]);
  });
});
