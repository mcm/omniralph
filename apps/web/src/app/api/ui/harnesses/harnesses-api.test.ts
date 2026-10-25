import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  harnessRefreshTokens,
  harnessRepoPins,
  harnesses,
  connectRepository,
  claimJob,
  closeDb,
  createDb,
  createHostTool,
  getHarnessOverview,
  jobs,
  listHarnessAudit,
  listHarnessHostTools,
  listHarnessOverview,
  listRecentHarnessAudit,
  scmConnections,
  setAllowedTaskTypeDefaults,
  setDefaultMaxConcurrency,
  setDesiredHarnessVersion,
  setHarnessHostToolPath,
  upsertScmConnection,
  users,
  writeHarnessAudit,
  type Database,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import type { HeartbeatResponse } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { callAction } from "@/lib/api/test-call";
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
vi.mock("@/lib/harnesses/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestHarnessVersion: async () => state.latest,
}));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const harnessDetail = await import("@/app/api/ui/harnesses/[id]/route");
const harnessSettings = await import("@/app/api/ui/harnesses/[id]/settings/route");
const harnessUpdate = await import("@/app/api/ui/harnesses/[id]/update/route");
const harnessRevoke = await import("@/app/api/ui/harnesses/[id]/revoke/route");
const harnessInstalls = await import("@/app/api/ui/harnesses/[id]/installs/route");
const harnessHostTools = await import("@/app/api/ui/harnesses/[id]/host-tools/route");
const pinnable = await import("@/app/api/ui/harnesses/pinnable-repositories/route");
const hostToolsRoute = await import("@/app/api/ui/host-tools/route");
const hostToolRoute = await import("@/app/api/ui/host-tools/[id]/route");
// Settings › Harness defaults › Host tools requests, under the server actions' old names.
const addHostTool = async (input: { name: string; description?: string }) =>
  (await callAction(hostToolsRoute.POST, "POST", {}, input)) as ActionResult & {
    hostToolId?: string;
  };
const removeHostTool = (id: string) => callAction(hostToolRoute.DELETE, "DELETE", { id });
const { harnessRow } = await import("@/lib/harnesses/rows");
const { enqueueInstall } = await import("@/lib/harnesses/installables");
const { PostgresDispatcher } = await import("@/lib/dispatch");
const jobCancel = await import("@/app/api/ui/jobs/[id]/cancel/route");
const jobRerun = await import("@/app/api/ui/jobs/[id]/rerun/route");
const jobList = await import("@/app/api/ui/jobs/route");
const { POST: enroll } = await import("@/app/api/harness/enroll/route");
const { POST: postEnrollment } = await import("@/app/api/ui/harness-enrollments/route");
const { POST: token } = await import("@/app/api/harness/token/route");
const { POST: heartbeat } = await import("@/app/api/harness/heartbeat/route");
const { requireJob } = await import("@/lib/harness-auth/verify");
const { getTokenSigner } = await import("@/lib/harness-auth/signer");

const databaseAvailable = testDatabaseAvailable();

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

function post(path: string, body: unknown, accessToken?: string): Request {
  return new Request(`http://localhost/api/harness/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": newIp(),
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify(body),
  });
}

/** `POST /api/ui/harness-enrollments`, as the Enroll harness dialog sends it. */
async function createEnrollment(name: string) {
  const response = await postEnrollment(
    new Request("http://localhost/api/ui/harness-enrollments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: await response.json() };
}

/**
 * Calls a harness page's `/api/ui` handler as the panel does; answers its JSON as an
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

/** The Settings tab's save of the config alone (the other parts are left as they are). */
const updateHarnessConfig = (
  id: string,
  config: {
    maxConcurrency: number | null;
    acceptedTaskTypes: string[] | null;
    poolLimits: Record<string, number>;
  },
) => ui(harnessSettings.PUT, id, { method: "PUT", body: { config } });
const setHarnessDesiredVersion = (id: string, version: string) =>
  ui(harnessSettings.PUT, id, { method: "PUT", body: { version } });
const pinRepository = (id: string, repositoryId: string) =>
  ui(harnessSettings.PUT, id, { method: "PUT", body: { pin: [repositoryId] } });
const unpinRepository = (id: string, repositoryId: string) =>
  ui(harnessSettings.PUT, id, { method: "PUT", body: { unpin: [repositoryId] } });
const requestHarnessUpdate = (id: string) => ui(harnessUpdate.POST, id);
const revokeHarness = (id: string) => ui(harnessRevoke.POST, id);
const cancelJob = (id: string) => ui(jobCancel.POST, id);
const rerunJob = (id: string) => ui(jobRerun.POST, id);
async function listedJob(id: string) {
  const response = await jobList.GET(new Request("http://localhost/api/ui/jobs"), {
    params: Promise.resolve({}),
  });
  const { jobs } = (await response.json()) as { jobs: { id: string }[] };
  return jobs.find((job) => job.id === id);
}
const deleteHarness = (id: string) => ui(harnessDetail.DELETE, id, { method: "DELETE" });
const installInstallable = (id: string, body: { name: string; version?: string }) =>
  ui(harnessInstalls.POST, id, { body });
const setHostToolPath = (id: string, hostToolId: string, path: string) =>
  ui(harnessHostTools.PUT, id, { method: "PUT", body: { paths: [{ hostToolId, path }] } });
async function searchPinnableRepositories(query: string) {
  const response = await pinnable.GET(
    new Request(`http://localhost/api/ui?${new URLSearchParams({ query })}`),
    { params: Promise.resolve({}) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  return response.ok
    ? { ok: true as const, repositories: json.repositories as { fullPath: string }[] }
    : { ok: false as const, error: json.error as string };
}

const HEARTBEAT = { version: "0.2.0", runningJobIds: [], freeSlots: 1 };

describe.skipIf(!databaseAvailable)("harnesses and jobs pages: server actions", () => {
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
  async function enrolledHarness(name = "") {
    const { token: enrollmentToken } = await newEnrollment(name);
    const enrolled = (await (await redeem(enrollmentToken)).json()) as {
      harnessId: string;
      refreshToken: string;
    };
    const tokens = (await (
      await token(post("token", { refreshToken: enrolled.refreshToken }))
    ).json()) as {
      accessToken: string;
      refreshToken: string;
    };
    return { harnessId: enrolled.harnessId, ...tokens };
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
        `omniralph-harness enroll --server https://omniralph.example.com --token ${result.token}`,
      );
      const expiresIn = new Date(result.expiresAt).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(59 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(60 * 60_000);

      const res = await redeem(result.token);
      expect(res.status).toBe(200);
      const { harnessId } = (await res.json()) as { harnessId: string };
      const [harness] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(harness!.name).toBe("Build box");
      expect(harness!.enrolledBy).toBe(adminId);
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
    it("reaches the harness in its next heartbeat response", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const before = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      // A new harness inherits the organization's (built-in) defaults.
      expect(before).toMatchObject({
        maxConcurrency: 5,
        pollIntervalSeconds: 5,
        acceptedTaskTypes: ["query", "review", "coding"],
        pinnedRepoIds: [],
      });

      expect(
        await updateHarnessConfig(harnessId, {
          maxConcurrency: 4,
          acceptedTaskTypes: [],
          poolLimits: {},
        }),
      ).toEqual({ ok: true });
      expect(await pinRepository(harnessId, repoA)).toEqual({ ok: true });

      const after = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(after).toMatchObject({
        maxConcurrency: 4,
        // Legacy constants: harnesses claim jobs instead of polling queue topics.
        pollIntervalSeconds: 5,
        acceptedTaskTypes: [],
        pinnedRepoIds: [repoA],
        topics: [],
      });

      expect(await unpinRepository(harnessId, repoA)).toEqual({ ok: true });
      const unpinned = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(unpinned.pinnedRepoIds).toEqual([]);
    });

    it("searches the connected repositories to pin, for admins only", async () => {
      expect(await searchPinnableRepositories("")).toEqual({
        ok: true,
        repositories: [
          { id: repoA, provider: "gitlab", fullPath: "acme/api" },
          { id: repoB, provider: "gitlab", fullPath: "acme/web" },
        ],
      });
      expect(await searchPinnableRepositories("WEB")).toEqual({
        ok: true,
        repositories: [{ id: repoB, provider: "gitlab", fullPath: "acme/web" }],
      });
      expect(await searchPinnableRepositories("nothing")).toEqual({ ok: true, repositories: [] });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await searchPinnableRepositories("")).toMatchObject({ ok: false });
    });

    it("returns at most 20 repositories per search, only the organization's", async () => {
      const [otherOrg] = await db.insert(organizations).values({ name: "Other" }).returning();
      await seedReviewProfiles(db, otherOrg!.id);
      const otherConnection = (await upsertScmConnection(db, {
        organizationId: otherOrg!.id,
        provider: "gitlab",
        name: "other bot",
        baseUrl: "https://gitlab.other.example.com",
        externalId: "6",
        credentials: { token: "glpat-other", webhookSecret: "hook" },
      }))!;
      await connectRepository(db, {
        connectionId: otherConnection.id,
        provider: "gitlab",
        externalId: "201",
        fullPath: "bulk/other-org",
      });
      expect(await searchPinnableRepositories("bulk/")).toEqual({ ok: true, repositories: [] });

      const [connection] = await db
        .select()
        .from(scmConnections)
        .where(eq(scmConnections.organizationId, orgId));
      for (let i = 0; i < 25; i += 1) {
        await connectRepository(db, {
          connectionId: connection!.id,
          provider: "gitlab",
          externalId: `bulk-${i}`,
          fullPath: `bulk/repo-${String(i).padStart(2, "0")}`,
        });
      }
      const result = await searchPinnableRepositories("bulk/");
      expect(result.ok).toBe(true);
      expect(result.repositories).toHaveLength(20);
      expect(result.repositories!.map((r) => r.fullPath)).toEqual(
        Array.from({ length: 20 }, (_, i) => `bulk/repo-${String(i).padStart(2, "0")}`),
      );
    });

    it("saves the accepted task types and they reach the harness", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const before = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(before.acceptedTaskTypes).toEqual(["query", "review", "coding"]);

      expect(
        await updateHarnessConfig(harnessId, {
          maxConcurrency: 1,
          acceptedTaskTypes: ["query", "coding", "query"],
          poolLimits: {},
        }),
      ).toEqual({ ok: true });
      const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(row!.acceptedTaskTypes).toEqual(["query", "coding"]);
      const after = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(after.acceptedTaskTypes).toEqual(["query", "coding"]);
      expect(after.topics).toEqual([]);
    });

    it("sends the effective per-pool limits and stores the edited ones", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const initial = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(initial.poolLimits).toEqual({ short: 5, long: 4 });

      // Unset: the long pool leaves one slot for short jobs.
      const config = {
        maxConcurrency: 3,
        acceptedTaskTypes: ["query", "review", "coding"],
        poolLimits: {},
      };
      expect(await updateHarnessConfig(harnessId, config)).toEqual({ ok: true });
      const defaults = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(defaults.poolLimits).toEqual({ short: 3, long: 2 });

      expect(
        await updateHarnessConfig(harnessId, {
          ...config,
          poolLimits: { long: 1, short: 3 },
        }),
      ).toEqual({ ok: true });
      const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(row!.poolLimits).toEqual({ long: 1, short: 3 });
      const limited = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(limited.poolLimits).toEqual({ short: 3, long: 1 });

      // Lowering maxConcurrency clamps the effective values.
      expect(
        await updateHarnessConfig(harnessId, {
          ...config,
          maxConcurrency: 2,
          poolLimits: { long: 1, short: 2 },
        }),
      ).toEqual({ ok: true });
      const clamped = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(clamped.poolLimits).toEqual({ short: 2, long: 1 });

      // Blank limits go back to the defaults.
      expect(await updateHarnessConfig(harnessId, config)).toEqual({ ok: true });
      const [cleared] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(cleared!.poolLimits).toEqual({});
      const reset = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(reset.poolLimits).toEqual({ short: 3, long: 2 });
    });

    it("saves an override and switches back to the organization's defaults", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const heartbeat = async () =>
        (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      const row = async () => harnessRow((await getHarnessOverview(db, orgId, harnessId))!);
      await setDefaultMaxConcurrency(db, orgId, 6, null);
      await setAllowedTaskTypeDefaults(db, orgId, ["query", "review"], null);
      try {
        expect(await row()).toMatchObject({
          acceptedTaskTypes: ["query", "review"],
          maxConcurrency: 6,
          overrides: { acceptedTaskTypes: null, maxConcurrency: null },
          defaults: { acceptedTaskTypes: ["query", "review"], maxConcurrency: 6 },
          effectivePoolLimits: { short: 6, long: 5 },
        });

        // Override both.
        expect(
          await updateHarnessConfig(harnessId, {
            maxConcurrency: 2,
            acceptedTaskTypes: ["coding"],
            poolLimits: {},
          }),
        ).toEqual({ ok: true });
        expect(await row()).toMatchObject({
          acceptedTaskTypes: ["coding"],
          maxConcurrency: 2,
          overrides: { acceptedTaskTypes: ["coding"], maxConcurrency: 2 },
          effectivePoolLimits: { short: 2, long: 1 },
        });
        expect(await heartbeat()).toMatchObject({
          maxConcurrency: 2,
          acceptedTaskTypes: ["coding"],
          poolLimits: { short: 2, long: 1 },
        });

        // Back to the organization's max concurrency only; pool limits are checked against it.
        const inheritMax = { maxConcurrency: null, acceptedTaskTypes: ["coding"] };
        expect(
          await updateHarnessConfig(harnessId, { ...inheritMax, poolLimits: { short: 7 } }),
        ).toMatchObject({ ok: false });
        expect(
          await updateHarnessConfig(harnessId, { ...inheritMax, poolLimits: { short: 6 } }),
        ).toEqual({ ok: true });
        const [stored] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
        expect(stored).toMatchObject({
          maxConcurrency: null,
          acceptedTaskTypes: ["coding"],
          poolLimits: { short: 6 },
        });
        expect(await heartbeat()).toMatchObject({
          maxConcurrency: 6,
          acceptedTaskTypes: ["coding"],
        });

        // Back to inheriting both: an organization change reaches the harness.
        expect(
          await updateHarnessConfig(harnessId, {
            maxConcurrency: null,
            acceptedTaskTypes: null,
            poolLimits: {},
          }),
        ).toEqual({ ok: true });
        await setDefaultMaxConcurrency(db, orgId, 3, null);
        expect(await row()).toMatchObject({
          acceptedTaskTypes: ["query", "review"],
          maxConcurrency: 3,
          overrides: { acceptedTaskTypes: null, maxConcurrency: null },
        });
        expect(await heartbeat()).toMatchObject({
          maxConcurrency: 3,
          acceptedTaskTypes: ["query", "review"],
          poolLimits: { short: 3, long: 2 },
        });
      } finally {
        await setDefaultMaxConcurrency(db, orgId, null, null);
        await setAllowedTaskTypeDefaults(db, orgId, null, null);
      }
    });

    it("sends the desired version (override, else the organization's) and stores the reported update state", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const other = await enrolledHarness();
      const desired = async (token: string) =>
        ((await (await sendHeartbeat(token)).json()) as HeartbeatResponse).desiredVersion;
      expect(await desired(accessToken)).toBeNull();

      await setDesiredHarnessVersion(db, orgId, "1.4.0", adminId);
      // Another organization's version doesn't reach this organization's harnesses.
      const [otherOrg] = await db.insert(organizations).values({ name: "Other" }).returning();
      await setDesiredHarnessVersion(db, otherOrg!.id, "9.0.0", null);
      expect(await desired(accessToken)).toBe("1.4.0");
      expect(await setHarnessDesiredVersion(harnessId, "v1.5.0")).toEqual({ ok: true });
      expect(await setHarnessDesiredVersion(harnessId, "latest")).toEqual({
        ok: false,
        error: expect.any(String),
      });
      expect(await desired(accessToken)).toBe("1.5.0");
      expect(await desired(other.accessToken)).toBe("1.4.0");

      // The harness reports where it is; the Harnesses pages show it.
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
      const overview = (await getHarnessOverview(db, orgId, harnessId))!;
      expect(overview).toMatchObject({
        selfUpdate: "supported",
        updateState: update,
        failedVersions: ["1.3.0"],
      });
      expect(harnessRow(overview, new Date(), "1.4.0")).toMatchObject({
        version: "0.2.0",
        desiredVersion: "1.5.0",
        desiredVersionOverride: "1.5.0",
        updateStatus: "updating",
        failedVersions: ["1.3.0"],
      });

      // Cleared override: the global version again. Older harnesses report nothing.
      expect(await setHarnessDesiredVersion(harnessId, "")).toEqual({ ok: true });
      expect(await desired(accessToken)).toBe("1.4.0");
      const legacy = (await getHarnessOverview(db, orgId, harnessId))!;
      expect(legacy).toMatchObject({ selfUpdate: null, updateState: null, failedVersions: [] });
      expect(harnessRow(legacy, new Date(), "1.4.0").updateStatus).toBe("manual");

      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await setHarnessDesiredVersion(harnessId, "1.6.0")).toEqual({
        ok: false,
        error: expect.any(String),
      });
      await setDesiredHarnessVersion(db, orgId, null, adminId);
    });

    it("tracking latest sends npm's latest, which Update now refreshes", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const supported = { ...HEARTBEAT, selfUpdate: "supported" };
      const respond = async () =>
        (await (await sendHeartbeat(accessToken, supported)).json()) as HeartbeatResponse;

      state.latest = "2.0.0";
      await setDesiredHarnessVersion(db, orgId, "latest", adminId);
      expect((await respond()).desiredVersion).toBe("2.0.0");
      expect(
        harnessRow((await getHarnessOverview(db, orgId, harnessId))!, new Date(), "2.0.0", true),
      ).toMatchObject({ desiredVersion: "2.0.0", tracksLatest: true, updateStatus: "updating" });

      // A new release is picked up once the stored read is old; until then heartbeats agree.
      state.latest = "2.1.0";
      expect((await respond()).desiredVersion).toBe("2.0.0");
      // Update now reads npm at once and records it, so heartbeats don't send the harness back.
      expect(await requestHarnessUpdate(harnessId)).toEqual({ ok: true, version: "2.1.0" });
      expect(await respond()).toMatchObject({
        desiredVersion: "2.1.0",
        updateRequest: { version: "2.1.0" },
      });

      // An override still wins.
      expect(await setHarnessDesiredVersion(harnessId, "1.9.0")).toEqual({ ok: true });
      expect((await respond()).desiredVersion).toBe("1.9.0");

      state.latest = "2.0.0";
      await setDesiredHarnessVersion(db, orgId, null, adminId);
    });

    it("Update now sends an update request until the harness reports it handled", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const respond = async (body: object = HEARTBEAT) =>
        (await (await sendHeartbeat(accessToken, body)).json()) as HeartbeatResponse;
      const supported = { ...HEARTBEAT, selfUpdate: "supported" };

      // Older harnesses and harnesses outside pm2 can't update themselves.
      await respond();
      expect(await requestHarnessUpdate(harnessId)).toEqual({
        ok: false,
        error: expect.any(String),
      });
      expect((await respond(supported)).updateRequest).toBeNull();

      // No version chosen: the latest on npm.
      expect(await requestHarnessUpdate(harnessId)).toEqual({ ok: true, version: "2.0.0" });
      const { updateRequest } = await respond(supported);
      expect(updateRequest).toEqual({ id: expect.any(String), version: "2.0.0" });
      const row = harnessRow((await getHarnessOverview(db, orgId, harnessId))!);
      expect(row).toMatchObject({
        updateRequest: { version: "2.0.0", requestedAt: expect.any(String) },
        updateStatus: "updating",
      });

      // The desired version, even one that failed on the harness.
      expect(await setHarnessDesiredVersion(harnessId, "1.5.0")).toEqual({ ok: true });
      await respond({ ...supported, failedVersions: ["1.5.0"] });
      expect(await requestHarnessUpdate(harnessId)).toEqual({ ok: true, version: "1.5.0" });
      const second = (await respond(supported)).updateRequest;
      expect(second).toEqual({ id: expect.any(String), version: "1.5.0" });
      expect(second!.id).not.toBe(updateRequest!.id);

      // Handled: the request is cleared (an older one doesn't clear it).
      expect(
        (await respond({ ...supported, handledUpdateRequestId: updateRequest!.id })).updateRequest,
      ).toEqual(second);
      expect(
        (await respond({ ...supported, handledUpdateRequestId: second!.id })).updateRequest,
      ).toBeNull();
      expect(
        harnessRow((await getHarnessOverview(db, orgId, harnessId))!).updateRequest,
      ).toBeNull();

      // Nothing to do on the desired version; members can't ask.
      await respond({ ...supported, version: "1.5.0" });
      expect(await requestHarnessUpdate(harnessId)).toEqual({
        ok: false,
        error: expect.stringContaining("already runs 1.5.0"),
      });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await requestHarnessUpdate(harnessId)).toEqual({
        ok: false,
        error: expect.any(String),
      });
    });

    it("pinning enqueues a repo.sync job targeting the harness", async () => {
      const { harnessId } = await enrolledHarness();
      expect(await pinRepository(harnessId, repoB)).toEqual({ ok: true });
      const targeted = await db.select().from(jobs).where(eq(jobs.targetHarnessId, harnessId));
      expect(targeted).toHaveLength(1);
      expect(targeted[0]).toMatchObject({
        type: "repo.sync",
        taskType: "system",
        pool: null,
        status: "queued",
        repositoryId: repoB,
      });
    });

    it("rejects invalid values, unknown task types and pools, and non-admins", async () => {
      const { harnessId } = await enrolledHarness();
      const valid = { maxConcurrency: 2, acceptedTaskTypes: ["review"], poolLimits: {} };
      const invalid: Parameters<typeof updateHarnessConfig>[1][] = [
        { ...valid, maxConcurrency: 0 },
        { ...valid, maxConcurrency: 1.5 },
        { ...valid, acceptedTaskTypes: ["deploy"] },
        { ...valid, acceptedTaskTypes: ["system"] },
        { ...valid, poolLimits: { short: 0 } },
        { ...valid, poolLimits: { short: 3 } },
        { ...valid, poolLimits: { long: 1.5 } },
        { ...valid, poolLimits: { gpu: 1 } },
      ];
      for (const input of invalid) {
        expect(await updateHarnessConfig(harnessId, input)).toMatchObject({ ok: false });
      }
      expect(await updateHarnessConfig(randomUUID(), valid)).toMatchObject({ ok: false });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await updateHarnessConfig(harnessId, valid)).toMatchObject({ ok: false });
      expect(await pinRepository(harnessId, repoA)).toMatchObject({ ok: false });
      const [harness] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      // Unchanged: still inheriting.
      expect(harness!.maxConcurrency).toBeNull();
    });
  });

  describe("settings save", () => {
    it("saves every change in one request and names the ones it didn't save when one fails", async () => {
      const { harnessId } = await enrolledHarness();
      const config = { maxConcurrency: 3, acceptedTaskTypes: ["review"], poolLimits: {} };
      const save = (body: object) => ui(harnessSettings.PUT, harnessId, { method: "PUT", body });

      expect(await save({ config, version: "nope", pin: [repoA] })).toEqual({
        ok: false,
        error:
          "Enter a version like 1.4.0, or leave it blank. Not saved: the desired version and pinned repositories.",
      });
      // What came before the failure is saved; what came after isn't.
      let harness = (await getHarnessOverview(db, orgId, harnessId))!;
      expect(harness).toMatchObject({ maxConcurrency: 3, desiredVersion: null });
      expect(harness.pinnedRepositories).toEqual([]);

      const response = await harnessSettings.PUT(
        new Request("http://localhost/api/ui", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: "1.4.0", pin: [repoA, repoB], unpin: [] }),
        }),
        { params: Promise.resolve({ id: harnessId }) },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; savedAt: string };
      expect(body.ok).toBe(true);
      // The harness has picked it up once a heartbeat is later than `savedAt`.
      expect(Date.parse(body.savedAt)).toBeLessThanOrEqual(Date.now());
      harness = (await getHarnessOverview(db, orgId, harnessId))!;
      expect(harness.desiredVersion).toBe("1.4.0");
      expect(harness.pinnedRepositories.map((repo) => repo.id).sort()).toEqual(
        [repoA, repoB].sort(),
      );

      // A single change keeps its own message.
      expect(await save({ unpin: [randomUUID()] })).toEqual({
        ok: false,
        error: "That repository isn't pinned to this harness.",
      });
      // Other tests expect the repositories unpinned.
      expect(await save({ unpin: [repoA, repoB] })).toEqual({ ok: true });
    });

    it("names the host tool paths it didn't save", async () => {
      const { harnessId } = await enrolledHarness();
      const first = await addHostTool({ name: "ui-save-a" });
      const second = await addHostTool({ name: "ui-save-b" });
      if (!first.ok || !second.ok) throw new Error("setup");
      expect(
        await ui(harnessHostTools.PUT, harnessId, {
          method: "PUT",
          body: {
            paths: [
              { hostToolId: first.hostToolId, path: "/opt/a" },
              { hostToolId: second.hostToolId, path: "relative" },
            ],
          },
        }),
      ).toEqual({
        ok: false,
        error:
          "Enter an absolute path, like /usr/local/bin/semgrep, or leave it blank. Not saved: the ui-save-b path.",
      });
      const tools = await listHarnessHostTools(db, orgId, harnessId);
      expect(Object.fromEntries(tools.map((t) => [t.name, t.configuredPath]))).toMatchObject({
        "ui-save-a": "/opt/a",
        "ui-save-b": null,
      });
      await removeHostTool(first.hostToolId!);
      await removeHostTool(second.hostToolId!);
    });
  });

  describe("install", () => {
    /** The IDs of every job the harness claims now (other tests' system jobs too). */
    async function claimAll(harnessId: string): Promise<string[]> {
      const ids: string[] = [];
      for (;;) {
        const { claim } = await claimJob(db, {
          harnessId,
          organizationId: orgId,
          acceptedTaskTypes: [],
          pools: [],
          harnessVersion: "0.2.0",
          maxDeliveries: 3,
        });
        if (!claim) return ids;
        ids.push(claim.job.id);
      }
    }

    it("enqueues an install RPC only the chosen harness claims", async () => {
      const target = await enrolledHarness();
      const other = await enrolledHarness();
      expect(
        await installInstallable(target.harnessId, {
          name: " @omniralph/hello ",
          version: "1.2.0",
        }),
      ).toEqual({ ok: true });
      // Asking again while it's queued doesn't enqueue a second one.
      expect(
        await installInstallable(target.harnessId, { name: "@omniralph/hello", version: "1.2.0" }),
      ).toEqual({ ok: true });
      const queued = await db.select().from(jobs).where(eq(jobs.targetHarnessId, target.harnessId));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        type: "install",
        taskType: "system",
        pool: null,
        status: "queued",
        payload: { name: "@omniralph/hello", version: "1.2.0" },
      });

      expect(await claimAll(other.harnessId)).not.toContain(queued[0]!.id);
      expect(await claimAll(target.harnessId)).toContain(queued[0]!.id);
    });

    it("stores the installables each heartbeat reports, replacing the last report", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const reported = async () => {
        const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
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

    it("negotiates host tool paths: sends the catalog with configured paths, stores the reports", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const configured = await createHostTool(db, orgId, { name: "hb-configured" });
      const discovered = await createHostTool(db, orgId, { name: "hb-discovered" });
      if (!configured.ok || !discovered.ok) throw new Error("setup");
      expect(
        await setHarnessHostToolPath(db, orgId, harnessId, configured.hostTool.id, "/opt/c/bin/c"),
      ).toEqual({ ok: true });

      const response = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(response.hostTools).toEqual(
        expect.arrayContaining([
          { name: "hb-configured", configuredPath: "/opt/c/bin/c" },
          { name: "hb-discovered", configuredPath: null },
        ]),
      );

      const hostTools = [
        {
          name: "hb-configured",
          configuredPath: "/opt/c/bin/c",
          configuredPathExists: true,
          discoveredPath: "/usr/bin/hb-configured",
        },
        { name: "hb-discovered", configuredPathExists: null, discoveredPath: "/usr/bin/hb-d" },
        { name: "hb-not-in-catalog", configuredPathExists: null, discoveredPath: "/usr/bin/x" },
      ];
      expect((await sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools })).status).toBe(200);
      const stored = await listHarnessHostTools(db, orgId, harnessId);
      expect(stored.filter((tool) => tool.name.startsWith("hb-"))).toEqual([
        expect.objectContaining({
          name: "hb-configured",
          configuredPathExists: true,
          discoveredPath: "/usr/bin/hb-configured",
          effectivePath: "/opt/c/bin/c",
          reportedAt: expect.any(Date),
        }),
        expect.objectContaining({
          name: "hb-discovered",
          configuredPathExists: null,
          discoveredPath: "/usr/bin/hb-d",
          effectivePath: "/usr/bin/hb-d",
        }),
      ]);

      // A heartbeat reporting no host tools: none is usable, configured paths stay.
      expect((await sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools: [] })).status).toBe(200);
      expect(
        (await listHarnessHostTools(db, orgId, harnessId)).filter((tool) =>
          tool.name.startsWith("hb-"),
        ),
      ).toEqual([
        expect.objectContaining({
          configuredPath: "/opt/c/bin/c",
          configuredPathExists: null,
          discoveredPath: null,
          effectivePath: null,
        }),
        expect.objectContaining({ discoveredPath: null, effectivePath: null }),
      ]);

      const tooMany = Array.from({ length: 101 }, (_, i) => ({
        name: `t${i}`,
        configuredPathExists: null,
        discoveredPath: null,
      }));
      expect((await sendHeartbeat(accessToken, { ...HEARTBEAT, hostTools: tooMany })).status).toBe(
        400,
      );
    });

    it("defaults to the latest version", async () => {
      const { harnessId } = await enrolledHarness();
      expect(
        await installInstallable(harnessId, { name: "@omniralph/graph", version: " " }),
      ).toEqual({ ok: true });
      const [job] = await db.select().from(jobs).where(eq(jobs.targetHarnessId, harnessId));
      expect(job!.payload).toEqual({ name: "@omniralph/graph" });
    });

    it("rejects invalid packages and versions, unknown harnesses and members", async () => {
      const { harnessId } = await enrolledHarness();
      expect(await installInstallable(harnessId, { name: "../evil" })).toEqual({
        ok: false,
        error: "That isn't a valid package name.",
      });
      expect(
        await installInstallable(harnessId, { name: "@omniralph/x", version: "npm:evil@1.0.0" }),
      ).toEqual({ ok: false, error: "That isn't a valid version." });
      expect(await installInstallable(randomUUID(), { name: "@omniralph/x" })).toMatchObject({
        ok: false,
      });
      await revokeHarness(harnessId);
      expect(await installInstallable(harnessId, { name: "@omniralph/x" })).toMatchObject({
        ok: false,
      });
      const fresh = await enrolledHarness();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await installInstallable(fresh.harnessId, { name: "@omniralph/x" })).toMatchObject({
        ok: false,
      });
      const none = await db.select().from(jobs).where(eq(jobs.type, "install"));
      expect(
        none.every((j) => j.targetHarnessId !== harnessId && j.targetHarnessId !== fresh.harnessId),
      ).toBe(true);
    });

    it("enqueueInstall targets the harness, dedupes per package and version, and validates", async () => {
      const dispatcher = new PostgresDispatcher({ db });
      const { harnessId } = await enrolledHarness();
      const enqueue = (input: { harnessId?: string; name: string; version?: string }) =>
        enqueueInstall(db, dispatcher, { organizationId: orgId, harnessId, ...input });
      const installJobs = () => db.select().from(jobs).where(eq(jobs.targetHarnessId, harnessId));

      const pinned = await enqueue({ name: "@omniralph/fixture", version: "1.2.0" });
      const latest = await enqueue({ name: "@omniralph/fixture" });
      expect(pinned).toMatchObject({ result: "enqueued", created: true });
      expect(latest).toMatchObject({ result: "enqueued", created: true });
      expect(await enqueue({ name: "@omniralph/fixture" })).toEqual({
        ...latest,
        created: false,
      });
      expect(
        (await installJobs()).map(({ type, taskType, targetHarnessId, dedupeKey }) => ({
          type,
          taskType,
          targetHarnessId,
          dedupeKey,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            type: "install",
            taskType: "system",
            targetHarnessId: harnessId,
            dedupeKey: `install:${harnessId}:@omniralph/fixture@1.2.0`,
          },
          {
            type: "install",
            taskType: "system",
            targetHarnessId: harnessId,
            dedupeKey: `install:${harnessId}:@omniralph/fixture@latest`,
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
        .insert(harnesses)
        .values({ organizationId: otherOrg!.id, name: "foreign" })
        .returning();
      const revoked = await enrolledHarness();
      await revokeHarness(revoked.harnessId);
      for (const id of [randomUUID(), revoked.harnessId, foreign!.id]) {
        expect(await enqueue({ harnessId: id, name: "@omniralph/x" })).toEqual({
          result: "unknown_harness",
        });
      }
      expect(await installJobs()).toHaveLength(2);
      const stray = await db.select().from(jobs).where(eq(jobs.type, "install"));
      expect(
        stray.some((job) => [revoked.harnessId, foreign!.id].includes(job.targetHarnessId ?? "")),
      ).toBe(false);
    });
  });

  describe("host tools", () => {
    async function knownTools(accessToken: string) {
      const response = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      return response.hostTools.filter((tool) => tool.name.startsWith("ui-"));
    }

    it("the catalog and configured paths set by admins reach the harness's next heartbeat", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const added = await addHostTool({ name: "ui-semgrep", description: "SAST" });
      if (!added.ok) throw new Error(added.error);
      const id = added.hostToolId!;
      expect(await knownTools(accessToken)).toEqual([{ name: "ui-semgrep", configuredPath: null }]);

      expect(await setHostToolPath(harnessId, id, " /opt/semgrep/bin/semgrep ")).toEqual({
        ok: true,
      });
      expect(await knownTools(accessToken)).toEqual([
        { name: "ui-semgrep", configuredPath: "/opt/semgrep/bin/semgrep" },
      ]);
      await sendHeartbeat(accessToken, {
        ...HEARTBEAT,
        hostTools: [
          {
            name: "ui-semgrep",
            configuredPath: "/opt/semgrep/bin/semgrep",
            configuredPathExists: true,
            discoveredPath: "/usr/bin/semgrep",
          },
        ],
      });
      const [stored] = (await listHarnessHostTools(db, orgId, harnessId)).filter(
        (tool) => tool.name === "ui-semgrep",
      );
      expect(stored).toMatchObject({
        configuredPath: "/opt/semgrep/bin/semgrep",
        configuredPathExists: true,
        effectivePath: "/opt/semgrep/bin/semgrep",
      });

      // Clearing it: the harness falls back to the path it discovers.
      expect(await setHostToolPath(harnessId, id, "  ")).toEqual({ ok: true });
      expect(await knownTools(accessToken)).toEqual([{ name: "ui-semgrep", configuredPath: null }]);

      // Deleted from the catalog: the harness no longer hears of it.
      expect(await removeHostTool(id)).toEqual({ ok: true });
      expect(await knownTools(accessToken)).toEqual([]);
    });

    it("rejects relative paths, unknown harnesses and tools, revoked harnesses and members", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const added = await addHostTool({ name: "ui-ruff" });
      if (!added.ok) throw new Error(added.error);
      const id = added.hostToolId!;
      expect(await addHostTool({ name: "ui-ruff" })).toEqual({
        ok: false,
        error: "There already is a host tool named ui-ruff.",
      });
      for (const relative of ["bin/ruff", "./ruff", "ruff", "~/bin/ruff"]) {
        expect(await setHostToolPath(harnessId, id, relative)).toEqual({
          ok: false,
          error: "Enter an absolute path, like /usr/local/bin/semgrep, or leave it blank.",
        });
      }
      expect(await setHostToolPath(harnessId, id, `/${"x".repeat(4096)}`)).toMatchObject({
        ok: false,
      });
      const missing = "That harness or host tool doesn't exist, or the harness was revoked.";
      expect(await setHostToolPath(randomUUID(), id, "/usr/bin/ruff")).toEqual({
        ok: false,
        error: missing,
      });
      expect(await setHostToolPath(harnessId, randomUUID(), "/usr/bin/ruff")).toEqual({
        ok: false,
        error: missing,
      });
      expect(await setHostToolPath("not-a-uuid", id, "/usr/bin/ruff")).toEqual({
        ok: false,
        error: missing,
      });

      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await setHostToolPath(harnessId, id, "/usr/bin/ruff")).toMatchObject({ ok: false });
      expect(await addHostTool({ name: "ui-member" })).toMatchObject({ ok: false });
      expect(await removeHostTool(id)).toMatchObject({ ok: false });
      expect(await knownTools(accessToken)).toEqual([{ name: "ui-ruff", configuredPath: null }]);

      state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
      await revokeHarness(harnessId);
      expect(await setHostToolPath(harnessId, id, "/usr/bin/ruff")).toEqual({
        ok: false,
        error: missing,
      });
      expect(await removeHostTool(id)).toEqual({ ok: true });
    });
  });

  describe("revoke", () => {
    it("rejects unexpired tokens, requeues running jobs and removes pins", async () => {
      const { harnessId, accessToken, refreshToken } = await enrolledHarness();
      await pinRepository(harnessId, repoA);
      expect((await sendHeartbeat(accessToken)).status).toBe(200);

      const [running, lastDelivery, canceling, queuedForIt, syncForIt] = await db
        .insert(jobs)
        .values([
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "running",
            harnessId,
            deliveryCount: 1,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "running",
            harnessId,
            deliveryCount: 3,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "running",
            harnessId,
            deliveryCount: 1,
            cancelRequested: true,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "queued",
            repositoryId: repoA,
            targetHarnessId: harnessId,
          },
          {
            organizationId: orgId,
            type: "repo.sync",
            taskType: "system",
            pool: null,
            status: "queued",
            repositoryId: repoA,
            targetHarnessId: harnessId,
          },
        ])
        .returning();
      const jobToken = await getTokenSigner().signJobToken({
        jobId: running!.id,
        harnessId,
        scopes: ["credentials:read"],
      });

      expect(await revokeHarness(harnessId)).toEqual({ ok: true });

      // Its unexpired access token, job token and refresh token are rejected right away.
      expect((await sendHeartbeat(accessToken)).status).toBe(401);
      const jobAuth = await requireJob(
        new Request("http://localhost/api/harness/credentials", {
          method: "POST",
          headers: { authorization: `Bearer ${jobToken}`, "x-real-ip": newIp() },
        }),
        "credentials:read",
      );
      expect((jobAuth as Response).status).toBe(401);
      expect((await token(post("token", { refreshToken }))).status).toBe(401);
      const tokens = await db
        .select()
        .from(harnessRefreshTokens)
        .where(eq(harnessRefreshTokens.harnessId, harnessId));
      expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
      const [harness] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(harness!.revokedAt).not.toBeNull();

      // Running jobs fail as retryable: back to queued for another harness to pick up.
      expect(await jobRow(running!.id)).toMatchObject({
        status: "queued",
        harnessId: null,
        error: "Harness revoked",
      });
      expect(await jobRow(lastDelivery!.id)).toMatchObject({ status: "failed" });
      expect(await jobRow(canceling!.id)).toMatchObject({ status: "canceled" });

      // Jobs only it could claim are redispatched (to any harness now) or skipped.
      expect(await jobRow(queuedForIt!.id)).toMatchObject({
        status: "queued",
        targetHarnessId: null,
      });
      expect(await jobRow(syncForIt!.id)).toMatchObject({ status: "skipped" });

      // Pins removed; audited.
      expect(
        await db.select().from(harnessRepoPins).where(eq(harnessRepoPins.harnessId, harnessId)),
      ).toEqual([]);
      const [audit] = await listHarnessAudit(db, { harnessId, event: "revoke" });
      expect(audit!.detail).toMatchObject({
        revokedBy: adminId,
        requeuedJobIds: [running!.id],
        failedJobIds: [lastDelivery!.id],
        unpinnedRepositoryIds: [repoA],
      });
      expect(audit!.ip).toBe("192.0.2.1");

      // A revoked harness can't be configured or pinned.
      expect(
        await updateHarnessConfig(harnessId, {
          maxConcurrency: 2,
          acceptedTaskTypes: [],
          poolLimits: {},
        }),
      ).toMatchObject({ ok: false });
      expect(await pinRepository(harnessId, repoB)).toMatchObject({ ok: false });
    });

    it("is admin-only and reports unknown harnesses", async () => {
      const { harnessId } = await enrolledHarness();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await revokeHarness(harnessId)).toMatchObject({ ok: false });
      const [harness] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(harness!.revokedAt).toBeNull();
      state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
      expect(await revokeHarness(randomUUID())).toMatchObject({ ok: false });
    });
  });

  describe("delete", () => {
    it("revokes an active harness, then hides it from the harness list", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      await pinRepository(harnessId, repoA);
      const [running] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          type: "review.run",
          taskType: "review",
          pool: "short",
          status: "running",
          harnessId,
          deliveryCount: 1,
        })
        .returning();

      expect(await deleteHarness(harnessId)).toEqual({ ok: true });

      expect((await sendHeartbeat(accessToken)).status).toBe(401);
      const [harness] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(harness!.revokedAt).not.toBeNull();
      expect(harness!.deletedAt).not.toBeNull();
      expect(await jobRow(running!.id)).toMatchObject({ status: "queued", harnessId: null });
      expect(
        await db.select().from(harnessRepoPins).where(eq(harnessRepoPins.harnessId, harnessId)),
      ).toEqual([]);
      expect((await listHarnessOverview(db, orgId)).map((a) => a.id)).not.toContain(harnessId);
      expect(await getHarnessOverview(db, orgId, harnessId)).toBeNull();
      expect(await listHarnessAudit(db, { harnessId, event: "revoke" })).toHaveLength(1);
      const [audit] = await listHarnessAudit(db, { harnessId, event: "delete" });
      expect(audit!.detail).toEqual({ deletedBy: adminId });

      // Gone: it can't be deleted or revoked again.
      expect(await deleteHarness(harnessId)).toMatchObject({ ok: false });
    });

    it("deletes an already revoked harness without revoking it again", async () => {
      const { harnessId } = await enrolledHarness();
      expect(await revokeHarness(harnessId)).toEqual({ ok: true });
      const [before] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(await deleteHarness(harnessId)).toEqual({ ok: true });
      const [after] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(after!.revokedAt).toEqual(before!.revokedAt);
      expect(after!.deletedAt).not.toBeNull();
      expect(await listHarnessAudit(db, { harnessId, event: "revoke" })).toHaveLength(1);
    });

    it("is admin-only and reports unknown harnesses", async () => {
      const { harnessId } = await enrolledHarness();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await deleteHarness(harnessId)).toMatchObject({ ok: false });
      const [harness] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(harness).toMatchObject({ revokedAt: null, deletedAt: null });
      state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
      expect(await deleteHarness(randomUUID())).toMatchObject({ ok: false });
    });
  });

  describe("audit log", () => {
    it("lists the 50 most recent events, newest first", async () => {
      const { harnessId } = await enrolledHarness();
      for (let i = 0; i < 60; i++) {
        await writeHarnessAudit(db, { harnessId, event: "credential_issued", detail: { i } });
      }
      await writeHarnessAudit(db, { harnessId, event: "refresh_reuse" });
      const recent = await listRecentHarnessAudit(db, harnessId, 50);
      expect(recent).toHaveLength(50);
      expect(recent[0]!.event).toBe("refresh_reuse");
      expect(recent[1]!.detail).toEqual({ i: 59 });
      expect(recent.every((e) => e.harnessId === harnessId)).toBe(true);
    });
  });

  describe("cancel job", () => {
    it("cancels queued jobs at once and running ones via the next heartbeat", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const [queued, running, done] = await db
        .insert(jobs)
        .values([
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "queued",
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "running",
            harnessId,
          },
          {
            organizationId: orgId,
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "completed",
            harnessId,
          },
        ])
        .returning();

      expect(await cancelJob(queued!.id)).toEqual({ ok: true });
      expect(await jobRow(queued!.id)).toMatchObject({ status: "canceled" });

      expect(await cancelJob(running!.id)).toMatchObject({ ok: true, warning: expect.any(String) });
      // The Jobs page shows it cancel-requested until its harness confirms.
      expect(await listedJob(running!.id)).toMatchObject({
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
          pool: "short",
          status: "queued",
        })
        .returning();
      // Members cancel jobs too.
      expect(await cancelJob(another!.id)).toEqual({ ok: true });
      expect(await jobRow(another!.id)).toMatchObject({ status: "canceled" });
    });
  });

  describe("rerun job", () => {
    it("queues a failed install again for its harness, and the Jobs page offers it", async () => {
      const { harnessId } = await enrolledHarness();
      const installed = await enqueueInstall(db, new PostgresDispatcher({ db }), {
        organizationId: orgId,
        harnessId,
        name: "@omniralph/rerun-fixture",
      });
      if (installed.result !== "enqueued") throw new Error("not enqueued");
      await db
        .update(jobs)
        .set({ status: "failed", error: "npm failed", finishedAt: new Date() })
        .where(eq(jobs.id, installed.jobId));
      expect(await listedJob(installed.jobId)).toMatchObject({ rerunnable: true });

      const rerun = await rerunJob(installed.jobId);
      expect(rerun).toEqual({ ok: true });
      const copies = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.targetHarnessId, harnessId), eq(jobs.status, "queued")));
      expect(copies).toHaveLength(1);
      const failed = await jobRow(installed.jobId);
      expect(copies[0]).toMatchObject({
        type: failed.type,
        taskType: "system",
        payload: failed.payload,
        dedupeKey: failed.dedupeKey,
      });
      expect(await listedJob(copies[0]!.id)).toMatchObject({ rerunnable: false });
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
