import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  agentRepoPins,
  agents,
  closeDb,
  createDb,
  createAgentEnrollment,
  captureChanges,
  createReview,
  enrollAgent,
  feedback,
  findings,
  jobs,
  insertMessage,
  insertPlaybook,
  listAgentAudit,
  listMessages,
  ralphRuns,
  repositories,
  rules,
  scmConnections,
  type Database,
  organizations,
  type RecordedChange,
} from "@omniralph/db";
import {
  JOB_LEASE_SECONDS,
  type HeartbeatResponse,
  type JobOutcomeResponse,
  JobStartResponse,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq, inArray } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as Tasks from "@omniralph/tasks";
import type * as Adapters from "@/lib/scm/adapters";

/** A heartbeat's `local`: the agent's machine settings, all defaults. */
const LOCAL = {
  maxConcurrency: 5,
  poolLimits: { short: 5, long: 4 },
  versionPin: null,
  installablesAllow: ["@omniralph/*"],
};

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  replies: [] as { number: number; commentId: string; body: string }[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
// Fixture built-ins for run-spec jobs (the registry is filled by the port stories).
vi.mock("@omniralph/tasks", async (importOriginal) => {
  const tasks = await importOriginal<typeof Tasks>();
  const defined = (
    [
      ["builtin:learn-rule", "learn-rule"],
      ["builtin:reply-to-finding", "reply-to-finding"],
    ] as const
  ).map(([id, role]) =>
    tasks.Playbook.parse({
      id,
      name: id,
      role,
      systemPrompt: "You answer questions about code.",
      promptTemplate: "{{finding.title}}",
      tools: { builtin: ["Read", "Grep"] },
      tokenBudget: { tokens: 5000 },
    }),
  );
  const getBuiltinPlaybook = (id: string) => defined.find((p) => p.id === id) ?? null;
  const getBuiltinRunSpec = (id: string) => {
    const playbook = getBuiltinPlaybook(id);
    return playbook && tasks.playbookRunSpec(playbook);
  };
  return {
    ...tasks,
    getBuiltinPlaybook,
    getBuiltinRunSpec,
    getBuiltinTask: (id: string) => getBuiltinRunSpec(id)?.task ?? null,
  };
});
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  scmAdapterFor: () => ({
    async replyToComment(_repo: unknown, number: number, commentId: string, body: string) {
      state.replies.push({ number, commentId, body });
      return { id: `reply-${state.replies.length}` };
    },
  }),
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.CRON_SECRET = "cron-secret";
process.env.APP_URL = "https://omniralph.example.com";

const { PostgresDispatcher } = await import("@/lib/dispatch");
const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { requireJob } = await import("@/lib/agent-auth/verify");
const { POST: heartbeat } = await import("./heartbeat/route");
const { POST: result } = await import("./jobs/[id]/result/route");
const { POST: fail } = await import("./jobs/[id]/fail/route");
const { POST: claim } = await import("./claim/route");
const { registerJobOutcomeHandler } = await import("@/lib/jobs/handlers");
const { learnedRuleSink } = await import("@/lib/sinks/learned-rule");
const { POST: credentials } = await import("./credentials/route");
const { POST: activities } = await import("./jobs/[id]/activities/route");
const { GET: attachment } = await import("./jobs/[id]/attachments/[attachmentId]/route");
const { GET: expireJobs } = await import("../cron/expire-jobs/route");

const databaseAvailable = testDatabaseAvailable();

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

/** A run-spec job's payload for the fixture tasks. */
const RUN_PAYLOAD = {
  trigger: { kind: "finding.dismissed", context: { finding: { title: "Unused import" } } },
};

describe.skipIf(!databaseAvailable)("job dispatch and agent API", () => {
  let testDb: TestDatabase;
  let db: Database;
  let repositoryId: string;
  let orgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;

    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: org!.id,
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
        organizationId: org!.id,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
        connectionId: connection!.id,
      })
      .returning();
    repositoryId = repo!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** Agent IDs by access token, for `startAs`. */
  const agentIds = new Map<string, string>();

  async function newAgent(values: Partial<typeof agents.$inferInsert> = {}) {
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1", ...values })
      .returning();
    const accessToken = await getTokenSigner().signAccessToken(agent!.id);
    agentIds.set(accessToken, agent!.id);
    return { agentId: agent!.id, accessToken };
  }

  function dispatcher() {
    return new PostgresDispatcher({ db });
  }

  /** An organization of its own, so other tests' queued jobs aren't claimable. */
  async function newOrg() {
    const [org] = await db.insert(organizations).values({ name: "Initech" }).returning();
    return org!.id;
  }

  async function newJob(
    input: { repositoryId?: string; dedupeKey?: string; organizationId?: string } = {},
  ) {
    const { job } = await dispatcher().createAndPublish({
      organizationId: input.organizationId ?? orgId,
      type: "review.run",
      taskType: "review",
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

  /**
   * Claims `jobId` as an agent through `POST /api/agent/claim`. The job is
   * targeted at the agent for the claim and made claimable now (as once a
   * retry delay passed, or a crashed agent's lease lapsed), so no other job is
   * claimed instead. Null when the claim settled the job (or found nothing).
   */
  async function startAs(jobId: string, accessToken: string) {
    const before = await jobRow(jobId);
    const past = new Date(Date.now() - 1000);
    await db
      .update(jobs)
      .set({
        targetAgentId: agentIds.get(accessToken)!,
        availableAt: past,
        ...(before.status === "running" && { leaseExpiresAt: past }),
      })
      .where(eq(jobs.id, jobId));
    try {
      const res = await claim(
        agentRequest("claim", accessToken, {
          body: { pools: ["short", "long"], waitSeconds: 0 },
        }),
      );
      if (res.status === 204) return null;
      expect(res.status).toBe(200);
      const body = (await res.json()) as JobStartResponse & { action: "run" };
      expect(body.job.id).toBe(jobId);
      return body;
    } finally {
      await db.update(jobs).set({ targetAgentId: before.targetAgentId }).where(eq(jobs.id, jobId));
    }
  }

  /** The `requireJob` principal of a job token (it must carry `credentials:read`). */
  async function jobPrincipal(token: string) {
    const principal = await requireJob(
      new Request("http://localhost/api/agent/credentials", {
        headers: { authorization: `Bearer ${token}`, "x-real-ip": newIp() },
      }),
      "credentials:read",
    );
    if (principal instanceof Response) throw new Error(`requireJob: ${principal.status}`);
    return principal;
  }

  async function failAs(jobId: string, accessToken: string, body: unknown) {
    return fail(agentRequest(`jobs/${jobId}/fail`, accessToken, { body }), ctx(jobId));
  }

  describe("PostgresDispatcher", () => {
    it("inserts a queued job any agent of the organization may claim", async () => {
      const { job, created } = await dispatcher().createAndPublish({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        payload: { prNumber: 7 },
        dedupeKey: "review:insert",
      });
      expect(created).toBe(true);
      expect(job).toMatchObject({ status: "queued", targetAgentId: null });
      expect(await jobRow(job.id)).toMatchObject({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        payload: { prNumber: 7 },
        status: "queued",
        targetAgentId: null,
        agentId: null,
      });
    });

    it("dedupes on dedupeKey while a job is queued or running", async () => {
      const first = await dispatcher().createAndPublish({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        dedupeKey: "review:dedupe",
      });
      const second = await dispatcher().createAndPublish({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        dedupeKey: "review:dedupe",
      });
      expect(second.created).toBe(false);
      expect(second.job).toMatchObject({ id: first.job.id, status: "queued" });
      expect(await db.select().from(jobs).where(eq(jobs.dedupeKey, "review:dedupe"))).toHaveLength(
        1,
      );

      // Once the job is finished, the key can be used again.
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, first.job.id));
      const third = await dispatcher().createAndPublish({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        dedupeKey: "review:dedupe",
      });
      expect(third.created).toBe(true);
      expect(third.job.id).not.toBe(first.job.id);
    });

    it("targets pinned repos' jobs at the least busy live pinned agent", async () => {
      const busy = await newAgent({ name: "busy" });
      const idle = await newAgent({ name: "idle" });
      const revoked = await newAgent({ name: "revoked", revokedAt: new Date() });
      await db.insert(agentRepoPins).values([
        { agentId: busy.agentId, repositoryId },
        { agentId: idle.agentId, repositoryId },
        { agentId: revoked.agentId, repositoryId },
      ]);
      await db.insert(jobs).values({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        status: "running",
        agentId: busy.agentId,
      });
      try {
        const pinned = await newJob({ repositoryId });
        expect(await jobRow(pinned)).toMatchObject({
          status: "queued",
          targetAgentId: idle.agentId,
        });

        // Explicit targets (e.g. `repo.sync` pre-clones) win over pins.
        const { job: targeted } = await dispatcher().createAndPublish({
          organizationId: orgId,
          type: "repo.sync",
          taskType: "system",
          repositoryId,
          targetAgentId: busy.agentId,
        });
        expect(targeted.targetAgentId).toBe(busy.agentId);
        expect((await jobRow(targeted.id)).targetAgentId).toBe(busy.agentId);
      } finally {
        await db.delete(agentRepoPins).where(eq(agentRepoPins.repositoryId, repositoryId));
      }

      // Without pins, any agent of the organization may claim the job.
      expect((await jobRow(await newJob({ repositoryId }))).targetAgentId).toBeNull();
    });

    it("republishes a queued job to its repo's current pins", async () => {
      const first = await newAgent({ name: "first" });
      const second = await newAgent({ name: "second" });
      await db.insert(agentRepoPins).values({ agentId: first.agentId, repositoryId });
      try {
        const jobId = await newJob({ repositoryId });
        expect((await jobRow(jobId)).targetAgentId).toBe(first.agentId);

        // The pin moves to another agent.
        await db.delete(agentRepoPins).where(eq(agentRepoPins.agentId, first.agentId));
        await db.insert(agentRepoPins).values({ agentId: second.agentId, repositoryId });
        expect(await dispatcher().republish(jobId)).toBe(true);
        expect(await jobRow(jobId)).toMatchObject({
          status: "queued",
          targetAgentId: second.agentId,
        });

        // Unpinned: any agent of the organization may claim it.
        await db.delete(agentRepoPins).where(eq(agentRepoPins.repositoryId, repositoryId));
        expect(await dispatcher().republish(jobId)).toBe(true);
        expect((await jobRow(jobId)).targetAgentId).toBeNull();
      } finally {
        await db.delete(agentRepoPins).where(eq(agentRepoPins.repositoryId, repositoryId));
      }
    });

    it("doesn't republish jobs that aren't queued or don't exist", async () => {
      const agent = await newAgent();
      const jobId = await newJob({ repositoryId });
      await db
        .update(jobs)
        .set({ status: "running", agentId: agent.agentId })
        .where(eq(jobs.id, jobId));
      await db.insert(agentRepoPins).values({ agentId: agent.agentId, repositoryId });
      try {
        expect(await dispatcher().republish(jobId)).toBe(false);
        expect(await jobRow(jobId)).toMatchObject({ status: "running", targetAgentId: null });
      } finally {
        await db.delete(agentRepoPins).where(eq(agentRepoPins.repositoryId, repositoryId));
      }
      expect(await dispatcher().republish(randomUUID())).toBe(false);
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

  describe("POST /api/agent/claim", () => {
    const outcomes: string[] = [];

    beforeAll(() => {
      // Test job types: `claim.skip` is skipped by its `onStarted`.
      for (const type of ["claim.run", "claim.skip"]) {
        registerJobOutcomeHandler(type, {
          payload: z.object({}),
          onStarted: async (db, job, agentId) => {
            outcomes.push(`started:${job.id}:${agentId}`);
            if (type !== "claim.skip") return { skip: false };
            await db.update(jobs).set({ status: "skipped" }).where(eq(jobs.id, job.id));
            return { skip: true, reason: "skipped" };
          },
          onFailed: async (_db, job, error) => void outcomes.push(`failed:${job.id}:${error}`),
          onCanceled: async (_db, job) => void outcomes.push(`canceled:${job.id}`),
        });
      }
    });

    beforeEach(() => {
      outcomes.length = 0;
    });

    /** An organization of its own, so other tests' queued jobs aren't claimable. */
    async function claimOrg() {
      const [org] = await db.insert(organizations).values({ name: "Claimco" }).returning();
      const organizationId = org!.id;
      const agent = await newAgent({ organizationId });
      async function job(type = "claim.run", values: Partial<typeof jobs.$inferInsert> = {}) {
        const { job } = await dispatcher().createAndPublish({
          organizationId,
          type,
          taskType: "query",
          payload: {},
          dedupeKey: randomUUID(),
        });
        if (Object.keys(values).length > 0) {
          await db.update(jobs).set(values).where(eq(jobs.id, job.id));
        }
        return job.id;
      }
      return { organizationId, agent, job };
    }

    function claimAs(
      accessToken: string,
      body: unknown = { pools: ["short"], waitSeconds: 0 },
      signal?: AbortSignal,
    ) {
      const req = agentRequest("claim", accessToken, { body });
      return claim(signal ? new Request(req, { signal }) : req);
    }

    it("claims a queued job at once and returns it with a job token", async () => {
      const { agent, job } = await claimOrg();
      const jobId = await job();
      const res = await claimAs(agent.accessToken, { pools: ["short"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JobStartResponse;
      expect(body).toMatchObject({
        action: "run",
        job: {
          id: jobId,
          type: "claim.run",
          taskType: "query",
          pool: "short",
          taskId: null,
          deliveryCount: 1,
        },
        jobToken: { jobId, expiresIn: 900 },
      });
      if (body.action !== "run") throw new Error("expected run");
      const principal = await requireJob(
        new Request("http://localhost/api/agent/credentials", {
          headers: { authorization: `Bearer ${body.jobToken.token}`, "x-real-ip": newIp() },
        }),
        "credentials:read",
      );
      expect(principal).toMatchObject({ jobId, agentId: agent.agentId });
      expect(await jobRow(jobId)).toMatchObject({
        status: "running",
        agentId: agent.agentId,
        deliveryCount: 1,
      });
      expect((await jobRow(jobId)).leaseExpiresAt).toBeInstanceOf(Date);
      expect(outcomes).toEqual([`started:${jobId}:${agent.agentId}`]);
    });

    it("gives a legacy job one token without a kind", async () => {
      const { agent, job } = await claimOrg();
      const jobId = await job();
      const body = (await (await claimAs(agent.accessToken)).json()) as JobStartResponse;
      if (body.action !== "run") throw new Error("expected run");
      expect(body.jobToken).toMatchObject({ jobId, kind: "legacy" });
      expect(body.sessionToken).toBeUndefined();
      expect(decodeJwt(body.jobToken.token).kind).toBeUndefined();
      expect(await jobPrincipal(body.jobToken.token)).toMatchObject({
        jobId,
        kind: "legacy",
        scopes: ["credentials:read"],
      });
    });

    it("gives a run-spec job a lifecycle and a session token, and its run spec with both", async () => {
      const { agent, job } = await claimOrg();
      const jobId = await job("claim.run", {
        taskId: "builtin:learn-rule",
        payload: RUN_PAYLOAD,
      });
      const body = (await (await claimAs(agent.accessToken)).json()) as JobStartResponse;
      if (body.action !== "run") throw new Error("expected run");
      expect(body.job.taskId).toBe("builtin:learn-rule");
      expect(JobStartResponse.safeParse(body).success).toBe(true);
      expect(body.runSpec).toMatchObject({
        jobId,
        taskType: "query",
        pool: "short",
        agent: { id: "builtin:learn-rule", systemPrompt: "You answer questions about code." },
        task: { id: "builtin:learn-rule" },
        trigger: RUN_PAYLOAD.trigger,
        repository: null,
        ref: null,
        requireCheckout: false,
        tokenBudget: 5000,
        tokens: { lifecycle: body.jobToken, session: body.sessionToken },
      });
      expect(body.jobToken).toMatchObject({ jobId, expiresIn: 900, kind: "lifecycle" });
      expect(body.sessionToken).toMatchObject({ jobId, expiresIn: 900, kind: "session" });
      expect(body.sessionToken!.token).not.toBe(body.jobToken.token);
      expect(await jobPrincipal(body.jobToken.token)).toMatchObject({
        jobId,
        agentId: agent.agentId,
        kind: "lifecycle",
        scopes: ["credentials:read"],
      });
      expect(await jobPrincipal(body.sessionToken!.token)).toMatchObject({
        jobId,
        agentId: agent.agentId,
        kind: "session",
        scopes: ["credentials:read", "run:activity", "run:attachments", "linear:read"],
      });
    });

    it("fails a run-spec job whose playbook is unknown and claims the next job", async () => {
      const { agent, job } = await claimOrg();
      const unknown = await job("claim.run", { taskId: "builtin:gone", payload: RUN_PAYLOAD });
      const next = await job();
      const body = (await (await claimAs(agent.accessToken)).json()) as JobStartResponse;
      if (body.action !== "run") throw new Error("expected run");
      expect(body.job.id).toBe(next);
      expect(await jobRow(unknown)).toMatchObject({
        status: "failed",
        error: "Unknown playbook builtin:gone",
        deliveryCount: 0,
      });
      // A run-spec job never reaches its type's outcome handler; an unknown playbook has no sink either.
      expect(outcomes).toEqual([`started:${next}:${agent.agentId}`]);
    });

    it("fails a run-spec job whose trigger the playbook's role doesn't allow", async () => {
      const { agent, job } = await claimOrg();
      const jobId = await job("claim.run", {
        taskId: "builtin:learn-rule",
        payload: { trigger: { kind: "chat.request", context: {} } },
      });
      const res = await claimAs(agent.accessToken);
      expect(res.status).toBe(204);
      expect(await jobRow(jobId)).toMatchObject({
        status: "failed",
        error: "Playbook builtin:learn-rule can't be triggered by chat.request",
      });
    });

    /** A custom chat playbook of `organizationId` with `systemPrompt`. */
    async function customPlaybook(organizationId: string, systemPrompt = "You explain code.") {
      return insertPlaybook(db, organizationId, {
        name: "Custom explainer",
        role: "chat-ask",
        definition: {
          systemPrompt,
          tools: { builtin: ["Read"] },
          promptTemplate: "{{question}}",
          tokenBudget: { tokens: 7000 },
        },
        requirements: {},
        createdBy: null,
      });
    }
    const CHAT_PAYLOAD = { trigger: { kind: "chat.request", context: { question: "Why?" } } };

    it("resolves the run spec of the organization's custom playbook", async () => {
      const { organizationId, agent, job } = await claimOrg();
      for (const systemPrompt of ["You answer questions about code.", "You explain code."]) {
        const task = await customPlaybook(organizationId, systemPrompt);
        const jobId = await job("claim.run", { taskId: task.id, payload: CHAT_PAYLOAD });
        const body = (await (await claimAs(agent.accessToken)).json()) as JobStartResponse;
        if (body.action !== "run") throw new Error("expected run");
        expect(JobStartResponse.safeParse(body).success).toBe(true);
        expect(body.runSpec).toMatchObject({
          jobId,
          taskType: "query",
          pool: "short",
          agent: { id: task.id, systemPrompt },
          task: { id: task.id, name: "Custom explainer", agentId: task.id, sink: "chat-thread" },
          trigger: CHAT_PAYLOAD.trigger,
          tokenBudget: 7000,
        });
      }
      expect((await claimAs(agent.accessToken)).status).toBe(204);
    });

    it("fails a run-spec job whose playbook belongs to another organization", async () => {
      const { agent, job } = await claimOrg();
      const theirs = await customPlaybook(orgId);
      const jobId = await job("claim.run", { taskId: theirs.id, payload: CHAT_PAYLOAD });
      expect((await claimAs(agent.accessToken)).status).toBe(204);
      expect(await jobRow(jobId)).toMatchObject({
        status: "failed",
        error: `Unknown playbook ${theirs.id}`,
        deliveryCount: 0,
      });
    });

    it("returns 204 with nothing to claim after waitSeconds: 0", async () => {
      const { agent, job } = await claimOrg();
      // Not claimable: a pool the agent didn't ask for, and a delayed retry.
      const delayed = await job("claim.run", { availableAt: new Date(Date.now() + 60_000) });
      await job();
      const res = await claimAs(agent.accessToken, { pools: ["long"], waitSeconds: 0 });
      expect(res.status).toBe(204);
      expect((await jobRow(delayed)).status).toBe("queued");
    });

    it("never claims task types the agent doesn't accept", async () => {
      const { organizationId, job } = await claimOrg();
      const untrusted = await newAgent({ organizationId, reportedAcceptedTaskTypes: ["review"] });
      const jobId = await job();
      expect((await claimAs(untrusted.accessToken)).status).toBe(204);
      expect((await jobRow(jobId)).status).toBe("queued");
    });

    it("claims system RPCs without a pool, also on an agent accepting no task types, with one lifecycle token", async () => {
      const { organizationId, job } = await claimOrg();
      const agent = await newAgent({ organizationId, reportedAcceptedTaskTypes: [] });
      const jobId = await job("repo.sync", { taskType: "system" });
      const res = await claimAs(agent.accessToken, { pools: [], waitSeconds: 0 });
      const body = (await res.json()) as JobStartResponse & { action: "run" };
      expect(body.job).toMatchObject({
        id: jobId,
        type: "repo.sync",
        taskType: "system",
        pool: null,
      });
      expect(body.runSpec).toBeUndefined();
      expect(body.sessionToken).toBeUndefined();
      expect(body.jobToken.kind).toBe("lifecycle");
      expect(await jobPrincipal(body.jobToken.token)).toMatchObject({
        jobId,
        kind: "lifecycle",
        scopes: ["credentials:read"],
      });
    });

    it("only claims jobs whose minimum version the agent reported", async () => {
      const { organizationId, job } = await claimOrg();
      const old = await newAgent({ organizationId, reportedVersion: "0.9.0" });
      const current = await newAgent({ organizationId, reportedVersion: "0.10.0" });
      const jobId = await job("claim.run", { minAgentVersion: "0.10.0" });
      expect((await claimAs(old.accessToken)).status).toBe(204);
      const res = await claimAs(current.accessToken);
      expect(((await res.json()) as JobStartResponse & { action: "run" }).job.id).toBe(jobId);
    });

    it("returns a job dispatched while the request waits", async () => {
      const { agent, job } = await claimOrg();
      const started = Date.now();
      const pending = claimAs(agent.accessToken, { pools: ["short"], waitSeconds: 10 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const jobId = await job();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(((await res.json()) as JobStartResponse & { action: "run" }).job.id).toBe(jobId);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("stops waiting when the request is aborted", async () => {
      const { agent } = await claimOrg();
      const controller = new AbortController();
      const started = Date.now();
      const pending = claimAs(
        agent.accessToken,
        { pools: ["short"], waitSeconds: 50 },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 300);
      expect((await pending).status).toBe(204);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("never returns another organization's job", async () => {
      const ours = await claimOrg();
      const theirs = await claimOrg();
      const theirJob = await theirs.job();
      expect((await claimAs(ours.agent.accessToken)).status).toBe(204);
      expect((await jobRow(theirJob)).status).toBe("queued");
      const res = await claimAs(theirs.agent.accessToken);
      expect(((await res.json()) as JobStartResponse & { action: "run" }).job.id).toBe(theirJob);
    });

    it("runs the outcome handlers of settled and skipped jobs and moves on", async () => {
      const { agent, job } = await claimOrg();
      const canceled = await job("claim.run", { cancelRequested: true });
      const exhausted = await job("claim.run", { deliveryCount: 3 });
      const skipped = await job("claim.skip");
      const runnable = await job();
      const res = await claimAs(agent.accessToken);
      expect(res.status).toBe(200);
      expect(((await res.json()) as JobStartResponse & { action: "run" }).job.id).toBe(runnable);
      expect(outcomes).toEqual([
        `canceled:${canceled}`,
        `failed:${exhausted}:Gave up after 3 deliveries`,
        `started:${skipped}:${agent.agentId}`,
        `started:${runnable}:${agent.agentId}`,
      ]);
      expect((await jobRow(canceled)).status).toBe("canceled");
      expect((await jobRow(exhausted)).status).toBe("failed");
      expect((await jobRow(skipped)).status).toBe("skipped");
    });

    it("uses up no delivery when signing the job token fails", async () => {
      const { agent, job } = await claimOrg();
      const jobId = await job();
      const signer = getTokenSigner();
      const spy = vi.spyOn(signer, "signJobToken").mockRejectedValueOnce(new Error("kms down"));
      try {
        await expect(claimAs(agent.accessToken)).rejects.toThrow("kms down");
      } finally {
        spy.mockRestore();
      }
      expect(await jobRow(jobId)).toMatchObject({ status: "queued", deliveryCount: 0 });
    });

    it("claims jobs targeted at the agent first, and never another agent's", async () => {
      const { organizationId, agent, job } = await claimOrg();
      const other = await newAgent({ organizationId });
      const untargeted = await job();
      const theirs = await job("claim.run", { targetAgentId: other.agentId });
      const ours = await job("claim.run", { targetAgentId: agent.agentId });
      const claimedId = async (accessToken: string) =>
        ((await (await claimAs(accessToken)).json()) as JobStartResponse & { action: "run" }).job
          .id;
      expect(await claimedId(agent.accessToken)).toBe(ours);
      expect(await claimedId(agent.accessToken)).toBe(untargeted);
      expect((await claimAs(agent.accessToken)).status).toBe(204);
      expect(await claimedId(other.accessToken)).toBe(theirs);
    });

    it("leaves a live agent's job alone and redelivers a crashed agent's once its lease lapses", async () => {
      const { organizationId, agent, job } = await claimOrg();
      const other = await newAgent({ organizationId });
      const jobId = await job();
      expect((await claimAs(agent.accessToken)).status).toBe(200);

      // The heartbeat renews the lease of a job the agent still runs.
      await db
        .update(jobs)
        .set({ leaseExpiresAt: new Date(Date.now() + 1000) })
        .where(eq(jobs.id, jobId));
      const beat = await heartbeat(
        agentRequest("heartbeat", agent.accessToken, {
          body: {
            version: "0.2.0",
            runningJobIds: [jobId],
            freeSlots: 0,
            local: LOCAL,
          },
        }),
      );
      expect(beat.status).toBe(200);
      expect((await jobRow(jobId)).leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        Date.now() + (JOB_LEASE_SECONDS - 5) * 1000,
      );
      expect((await claimAs(other.accessToken)).status).toBe(204);

      // The agent crashed: no more heartbeats, the lease lapses, another agent takes over.
      await db
        .update(jobs)
        .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(jobs.id, jobId));
      const res = await claimAs(other.accessToken);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ job: { id: jobId, deliveryCount: 2 } });
      expect(await jobRow(jobId)).toMatchObject({ status: "running", agentId: other.agentId });

      // The crashed agent's late result is rejected.
      const late = await result(
        agentRequest(`jobs/${jobId}/result`, agent.accessToken, { body: { result: {} } }),
        ctx(jobId),
      );
      expect(late.status).toBe(409);
      expect(await jobRow(jobId)).toMatchObject({ status: "running", agentId: other.agentId });
    });

    it("rejects invalid bodies, bad tokens and revoked agents", async () => {
      const { agent, job } = await claimOrg();
      await job();
      expect((await claimAs(agent.accessToken, { pools: ["short"], waitSeconds: 51 })).status).toBe(
        400,
      );
      expect((await claimAs(agent.accessToken, { waitSeconds: 0 })).status).toBe(400);
      expect((await claimAs("garbage")).status).toBe(401);
      await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agent.agentId));
      expect((await claimAs(agent.accessToken)).status).toBe(401);
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
        const row = await jobRow(jobId);
        expect(row).toMatchObject({ status: "queued", agentId: null, leaseExpiresAt: null });
        // Claimable again only once the retry delay passed.
        expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() + 110_000);
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
      // Once the job is failed, the claim moves on: in an organization of its own, to nothing.
      const organizationId = await newOrg();
      const { accessToken } = await newAgent({ organizationId });
      const jobId = await newJob({ organizationId });
      for (let i = 0; i < 3; i++) await startAs(jobId, accessToken);
      expect(await startAs(jobId, accessToken)).toBeNull();
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
      // The stale agent's lease lapsed and another agent claimed the job.
      await startAs(jobId, current.accessToken);

      const staleResult = await result(
        agentRequest(`jobs/${jobId}/result`, stale.accessToken, { body: { result: {} } }),
        ctx(jobId),
      );
      expect(staleResult.status).toBe(409);
      expect((await failAs(jobId, stale.accessToken, { retryable: false })).status).toBe(409);
      expect(await jobRow(jobId)).toMatchObject({
        status: "running",
        agentId: current.agentId,
      });

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

    describe("a run-spec job's sink", () => {
      const sha = (n: number) => n.toString(16).padStart(40, "0");
      const sinkCalls: string[] = [];

      afterEach(() => {
        delete learnedRuleSink.onStarted;
        delete learnedRuleSink.onFailed;
        sinkCalls.length = 0;
      });

      /** A dismissed finding and a builtin:learn-rule run for it, as `enqueueLearnRule` inserts it. */
      async function learnRuleRun() {
        const review = await createReview(db, {
          repositoryId,
          prNumber: 9,
          headSha: sha(2),
          baseSha: sha(1),
          trigger: "webhook",
          depth: "standard",
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
          organizationId: orgId,
          type: "review.learn-rule",
          taskType: "query",
          taskId: "builtin:learn-rule",
          repositoryId,
          dedupeKey: `review.learn-rule:${row!.id}`,
          payload: {
            trigger: {
              kind: "finding.dismissed",
              context: {
                feedbackId: row!.id,
                repository: "acme/app",
                finding: {
                  id: finding!.id,
                  path: "src/a.ts",
                  file: '"src/a.ts"',
                  startLine: 1,
                  endLine: 1,
                  location: "line 1",
                  severity: "low",
                  category: "correctness",
                  title: "Unused value",
                  body: "Never read.",
                  baseSha: sha(1),
                  headSha: sha(2),
                },
                dismissal: { note: "" },
              },
            },
            repositoryId,
          },
        });
        return { job, finding: finding! };
      }

      it("hears about the start on claim", async () => {
        const { accessToken, agentId } = await newAgent();
        learnedRuleSink.onStarted = async (_db, job, id) => {
          sinkCalls.push(`started:${job.id}:${id}`);
          return { skip: false };
        };
        const { job } = await learnRuleRun();
        const body = await startAs(job.id, accessToken);
        expect(body?.runSpec?.task.id).toBe("builtin:learn-rule");
        expect(sinkCalls).toEqual([`started:${job.id}:${agentId}`]);
      });

      it("hears about a final failure", async () => {
        const { accessToken } = await newAgent();
        learnedRuleSink.onFailed = async (_db, job, error) =>
          void sinkCalls.push(`failed:${job.id}:${error}`);
        const { job } = await learnRuleRun();
        await startAs(job.id, accessToken);
        const res = await failAs(job.id, accessToken, { retryable: false, error: "boom" });
        expect(res.status).toBe(200);
        expect(sinkCalls).toEqual([`failed:${job.id}:boom`]);
      });

      it("validates the result (400 before the job completes) and stores the learned rule once", async () => {
        const { accessToken } = await newAgent();
        const { job, finding } = await learnRuleRun();
        await startAs(job.id, accessToken);
        const submit = (body: unknown) =>
          result(agentRequest(`jobs/${job.id}/result`, accessToken, { body }), ctx(job.id));

        const valid = {
          outcome: "answered",
          answer: null,
          structured: { rule: "Do not flag values kept for debugging." },
          references: [],
          usage: { inputTokens: 2000, outputTokens: 50 },
          durationMs: 900,
        };
        // Not a query run result, structured output the sink doesn't take, a text answer instead.
        for (const invalid of [
          { rule: "x", outcome: "rule", usage: valid.usage, durationMs: 900 },
          { ...valid, structured: { rule: 42 } },
          { ...valid, structured: { rule: "x", confidence: 1 } },
          { ...valid, structured: null, answer: "Do not flag it." },
        ]) {
          expect((await submit({ result: invalid })).status).toBe(400);
          expect(await jobRow(job.id)).toMatchObject({ status: "running", result: null });
        }
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
            sourceFindingId: finding.id,
          },
        ]);
      });
    });

    it("validates a builtin:reply-to-finding result and posts the answer in the thread once", async () => {
      const { accessToken } = await newAgent();
      const sha = (n: number) => n.toString(16).padStart(40, "0");
      const review = await createReview(db, {
        repositoryId,
        prNumber: 11,
        headSha: sha(2),
        baseSha: sha(1),
        trigger: "webhook",
        depth: "standard",
        model: null,
        budget: 200_000,
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
          scmCommentId: "777",
        })
        .returning();
      const { job } = await dispatcher().createAndPublish({
        organizationId: orgId,
        type: "review.reply",
        taskType: "query",
        taskId: "builtin:reply-to-finding",
        repositoryId,
        dedupeKey: `review.reply:${repositoryId}:778`,
        payload: {
          trigger: {
            kind: "finding.mention",
            context: {
              repository: "acme/app",
              pr: { number: 11 },
              review: { id: review.id },
              finding: {
                id: finding!.id,
                path: "src/a.ts",
                file: '"src/a.ts"',
                startLine: 1,
                endLine: 1,
                location: "line 1",
                severity: "low",
                category: "correctness",
                title: "Unused value",
                body: "Never read.",
                baseSha: sha(1),
                headSha: sha(2),
              },
              question: "@omniralph is it really unused?",
              askedBy: "octocat",
              threadCommentId: "777",
              budgetTokens: 20_000,
            },
          },
          repositoryId,
          ref: sha(2),
        },
      });
      await startAs(job.id, accessToken);
      const submit = (body: unknown) =>
        result(agentRequest(`jobs/${job.id}/result`, accessToken, { body }), ctx(job.id));

      const valid = {
        outcome: "answered",
        answer: "Yes, nothing reads it after line 1.",
        structured: null,
        references: [],
        usage: { inputTokens: 4000, outputTokens: 50 },
        durationMs: 900,
      };
      expect((await submit({ result: { ...valid, answer: null } })).status).toBe(400);
      // The finding-thread sink takes a Markdown answer, not structured output.
      expect(
        (await submit({ result: { ...valid, answer: null, structured: { rule: null } } })).status,
      ).toBe(400);
      state.replies.length = 0;
      expect((await submit({ result: valid })).status).toBe(200);
      // The agent's replay after a timeout posts nothing new.
      expect((await submit({ result: valid })).status).toBe(200);

      expect(await jobRow(job.id)).toMatchObject({
        status: "completed",
        result: valid,
        scmCommentId: "reply-1",
      });
      expect(state.replies).toHaveLength(1);
      expect(state.replies[0]).toMatchObject({ number: 11, commentId: "777" });
      expect(state.replies[0]!.body).toContain("Yes, nothing reads it after line 1.");
      expect(state.replies[0]!.body).toContain("@octocat");
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
      const { agentId, accessToken } = await newAgent();
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
      const stale = new Date(Date.now() - 60_000);
      await db
        .update(jobs)
        .set({ leaseExpiresAt: stale })
        .where(inArray(jobs.id, [running, canceled, takenOver]));

      const before = Date.now();
      const res = await heartbeat(
        agentRequest("heartbeat", accessToken, {
          body: {
            version: "0.2.0",
            runningJobIds: [running, canceled, takenOver],
            freeSlots: 0,
            local: LOCAL,
            models: [{ value: "opus", displayName: "Opus" }],
          },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HeartbeatResponse;
      expect(body).toMatchObject({
        acceptedTaskTypes: ["query", "review", "coding"],
        pinnedRepositories: [{ id: repositoryId, provider: "github", fullPath: "acme/app" }],
        organizationId: orgId,
      });
      // Its slots and pool limits are its own: none are sent.
      expect(body).not.toHaveProperty("maxConcurrency");
      expect(body).not.toHaveProperty("poolLimits");
      // Legacy fields old agents require: no topics, so they stop polling.
      expect(body.pollIntervalSeconds).toBe(5);
      expect(body.topics).toEqual([]);
      expect(body.queueRegion).toBe("");
      expect(body.cancelJobIds.sort()).toEqual([canceled, takenOver].sort());
      expect(body.jobTokens.map((t) => [t.jobId, t.expiresIn])).toEqual([[running, 900]]);

      const principal = await requireJob(
        new Request("http://localhost/api/agent/credentials", {
          headers: { authorization: `Bearer ${body.jobTokens[0]!.token}`, "x-real-ip": newIp() },
        }),
        "credentials:read",
      );
      expect(principal).toMatchObject({ jobId: running, agentId });

      // Only the job the agent keeps gets its lease renewed.
      const leases = new Map(
        (
          await db
            .select({ id: jobs.id, leaseExpiresAt: jobs.leaseExpiresAt })
            .from(jobs)
            .where(inArray(jobs.id, [running, canceled, takenOver]))
        ).map((j) => [j.id, j.leaseExpiresAt?.getTime() ?? null]),
      );
      expect(leases.get(running)).toBeGreaterThanOrEqual(before + JOB_LEASE_SECONDS * 1000);
      expect(leases.get(takenOver)).toBe(stale.getTime());
      expect(leases.get(canceled)).not.toBeGreaterThan(before);

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent).toMatchObject({
        reportedVersion: "0.2.0",
        reportedModels: [{ value: "opus", displayName: "Opus" }],
      });
      expect(agent!.lastHeartbeatAt).toBeInstanceOf(Date);
      await db.delete(agentRepoPins).where(eq(agentRepoPins.agentId, agentId));
    });

    it("refreshes both tokens of a run-spec job, by kind", async () => {
      const { agentId, accessToken } = await newAgent();
      const legacy = await newJob();
      await startAs(legacy, accessToken);
      const runSpec = await newJob();
      await db
        .update(jobs)
        .set({
          type: "task.run",
          taskType: "query",
          taskId: "builtin:learn-rule",
          payload: RUN_PAYLOAD,
        })
        .where(eq(jobs.id, runSpec));
      await startAs(runSpec, accessToken);

      const res = await heartbeat(
        agentRequest("heartbeat", accessToken, {
          body: { version: "0.2.0", runningJobIds: [legacy, runSpec], freeSlots: 0, local: LOCAL },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HeartbeatResponse;
      const tokens = body.jobTokens.map((t) => [t.jobId, t.kind]);
      expect(tokens).toHaveLength(3);
      expect(tokens).toEqual(
        expect.arrayContaining([
          [legacy, "legacy"],
          [runSpec, "lifecycle"],
          [runSpec, "session"],
        ]),
      );
      for (const token of body.jobTokens) {
        expect(await jobPrincipal(token.token)).toMatchObject({
          jobId: token.jobId,
          agentId,
          kind: token.kind,
        });
      }
      const session = body.jobTokens.find((t) => t.kind === "session")!;
      expect((await jobPrincipal(session.token)).scopes).not.toContain("credentials:write");
    });

    it("sends undelivered messages for the agent's running ralph jobs and applies its acknowledgements", async () => {
      const { agentId, accessToken } = await newAgent({ reportedAcceptedTaskTypes: ["coding"] });
      const [run] = await db
        .insert(ralphRuns)
        .values({
          organizationId: orgId,
          linearIssueId: `issue-${randomUUID()}`,
          linearIdentifier: "ENG-1",
          linearAgentSessionId: `session-${randomUUID()}`,
          kind: "prd",
          repositoryId,
          status: "running",
          agentId,
        })
        .returning();
      const [job] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          type: "ralph.story",
          taskType: "coding",
          status: "running",
          agentId,
          ralphRunId: run!.id,
          deliveryCount: 1,
          startedAt: new Date(),
        })
        .returning();
      const message = await insertMessage(db, {
        runId: run!.id,
        jobId: job!.id,
        kind: "guidance",
        text: "Use a smallint column",
      });
      const beat = async (acks: { deliveredMessageIds?: string[] } = {}) => {
        const res = await heartbeat(
          agentRequest("heartbeat", accessToken, {
            body: {
              version: "0.2.0",
              runningJobIds: [job!.id],
              freeSlots: 0,
              local: LOCAL,
              ...acks,
            },
          }),
        );
        expect(res.status).toBe(200);
        return (await res.json()) as HeartbeatResponse;
      };

      expect((await beat()).jobMessages).toEqual([
        { jobId: job!.id, messageId: message.id, text: "Use a smallint column" },
      ]);
      // Old agents don't acknowledge: the message is sent again.
      expect((await beat()).jobMessages).toHaveLength(1);
      expect((await beat({ deliveredMessageIds: [message.id] })).jobMessages).toEqual([]);
      const [stored] = await listMessages(db, run!.id);
      expect(stored?.deliveredAt).toBeInstanceOf(Date);
      const [updated] = await db.select().from(ralphRuns).where(eq(ralphRuns.id, run!.id));
      expect(updated!.guidance.map((g) => g.text)).toEqual(["Use a smallint column"]);
    });

    it("rejects invalid heartbeats and revoked agents", async () => {
      const { agentId, accessToken } = await newAgent();
      const bad = await heartbeat(agentRequest("heartbeat", accessToken, { body: { version: 1 } }));
      expect(bad.status).toBe(400);
      await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
      const revoked = await heartbeat(
        agentRequest("heartbeat", accessToken, {
          body: { version: "0.2.0", runningJobIds: [], freeSlots: 1, local: LOCAL },
        }),
      );
      expect(revoked.status).toBe(401);
    });
  });

  describe("live agent events", () => {
    const agentEvents = (changes: RecordedChange[], agentId: string) =>
      changes.filter((c) => c.resource === "agent" && c.ids.includes(agentId));
    const HEARTBEAT = { version: "1.0.0", runningJobIds: [], freeSlots: 1, local: LOCAL };
    const beat = (accessToken: string, body: object) =>
      captureChanges(async () => {
        const res = await heartbeat(agentRequest("heartbeat", accessToken, { body }));
        expect(res.status).toBe(200);
      });

    it("a heartbeat publishes the agent when what Fleet shows changed, and nothing otherwise", async () => {
      const { agentId, accessToken } = await newAgent({ name: "live-1" });
      // The first heartbeat announces the agent online: get that out of the way.
      await beat(accessToken, HEARTBEAT);
      const steady = await beat(accessToken, HEARTBEAT);
      expect(agentEvents(steady.changes, agentId)).toEqual([]);

      const changes: [string, object][] = [
        ["version", { ...HEARTBEAT, version: "1.1.0" }],
        [
          "update state",
          {
            ...HEARTBEAT,
            version: "1.1.0",
            update: {
              state: "draining",
              version: "1.2.0",
              previous: "1.1.0",
              startsSincePending: 0,
              error: null,
            },
          },
        ],
        [
          "reported models",
          { ...HEARTBEAT, version: "1.1.0", models: [{ value: "opus", displayName: "Opus" }] },
        ],
        [
          "installables",
          { ...HEARTBEAT, version: "1.1.0", installables: [{ name: "gh", version: "2.0.0" }] },
        ],
        ["accepted kinds", { ...HEARTBEAT, version: "1.1.0", acceptedTaskTypes: ["review"] }],
      ];
      for (const [what, body] of changes) {
        const changed = await beat(accessToken, body);
        expect(agentEvents(changed.changes, agentId), what).toEqual([
          expect.objectContaining({ resource: "agent", ids: [agentId], organizationId: orgId }),
        ]);
        // The same report again changes nothing and publishes nothing.
        const same = await beat(accessToken, body);
        expect(agentEvents(same.changes, agentId), `${what} again`).toEqual([]);
      }
    });

    it("a heartbeat stores the Claude login state and publishes the agent when status or source changes", async () => {
      const { agentId, accessToken } = await newAgent({ name: "live-claude" });
      await beat(accessToken, HEARTBEAT);
      const signedIn = {
        status: "signed_in",
        source: "login",
        checkedAt: "2026-10-28T10:00:00.000Z",
      };
      const stored = async () =>
        (await db.select().from(agents).where(eq(agents.id, agentId)))[0]?.reportedClaude;

      // The account never reaches the control panel, even when an agent sends it.
      const first = await beat(accessToken, {
        ...HEARTBEAT,
        claude: { ...signedIn, email: "steve@example.com", subscriptionType: "max" },
      });
      expect(agentEvents(first.changes, agentId)).toHaveLength(1);
      expect(await stored()).toEqual(signedIn);

      // Checked again with the same result: stored, nothing published.
      const rechecked = { ...signedIn, checkedAt: "2026-10-28T11:00:00.000Z" };
      const same = await beat(accessToken, { ...HEARTBEAT, claude: rechecked });
      expect(agentEvents(same.changes, agentId)).toEqual([]);
      expect(await stored()).toEqual(rechecked);

      for (const claude of [
        { ...rechecked, source: "oauth_token" },
        { ...rechecked, status: "signed_out", source: null },
      ]) {
        const changed = await beat(accessToken, { ...HEARTBEAT, claude });
        expect(agentEvents(changed.changes, agentId), claude.status).toHaveLength(1);
        expect(await stored()).toEqual(claude);
      }
      // An older agent sends none: the last report stays.
      await beat(accessToken, HEARTBEAT);
      expect(await stored()).toMatchObject({ status: "signed_out", source: null });
    });

    it("an attempt's start and finish publish the agent that runs it", async () => {
      const { agentId, accessToken } = await newAgent({ name: "live-2" });
      const completed = await newJob();
      const started = await captureChanges(() => startAs(completed, accessToken));
      expect(agentEvents(started.changes, agentId)).toEqual([
        expect.objectContaining({ resource: "agent", ids: [agentId], organizationId: orgId }),
      ]);
      const finished = await captureChanges(() =>
        result(
          agentRequest(`jobs/${completed}/result`, accessToken, { body: { result: {} } }),
          ctx(completed),
        ),
      );
      expect(finished.result.status).toBe(200);
      expect(agentEvents(finished.changes, agentId)).toHaveLength(1);

      const failed = await newJob();
      await startAs(failed, accessToken);
      const failure = await captureChanges(() =>
        failAs(failed, accessToken, { retryable: false, error: "boom" }),
      );
      expect(failure.result.status).toBe(200);
      expect(agentEvents(failure.changes, agentId)).toHaveLength(1);

      // A rejected report (the job is over) publishes nothing.
      const rejected = await captureChanges(() =>
        result(
          agentRequest(`jobs/${completed}/result`, accessToken, { body: { result: {} } }),
          ctx(completed),
        ),
      );
      expect(rejected.result.status).toBe(409);
      expect(agentEvents(rejected.changes, agentId)).toEqual([]);
    });

    it("a lapsed lease taken over publishes both agents", async () => {
      const first = await newAgent({ name: "live-3" });
      const second = await newAgent({ name: "live-4" });
      const jobId = await newJob();
      await startAs(jobId, first.accessToken);
      const takenOver = await captureChanges(() => startAs(jobId, second.accessToken));
      expect(agentEvents(takenOver.changes, first.agentId)).toHaveLength(1);
      expect(agentEvents(takenOver.changes, second.agentId)).toHaveLength(1);
    });
  });

  describe("organization defaults", () => {
    beforeAll(() => {
      registerJobOutcomeHandler("defaults.run", {
        payload: z.object({}),
        onStarted: async () => ({ skip: false }),
      });
    });

    async function codingJob(organizationId: string) {
      return taskJob(organizationId, "coding");
    }

    async function taskJob(organizationId: string, taskType: Tasks.TaskType) {
      const { job } = await dispatcher().createAndPublish({
        organizationId,
        type: "defaults.run",
        taskType,
        payload: {},
        dedupeKey: randomUUID(),
      });
      return job.id;
    }

    async function heartbeatAs(accessToken: string, report: object = {}) {
      const res = await heartbeat(
        agentRequest("heartbeat", accessToken, {
          body: { version: "0.2.0", runningJobIds: [], freeSlots: 1, local: LOCAL, ...report },
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as HeartbeatResponse;
    }

    function claimLong(accessToken: string, request: object = {}) {
      return claim(
        agentRequest("claim", accessToken, {
          body: { pools: ["long"], waitSeconds: 0, ...request },
        }),
      );
    }

    it("has an enrolled agent claim coding jobs and run 5 at once with no organization settings", async () => {
      const organizationId = await newOrg();
      const enrollment = await createAgentEnrollment(db, { organizationId });
      const { agentId } = (await enrollAgent(db, {
        enrollmentToken: enrollment.token,
        name: "host",
        version: "0.2.0",
      }))!;
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(row).toMatchObject({
        reportedMaxConcurrency: null,
        reportedAcceptedTaskTypes: null,
        reportedPoolLimits: null,
      });
      const accessToken = await getTokenSigner().signAccessToken(agentId);

      const jobId = await codingJob(organizationId);
      const res = await claimLong(accessToken);
      expect(res.status).toBe(200);
      expect(((await res.json()) as JobStartResponse & { action: "run" }).job.id).toBe(jobId);

      expect(await heartbeatAs(accessToken)).toMatchObject({
        acceptedTaskTypes: ["query", "review", "coding"],
      });
      // Its default slots, as it reports them.
      const [reported] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(reported).toMatchObject({
        reportedMaxConcurrency: 5,
        reportedPoolLimits: { short: 5, long: 4 },
      });
    });

    it("has an inheriting agent claim query, review and coding jobs with no organization settings", async () => {
      const organizationId = await newOrg();
      const { accessToken } = await newAgent({ organizationId });
      for (const [taskType, pool] of [
        ["query", "short"],
        ["review", "short"],
        ["coding", "long"],
      ] as const) {
        const jobId = await taskJob(organizationId, taskType);
        const res = await claim(
          agentRequest("claim", accessToken, { body: { pools: [pool], waitSeconds: 0 } }),
        );
        expect(res.status).toBe(200);
        // The pool is derived from the task type, so the agent counts the right slots.
        const { job } = (await res.json()) as JobStartResponse & { action: "run" };
        expect(job).toMatchObject({ id: jobId, taskType, pool });
      }
    });

    it("claims by the task types an older agent last reported when its claim carries none", async () => {
      const organizationId = await newOrg();
      const own = await newAgent({
        organizationId,
        reportedAcceptedTaskTypes: ["query", "review"],
      });
      const jobId = await codingJob(organizationId);
      expect((await claimLong(own.accessToken)).status).toBe(204);
      expect((await jobRow(jobId)).status).toBe("queued");
    });

    it("claims by the claim request's task types: an agent reporting review can't claim coding", async () => {
      const organizationId = await newOrg();
      const agent = await newAgent({ organizationId });
      // Its heartbeat reports review only: stored, and no task types come back.
      const response = await heartbeatAs(agent.accessToken, { acceptedTaskTypes: ["review"] });
      expect(response.acceptedTaskTypes).toBeUndefined();
      const [row] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
      expect(row!.reportedAcceptedTaskTypes).toEqual(["review"]);

      const jobId = await codingJob(organizationId);
      // Nor does the heartbeat say a claim for the long pool would find a job.
      expect(
        await heartbeatAs(agent.accessToken, {
          acceptedTaskTypes: ["review"],
          claimablePools: ["long"],
        }),
      ).toMatchObject({ claimable: false });
      expect(
        await heartbeatAs(agent.accessToken, {
          acceptedTaskTypes: ["review", "coding"],
          claimablePools: ["long"],
        }),
      ).toMatchObject({ claimable: true });
      // The claim's own types count, not the stored ones (now review and coding).
      expect((await claimLong(agent.accessToken, { acceptedTaskTypes: ["review"] })).status).toBe(
        204,
      );
      expect((await jobRow(jobId)).status).toBe("queued");
      expect(
        (await claimLong(agent.accessToken, { acceptedTaskTypes: ["review", "coding"] })).status,
      ).toBe(200);
      expect((await jobRow(jobId)).status).toBe("running");
      // A bad list is refused.
      expect((await claimLong(agent.accessToken, { acceptedTaskTypes: [] })).status).toBe(400);
    });

    it("stores the slots, pool limits, pin and allow-list each agent reports", async () => {
      const organizationId = await newOrg();
      const small = await newAgent({ organizationId });
      const large = await newAgent({ organizationId });
      await heartbeatAs(small.accessToken, {
        local: { ...LOCAL, maxConcurrency: 2, poolLimits: { short: 2, long: 1 } },
      });
      await heartbeatAs(large.accessToken, {
        local: {
          maxConcurrency: 12,
          poolLimits: { short: 12, long: 3 },
          versionPin: "2.0.3",
          installablesAllow: [],
        },
      });
      const reported = async (agentId: string) => {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return {
          maxConcurrency: row!.reportedMaxConcurrency,
          poolLimits: row!.reportedPoolLimits,
          versionPin: row!.reportedVersionPin,
          installablesAllow: row!.reportedInstallablesAllow,
        };
      };
      expect(await reported(small.agentId)).toEqual({
        ...LOCAL,
        maxConcurrency: 2,
        poolLimits: { short: 2, long: 1 },
      });
      expect(await reported(large.agentId)).toEqual({
        maxConcurrency: 12,
        poolLimits: { short: 12, long: 3 },
        versionPin: "2.0.3",
        installablesAllow: [],
      });
    });

    it("refuses a heartbeat without the agent's local settings", async () => {
      const { accessToken } = await newAgent({ organizationId: await newOrg() });
      const res = await heartbeat(
        agentRequest("heartbeat", accessToken, {
          body: { version: "0.2.0", runningJobIds: [], freeSlots: 1 },
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("organization isolation", () => {
    let otherOrgId: string;
    let otherRepositoryId: string;

    beforeAll(async () => {
      const [org] = await db.insert(organizations).values({ name: "Globex" }).returning();
      otherOrgId = org!.id;
      const [connection] = await db
        .insert(scmConnections)
        .values({
          organizationId: otherOrgId,
          provider: "github",
          name: "globex",
          baseUrl: "https://api.github.com",
          externalId: "2",
          encryptedCredentials: "unused",
        })
        .returning();
      const [repo] = await db
        .insert(repositories)
        .values({
          organizationId: otherOrgId,
          provider: "github",
          externalId: "200",
          fullPath: "globex/app",
          connectionId: connection!.id,
        })
        .returning();
      otherRepositoryId = repo!.id;
    });

    async function otherAgent(values: Partial<typeof agents.$inferInsert> = {}) {
      return newAgent({ organizationId: otherOrgId, name: "globex-1", ...values });
    }

    /** A job of the other organization, published by the dispatcher. */
    async function otherJob(input: { repositoryId?: string } = {}) {
      const { job } = await dispatcher().createAndPublish({
        organizationId: otherOrgId,
        type: "review.run",
        taskType: "review",
        repositoryId: input.repositoryId ?? null,
        dedupeKey: randomUUID(),
      });
      return job.id;
    }

    it("inserts each job for its own organization, never another's", async () => {
      const ours = await newJob({ repositoryId });
      const theirs = await otherJob({ repositoryId: otherRepositoryId });
      expect(await jobRow(ours)).toMatchObject({ organizationId: orgId, targetAgentId: null });
      expect(await jobRow(theirs)).toMatchObject({
        organizationId: otherOrgId,
        targetAgentId: null,
      });
    });

    it("never targets a job at a pinned or targeted agent of another organization", async () => {
      // A pin can't be created across organizations; even if one existed it's ignored.
      const foreign = await otherAgent();
      await db.insert(agentRepoPins).values({ agentId: foreign.agentId, repositoryId });
      try {
        const jobId = await newJob({ repositoryId });
        expect((await jobRow(jobId)).targetAgentId).toBeNull();
        expect(await dispatcher().republish(jobId)).toBe(true);
        expect((await jobRow(jobId)).targetAgentId).toBeNull();
      } finally {
        await db.delete(agentRepoPins).where(eq(agentRepoPins.agentId, foreign.agentId));
      }

      const dedupeKey = randomUUID();
      await expect(
        dispatcher().createAndPublish({
          organizationId: orgId,
          type: "repo.sync",
          taskType: "system",
          repositoryId,
          targetAgentId: foreign.agentId,
          dedupeKey,
        }),
      ).rejects.toThrow(/organization/);
      expect(await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey))).toHaveLength(0);
      expect(
        await db.select().from(jobs).where(eq(jobs.targetAgentId, foreign.agentId)),
      ).toHaveLength(0);
    });

    it("gives agents their own organization", async () => {
      const ours = await newAgent();
      const theirs = await otherAgent();
      const beat = async (accessToken: string) => {
        const res = await heartbeat(
          agentRequest("heartbeat", accessToken, {
            body: { version: "0.2.0", runningJobIds: [], freeSlots: 1, local: LOCAL },
          }),
        );
        return (await res.json()) as HeartbeatResponse;
      };
      const ourConfig = await beat(ours.accessToken);
      expect(ourConfig.organizationId).toBe(orgId);
      const theirConfig = await beat(theirs.accessToken);
      expect(theirConfig.organizationId).toBe(otherOrgId);
    });

    it("never starts, completes or fails another organization's job", async () => {
      // An organization with no jobs of its own: the claim finds nothing.
      const foreign = await newAgent({ organizationId: await newOrg() });
      const jobId = await newJob();

      expect(await startAs(jobId, foreign.accessToken)).toBeNull();
      expect(await jobRow(jobId)).toMatchObject({
        status: "queued",
        agentId: null,
        deliveryCount: 0,
      });

      // Even a job (wrongly) marked running on the foreign agent can't be reported on.
      await db
        .update(jobs)
        .set({ status: "running", agentId: foreign.agentId, deliveryCount: 1 })
        .where(eq(jobs.id, jobId));
      const res = await result(
        agentRequest(`jobs/${jobId}/result`, foreign.accessToken, { body: { result: {} } }),
        ctx(jobId),
      );
      expect(res.status).toBe(404);
      expect((await failAs(jobId, foreign.accessToken, { retryable: false })).status).toBe(404);
      expect(await jobRow(jobId)).toMatchObject({ status: "running", result: null });
    });

    it("refuses credentials and job routes for a job of another organization", async () => {
      const foreign = await otherAgent({
        reportedAcceptedTaskTypes: ["query", "review", "coding"],
      });
      const jobId = await newJob({ repositoryId });
      await db
        .update(jobs)
        .set({
          status: "running",
          agentId: foreign.agentId,
          deliveryCount: 1,
        })
        .where(eq(jobs.id, jobId));
      const token = await getTokenSigner().signJobToken({
        jobId,
        agentId: foreign.agentId,
        scopes: ["credentials:read", "credentials:write", "run:activity", "run:attachments"],
      });
      const jobRequest = (path: string, method = "POST", body?: unknown) =>
        new Request(`http://localhost/api/agent/${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-real-ip": newIp(),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      expect((await credentials(jobRequest("credentials"))).status).toBe(401);
      expect(
        (
          await activities(
            jobRequest(`jobs/${jobId}/activities`, "POST", { type: "thought", body: "hi" }),
            ctx(jobId),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await attachment(jobRequest(`jobs/${jobId}/attachments/a-1`, "GET"), {
            params: Promise.resolve({ id: jobId, attachmentId: "a-1" }),
          })
        ).status,
      ).toBe(401);
      const audit = await listAgentAudit(db, {
        agentId: foreign.agentId,
        event: "credential_issued",
      });
      expect(audit).toEqual([]);
    });

    it("expires stale queued jobs of every organization", async () => {
      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const [ours, theirs] = await db
        .insert(jobs)
        .values([
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            createdAt: dayAgo,
          },
          {
            organizationId: otherOrgId,
            type: "review.run",
            taskType: "review",
            createdAt: dayAgo,
          },
        ])
        .returning({ id: jobs.id });
      const res = await expireJobs(
        new Request("http://localhost/api/cron/expire-jobs", {
          headers: { authorization: "Bearer cron-secret" },
        }),
      );
      expect(res.status).toBe(200);
      expect(await jobRow(ours!.id)).toMatchObject({ status: "expired", organizationId: orgId });
      expect(await jobRow(theirs!.id)).toMatchObject({
        status: "expired",
        organizationId: otherOrgId,
      });
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
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            createdAt: dayAgo,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "running",
            createdAt: dayAgo,
          },
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
