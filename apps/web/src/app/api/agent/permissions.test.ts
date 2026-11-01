import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  answerRunPermissionRequest,
  connectRepository,
  closeDb,
  createDb,
  createRun,
  createRunPermissionRequest,
  getRun,
  getRunPermissionRequest,
  agents,
  jobs,
  organizations,
  updateRun,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import type { JobTokenScope } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";

const RALPH_SCOPES: JobTokenScope[] = [
  "credentials:read",
  "credentials:write",
  "run:activity",
  "run:attachments",
];
const SESSION_SCOPES: JobTokenScope[] = [
  "credentials:read",
  "run:activity",
  "run:attachments",
  "tracker:read",
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

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { POST: ask } = await import("./jobs/[id]/permissions/route");
const { GET: read, DELETE: close } = await import("./jobs/[id]/permissions/[requestId]/route");

const databaseAvailable = testDatabaseAvailable();

let ipCounter = 0;
function headers(token: string | undefined) {
  ipCounter += 1;
  return {
    ...(token && { authorization: `Bearer ${token}` }),
    "content-type": "application/json",
    "x-real-ip": `198.51.100.${ipCounter % 250}`,
  };
}

function askRequest(jobId: string, token: string | undefined, body: unknown) {
  return ask(
    new Request(`http://localhost/api/agent/jobs/${jobId}/permissions`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: jobId }) },
  );
}

function answerRequest(method: "GET" | "DELETE", jobId: string, requestId: string, token: string) {
  const handler = method === "GET" ? read : close;
  return handler(
    new Request(`http://localhost/api/agent/jobs/${jobId}/permissions/${requestId}`, {
      method,
      headers: headers(token),
    }),
    { params: Promise.resolve({ id: jobId, requestId }) },
  );
}

async function readAnswer(jobId: string, requestId: string, token: string) {
  const res = await answerRequest("GET", jobId, requestId, token);
  expect(res.status).toBe(200);
  return res.json();
}

function permission(overrides: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    tool: "Bash",
    detail: "git push",
    reason: "The repository asks about pushes",
    timeoutSeconds: 600,
    ...overrides,
  };
}

describe.skipIf(!databaseAvailable)("/api/agent/jobs/{id}/permissions", () => {
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
  });

  describe("a query run", () => {
    async function newQueryJob() {
      const [job] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          type: "chat.ask",
          taskType: "query",
          taskId: "builtin:chat-ask",
          status: "running",
          agentId,
        })
        .returning();
      const session = await getTokenSigner().signJobToken({
        jobId: job!.id,
        agentId,
        kind: "session",
        scopes: SESSION_SCOPES,
      });
      return { jobId: job!.id, session };
    }

    it("stores the request and answers from it", async () => {
      const { jobId, session } = await newQueryJob();
      const body = permission({ requestId: randomUUID().toUpperCase() });
      const requestId = body.requestId.toLowerCase();
      const before = Date.now();
      const res = await askRequest(jobId, session, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "pending" });
      const stored = await getRunPermissionRequest(db, jobId, requestId);
      expect(stored).toMatchObject({ tool: "Bash", detail: "git push", answer: null });
      expect(stored!.expiresAt.getTime() - stored!.askedAt.getTime()).toBe(600_000);
      expect(stored!.askedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      // Asking again keeps the one request.
      expect((await askRequest(jobId, session, body)).status).toBe(200);
      // Nothing is posted anywhere.
      expect(state.linear.activities).toEqual([]);

      expect(await readAnswer(jobId, requestId, session)).toEqual({
        status: "pending",
        answeredBy: null,
      });
      await answerRunPermissionRequest(db, {
        jobId,
        requestId,
        answer: "allowed",
        answeredBy: "Ada",
      });
      expect(await readAnswer(jobId, body.requestId, session)).toEqual({
        status: "allowed",
        answeredBy: "Ada",
      });
      // Closing an answered request keeps the answer.
      expect((await answerRequest("DELETE", jobId, requestId, session)).status).toBe(204);
      expect(await readAnswer(jobId, requestId, session)).toEqual({
        status: "allowed",
        answeredBy: "Ada",
      });
    });

    it("reads an unanswered request past its expiry, or an unknown one, as expired", async () => {
      const { jobId, session } = await newQueryJob();
      const requestId = randomUUID();
      await createRunPermissionRequest(db, {
        jobId,
        requestId,
        tool: "Bash",
        askedAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(await readAnswer(jobId, requestId, session)).toEqual({
        status: "expired",
        answeredBy: null,
      });
      expect(await readAnswer(jobId, randomUUID(), session)).toEqual({
        status: "expired",
        answeredBy: null,
      });
    });

    it("closes a pending request as expired when the agent stops waiting", async () => {
      const { jobId, session } = await newQueryJob();
      const body = permission();
      await askRequest(jobId, session, body);
      expect((await answerRequest("DELETE", jobId, body.requestId, session)).status).toBe(204);
      expect(await getRunPermissionRequest(db, jobId, body.requestId)).toMatchObject({
        answer: "expired",
      });
      expect(await readAnswer(jobId, body.requestId, session)).toEqual({
        status: "expired",
        answeredBy: null,
      });
    });

    it("requires the job's own token with run:activity", async () => {
      const { jobId } = await newQueryJob();
      const other = await newQueryJob();
      const body = permission();
      expect((await askRequest(jobId, undefined, body)).status).toBe(401);
      const lifecycle = await getTokenSigner().signJobToken({
        jobId,
        agentId,
        kind: "lifecycle",
        scopes: ["credentials:read"],
      });
      expect((await askRequest(jobId, lifecycle, body)).status).toBe(401);
      expect((await answerRequest("GET", jobId, body.requestId, lifecycle)).status).toBe(401);
      const mismatch = await askRequest(jobId, other.session, body);
      expect(mismatch.status).toBe(403);
      expect(await mismatch.json()).toEqual({ error: "job_mismatch" });
      expect(await getRunPermissionRequest(db, jobId, body.requestId)).toBeNull();
    });
  });

  describe("a ralph run", () => {
    async function newRalphJob(runStatus?: "stopped") {
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
      if (runStatus) await updateRun(db, run.id, { status: runStatus });
      const [job] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          type: "ralph.story",
          taskType: "coding",
          status: "running",
          agentId,
          repositoryId,
          ralphRunId: run.id,
        })
        .returning();
      const token = await getTokenSigner().signJobToken({
        jobId: job!.id,
        agentId,
        scopes: RALPH_SCOPES,
      });
      return { run, jobId: job!.id, token };
    }

    it("stores the request, asks in Linear and copies the run's answer", async () => {
      const { run, jobId, token } = await newRalphJob();
      const body = permission();
      const res = await askRequest(jobId, token, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "pending" });
      expect(await getRunPermissionRequest(db, jobId, body.requestId)).toMatchObject({
        tool: "Bash",
        answer: null,
      });
      expect(state.linear.activities).toHaveLength(1);
      expect(state.linear.activities[0]).toMatchObject({
        sessionId: run.trackerSessionId,
        content: { type: "elicitation" },
      });
      expect((await getRun(db, run.id))!.permission).toMatchObject({
        requestId: body.requestId,
        jobId,
      });
      expect(await readAnswer(jobId, body.requestId, token)).toEqual({
        status: "pending",
        answeredBy: null,
      });

      // Someone answers in Linear: the run records it.
      const question = (await getRun(db, run.id))!.permission!;
      await updateRun(db, run.id, {
        permission: {
          ...question,
          answer: "denied",
          answeredAt: "2026-10-11T10:05:00.000Z",
          answeredBy: "Ada",
        },
      });
      expect(await readAnswer(jobId, body.requestId, token)).toEqual({
        status: "denied",
        answeredBy: "Ada",
      });
      expect(await getRunPermissionRequest(db, jobId, body.requestId)).toMatchObject({
        answer: "denied",
        answeredBy: "Ada",
        answeredAt: new Date("2026-10-11T10:05:00.000Z"),
      });
    });

    it("closes the stored request and the run's question when the agent stops waiting", async () => {
      const { run, jobId, token } = await newRalphJob();
      const body = permission();
      await askRequest(jobId, token, body);
      expect((await answerRequest("DELETE", jobId, body.requestId, token)).status).toBe(204);
      expect(await getRunPermissionRequest(db, jobId, body.requestId)).toMatchObject({
        answer: "expired",
      });
      expect((await getRun(db, run.id))!.permission).toMatchObject({ answer: "expired" });
      expect(await readAnswer(jobId, body.requestId, token)).toEqual({
        status: "expired",
        answeredBy: null,
      });
    });

    it("answers 410 and closes the request when the run is over", async () => {
      const { jobId, token } = await newRalphJob("stopped");
      const body = permission();
      const res = await askRequest(jobId, token, body);
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "run_over" });
      expect(await getRunPermissionRequest(db, jobId, body.requestId)).toMatchObject({
        answer: "expired",
      });
      expect(state.linear.activities).toEqual([]);
    });
  });
});
