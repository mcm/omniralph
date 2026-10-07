import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  agentRefreshTokens,
  agentRepoPins,
  agents,
  connectRepository,
  closeDb,
  createDb,
  getAgentOverview,
  jobs,
  listAgentAudit,
  listRecentAgentAudit,
  runMigrations,
  setDesiredAgentVersion,
  upsertScmConnection,
  users,
  writeAgentAudit,
  type Database,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import type { HeartbeatResponse } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000", "x-real-ip": "192.0.2.1" }),
}));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  sends: [] as { topic: string; payload: unknown; options: unknown }[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  // The signed-in user works in `state.orgId`.
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    async send(topic: string, payload: unknown, options: unknown) {
      state.sends.push({ topic, payload, options });
      return { messageId: `msg-${state.sends.length}` };
    }
  },
}));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.QUEUE_REGIONS = "iad1";
process.env.APP_URL = "https://omniralph.example.com/";

const {
  createEnrollment,
  pinRepository,
  revokeAgent,
  setAgentDesiredVersion,
  unpinRepository,
  updateAgentConfig,
} = await import("./actions");
const { agentRow } = await import("@/lib/agents/rows");
const { cancelJob } = await import("../jobs/actions");
const { POST: enroll } = await import("@/app/api/agent/enroll/route");
const { POST: token } = await import("@/app/api/agent/token/route");
const { POST: heartbeat } = await import("@/app/api/agent/heartbeat/route");
const { requireJob } = await import("@/lib/agent-auth/verify");
const { getTokenSigner } = await import("@/lib/agent-auth/signer");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

function post(path: string, body: unknown, accessToken?: string): Request {
  return new Request(`http://localhost/api/agent/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": newIp(),
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify(body),
  });
}

const HEARTBEAT = { version: "0.2.0", capabilities: ["review"], runningJobIds: [], freeSlots: 1 };

describe.skipIf(!dockerAvailable)("agents and jobs pages: server actions", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;
  const adminId = "admin-1";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
    state.orgId = orgId;
    state.db = db;
    await db.insert(users).values([
      { id: adminId, email: "admin@example.com" },
      { id: "member-1", email: "member@example.com" },
    ]);
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    repoA = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "101",
        fullPath: "acme/api",
      })
    ).id;
    repoB = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "102",
        fullPath: "acme/web",
      })
    ).id;
  }, 180_000);

  beforeEach(() => {
    state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
    state.sends.length = 0;
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (db) await closeDb(db);
    await container?.stop();
  });

  async function newEnrollment(name = "") {
    const result = await createEnrollment(name);
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  function redeem(enrollmentToken: string) {
    return enroll(
      post("enroll", {
        enrollmentToken,
        name: "coder-host",
        version: "0.1.0",
        capabilities: ["review"],
      }),
    );
  }

  /** Enrolls through the UI flow and exchanges the refresh token for an access token. */
  async function enrolledAgent(name = "") {
    const { token: enrollmentToken } = await newEnrollment(name);
    const enrolled = (await (await redeem(enrollmentToken)).json()) as {
      agentId: string;
      refreshToken: string;
    };
    const tokens = (await (
      await token(post("token", { refreshToken: enrolled.refreshToken }))
    ).json()) as {
      accessToken: string;
      refreshToken: string;
    };
    return { agentId: enrolled.agentId, ...tokens };
  }

  async function sendHeartbeat(accessToken: string, body: object = HEARTBEAT) {
    return heartbeat(post("heartbeat", body, accessToken));
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    return row!;
  }

  describe("enrollment", () => {
    it("shows a one-time token and the exact enroll command", async () => {
      const result = await newEnrollment("Build box");
      expect(result.token).toMatch(/^ore_[\w-]{43}$/);
      expect(result.command).toBe(
        `omniralph-agent enroll --server https://omniralph.example.com --token ${result.token}`,
      );
      const expiresIn = new Date(result.expiresAt).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(59 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(60 * 60_000);

      const res = await redeem(result.token);
      expect(res.status).toBe(200);
      const { agentId } = (await res.json()) as { agentId: string };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.name).toBe("Build box");
      expect(agent!.enrolledBy).toBe(adminId);
    });

    it("accepts the token only once", async () => {
      const { token: enrollmentToken } = await newEnrollment();
      expect((await redeem(enrollmentToken)).status).toBe(200);
      expect((await redeem(enrollmentToken)).status).toBe(401);
    });

    it("rejects the token after 1 hour", async () => {
      const { token: enrollmentToken } = await newEnrollment();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60 * 60_000 + 1000 });
      expect((await redeem(enrollmentToken)).status).toBe(401);
      vi.useRealTimers();
    });

    it("is admin-only", async () => {
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await createEnrollment("x")).toEqual({ ok: false, error: expect.any(String) });
    });
  });

  describe("central configuration", () => {
    it("reaches the agent in its next heartbeat response", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const before = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(before).toMatchObject({
        maxConcurrency: 1,
        pollIntervalSeconds: 5,
        enabledCapabilities: ["review"],
        pinnedRepoIds: [],
      });

      expect(
        await updateAgentConfig(agentId, {
          maxConcurrency: 4,
          pollIntervalSeconds: 30,
          enabledCapabilities: [],
        }),
      ).toEqual({ ok: true });
      expect(await pinRepository(agentId, repoA)).toEqual({ ok: true });

      const after = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(after).toMatchObject({
        maxConcurrency: 4,
        pollIntervalSeconds: 30,
        enabledCapabilities: [],
        pinnedRepoIds: [repoA],
        topics: [`system-jobs-agent-${agentId}`],
      });

      expect(await unpinRepository(agentId, repoA)).toEqual({ ok: true });
      const unpinned = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(unpinned.pinnedRepoIds).toEqual([]);
    });

    it("enabling ralph lets the agent read the ralph topics", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const before = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(before.topics).not.toContain(`ralph-jobs-org-${orgId}`);
      expect(before.topics).not.toContain(`ralph-jobs-agent-${agentId}`);

      expect(
        await updateAgentConfig(agentId, {
          maxConcurrency: 1,
          pollIntervalSeconds: 5,
          enabledCapabilities: ["review", "ralph"],
        }),
      ).toEqual({ ok: true });
      const after = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(after.enabledCapabilities).toEqual(["review", "ralph"]);
      expect(after.topics).toEqual([
        `review-jobs-agent-${agentId}`,
        `ralph-jobs-agent-${agentId}`,
        `review-jobs-org-${orgId}`,
        `ralph-jobs-org-${orgId}`,
        `system-jobs-agent-${agentId}`,
      ]);
    });

    it("sends the effective per-capability limits and stores the edited ones", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const initial = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(initial.capabilityLimits).toEqual({ review: 1 });

      // Unset: ralph leaves one slot for reviews.
      const config = {
        maxConcurrency: 3,
        pollIntervalSeconds: 5,
        enabledCapabilities: ["review", "ralph"],
      };
      expect(await updateAgentConfig(agentId, config)).toEqual({ ok: true });
      const defaults = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(defaults.capabilityLimits).toEqual({ review: 3, ralph: 2 });

      expect(
        await updateAgentConfig(agentId, { ...config, capabilityLimits: { ralph: 1, review: 3 } }),
      ).toEqual({ ok: true });
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(row!.capabilityLimits).toEqual({ ralph: 1, review: 3 });
      const limited = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(limited.capabilityLimits).toEqual({ review: 3, ralph: 1 });

      // Saving without limits keeps them; lowering maxConcurrency clamps the effective values.
      expect(
        await updateAgentConfig(agentId, {
          ...config,
          maxConcurrency: 2,
          capabilityLimits: undefined,
        }),
      ).toEqual({ ok: true });
      const clamped = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(clamped.capabilityLimits).toEqual({ review: 2, ralph: 1 });

      // Disabled capabilities aren't sent.
      expect(
        await updateAgentConfig(agentId, {
          ...config,
          enabledCapabilities: ["review"],
          capabilityLimits: {},
        }),
      ).toEqual({ ok: true });
      const reviewOnly = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(reviewOnly.capabilityLimits).toEqual({ review: 3 });
    });

    it("sends the desired version (override, else the organization's) and stores the reported update state", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const other = await enrolledAgent();
      const desired = async (token: string) =>
        ((await (await sendHeartbeat(token)).json()) as HeartbeatResponse).desiredVersion;
      expect(await desired(accessToken)).toBeNull();

      await setDesiredAgentVersion(db, orgId, "1.4.0", adminId);
      // Another organization's version doesn't reach this organization's agents.
      const [otherOrg] = await db.insert(organizations).values({ name: "Other" }).returning();
      await setDesiredAgentVersion(db, otherOrg!.id, "9.0.0", null);
      expect(await desired(accessToken)).toBe("1.4.0");
      expect(await setAgentDesiredVersion(agentId, "v1.5.0")).toEqual({ ok: true });
      expect(await setAgentDesiredVersion(agentId, "latest")).toEqual({
        ok: false,
        error: expect.any(String),
      });
      expect(await desired(accessToken)).toBe("1.5.0");
      expect(await desired(other.accessToken)).toBe("1.4.0");

      // The agent reports where it is; the Agents pages show it.
      const update = {
        state: "draining",
        version: "1.5.0",
        previous: "0.2.0",
        startsSincePending: 0,
        error: null,
      };
      await sendHeartbeat(accessToken, {
        ...HEARTBEAT,
        selfUpdate: "supported",
        update,
        failedVersions: ["1.3.0"],
      });
      const overview = (await getAgentOverview(db, orgId, agentId))!;
      expect(overview).toMatchObject({
        selfUpdate: "supported",
        updateState: update,
        failedVersions: ["1.3.0"],
      });
      expect(agentRow(overview, new Date(), "1.4.0")).toMatchObject({
        version: "0.2.0",
        desiredVersion: "1.5.0",
        desiredVersionOverride: "1.5.0",
        updateStatus: "updating",
        failedVersions: ["1.3.0"],
      });

      // Cleared override: the global version again. Older agents report nothing.
      expect(await setAgentDesiredVersion(agentId, "")).toEqual({ ok: true });
      expect(await desired(accessToken)).toBe("1.4.0");
      const legacy = (await getAgentOverview(db, orgId, agentId))!;
      expect(legacy).toMatchObject({ selfUpdate: null, updateState: null, failedVersions: [] });
      expect(agentRow(legacy, new Date(), "1.4.0").updateStatus).toBe("manual");

      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await setAgentDesiredVersion(agentId, "1.6.0")).toEqual({
        ok: false,
        error: expect.any(String),
      });
      await setDesiredAgentVersion(db, orgId, null, adminId);
    });

    it("pinning enqueues a repo.sync job on the agent's topic", async () => {
      const { agentId } = await enrolledAgent();
      expect(await pinRepository(agentId, repoB)).toEqual({ ok: true });
      expect(state.sends).toHaveLength(1);
      expect(state.sends[0]!.topic).toBe(`system-jobs-agent-${agentId}`);
      const { jobId } = state.sends[0]!.payload as { jobId: string };
      expect(await jobRow(jobId)).toMatchObject({
        capability: "system",
        type: "repo.sync",
        status: "queued",
        repositoryId: repoB,
        topic: `system-jobs-agent-${agentId}`,
      });
    });

    it("rejects invalid values, unknown capabilities and non-admins", async () => {
      const { agentId } = await enrolledAgent();
      const valid = { maxConcurrency: 2, pollIntervalSeconds: 10, enabledCapabilities: ["review"] };
      const invalid: Parameters<typeof updateAgentConfig>[1][] = [
        { ...valid, maxConcurrency: 0 },
        { ...valid, maxConcurrency: 1.5 },
        { ...valid, pollIntervalSeconds: 301 },
        { ...valid, enabledCapabilities: ["deploy"] },
        { ...valid, capabilityLimits: { review: 0 } },
        { ...valid, capabilityLimits: { review: 3 } },
        { ...valid, capabilityLimits: { review: 1.5 } },
        { ...valid, capabilityLimits: { ralph: 1 } },
        { ...valid, capabilityLimits: { deploy: 1 } },
      ];
      for (const input of invalid) {
        expect(await updateAgentConfig(agentId, input)).toMatchObject({ ok: false });
      }
      expect(await updateAgentConfig(randomUUID(), valid)).toMatchObject({ ok: false });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await updateAgentConfig(agentId, valid)).toMatchObject({ ok: false });
      expect(await pinRepository(agentId, repoA)).toMatchObject({ ok: false });
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.maxConcurrency).toBe(1);
    });
  });

  describe("revoke", () => {
    it("rejects unexpired tokens, requeues running jobs and removes pins", async () => {
      const { agentId, accessToken, refreshToken } = await enrolledAgent();
      await pinRepository(agentId, repoA);
      state.sends.length = 0;
      expect((await sendHeartbeat(accessToken)).status).toBe(200);

      const [running, lastDelivery, canceling, queuedOnOwnTopic, syncOnOwnTopic] = await db
        .insert(jobs)
        .values([
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            status: "running",
            agentId,
            deliveryCount: 1,
            topic: `review-jobs-org-${orgId}`,
          },
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            status: "running",
            agentId,
            deliveryCount: 3,
            topic: `review-jobs-org-${orgId}`,
          },
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            status: "running",
            agentId,
            deliveryCount: 1,
            cancelRequested: true,
          },
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            status: "queued",
            repositoryId: repoA,
            topic: `review-jobs-agent-${agentId}`,
          },
          {
            organizationId: orgId,
            capability: "system",
            type: "repo.sync",
            status: "queued",
            repositoryId: repoA,
            topic: `system-jobs-agent-${agentId}`,
          },
        ])
        .returning();
      const jobToken = await getTokenSigner().signJobToken({
        jobId: running!.id,
        agentId,
        scopes: ["credentials:read"],
      });

      expect(await revokeAgent(agentId)).toEqual({ ok: true });

      // Its unexpired access token, job token and refresh token are rejected right away.
      expect((await sendHeartbeat(accessToken)).status).toBe(401);
      const jobAuth = await requireJob(
        new Request("http://localhost/api/agent/credentials", {
          method: "POST",
          headers: { authorization: `Bearer ${jobToken}`, "x-real-ip": newIp() },
        }),
        "credentials:read",
      );
      expect((jobAuth as Response).status).toBe(401);
      expect((await token(post("token", { refreshToken }))).status).toBe(401);
      const tokens = await db
        .select()
        .from(agentRefreshTokens)
        .where(eq(agentRefreshTokens.agentId, agentId));
      expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).not.toBeNull();

      // Running jobs fail as retryable: back to queued for another agent to pick up.
      expect(await jobRow(running!.id)).toMatchObject({
        status: "queued",
        agentId: null,
        error: "Agent revoked",
      });
      expect(await jobRow(lastDelivery!.id)).toMatchObject({ status: "failed" });
      expect(await jobRow(canceling!.id)).toMatchObject({ status: "canceled" });

      // Jobs only it could read are re-published (to the shared topic now) or skipped.
      expect(await jobRow(queuedOnOwnTopic!.id)).toMatchObject({
        status: "queued",
        topic: `review-jobs-org-${orgId}`,
      });
      expect(state.sends).toEqual([
        {
          topic: `review-jobs-org-${orgId}`,
          payload: { jobId: queuedOnOwnTopic!.id },
          options: expect.objectContaining({ idempotencyKey: queuedOnOwnTopic!.id }),
        },
      ]);
      expect(await jobRow(syncOnOwnTopic!.id)).toMatchObject({ status: "skipped" });

      // Pins removed; audited.
      expect(
        await db.select().from(agentRepoPins).where(eq(agentRepoPins.agentId, agentId)),
      ).toEqual([]);
      const [audit] = await listAgentAudit(db, { agentId, event: "revoke" });
      expect(audit!.detail).toMatchObject({
        revokedBy: adminId,
        requeuedJobIds: [running!.id],
        failedJobIds: [lastDelivery!.id],
        unpinnedRepositoryIds: [repoA],
      });
      expect(audit!.ip).toBe("192.0.2.1");

      // A revoked agent can't be configured or pinned.
      expect(
        await updateAgentConfig(agentId, {
          maxConcurrency: 2,
          pollIntervalSeconds: 5,
          enabledCapabilities: [],
        }),
      ).toMatchObject({ ok: false });
      expect(await pinRepository(agentId, repoB)).toMatchObject({ ok: false });
    });

    it("is admin-only and reports unknown agents", async () => {
      const { agentId } = await enrolledAgent();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await revokeAgent(agentId)).toMatchObject({ ok: false });
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).toBeNull();
      state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
      expect(await revokeAgent(randomUUID())).toMatchObject({ ok: false });
    });
  });

  describe("audit log", () => {
    it("lists the 50 most recent events, newest first", async () => {
      const { agentId } = await enrolledAgent();
      for (let i = 0; i < 60; i++) {
        await writeAgentAudit(db, { agentId, event: "credential_issued", detail: { i } });
      }
      await writeAgentAudit(db, { agentId, event: "refresh_reuse" });
      const recent = await listRecentAgentAudit(db, agentId, 50);
      expect(recent).toHaveLength(50);
      expect(recent[0]!.event).toBe("refresh_reuse");
      expect(recent[1]!.detail).toEqual({ i: 59 });
      expect(recent.every((e) => e.agentId === agentId)).toBe(true);
    });
  });

  describe("cancel job", () => {
    it("cancels queued jobs at once and running ones via the next heartbeat", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const [queued, running, done] = await db
        .insert(jobs)
        .values([
          { organizationId: orgId, capability: "review", type: "review.run", status: "queued" },
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            status: "running",
            agentId,
          },
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            status: "completed",
            agentId,
          },
        ])
        .returning();

      expect(await cancelJob(queued!.id)).toEqual({ ok: true });
      expect(await jobRow(queued!.id)).toMatchObject({ status: "canceled" });

      expect(await cancelJob(running!.id)).toMatchObject({ ok: true, warning: expect.any(String) });
      const res = (await (
        await sendHeartbeat(accessToken, { ...HEARTBEAT, runningJobIds: [running!.id] })
      ).json()) as HeartbeatResponse;
      expect(res.cancelJobIds).toEqual([running!.id]);

      expect(await cancelJob(done!.id)).toMatchObject({ ok: false });
      expect(await cancelJob(randomUUID())).toMatchObject({ ok: false });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      const [another] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          capability: "review",
          type: "review.run",
          status: "queued",
        })
        .returning();
      expect(await cancelJob(another!.id)).toMatchObject({ ok: false });
      expect(await jobRow(another!.id)).toMatchObject({ status: "queued" });
    });
  });
});
