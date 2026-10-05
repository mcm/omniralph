import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  agentRepoPins,
  agents,
  createDb,
  createReview,
  feedback,
  findings,
  jobs,
  listAgentAudit,
  repositories,
  rules,
  runMigrations,
  scmConnections,
  type Database,
} from "@omniralph/db";
import type { HeartbeatResponse, JobOutcomeResponse, JobStartResponse } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  sends: [] as { topic: string; payload: unknown; options: unknown }[],
  clients: [] as unknown[],
  sendError: null as Error | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    constructor(options: unknown) {
      state.clients.push(options);
    }
    async send(topic: string, payload: unknown, options: unknown) {
      if (state.sendError) throw state.sendError;
      state.sends.push({ topic, payload, options });
      return { messageId: `msg-${state.sends.length}` };
    }
  },
}));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: async () => "control-panel-oidc" }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.QUEUE_REGIONS = "iad1";
process.env.CRON_SECRET = "cron-secret";

const { VercelQueuesDispatcher } = await import("@/lib/dispatch");
const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { requireJob } = await import("@/lib/agent-auth/verify");
const { POST: heartbeat } = await import("./heartbeat/route");
const { POST: start } = await import("./jobs/[id]/start/route");
const { POST: result } = await import("./jobs/[id]/result/route");
const { POST: fail } = await import("./jobs/[id]/fail/route");
const queueRoute = await import("./queue/[region]/[...path]/route");
const { GET: expireJobs } = await import("../cron/expire-jobs/route");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const upstreamCalls: { method: string; url: string; authorization: string | null }[] = [];
const server = setupServer(
  http.all("https://iad1.vercel-queue.com/*", ({ request }) => {
    upstreamCalls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    return new HttpResponse(null, { status: 204 });
  }),
);

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function agentRequest(
  path: string,
  accessToken: string,
  init: { method?: string; body?: unknown } = {},
): Request {
  return new Request(`http://localhost/api/agent/${path}`, {
    method: init.method ?? "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-real-ip": newIp(),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!dockerAvailable)("job dispatch and agent API", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let repositoryId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    // After the container started, or msw intercepts Testcontainers' Docker calls.
    server.listen({ onUnhandledFrame: "error" });

    const [connection] = await db
      .insert(scmConnections)
      .values({
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        encryptedCredentials: "unused",
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
        connectionId: connection!.id,
      })
      .returning();
    repositoryId = repo!.id;
  }, 180_000);

  afterAll(async () => {
    server.close();
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(() => {
    state.sends.length = 0;
    state.clients.length = 0;
    state.sendError = null;
    upstreamCalls.length = 0;
  });

  async function newAgent(values: Partial<typeof agents.$inferInsert> = {}) {
    const [agent] = await db
      .insert(agents)
      .values({ name: "coder-1", ...values })
      .returning();
    const accessToken = await getTokenSigner().signAccessToken(agent!.id);
    return { agentId: agent!.id, accessToken };
  }

  function dispatcher() {
    return new VercelQueuesDispatcher({ db });
  }

  async function newJob(input: { repositoryId?: string; dedupeKey?: string } = {}) {
    const { job } = await dispatcher().createAndPublish({
      capability: "review",
      type: "review.run",
      payload: { prNumber: 7 },
      repositoryId: input.repositoryId ?? null,
      dedupeKey: input.dedupeKey ?? randomUUID(),
    });
    return job.id;
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    return row!;
  }

  async function startAs(jobId: string, accessToken: string) {
    const res = await start(agentRequest(`jobs/${jobId}/start`, accessToken), ctx(jobId));
    expect(res.status).toBe(200);
    return (await res.json()) as JobStartResponse;
  }

  async function failAs(jobId: string, accessToken: string, body: unknown) {
    return fail(agentRequest(`jobs/${jobId}/fail`, accessToken, { body }), ctx(jobId));
  }

  describe("VercelQueuesDispatcher", () => {
    it("publishes { jobId } deploymentless with idempotencyKey = jobId and 24h retention", async () => {
      const { job, created } = await dispatcher().createAndPublish({
        capability: "review",
        type: "review.run",
        dedupeKey: "review:publish",
      });
      expect(created).toBe(true);
      expect(state.clients).toEqual([{ region: "iad1", deploymentId: null }]);
      expect(state.sends).toEqual([
        {
          topic: "review-jobs",
          payload: { jobId: job.id },
          options: { idempotencyKey: job.id, retentionSeconds: 86_400 },
        },
      ]);
      const row = await jobRow(job.id);
      expect(row).toMatchObject({
        status: "queued",
        topic: "review-jobs",
        queueMessageId: "msg-1",
      });
    });

    it("dedupes on dedupeKey while a job is queued or running", async () => {
      const first = await dispatcher().createAndPublish({
        capability: "review",
        type: "review.run",
        dedupeKey: "review:dedupe",
      });
      const second = await dispatcher().createAndPublish({
        capability: "review",
        type: "review.run",
        dedupeKey: "review:dedupe",
      });
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      expect(state.sends).toHaveLength(1);
      expect(await db.select().from(jobs).where(eq(jobs.dedupeKey, "review:dedupe"))).toHaveLength(
        1,
      );

      // Once the job is finished, the key can be used again.
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, first.job.id));
      const third = await dispatcher().createAndPublish({
        capability: "review",
        type: "review.run",
        dedupeKey: "review:dedupe",
      });
      expect(third.created).toBe(true);
      expect(third.job.id).not.toBe(first.job.id);
    });

    it("republishes a deduped job whose earlier publish failed", async () => {
      state.sendError = new Error("queue down");
      await expect(
        dispatcher().createAndPublish({
          capability: "review",
          type: "review.run",
          dedupeKey: "review:publish-failed",
        }),
      ).rejects.toThrow("queue down");
      state.sendError = null;
      const retried = await dispatcher().createAndPublish({
        capability: "review",
        type: "review.run",
        dedupeKey: "review:publish-failed",
      });
      expect(retried.created).toBe(false);
      expect(state.sends).toHaveLength(1);
      expect(state.sends[0]!.options).toEqual({
        idempotencyKey: retried.job.id,
        retentionSeconds: 86_400,
      });
      expect((await jobRow(retried.job.id)).topic).toBe("review-jobs");
    });

    it("publishes pinned repos' jobs to the pinned agent's topic", async () => {
      const busy = await newAgent({ name: "busy" });
      const idle = await newAgent({ name: "idle" });
      const revoked = await newAgent({ name: "revoked", revokedAt: new Date() });
      await db.insert(agentRepoPins).values([
        { agentId: busy.agentId, repositoryId },
        { agentId: idle.agentId, repositoryId },
        { agentId: revoked.agentId, repositoryId },
      ]);
      await db.insert(jobs).values({
        capability: "review",
        type: "review.run",
        status: "running",
        agentId: busy.agentId,
      });

      await newJob({ repositoryId });
      expect(state.sends.at(-1)!.topic).toBe(`review-jobs-agent-${idle.agentId}`);

      // Explicit targets (e.g. `repo.sync` pre-clones) win.
      await dispatcher().createAndPublish({
        capability: "review",
        type: "repo.sync",
        repositoryId,
        targetAgentId: busy.agentId,
      });
      expect(state.sends.at(-1)!.topic).toBe(`review-jobs-agent-${busy.agentId}`);

      await db.delete(agentRepoPins).where(eq(agentRepoPins.repositoryId, repositoryId));
      await newJob({ repositoryId });
      expect(state.sends.at(-1)!.topic).toBe("review-jobs");
    });

    it("cancels queued jobs at once and flags running ones", async () => {
      const queued = await newJob();
      expect(await dispatcher().cancel(queued)).toBe("canceled");
      expect(await jobRow(queued)).toMatchObject({ status: "canceled", cancelRequested: true });

      const { accessToken } = await newAgent();
      const running = await newJob();
      await startAs(running, accessToken);
      expect(await dispatcher().cancel(running)).toBe("cancel_requested");
      expect(await jobRow(running)).toMatchObject({ status: "running", cancelRequested: true });
      expect(await dispatcher().cancel(queued)).toBe("not_cancelable");
    });
  });

  describe("POST /api/agent/jobs/{id}/start", () => {
    it("runs a queued job and returns a job token with the capability's scopes", async () => {
      const { agentId, accessToken } = await newAgent();
      const jobId = await newJob();
      const body = await startAs(jobId, accessToken);
      expect(body).toMatchObject({
        action: "run",
        job: {
          id: jobId,
          capability: "review",
          type: "review.run",
          repositoryId: null,
          payload: { prNumber: 7 },
          deliveryCount: 1,
        },
        jobToken: { jobId, expiresIn: 900 },
      });
      expect(await jobRow(jobId)).toMatchObject({ status: "running", agentId, deliveryCount: 1 });

      if (body.action !== "run") throw new Error("expected run");
      const principal = await requireJob(
        new Request("http://localhost/api/agent/credentials", {
          headers: { authorization: `Bearer ${body.jobToken.token}`, "x-real-ip": newIp() },
        }),
        "credentials:read",
      );
      expect(principal).toEqual({ jobId, agentId, scopes: ["credentials:read"] });
    });

    it("skips a canceled job", async () => {
      const { accessToken } = await newAgent();
      const jobId = await newJob();
      await dispatcher().cancel(jobId);
      expect(await startAs(jobId, accessToken)).toEqual({ action: "skip", reason: "canceled" });
      expect((await jobRow(jobId)).deliveryCount).toBe(0);
    });

    it("skips a running job whose cancellation was requested", async () => {
      const a = await newAgent();
      const b = await newAgent();
      const jobId = await newJob();
      await startAs(jobId, a.accessToken);
      await dispatcher().cancel(jobId);
      expect(await startAs(jobId, b.accessToken)).toEqual({ action: "skip", reason: "canceled" });
      expect((await jobRow(jobId)).status).toBe("canceled");
    });

    it("skips completed, failed and expired jobs, and unknown IDs", async () => {
      const { accessToken } = await newAgent();
      for (const status of ["completed", "failed", "expired"] as const) {
        const jobId = await newJob();
        await db.update(jobs).set({ status }).where(eq(jobs.id, jobId));
        expect(await startAs(jobId, accessToken)).toEqual({ action: "skip", reason: status });
      }
      expect(await startAs(randomUUID(), accessToken)).toEqual({
        action: "skip",
        reason: "not_found",
      });
    });

    it("skips jobs of capabilities not enabled for the agent", async () => {
      const { accessToken } = await newAgent({ enabledCapabilities: [] });
      const jobId = await newJob();
      expect(await startAs(jobId, accessToken)).toEqual({
        action: "skip",
        reason: "capability_disabled",
      });
      expect((await jobRow(jobId)).status).toBe("queued");
    });

    it("requires an agent access token", async () => {
      const jobId = await newJob();
      const res = await start(agentRequest(`jobs/${jobId}/start`, "garbage"), ctx(jobId));
      expect(res.status).toBe(401);
    });
  });

  describe("failure and delivery-count rules", () => {
    it("redelivers retryable failures until the 3rd delivery, then fails the job", async () => {
      const { accessToken } = await newAgent();
      const jobId = await newJob();

      for (const delivery of [1, 2]) {
        const started = await startAs(jobId, accessToken);
        expect(started).toMatchObject({ action: "run", job: { deliveryCount: delivery } });
        const res = await failAs(jobId, accessToken, {
          retryable: true,
          retryAfterSeconds: 120,
          error: "rate limited",
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "retry", retryAfterSeconds: 120 });
        expect(await jobRow(jobId)).toMatchObject({ status: "queued", agentId: null });
      }

      await startAs(jobId, accessToken);
      const res = await failAs(jobId, accessToken, { retryable: true });
      expect(await res.json()).toEqual({ status: "failed" } satisfies JobOutcomeResponse);
      expect(await jobRow(jobId)).toMatchObject({ status: "failed", deliveryCount: 3 });
    });

    it("defaults the retry delay", async () => {
      const { accessToken } = await newAgent();
      const jobId = await newJob();
      await startAs(jobId, accessToken);
      const res = await failAs(jobId, accessToken, { retryable: true });
      expect(await res.json()).toEqual({ status: "retry", retryAfterSeconds: 60 });
    });

    it("fails non-retryable failures at once", async () => {
      const { accessToken } = await newAgent();
      const jobId = await newJob();
      await startAs(jobId, accessToken);
      const res = await failAs(jobId, accessToken, { retryable: false, error: "bad diff" });
      expect(await res.json()).toEqual({ status: "failed" });
      expect(await jobRow(jobId)).toMatchObject({ status: "failed", error: "bad diff" });
    });

    it("fails a job delivered more than 3 times (agents crashed mid-run)", async () => {
      const { accessToken } = await newAgent();
      const jobId = await newJob();
      for (let i = 0; i < 3; i++) await startAs(jobId, accessToken);
      expect(await startAs(jobId, accessToken)).toEqual({
        action: "skip",
        reason: "max_deliveries",
      });
      expect(await jobRow(jobId)).toMatchObject({ status: "failed", deliveryCount: 3 });
    });

    it("ends a canceled running job as canceled", async () => {
      const { accessToken } = await newAgent();
      const jobId = await newJob();
      await startAs(jobId, accessToken);
      await dispatcher().cancel(jobId);
      const res = await failAs(jobId, accessToken, { retryable: true });
      expect(await res.json()).toEqual({ status: "canceled" });
      expect((await jobRow(jobId)).status).toBe("canceled");
    });

    it("rejects invalid bodies", async () => {
      const { accessToken } = await newAgent();
      const jobId = await newJob();
      await startAs(jobId, accessToken);
      expect((await failAs(jobId, accessToken, { retryable: "yes" })).status).toBe(400);
    });
  });

  describe("results", () => {
    it("completes the job and audits the submission", async () => {
      const { agentId, accessToken } = await newAgent();
      const jobId = await newJob();
      await startAs(jobId, accessToken);
      const res = await result(
        agentRequest(`jobs/${jobId}/result`, accessToken, { body: { result: { findings: [] } } }),
        ctx(jobId),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "completed" });
      expect(await jobRow(jobId)).toMatchObject({
        status: "completed",
        result: { findings: [] },
      });
      const audit = await listAgentAudit(db, { agentId, event: "result_submitted" });
      expect(audit.map((a) => a.detail)).toEqual([{ jobId, status: "completed" }]);
    });

    it("rejects results and failures from an agent that is not the job's current agent", async () => {
      const stale = await newAgent({ name: "stale" });
      const current = await newAgent({ name: "current" });
      const jobId = await newJob();
      await startAs(jobId, stale.accessToken);
      // The stale agent's lease lapsed and the message was redelivered to another agent.
      await startAs(jobId, current.accessToken);

      const staleResult = await result(
        agentRequest(`jobs/${jobId}/result`, stale.accessToken, { body: { result: {} } }),
        ctx(jobId),
      );
      expect(staleResult.status).toBe(409);
      expect((await failAs(jobId, stale.accessToken, { retryable: false })).status).toBe(409);
      expect(await jobRow(jobId)).toMatchObject({ status: "running", agentId: current.agentId });

      const ok = await result(
        agentRequest(`jobs/${jobId}/result`, current.accessToken, { body: { result: {} } }),
        ctx(jobId),
      );
      expect(ok.status).toBe(200);
      // Finished jobs accept no further reports, not even from their agent.
      const again = await result(
        agentRequest(`jobs/${jobId}/result`, current.accessToken, { body: { result: {} } }),
        ctx(jobId),
      );
      expect(again.status).toBe(409);
    });

    it("validates a review.learn-rule result and stores its rule once", async () => {
      const { accessToken } = await newAgent();
      const sha = (n: number) => n.toString(16).padStart(40, "0");
      const review = await createReview(db, {
        repositoryId,
        prNumber: 9,
        headSha: sha(2),
        baseSha: sha(1),
        trigger: "webhook",
        profileId: "standard",
        model: null,
        budget: 100_000,
      });
      const [finding] = await db
        .insert(findings)
        .values({
          reviewId: review.id,
          path: "src/a.ts",
          startLine: 1,
          endLine: 1,
          severity: "low",
          category: "correctness",
          title: "Unused value",
          body: "Never read.",
          confidence: 0.5,
          status: "dismissed",
        })
        .returning();
      const [row] = await db
        .insert(feedback)
        .values({ findingId: finding!.id, source: "ui", reason: "false_positive" })
        .returning();
      const { job } = await dispatcher().createAndPublish({
        capability: "review",
        type: "review.learn-rule",
        repositoryId,
        dedupeKey: `review.learn-rule:${row!.id}`,
        payload: {
          feedbackId: row!.id,
          findingId: finding!.id,
          repositoryId,
          repository: {
            provider: "github",
            fullPath: "acme/app",
            cloneUrl: "https://github.com/acme/app.git",
          },
          baseSha: sha(1),
          headSha: sha(2),
          model: null,
          maxTokens: 5000,
          finding: {
            path: "src/a.ts",
            startLine: 1,
            endLine: 1,
            severity: "low",
            category: "correctness",
            title: "Unused value",
            body: "Never read.",
          },
          note: null,
        },
      });
      await startAs(job.id, accessToken);
      const submit = (body: unknown) =>
        result(agentRequest(`jobs/${job.id}/result`, accessToken, { body }), ctx(job.id));

      const valid = {
        rule: "Do not flag values kept for debugging.",
        outcome: "rule",
        usage: { inputTokens: 2000, outputTokens: 50 },
        durationMs: 900,
      };
      expect((await submit({ result: { ...valid, rule: "x".repeat(301) } })).status).toBe(400);
      expect((await submit({ result: { ...valid, outcome: "none" } })).status).toBe(400);
      expect((await submit({ result: valid })).status).toBe(200);
      // The agent's replay after a timeout stores nothing new.
      expect((await submit({ result: valid })).status).toBe(200);

      expect(await jobRow(job.id)).toMatchObject({ status: "completed", result: valid });
      const stored = await db.select().from(rules).where(eq(rules.repositoryId, repositoryId));
      expect(stored).toMatchObject([
        {
          kind: "learned",
          text: "Do not flag values kept for debugging.",
          enabled: true,
          sourceFindingId: finding!.id,
        },
      ]);
    });

    it("returns 404 for unknown jobs", async () => {
      const { accessToken } = await newAgent();
      const id = randomUUID();
      const res = await result(
        agentRequest(`jobs/${id}/result`, accessToken, { body: { result: {} } }),
        ctx(id),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/agent/heartbeat", () => {
    it("returns central config, refreshed job tokens and jobs to cancel", async () => {
      const { agentId, accessToken } = await newAgent({
        maxConcurrency: 2,
        pollIntervalSeconds: 7,
      });
      const other = await newAgent();
      await db.insert(agentRepoPins).values({ agentId, repositoryId });

      const running = await newJob();
      await startAs(running, accessToken);
      const canceled = await newJob();
      await startAs(canceled, accessToken);
      await dispatcher().cancel(canceled);
      const takenOver = await newJob();
      await startAs(takenOver, accessToken);
      await startAs(takenOver, other.accessToken);

      const res = await heartbeat(
        agentRequest("heartbeat", accessToken, {
          body: {
            version: "0.2.0",
            capabilities: ["review", "ralph"],
            runningJobIds: [running, canceled, takenOver],
            freeSlots: 0,
          },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HeartbeatResponse;
      expect(body).toMatchObject({
        maxConcurrency: 2,
        pollIntervalSeconds: 7,
        enabledCapabilities: ["review"],
        pinnedRepoIds: [repositoryId],
        topics: [`review-jobs-agent-${agentId}`, "review-jobs", `system-jobs-agent-${agentId}`],
        queueRegion: "iad1",
      });
      expect(body.cancelJobIds.sort()).toEqual([canceled, takenOver].sort());
      expect(body.jobTokens.map((t) => [t.jobId, t.expiresIn])).toEqual([[running, 900]]);

      const principal = await requireJob(
        new Request("http://localhost/api/agent/credentials", {
          headers: { authorization: `Bearer ${body.jobTokens[0]!.token}`, "x-real-ip": newIp() },
        }),
        "credentials:read",
      );
      expect(principal).toMatchObject({ jobId: running, agentId });

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent).toMatchObject({
        reportedVersion: "0.2.0",
        reportedCapabilities: ["review", "ralph"],
      });
      expect(agent!.lastHeartbeatAt).toBeInstanceOf(Date);
      await db.delete(agentRepoPins).where(eq(agentRepoPins.agentId, agentId));
    });

    it("rejects invalid heartbeats and revoked agents", async () => {
      const { agentId, accessToken } = await newAgent();
      const bad = await heartbeat(agentRequest("heartbeat", accessToken, { body: { version: 1 } }));
      expect(bad.status).toBe(400);
      await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
      const revoked = await heartbeat(
        agentRequest("heartbeat", accessToken, {
          body: { version: "0.2.0", capabilities: [], runningJobIds: [], freeSlots: 1 },
        }),
      );
      expect(revoked.status).toBe(401);
    });
  });

  describe("queue proxy route", () => {
    const base = "http://localhost/api/agent/queue/iad1/api/v3/topic";

    function proxyRequest(url: string, accessToken: string, method = "POST") {
      return new Request(url, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "multipart/mixed",
          "x-real-ip": newIp(),
        },
      });
    }

    it("forwards the agent's topics with the control panel's OIDC token", async () => {
      const { agentId, accessToken } = await newAgent();
      for (const topic of ["review-jobs", `review-jobs-agent-${agentId}`]) {
        const res = await queueRoute.POST(
          proxyRequest(`${base}/${topic}/consumer/agents`, accessToken),
        );
        expect(res.status).toBe(204);
      }
      const ack = await queueRoute.DELETE(
        proxyRequest(`${base}/review-jobs/consumer/agents/lease/rh-1`, accessToken, "DELETE"),
      );
      expect(ack.status).toBe(204);
      expect(upstreamCalls).toEqual([
        {
          method: "POST",
          url: "https://iad1.vercel-queue.com/api/v3/topic/review-jobs/consumer/agents",
          authorization: "Bearer control-panel-oidc",
        },
        {
          method: "POST",
          url: `https://iad1.vercel-queue.com/api/v3/topic/review-jobs-agent-${agentId}/consumer/agents`,
          authorization: "Bearer control-panel-oidc",
        },
        {
          method: "DELETE",
          url: "https://iad1.vercel-queue.com/api/v3/topic/review-jobs/consumer/agents/lease/rh-1",
          authorization: "Bearer control-panel-oidc",
        },
      ]);
    });

    it("denies other agents' topics, disabled capabilities and other operations", async () => {
      const { accessToken } = await newAgent();
      const other = await newAgent();
      const disabled = await newAgent({ enabledCapabilities: [] });
      const denied = [
        queueRoute.POST(
          proxyRequest(`${base}/review-jobs-agent-${other.agentId}/consumer/agents`, accessToken),
        ),
        queueRoute.POST(proxyRequest(`${base}/review-jobs/consumer/agents`, disabled.accessToken)),
        queueRoute.POST(proxyRequest(`${base}/review-jobs/consumer/workers`, accessToken)),
        queueRoute.GET(proxyRequest(`${base}/review-jobs/consumer/agents`, accessToken, "GET")),
        queueRoute.PUT(proxyRequest(`${base}/review-jobs`, accessToken, "PUT")),
      ];
      for (const res of await Promise.all(denied)) expect(res.status).toBe(403);
      expect(upstreamCalls).toHaveLength(0);
    });

    it("lets every agent read its own system topic (even with no capability enabled), not others'", async () => {
      const agent = await newAgent({ enabledCapabilities: [] });
      const other = await newAgent();
      const own = await queueRoute.POST(
        proxyRequest(
          `${base}/system-jobs-agent-${agent.agentId}/consumer/agents`,
          agent.accessToken,
        ),
      );
      expect(own.status).toBe(204);
      const foreign = await queueRoute.POST(
        proxyRequest(
          `${base}/system-jobs-agent-${other.agentId}/consumer/agents`,
          agent.accessToken,
        ),
      );
      expect(foreign.status).toBe(403);
      expect(upstreamCalls.map((c) => c.url)).toEqual([
        `https://iad1.vercel-queue.com/api/v3/topic/system-jobs-agent-${agent.agentId}/consumer/agents`,
      ]);
    });

    it("requires an agent access token", async () => {
      const res = await queueRoute.POST(proxyRequest(`${base}/review-jobs/consumer/agents`, "x"));
      expect(res.status).toBe(401);
      expect(upstreamCalls).toHaveLength(0);
    });
  });

  describe("GET /api/cron/expire-jobs", () => {
    function cronRequest(secret?: string) {
      return new Request("http://localhost/api/cron/expire-jobs", {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      });
    }

    it("expires jobs still queued after 24h", async () => {
      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const [stale, fresh, oldRunning] = await db
        .insert(jobs)
        .values([
          { capability: "review", type: "review.run", createdAt: dayAgo },
          { capability: "review", type: "review.run" },
          { capability: "review", type: "review.run", status: "running", createdAt: dayAgo },
        ])
        .returning({ id: jobs.id });

      const res = await expireJobs(cronRequest("cron-secret"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ expired: 1 });
      expect(await jobRow(stale!.id)).toMatchObject({ status: "expired" });
      expect((await jobRow(stale!.id)).finishedAt).toBeInstanceOf(Date);
      expect((await jobRow(fresh!.id)).status).toBe("queued");
      expect((await jobRow(oldRunning!.id)).status).toBe("running");
    });

    it("requires CRON_SECRET", async () => {
      expect((await expireJobs(cronRequest())).status).toBe(401);
      expect((await expireJobs(cronRequest("wrong"))).status).toBe(401);
    });
  });
});
