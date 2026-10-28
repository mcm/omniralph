import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  agentRefreshTokens,
  agentRepoPins,
  agents,
  connectRepository,
  claimJob,
  insertPlaybook,
  closeDb,
  createDb,
  captureChanges,
  getAgentOverview,
  jobs,
  listAgentAudit,
  listAgentOverview,
  listRecentAgentAudit,
  setDesiredAgentVersion,
  unpinRepositoryFromAgent,
  upsertScmConnection,
  users,
  writeAgentAudit,
  type Database,
  organizations,
  playbooks,
  type RecordedChange,
} from "@omniralph/db";
import type { HeartbeatResponse } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail, AgentList } from "@/lib/api/agents";
import { assertRole, type Role } from "@/lib/auth/roles";

/** A heartbeat's `local`: the agent's machine settings, all defaults. */
const LOCAL = {
  maxConcurrency: 5,
  poolLimits: { short: 5, long: 4 },
  versionPin: null,
  installablesAllow: ["@omniralph/*"],
};

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000", "x-real-ip": "192.0.2.1" }),
}));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  latest: "2.0.0",
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
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => state.latest,
}));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const agentDetail = await import("@/app/api/ui/agents/[id]/route");
const agentUpdate = await import("@/app/api/ui/agents/[id]/update/route");
const agentRevoke = await import("@/app/api/ui/agents/[id]/revoke/route");
const agentInstalls = await import("@/app/api/ui/agents/[id]/installs/route");
const pins = await import("@/lib/agents/pins");
const { bumpAgentHeartbeat } = await import("@/lib/agents/heartbeat-cache");
const { agentRow } = await import("@/lib/agents/rows");
const { enqueueInstall } = await import("@/lib/agents/installables");
const { PostgresDispatcher } = await import("@/lib/dispatch");
const jobCancel = await import("@/app/api/ui/jobs/[id]/cancel/route");
const jobRerun = await import("@/app/api/ui/jobs/[id]/rerun/route");
const { isRerunnable } = await import("@/lib/jobs/rerun-kind");
const { POST: enroll } = await import("@/app/api/agent/enroll/route");
const { POST: postEnrollment } = await import("@/app/api/ui/agent-enrollments/route");
const { POST: token } = await import("@/app/api/agent/token/route");
const { POST: heartbeat } = await import("@/app/api/agent/heartbeat/route");
const { requireJob } = await import("@/lib/agent-auth/verify");
const { getTokenSigner } = await import("@/lib/agent-auth/signer");

const databaseAvailable = testDatabaseAvailable();

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

/** `POST /api/ui/agent-enrollments`, as the Enroll agent dialog sends it. */
async function createEnrollment(name: string) {
  const response = await postEnrollment(
    new Request("http://localhost/api/ui/agent-enrollments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: await response.json() };
}

/**
 * Calls an agent page's `/api/ui` handler as the panel does; answers its JSON as an
 * `ActionResult` (`{ ok: false, error }` for a non-2xx), without the `savedAt` and `jobId`
 * the pages track.
 */
async function ui(
  handler: (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: string,
  {
    method = "POST",
    body,
    path = "/api/ui",
  }: { method?: string; body?: unknown; path?: string } = {},
) {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "x-real-ip": "192.0.2.1",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) return { ok: false as const, error: json.error as string };
  const { savedAt: _savedAt, jobId: _jobId, ...result } = json;
  return result as { ok: true; version?: string };
}

/**
 * An agent's desired-version override, set in the database: no route sets it any more (the
 * version pin is the agent's own), and the column goes with the old Settings tab.
 */
async function setAgentDesiredVersion(id: string, version: string | null) {
  await state.db!.update(agents).set({ desiredVersion: version }).where(eq(agents.id, id));
  await bumpAgentHeartbeat(id);
}
// Pins are edited from the repository's settings; these call the same pin logic directly.
async function pinRepository(agentId: string, repositoryId: string) {
  const dispatcher = new PostgresDispatcher({ db: state.db! });
  const { result } = await pins.pinRepository(state.db!, dispatcher, { agentId, repositoryId });
  return result === "pinned" || result === "already_pinned"
    ? { ok: true as const }
    : { ok: false as const, error: result };
}
async function unpinRepository(agentId: string, repositoryId: string) {
  if (!(await unpinRepositoryFromAgent(state.db!, { agentId, repositoryId }))) {
    return { ok: false as const };
  }
  await bumpAgentHeartbeat(agentId);
  return { ok: true as const };
}
const requestAgentUpdate = (id: string) => ui(agentUpdate.POST, id);
const revokeAgent = (id: string) => ui(agentRevoke.POST, id);
const cancelJob = (id: string) => ui(jobCancel.POST, id);
const rerunJob = (id: string) => ui(jobRerun.POST, id);
const deleteAgent = (id: string) => ui(agentDetail.DELETE, id, { method: "DELETE" });
const installInstallable = (id: string, body: { name: string; version?: string }) =>
  ui(agentInstalls.POST, id, { body });
const agentList = await import("@/app/api/ui/agents/route");
async function listAgents() {
  const response = await agentList.GET(new Request("http://localhost/api/ui/agents"), {
    params: Promise.resolve({}),
  });
  return ((await response.json()) as AgentList).agents;
}
async function getAgent(id: string) {
  const response = await agentDetail.GET(new Request(`http://localhost/api/ui/agents/${id}`), {
    params: Promise.resolve({ id }),
  });
  return ((await response.json()) as AgentDetail).agent;
}
async function getAgentDetail(id: string) {
  const response = await agentDetail.GET(new Request(`http://localhost/api/ui/agents/${id}`), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: (await response.json()) as AgentDetail };
}
const HEARTBEAT = { version: "0.2.0", runningJobIds: [], freeSlots: 1, local: LOCAL };

describe.skipIf(!databaseAvailable)("agents and jobs pages: server actions", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;
  const adminId = "admin-1";

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
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
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function newEnrollment(name = "") {
    const { status, body } = await createEnrollment(name);
    if (status !== 200) throw new Error(body.error);
    return body as { id: string; token: string; expiresAt: string; command: string };
  }

  function redeem(enrollmentToken: string) {
    return enroll(
      post("enroll", {
        enrollmentToken,
        name: "coder-host",
        version: "0.1.0",
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
      expect(await createEnrollment("x")).toMatchObject({
        status: 403,
        body: { error: expect.any(String) },
      });
    });
  });

  describe("central configuration", () => {
    it("reaches the agent in its next heartbeat response", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const before = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      // An older agent, which reports no task types, is sent every type. No slots: they're
      // its own.
      expect(before).toMatchObject({
        pollIntervalSeconds: 5,
        acceptedTaskTypes: ["query", "review", "coding"],
        pinnedRepoIds: [],
      });
      expect(before).not.toHaveProperty("maxConcurrency");
      expect(before).not.toHaveProperty("poolLimits");

      expect(await pinRepository(agentId, repoA)).toEqual({ ok: true });

      const after = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(after).toMatchObject({
        // Legacy constants: agents claim jobs instead of polling queue topics.
        pollIntervalSeconds: 5,
        pinnedRepoIds: [repoA],
        topics: [],
      });

      expect(await unpinRepository(agentId, repoA)).toEqual({ ok: true });
      const unpinned = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(unpinned.pinnedRepoIds).toEqual([]);
    });

    it("stores the task types the agent reports, publishing a change only when they differ", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const reported = { ...HEARTBEAT, acceptedTaskTypes: ["coding", "query"] };
      const agentChanges = (changes: RecordedChange[]) =>
        changes.filter((c) => c.resource === "agent" && c.ids.includes(agentId));
      // The first heartbeat announces the agent online: get that out of the way.
      await sendHeartbeat(accessToken);

      const first = await captureChanges(
        async () =>
          (await (await sendHeartbeat(accessToken, reported)).json()) as HeartbeatResponse,
      );
      // An agent that reports its own task types isn't sent any.
      expect(first.result.acceptedTaskTypes).toBeUndefined();
      expect(agentChanges(first.changes)).toEqual([
        expect.objectContaining({ resource: "agent", ids: [agentId], organizationId: orgId }),
      ]);
      const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(row!.reportedAcceptedTaskTypes).toEqual(["coding", "query"]);

      // The same report again changes nothing and publishes nothing.
      const same = await captureChanges(() => sendHeartbeat(accessToken, reported));
      expect(agentChanges(same.changes)).toEqual([]);

      // The list and the detail show them read-only, in task type order.
      const listed = await listAgents();
      expect(listed.find((h) => h.id === agentId)?.acceptedTaskTypes).toEqual(["query", "coding"]);
      expect((await getAgent(agentId)).acceptedTaskTypes).toEqual(["query", "coding"]);

      // An older agent reports none: it keeps the last report and is sent it.
      const legacy = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(legacy.acceptedTaskTypes).toEqual(["query", "coding"]);
      expect(legacy.topics).toEqual([]);

      // A bad report is refused.
      const bad = await sendHeartbeat(accessToken, { ...HEARTBEAT, acceptedTaskTypes: [] });
      expect(bad.status).toBe(400);
    });

    it("stores the local settings the agent reports, publishing a change only when they differ", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const agentChanges = (changes: RecordedChange[]) =>
        changes.filter((c) => c.resource === "agent" && c.ids.includes(agentId));
      const stored = async () => {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return {
          maxConcurrency: row!.reportedMaxConcurrency,
          poolLimits: row!.reportedPoolLimits,
          versionPin: row!.reportedVersionPin,
          installablesAllow: row!.reportedInstallablesAllow,
        };
      };
      // The first heartbeat announces the agent online and stores the defaults it reports.
      await sendHeartbeat(accessToken);
      expect(await stored()).toEqual(LOCAL);

      // The same report again changes nothing and publishes nothing.
      const same = await captureChanges(() => sendHeartbeat(accessToken));
      expect(agentChanges(same.changes)).toEqual([]);

      // Each changed value is stored and announces the agent.
      for (const local of [
        { ...LOCAL, maxConcurrency: 2, poolLimits: { short: 2, long: 1 } },
        { ...LOCAL, maxConcurrency: 2, poolLimits: { short: 1, long: 1 } },
        { ...LOCAL, maxConcurrency: 2, poolLimits: { short: 1, long: 1 }, versionPin: "2.0.3" },
        {
          maxConcurrency: 2,
          poolLimits: { short: 1, long: 1 },
          versionPin: "2.0.3",
          installablesAllow: [],
        },
      ]) {
        const changed = await captureChanges(() =>
          sendHeartbeat(accessToken, { ...HEARTBEAT, local }),
        );
        expect(changed.result.status).toBe(200);
        expect(agentChanges(changed.changes)).toEqual([
          expect.objectContaining({ resource: "agent", ids: [agentId], organizationId: orgId }),
        ]);
        expect(await stored()).toEqual(local);
      }

      // A bad report is refused and stores nothing.
      const bad = await sendHeartbeat(accessToken, {
        ...HEARTBEAT,
        local: { ...LOCAL, maxConcurrency: 0 },
      });
      expect(bad.status).toBe(400);
      expect((await stored()).maxConcurrency).toBe(2);
    });

    it("stores the host the agent reports, keeping it when omitted, publishing only when it changes", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const agentChanges = (changes: RecordedChange[]) =>
        changes.filter((c) => c.resource === "agent" && c.ids.includes(agentId));
      const reportedHost = async () => {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return row!.reportedHost;
      };
      // The first heartbeat announces the agent online: get that out of the way.
      await sendHeartbeat(accessToken);
      expect(await reportedHost()).toBeNull();

      const coder = { hostname: "coder-ws-1", coder: { owner: "steve", workspace: "omniralph" } };
      const first = await captureChanges(() =>
        sendHeartbeat(accessToken, { ...HEARTBEAT, host: coder }),
      );
      expect(first.result.status).toBe(200);
      expect(await reportedHost()).toEqual(coder);
      expect(agentChanges(first.changes)).toEqual([
        expect.objectContaining({ resource: "agent", ids: [agentId], organizationId: orgId }),
      ]);

      // The same host again stores nothing new and publishes nothing.
      const same = await captureChanges(() =>
        sendHeartbeat(accessToken, { ...HEARTBEAT, host: coder }),
      );
      expect(agentChanges(same.changes)).toEqual([]);
      expect(await reportedHost()).toEqual(coder);

      // A heartbeat without a host (an older agent) leaves it unchanged and publishes nothing.
      const omitted = await captureChanges(() => sendHeartbeat(accessToken));
      expect(omitted.result.status).toBe(200);
      expect(agentChanges(omitted.changes)).toEqual([]);
      expect(await reportedHost()).toEqual(coder);

      // A different host replaces it and publishes once.
      const plain = { hostname: "build-01", coder: null };
      const moved = await captureChanges(() =>
        sendHeartbeat(accessToken, { ...HEARTBEAT, host: plain }),
      );
      expect(await reportedHost()).toEqual(plain);
      expect(agentChanges(moved.changes)).toHaveLength(1);

      // A bad report is refused and the last report stays.
      const bad = await sendHeartbeat(accessToken, {
        ...HEARTBEAT,
        host: { hostname: "x".repeat(256), coder: null },
      });
      expect(bad.status).toBe(400);
      expect(await reportedHost()).toEqual(plain);
    });

    it("lists the slots each agent reports, and its local settings in the detail", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const quiet = await enrolledAgent();
      const listed = async (id: string) => (await listAgents()).find((agent) => agent.id === id)!;
      const detail = async (id: string) => {
        const response = await agentDetail.GET(
          new Request(`http://localhost/api/ui/agents/${id}`),
          { params: Promise.resolve({ id }) },
        );
        return (await response.json()) as AgentDetail;
      };
      // Nothing reported yet: no slots known, no local settings.
      expect((await listed(agentId)).slots).toEqual({ running: 0, max: null });
      expect((await detail(agentId)).local).toEqual({
        poolLimits: null,
        versionPin: null,
        installablesAllow: null,
      });

      const local = {
        maxConcurrency: 3,
        poolLimits: { short: 3, long: 1 },
        versionPin: "2.0.3",
        installablesAllow: ["@omniralph/*", "@acme/*"],
      };
      expect((await sendHeartbeat(accessToken, { ...HEARTBEAT, local })).status).toBe(200);
      const [running] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          type: "test.job",
          taskType: "review",
          status: "running",
          agentId,
          startedAt: new Date(),
        })
        .returning();
      try {
        expect((await listed(agentId)).slots).toEqual({ running: 1, max: 3 });
        expect((await getAgent(agentId)).slots).toEqual({ running: 1, max: 3 });
        expect((await detail(agentId)).local).toEqual({
          poolLimits: { short: 3, long: 1 },
          versionPin: "2.0.3",
          installablesAllow: ["@omniralph/*", "@acme/*"],
        });
        expect((await listed(quiet.agentId)).slots).toEqual({ running: 0, max: null });
      } finally {
        await db.delete(jobs).where(eq(jobs.id, running!.id));
      }
    });

    it("sends the desired version (override, else the organization's) and stores the reported update state", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const other = await enrolledAgent();
      const desired = async (token: string) =>
        ((await (await sendHeartbeat(token)).json()) as HeartbeatResponse).desiredVersion;
      expect(await desired(accessToken)).toBeNull();

      await setDesiredAgentVersion(db, orgId, "2.4.0", adminId);
      // Another organization's version doesn't reach this organization's agents.
      const [otherOrg] = await db.insert(organizations).values({ name: "Other" }).returning();
      await setDesiredAgentVersion(db, otherOrg!.id, "9.0.0", null);
      expect(await desired(accessToken)).toBe("2.4.0");
      await setAgentDesiredVersion(agentId, "2.5.0");
      expect(await desired(accessToken)).toBe("2.5.0");
      expect(await desired(other.accessToken)).toBe("2.4.0");

      // The agent reports where it is; the Agents pages show it.
      const update = {
        state: "draining",
        version: "2.5.0",
        previous: "0.2.0",
        startsSincePending: 0,
        error: null,
      };
      await sendHeartbeat(accessToken, {
        ...HEARTBEAT,
        selfUpdate: "supported",
        update,
        failedVersions: ["2.3.0"],
      });
      const overview = (await getAgentOverview(db, orgId, agentId))!;
      expect(overview).toMatchObject({
        selfUpdate: "supported",
        updateState: update,
        failedVersions: ["2.3.0"],
      });
      expect(agentRow(overview, new Date(), "2.4.0")).toMatchObject({
        version: "0.2.0",
        desiredVersion: "2.5.0",
        desiredVersionOverride: "2.5.0",
        updateStatus: "updating",
        failedVersions: ["2.3.0"],
      });

      // Cleared override: the global version again. Older agents report nothing.
      await setAgentDesiredVersion(agentId, null);
      expect(await desired(accessToken)).toBe("2.4.0");
      const legacy = (await getAgentOverview(db, orgId, agentId))!;
      expect(legacy).toMatchObject({ selfUpdate: null, updateState: null, failedVersions: [] });
      expect(agentRow(legacy, new Date(), "2.4.0").updateStatus).toBe("manual");
      await setDesiredAgentVersion(db, orgId, null, adminId);
    });

    it("tracking latest sends npm's latest, which Update now refreshes", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const supported = { ...HEARTBEAT, selfUpdate: "supported" };
      const respond = async () =>
        (await (await sendHeartbeat(accessToken, supported)).json()) as HeartbeatResponse;

      state.latest = "2.0.0";
      await setDesiredAgentVersion(db, orgId, "latest", adminId);
      expect((await respond()).desiredVersion).toBe("2.0.0");
      expect(
        agentRow((await getAgentOverview(db, orgId, agentId))!, new Date(), "2.0.0", true),
      ).toMatchObject({ desiredVersion: "2.0.0", tracksLatest: true, updateStatus: "updating" });

      // A new release is picked up once the stored read is old; until then heartbeats agree.
      state.latest = "2.1.0";
      expect((await respond()).desiredVersion).toBe("2.0.0");
      // Update now reads npm at once and records it, so heartbeats don't send the agent back.
      expect(await requestAgentUpdate(agentId)).toEqual({ ok: true, version: "2.1.0" });
      expect(await respond()).toMatchObject({
        desiredVersion: "2.1.0",
        updateRequest: { version: "2.1.0" },
      });

      // An override still wins.
      await setAgentDesiredVersion(agentId, "2.9.0");
      expect((await respond()).desiredVersion).toBe("2.9.0");

      state.latest = "2.0.0";
      await setDesiredAgentVersion(db, orgId, null, adminId);
    });

    it("Update now sends an update request until the agent reports it handled", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const respond = async (body: object = HEARTBEAT) =>
        (await (await sendHeartbeat(accessToken, body)).json()) as HeartbeatResponse;
      const supported = { ...HEARTBEAT, selfUpdate: "supported" };

      // Older agents and agents outside pm2 can't update themselves.
      await respond();
      expect(await requestAgentUpdate(agentId)).toEqual({
        ok: false,
        error: expect.any(String),
      });
      expect((await respond(supported)).updateRequest).toBeNull();

      // No version chosen: the latest on npm.
      expect(await requestAgentUpdate(agentId)).toEqual({ ok: true, version: "2.0.0" });
      const { updateRequest } = await respond(supported);
      expect(updateRequest).toEqual({ id: expect.any(String), version: "2.0.0" });
      const row = agentRow((await getAgentOverview(db, orgId, agentId))!);
      expect(row).toMatchObject({
        updateRequest: { version: "2.0.0", requestedAt: expect.any(String) },
        updateStatus: "updating",
      });

      // The desired version, even one that failed on the agent.
      await setAgentDesiredVersion(agentId, "2.5.0");
      await respond({ ...supported, failedVersions: ["2.5.0"] });
      expect(await requestAgentUpdate(agentId)).toEqual({ ok: true, version: "2.5.0" });
      const second = (await respond(supported)).updateRequest;
      expect(second).toEqual({ id: expect.any(String), version: "2.5.0" });
      expect(second!.id).not.toBe(updateRequest!.id);

      // Handled: the request is cleared (an older one doesn't clear it).
      expect(
        (await respond({ ...supported, handledUpdateRequestId: updateRequest!.id })).updateRequest,
      ).toEqual(second);
      expect(
        (await respond({ ...supported, handledUpdateRequestId: second!.id })).updateRequest,
      ).toBeNull();
      expect(agentRow((await getAgentOverview(db, orgId, agentId))!).updateRequest).toBeNull();

      // Nothing to do on the desired version; members can't ask.
      await respond({ ...supported, version: "2.5.0" });
      expect(await requestAgentUpdate(agentId)).toEqual({
        ok: false,
        error: expect.stringContaining("already runs 2.5.0"),
      });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await requestAgentUpdate(agentId)).toEqual({
        ok: false,
        error: expect.any(String),
      });
    });

    it("pinning enqueues a repo.sync job targeting the agent", async () => {
      const { agentId } = await enrolledAgent();
      expect(await pinRepository(agentId, repoB)).toEqual({ ok: true });
      const targeted = await db.select().from(jobs).where(eq(jobs.targetAgentId, agentId));
      expect(targeted).toHaveLength(1);
      expect(targeted[0]).toMatchObject({
        type: "repo.sync",
        taskType: "system",
        status: "queued",
        repositoryId: repoB,
      });
    });
  });

  describe("install", () => {
    /** The IDs of every job the agent claims now (other tests' system jobs too). */
    async function claimAll(agentId: string): Promise<string[]> {
      const ids: string[] = [];
      for (;;) {
        const { claim } = await claimJob(db, {
          agentId,
          organizationId: orgId,
          acceptedTaskTypes: [],
          pools: [],
          agentVersion: "0.2.0",
          maxDeliveries: 3,
        });
        if (!claim) return ids;
        ids.push(claim.job.id);
      }
    }

    it("enqueues an install RPC only the chosen agent claims", async () => {
      const target = await enrolledAgent();
      const other = await enrolledAgent();
      expect(
        await installInstallable(target.agentId, {
          name: " @omniralph/hello ",
          version: "1.2.0",
        }),
      ).toEqual({ ok: true });
      // Asking again while it's queued doesn't enqueue a second one.
      expect(
        await installInstallable(target.agentId, { name: "@omniralph/hello", version: "1.2.0" }),
      ).toEqual({ ok: true });
      const queued = await db.select().from(jobs).where(eq(jobs.targetAgentId, target.agentId));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        type: "install",
        taskType: "system",
        status: "queued",
        payload: { name: "@omniralph/hello", version: "1.2.0" },
      });

      expect(await claimAll(other.agentId)).not.toContain(queued[0]!.id);
      expect(await claimAll(target.agentId)).toContain(queued[0]!.id);
    });

    it("stores the installables each heartbeat reports, replacing the last report", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const reported = async () => {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return row!.reportedInstallables;
      };
      expect(await reported()).toEqual([]);
      const hello = { name: "@omniralph/hello", version: "1.0.0" };
      const graph = { name: "@omniralph/code-graph", version: "0.3.1" };
      expect(
        (await sendHeartbeat(accessToken, { ...HEARTBEAT, installables: [hello, graph] })).status,
      ).toBe(200);
      expect(await reported()).toEqual([hello, graph]);
      await sendHeartbeat(accessToken, { ...HEARTBEAT, installables: [graph] });
      expect(await reported()).toEqual([graph]);
      await sendHeartbeat(accessToken, { ...HEARTBEAT, installables: [] });
      expect(await reported()).toEqual([]);
      // Too many to report: the heartbeat is refused and the last report stays.
      await sendHeartbeat(accessToken, { ...HEARTBEAT, installables: [hello] });
      const tooMany = Array.from({ length: 101 }, (_, i) => ({ name: `p${i}`, version: "1.0.0" }));
      expect(
        (await sendHeartbeat(accessToken, { ...HEARTBEAT, installables: tooMany })).status,
      ).toBe(400);
      expect(await reported()).toEqual([hello]);
    });

    it("defaults to the latest version", async () => {
      const { agentId } = await enrolledAgent();
      expect(await installInstallable(agentId, { name: "@omniralph/graph", version: " " })).toEqual(
        { ok: true },
      );
      const [job] = await db.select().from(jobs).where(eq(jobs.targetAgentId, agentId));
      expect(job!.payload).toEqual({ name: "@omniralph/graph" });
    });

    it("rejects invalid packages and versions, unknown agents and members", async () => {
      const { agentId } = await enrolledAgent();
      expect(await installInstallable(agentId, { name: "../evil" })).toEqual({
        ok: false,
        error: "That isn't a valid package name.",
      });
      expect(
        await installInstallable(agentId, { name: "@omniralph/x", version: "npm:evil@1.0.0" }),
      ).toEqual({ ok: false, error: "That isn't a valid version." });
      expect(await installInstallable(randomUUID(), { name: "@omniralph/x" })).toMatchObject({
        ok: false,
      });
      await revokeAgent(agentId);
      expect(await installInstallable(agentId, { name: "@omniralph/x" })).toMatchObject({
        ok: false,
      });
      const fresh = await enrolledAgent();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await installInstallable(fresh.agentId, { name: "@omniralph/x" })).toMatchObject({
        ok: false,
      });
      const none = await db.select().from(jobs).where(eq(jobs.type, "install"));
      expect(
        none.every((j) => j.targetAgentId !== agentId && j.targetAgentId !== fresh.agentId),
      ).toBe(true);
    });

    it("enqueueInstall targets the agent, dedupes per package and version, and validates", async () => {
      const dispatcher = new PostgresDispatcher({ db });
      const { agentId } = await enrolledAgent();
      const enqueue = (input: { agentId?: string; name: string; version?: string }) =>
        enqueueInstall(db, dispatcher, { organizationId: orgId, agentId, ...input });
      const installJobs = () => db.select().from(jobs).where(eq(jobs.targetAgentId, agentId));

      const pinned = await enqueue({ name: "@omniralph/fixture", version: "1.2.0" });
      const latest = await enqueue({ name: "@omniralph/fixture" });
      expect(pinned).toMatchObject({ result: "enqueued", created: true });
      expect(latest).toMatchObject({ result: "enqueued", created: true });
      expect(await enqueue({ name: "@omniralph/fixture" })).toEqual({
        ...latest,
        created: false,
      });
      expect(
        (await installJobs()).map(({ type, taskType, targetAgentId, dedupeKey }) => ({
          type,
          taskType,
          targetAgentId,
          dedupeKey,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            type: "install",
            taskType: "system",
            targetAgentId: agentId,
            dedupeKey: `install:${agentId}:@omniralph/fixture@1.2.0`,
          },
          {
            type: "install",
            taskType: "system",
            targetAgentId: agentId,
            dedupeKey: `install:${agentId}:@omniralph/fixture@latest`,
          },
        ]),
      );

      for (const name of ["-x", "../evil", "@omniralph/x@1.0.0", ""]) {
        expect(await enqueue({ name })).toEqual({ result: "invalid", field: "name" });
      }
      expect(await enqueue({ name: "@omniralph/x", version: "^1.0.0" })).toEqual({
        result: "invalid",
        field: "version",
      });

      const [otherOrg] = await db.insert(organizations).values({ name: "Other" }).returning();
      const [foreign] = await db
        .insert(agents)
        .values({ organizationId: otherOrg!.id, name: "foreign" })
        .returning();
      const revoked = await enrolledAgent();
      await revokeAgent(revoked.agentId);
      for (const id of [randomUUID(), revoked.agentId, foreign!.id]) {
        expect(await enqueue({ agentId: id, name: "@omniralph/x" })).toEqual({
          result: "unknown_agent",
        });
      }
      expect(await installJobs()).toHaveLength(2);
      const stray = await db.select().from(jobs).where(eq(jobs.type, "install"));
      expect(
        stray.some((job) => [revoked.agentId, foreign!.id].includes(job.targetAgentId ?? "")),
      ).toBe(false);
    });
  });

  describe("host tools", () => {
    const configured = {
      name: "ui-gh",
      path: "/opt/gh/bin/gh",
      source: "configured",
      problem: null,
    } as const;
    const discovered = {
      name: "ui-opengrep",
      path: "/usr/bin/opengrep",
      source: "discovered",
      problem: null,
    } as const;
    const blocked = { name: "ui-semgrep", path: null, source: null, problem: "blocked" } as const;

    /** A playbook of the organization requiring `hostTools` (removed with `drop`). */
    async function requirePlaybook(hostTools: string[]) {
      const row = await insertPlaybook(db, orgId, {
        name: `Requires ${hostTools.join(" ")}`,
        role: "chat-ask",
        definition: {},
        requirements: { installables: [], hostTools },
        createdBy: null,
      });
      return () => db.delete(playbooks).where(eq(playbooks.id, row.id));
    }

    it("stores each heartbeat's host tools, publishing the agent only when they change", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      const agentChanges = (changes: RecordedChange[]) =>
        changes.filter((c) => c.resource === "agent" && c.ids.includes(agentId));
      const reported = async () => {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        return row!.reportedHostTools;
      };
      // The first heartbeat announces the agent online: get that out of the way.
      await sendHeartbeat(accessToken);
      expect(await reported()).toEqual([]);

      const hostTools = [configured, discovered, blocked];
      const first = await captureChanges(() =>
        sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools }),
      );
      expect(first.result.status).toBe(200);
      expect(await reported()).toEqual(hostTools);
      expect(agentChanges(first.changes)).toEqual([
        expect.objectContaining({ resource: "agent", ids: [agentId], organizationId: orgId }),
      ]);

      // The same report again publishes nothing.
      const same = await captureChanges(() =>
        sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools }),
      );
      expect(agentChanges(same.changes)).toEqual([]);

      // A tool found now: stored and published once.
      const found = { ...blocked, path: "/opt/semgrep", source: "configured", problem: null };
      const changed = await captureChanges(() =>
        sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools: [configured, discovered, found] }),
      );
      expect(agentChanges(changed.changes)).toHaveLength(1);
      expect((await reported())[2]).toEqual(found);

      // Too many, or a bad entry: refused, the last report stays.
      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        name: `t${i}`,
        path: null,
        source: null,
        problem: null,
      }));
      for (const bad of [
        tooMany,
        [{ ...configured, path: "bin/gh" }],
        [{ name: "ui-gh", configuredPathExists: true, discoveredPath: null }],
      ]) {
        expect((await sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools: bad })).status).toBe(
          400,
        );
      }
      expect(await reported()).toHaveLength(3);

      // None reported clears it.
      await sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools: [] });
      expect(await reported()).toEqual([]);
    });

    it("sends the host tools the organization's playbooks require", async () => {
      const { accessToken } = await enrolledAgent();
      const required = async () =>
        (
          (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse
        ).requiredHostTools.filter((name) => name.startsWith("ui-"));
      expect(await required()).toEqual([]);
      const dropFirst = await requirePlaybook(["ui-opengrep", "ui-gh"]);
      const dropSecond = await requirePlaybook(["ui-gh"]);
      try {
        expect(await required()).toEqual(["ui-gh", "ui-opengrep"]);
      } finally {
        await dropFirst();
        await dropSecond();
      }
      expect(await required()).toEqual([]);
    });

    it("shows the reported host tools and the required ones missing on the agent's detail", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      expect(await getAgentDetail(agentId)).toMatchObject({
        status: 200,
        body: { hostTools: [], missingRequiredHostTools: [] },
      });
      const drop = await requirePlaybook(["ui-gh", "ui-semgrep", "ui-trivy"]);
      try {
        await sendHeartbeat(accessToken, {
          ...HEARTBEAT,
          hostTools: [configured, discovered, blocked],
        });
        const detail = await getAgentDetail(agentId);
        expect(detail.status).toBe(200);
        expect(detail.body.hostTools).toEqual([configured, discovered, blocked]);
        expect(
          detail.body.missingRequiredHostTools.filter((name) => name.startsWith("ui-")),
        ).toEqual(["ui-semgrep", "ui-trivy"]);
      } finally {
        await drop();
      }
    });
  });

  describe("revoke", () => {
    it("rejects unexpired tokens, requeues running jobs and removes pins", async () => {
      const { agentId, accessToken, refreshToken } = await enrolledAgent();
      await pinRepository(agentId, repoA);
      expect((await sendHeartbeat(accessToken)).status).toBe(200);

      const [running, lastDelivery, canceling, queuedForIt, syncForIt] = await db
        .insert(jobs)
        .values([
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "running",
            agentId,
            deliveryCount: 1,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "running",
            agentId,
            deliveryCount: 3,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "running",
            agentId,
            deliveryCount: 1,
            cancelRequested: true,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "queued",
            repositoryId: repoA,
            targetAgentId: agentId,
          },
          {
            organizationId: orgId,
            type: "repo.sync",
            taskType: "system",
            status: "queued",
            repositoryId: repoA,
            targetAgentId: agentId,
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

      // Jobs only it could claim are redispatched (to any agent now) or skipped.
      expect(await jobRow(queuedForIt!.id)).toMatchObject({
        status: "queued",
        targetAgentId: null,
      });
      expect(await jobRow(syncForIt!.id)).toMatchObject({ status: "skipped" });

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

      // A revoked agent can't be pinned.
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

  describe("delete", () => {
    it("revokes an active agent, then hides it from the agent list", async () => {
      const { agentId, accessToken } = await enrolledAgent();
      await pinRepository(agentId, repoA);
      const [running] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          type: "review.run",
          taskType: "review",
          status: "running",
          agentId,
          deliveryCount: 1,
        })
        .returning();

      expect(await deleteAgent(agentId)).toEqual({ ok: true });

      expect((await sendHeartbeat(accessToken)).status).toBe(401);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).not.toBeNull();
      expect(agent!.deletedAt).not.toBeNull();
      expect(await jobRow(running!.id)).toMatchObject({ status: "queued", agentId: null });
      expect(
        await db.select().from(agentRepoPins).where(eq(agentRepoPins.agentId, agentId)),
      ).toEqual([]);
      expect((await listAgentOverview(db, orgId)).map((a) => a.id)).not.toContain(agentId);
      expect(await getAgentOverview(db, orgId, agentId)).toBeNull();
      expect(await listAgentAudit(db, { agentId, event: "revoke" })).toHaveLength(1);
      const [audit] = await listAgentAudit(db, { agentId, event: "delete" });
      expect(audit!.detail).toEqual({ deletedBy: adminId });

      // Gone: it can't be deleted or revoked again.
      expect(await deleteAgent(agentId)).toMatchObject({ ok: false });
    });

    it("deletes an already revoked agent without revoking it again", async () => {
      const { agentId } = await enrolledAgent();
      expect(await revokeAgent(agentId)).toEqual({ ok: true });
      const [before] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(await deleteAgent(agentId)).toEqual({ ok: true });
      const [after] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(after!.revokedAt).toEqual(before!.revokedAt);
      expect(after!.deletedAt).not.toBeNull();
      expect(await listAgentAudit(db, { agentId, event: "revoke" })).toHaveLength(1);
    });

    it("is admin-only and reports unknown agents", async () => {
      const { agentId } = await enrolledAgent();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await deleteAgent(agentId)).toMatchObject({ ok: false });
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent).toMatchObject({ revokedAt: null, deletedAt: null });
      state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
      expect(await deleteAgent(randomUUID())).toMatchObject({ ok: false });
    });
  });

  describe("audit log", () => {
    it("lists the 50 most recent events, newest first", async () => {
      const { agentId } = await enrolledAgent();
      for (let i = 0; i < 60; i++) {
        await writeAgentAudit(db, {
          agentId,
          event: "credential_issued",
          detail: { i },
        });
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
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "queued",
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "running",
            agentId,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            status: "completed",
            agentId,
          },
        ])
        .returning();

      expect(await cancelJob(queued!.id)).toEqual({ ok: true });
      expect(await jobRow(queued!.id)).toMatchObject({ status: "canceled" });

      expect(await cancelJob(running!.id)).toMatchObject({ ok: true, warning: expect.any(String) });
      // It shows as cancel-requested until its agent confirms.
      expect(await jobRow(running!.id)).toMatchObject({
        status: "running",
        cancelRequested: true,
      });
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
          type: "review.run",
          taskType: "review",
          status: "queued",
        })
        .returning();
      // Members cancel jobs too.
      expect(await cancelJob(another!.id)).toEqual({ ok: true });
      expect(await jobRow(another!.id)).toMatchObject({ status: "canceled" });
    });
  });

  describe("rerun job", () => {
    it("queues a failed install again for its agent, which can be rerun", async () => {
      const { agentId } = await enrolledAgent();
      const installed = await enqueueInstall(db, new PostgresDispatcher({ db }), {
        organizationId: orgId,
        agentId,
        name: "@omniralph/rerun-fixture",
      });
      if (installed.result !== "enqueued") throw new Error("not enqueued");
      await db
        .update(jobs)
        .set({ status: "failed", error: "npm failed", finishedAt: new Date() })
        .where(eq(jobs.id, installed.jobId));
      expect(isRerunnable(await jobRow(installed.jobId))).toBe(true);

      const rerun = await rerunJob(installed.jobId);
      expect(rerun).toEqual({ ok: true });
      const copies = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.targetAgentId, agentId), eq(jobs.status, "queued")));
      expect(copies).toHaveLength(1);
      const failed = await jobRow(installed.jobId);
      expect(copies[0]).toMatchObject({
        type: failed.type,
        taskType: "system",
        payload: failed.payload,
        dedupeKey: failed.dedupeKey,
      });
      expect(isRerunnable(await jobRow(copies[0]!.id))).toBe(false);
      // The failed job stays as it was; a second rerun finds the copy queued.
      expect(failed).toMatchObject({ status: "failed", error: "npm failed" });
      expect(await rerunJob(installed.jobId)).toMatchObject({
        ok: true,
        warning: expect.any(String),
      });
      // A job that didn't fail can't be rerun.
      expect(await rerunJob(copies[0]!.id)).toMatchObject({ ok: false });
      // Members rerun jobs too: the copy is already queued, so the copy's a warning.
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await rerunJob(installed.jobId)).toMatchObject({
        ok: true,
        warning: expect.any(String),
      });
      await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, copies[0]!.id));
      expect(await rerunJob(copies[0]!.id)).toEqual({ ok: true });
    });
  });
});
