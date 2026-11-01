import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  connectRepository,
  closeDb,
  createDb,
  createRun,
  jobs,
  listRunActivities,
  updateRun,
  upsertScmConnection,
  type Database,
  organizations,
} from "@omniralph/db";
import type { JobTokenScope } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type * as RalphActivities from "@/lib/ralph/activities";

const RALPH_SCOPES: JobTokenScope[] = [
  "credentials:read",
  "credentials:write",
  "run:activity",
  "run:attachments",
];

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  linear: undefined as unknown as FakeLinearGateway,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLinearGateway: async () => state.linear,
}));
const relayActivity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ralph/activities", async (importOriginal) => {
  const actual = await importOriginal<typeof RalphActivities>();
  relayActivity.mockImplementation(actual.relayActivity);
  return { ...actual, relayActivity };
});

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { runTokenScopes } = await import("@/lib/agent-api/jobs");
const { POST: activities } = await import("./jobs/[id]/activities/route");

const databaseAvailable = testDatabaseAvailable();

let ipCounter = 0;
function activityRequest(jobId: string, token: string | undefined, body: unknown) {
  ipCounter += 1;
  return activities(
    new Request(`http://localhost/api/agent/jobs/${jobId}/activities`, {
      method: "POST",
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
        "x-real-ip": `198.51.100.${ipCounter}`,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: jobId }) },
  );
}

const THOUGHT = { type: "thought", body: "Reading the PRD." };

describe.skipIf(!databaseAvailable)("POST /api/agent/jobs/{id}/activities", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repositoryId: string;
  let agentId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat", webhookSecret: "hook" },
    }))!;
    repositoryId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "77",
        fullPath: "group/app",
      })
    ).id;
    const [agent] = await db
      .insert(agents)
      .values({
        organizationId: orgId,
        name: "coder-1",
        reportedAcceptedTaskTypes: ["query", "review", "coding"],
      })
      .returning();
    agentId = agent!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.linear = new FakeLinearGateway();
    relayActivity.mockClear();
  });

  async function newRun() {
    const { run } = await createRun(db, {
      organizationId: orgId,
      trackerIssueId: randomUUID(),
      trackerIdentifier: "TOOL-32",
      trackerSessionId: `session-${randomUUID()}`,
      kind: "children",
      repositoryId,
      branch: "feat/tool-32",
      baseBranch: "main",
    });
    return run;
  }

  async function newJob(values: Partial<typeof jobs.$inferInsert> = {}) {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "ralph.story",
        taskType: "coding",
        status: "running",
        agentId,
        repositoryId,
        ...values,
      })
      .returning();
    return job!.id;
  }

  function token(jobId: string, scopes: JobTokenScope[] = RALPH_SCOPES) {
    return getTokenSigner().signJobToken({ jobId, agentId, scopes });
  }

  /** The stored activities of a job, as `{ type, body, parameter }`. */
  async function stored(jobId: string) {
    return (await listRunActivities(db, jobId)).map(({ type, body, parameter }) => ({
      type,
      body,
      parameter,
    }));
  }

  it("stores and forwards thoughts and ephemeral actions, in order, to the run's agent session", async () => {
    const run = await newRun();
    const jobId = await newJob({ ralphRunId: run.id });
    const jobToken = await token(jobId);

    const first = await activityRequest(jobId, jobToken, THOUGHT);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ forwarded: true });
    const second = await activityRequest(jobId, jobToken, {
      type: "action",
      body: "Bash",
      parameter: "pnpm test",
      ephemeral: true,
    });
    expect(second.status).toBe(200);

    expect(state.linear.activities).toEqual([
      {
        sessionId: run.trackerSessionId,
        content: { type: "thought", body: "Reading the PRD." },
        options: { ephemeral: false },
      },
      {
        sessionId: run.trackerSessionId,
        content: { type: "action", action: "Bash", parameter: "pnpm test" },
        options: { ephemeral: true },
      },
    ]);
    expect(await stored(jobId)).toEqual([
      { type: "thought", body: "Reading the PRD.", parameter: null },
      { type: "action", body: "Bash", parameter: "pnpm test" },
    ]);
    expect((await listRunActivities(db, jobId))[0]!.organizationId).toBe(orgId);
  });

  it("stores a chat.ask run's activities without relaying them", async () => {
    const jobId = await newJob({
      type: "chat.ask",
      taskType: "query",
      taskId: "builtin:chat-ask",
    });
    // The session token a query job is claimed with.
    const session = await getTokenSigner().signJobToken({
      jobId,
      agentId,
      kind: "session",
      scopes: runTokenScopes("session", "query"),
    });
    const action = await activityRequest(jobId, session, {
      type: "action",
      body: "Read",
      parameter: "src/list.ts",
      ephemeral: true,
    });
    expect(action.status).toBe(200);
    expect(await action.json()).toEqual({ forwarded: false });
    const res = await activityRequest(jobId, session, THOUGHT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forwarded: false });
    expect(await stored(jobId)).toEqual([
      { type: "action", body: "Read", parameter: "src/list.ts" },
      { type: "thought", body: "Reading the PRD.", parameter: null },
    ]);
    expect(relayActivity).not.toHaveBeenCalled();
    expect(state.linear.activities).toEqual([]);

    // A session token without the scope.
    const noScope = await getTokenSigner().signJobToken({
      jobId,
      agentId,
      kind: "session",
      scopes: ["credentials:read"],
    });
    expect((await activityRequest(jobId, noScope, THOUGHT)).status).toBe(401);
  });

  it("drops activities of a finished run", async () => {
    const run = await newRun();
    await updateRun(db, run.id, { status: "stopped" });
    const jobId = await newJob({ ralphRunId: run.id });
    const res = await activityRequest(jobId, await token(jobId), THOUGHT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forwarded: false });
    expect(state.linear.activities).toEqual([]);
    expect(await stored(jobId)).toEqual([
      { type: "thought", body: "Reading the PRD.", parameter: null },
    ]);
  });

  it("requires a valid job token with run:activity for a running job", async () => {
    const run = await newRun();
    const jobId = await newJob({ ralphRunId: run.id });
    expect((await activityRequest(jobId, undefined, THOUGHT)).status).toBe(401);
    expect((await activityRequest(jobId, "not-a-token", THOUGHT)).status).toBe(401);
    // An agent access token isn't a job token.
    const access = await getTokenSigner().signAccessToken(agentId);
    expect((await activityRequest(jobId, access, THOUGHT)).status).toBe(401);
    // A ralph job token without the scope.
    expect(
      (await activityRequest(jobId, await token(jobId, ["credentials:read"]), THOUGHT)).status,
    ).toBe(401);
    // The job isn't running (anymore).
    const done = await newJob({ ralphRunId: run.id, status: "completed" });
    expect((await activityRequest(done, await token(done), THOUGHT)).status).toBe(401);
    // Another job's token.
    const other = await newJob({ ralphRunId: run.id });
    const res = await activityRequest(jobId, await token(other), THOUGHT);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "job_mismatch" });
    expect(state.linear.activities).toEqual([]);
  });

  it("needs the scope, which review jobs don't get", async () => {
    const reviewJob = await newJob({
      type: "review.run",
      taskType: "review",
    });
    const reviewToken = await token(reviewJob, ["credentials:read"]);
    expect((await activityRequest(reviewJob, reviewToken, THOUGHT)).status).toBe(401);
    expect(await stored(reviewJob)).toEqual([]);
  });

  it("validates the body against RalphActivity", async () => {
    const run = await newRun();
    const jobId = await newJob({ ralphRunId: run.id });
    const jobToken = await token(jobId);
    for (const body of [
      { type: "response", body: "Done" },
      { type: "thought", body: "  " },
      { type: "elicitation", body: "Pick one" },
      "thought",
    ]) {
      expect((await activityRequest(jobId, jobToken, body)).status).toBe(400);
    }
    expect(state.linear.activities).toEqual([]);
    expect(await stored(jobId)).toEqual([]);
  });

  it("answers 502 when Linear fails", async () => {
    const run = await newRun();
    const jobId = await newJob({ ralphRunId: run.id });
    state.linear.sessions.createActivity = () => Promise.reject(new Error("Linear is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await activityRequest(jobId, await token(jobId), THOUGHT);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "linear_unavailable" });
    // Stored all the same.
    expect(await stored(jobId)).toEqual([
      { type: "thought", body: "Reading the PRD.", parameter: null },
    ]);
    error.mockRestore();
  });
});
