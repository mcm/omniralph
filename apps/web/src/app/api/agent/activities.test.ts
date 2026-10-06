import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  connectRepository,
  createDb,
  createRun,
  jobs,
  runMigrations,
  updateRun,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import { CAPABILITY_JOB_SCOPES, type JobTokenScope } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  linear: undefined as unknown as FakeLinearGateway,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/linear/client", () => ({ getLinearGateway: async () => state.linear }));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { POST: activities } = await import("./jobs/[id]/activities/route");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

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

describe.skipIf(!dockerAvailable)("POST /api/agent/jobs/{id}/activities", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let repositoryId: string;
  let agentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    const connection = await upsertScmConnection(db, {
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat", webhookSecret: "hook" },
    });
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
      .values({ name: "coder-1", enabledCapabilities: ["review", "ralph"] })
      .returning();
    agentId = agent!.id;
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(() => {
    state.linear = new FakeLinearGateway();
  });

  async function newRun() {
    const { run } = await createRun(db, {
      linearIssueId: randomUUID(),
      linearIdentifier: "TOOL-32",
      linearAgentSessionId: `session-${randomUUID()}`,
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
        capability: "ralph",
        type: "ralph.story",
        status: "running",
        agentId,
        repositoryId,
        ...values,
      })
      .returning();
    return job!.id;
  }

  function token(jobId: string, scopes: JobTokenScope[] = CAPABILITY_JOB_SCOPES.ralph) {
    return getTokenSigner().signJobToken({ jobId, agentId, scopes });
  }

  it("forwards thoughts and ephemeral actions, in order, to the run's agent session", async () => {
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
        sessionId: run.linearAgentSessionId,
        content: { type: "thought", body: "Reading the PRD." },
        options: { ephemeral: false },
      },
      {
        sessionId: run.linearAgentSessionId,
        content: { type: "action", action: "Bash", parameter: "pnpm test" },
        options: { ephemeral: true },
      },
    ]);
  });

  it("drops activities of a finished run", async () => {
    const run = await newRun();
    await updateRun(db, run.id, { status: "stopped" });
    const jobId = await newJob({ ralphRunId: run.id });
    const res = await activityRequest(jobId, await token(jobId), THOUGHT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forwarded: false });
    expect(state.linear.activities).toEqual([]);
  });

  it("requires a valid job token with ralph:activity for a running job", async () => {
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

  it("rejects review jobs, even with a forged ralph:activity scope", async () => {
    const reviewJob = await newJob({ capability: "review", type: "review.run" });
    // A review job token never carries the scope.
    const reviewToken = await token(reviewJob, CAPABILITY_JOB_SCOPES.review);
    expect((await activityRequest(reviewJob, reviewToken, THOUGHT)).status).toBe(401);
    const forged = await token(reviewJob, ["credentials:read", "ralph:activity"]);
    const res = await activityRequest(reviewJob, forged, THOUGHT);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_a_ralph_job" });
    // A non-ralph job type under the ralph capability.
    const odd = await newJob({ type: "review.run" });
    expect((await activityRequest(odd, await token(odd), THOUGHT)).status).toBe(403);
    expect(state.linear.activities).toEqual([]);
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
  });

  it("answers 502 when Linear fails", async () => {
    const run = await newRun();
    const jobId = await newJob({ ralphRunId: run.id });
    state.linear.createActivity = () => Promise.reject(new Error("Linear is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await activityRequest(jobId, await token(jobId), THOUGHT);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "linear_unavailable" });
    error.mockRestore();
  });
});
