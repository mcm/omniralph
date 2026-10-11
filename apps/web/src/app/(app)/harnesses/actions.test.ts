import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  harnessRefreshTokens,
  harnessRepoPins,
  harnesses,
  connectRepository,
  closeDb,
  createDb,
  getHarnessOverview,
  jobs,
  listHarnessAudit,
  listHarnessOverview,
  listRecentHarnessAudit,
  runMigrations,
  setDesiredHarnessVersion,
  upsertScmConnection,
  users,
  writeHarnessAudit,
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

const {
  createEnrollment,
  deleteHarness,
  pinRepository,
  requestHarnessUpdate,
  revokeHarness,
  setHarnessDesiredVersion,
  unpinRepository,
  updateHarnessConfig,
} = await import("./actions");
const { harnessRow } = await import("@/lib/harnesses/rows");
const { cancelJob } = await import("../jobs/actions");
const { POST: enroll } = await import("@/app/api/harness/enroll/route");
const { POST: token } = await import("@/app/api/harness/token/route");
const { POST: heartbeat } = await import("@/app/api/harness/heartbeat/route");
const { requireJob } = await import("@/lib/harness-auth/verify");
const { getTokenSigner } = await import("@/lib/harness-auth/signer");

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

const HEARTBEAT = { version: "0.2.0", capabilities: ["review"], runningJobIds: [], freeSlots: 1 };

describe.skipIf(!dockerAvailable)("harnesses and jobs pages: server actions", () => {
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
      expect(await createEnrollment("x")).toEqual({ ok: false, error: expect.any(String) });
    });
  });

  describe("central configuration", () => {
    it("reaches the harness in its next heartbeat response", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const before = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(before).toMatchObject({
        maxConcurrency: 1,
        pollIntervalSeconds: 5,
        acceptedTaskTypes: ["query", "review"],
        pinnedRepoIds: [],
      });

      expect(
        await updateHarnessConfig(harnessId, {
          maxConcurrency: 4,
          enabledCapabilities: [],
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

    it("enabling ralph reaches the harness's accepted task types", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const before = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(before.acceptedTaskTypes).toEqual(["query", "review"]);

      expect(
        await updateHarnessConfig(harnessId, {
          maxConcurrency: 1,
          enabledCapabilities: ["review", "ralph"],
        }),
      ).toEqual({ ok: true });
      const after = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(after.acceptedTaskTypes).toEqual(["query", "review", "coding"]);
      expect(after.topics).toEqual([]);
    });

    it("sends the effective per-pool limits and stores the edited ones", async () => {
      const { harnessId, accessToken } = await enrolledHarness();
      const initial = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(initial.poolLimits).toEqual({ short: 1, long: 1 });

      // Unset: the long pool leaves one slot for short jobs.
      const config = {
        maxConcurrency: 3,
        enabledCapabilities: ["review", "ralph"],
      };
      expect(await updateHarnessConfig(harnessId, config)).toEqual({ ok: true });
      const defaults = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(defaults.poolLimits).toEqual({ short: 3, long: 2 });

      expect(
        await updateHarnessConfig(harnessId, {
          ...config,
          capabilityLimits: { ralph: 1, review: 3 },
        }),
      ).toEqual({ ok: true });
      const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(row!.capabilityLimits).toEqual({ ralph: 1, review: 3 });
      expect(row!.poolLimits).toEqual({ long: 1, short: 3 });
      const limited = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(limited.poolLimits).toEqual({ short: 3, long: 1 });

      // Saving without limits keeps them; lowering maxConcurrency clamps the effective values.
      expect(
        await updateHarnessConfig(harnessId, {
          ...config,
          maxConcurrency: 2,
          capabilityLimits: undefined,
        }),
      ).toEqual({ ok: true });
      const clamped = (await (await sendHeartbeat(accessToken)).json()) as HeartbeatResponse;
      expect(clamped.poolLimits).toEqual({ short: 2, long: 1 });
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
        capability: "system",
        type: "repo.sync",
        taskType: "system",
        pool: null,
        status: "queued",
        repositoryId: repoB,
      });
    });

    it("rejects invalid values, unknown capabilities and non-admins", async () => {
      const { harnessId } = await enrolledHarness();
      const valid = { maxConcurrency: 2, enabledCapabilities: ["review"] };
      const invalid: Parameters<typeof updateHarnessConfig>[1][] = [
        { ...valid, maxConcurrency: 0 },
        { ...valid, maxConcurrency: 1.5 },
        { ...valid, enabledCapabilities: ["deploy"] },
        { ...valid, capabilityLimits: { review: 0 } },
        { ...valid, capabilityLimits: { review: 3 } },
        { ...valid, capabilityLimits: { review: 1.5 } },
        { ...valid, capabilityLimits: { ralph: 1 } },
        { ...valid, capabilityLimits: { deploy: 1 } },
      ];
      for (const input of invalid) {
        expect(await updateHarnessConfig(harnessId, input)).toMatchObject({ ok: false });
      }
      expect(await updateHarnessConfig(randomUUID(), valid)).toMatchObject({ ok: false });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await updateHarnessConfig(harnessId, valid)).toMatchObject({ ok: false });
      expect(await pinRepository(harnessId, repoA)).toMatchObject({ ok: false });
      const [harness] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      expect(harness!.maxConcurrency).toBe(1);
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
            capability: "review",
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "running",
            harnessId,
            deliveryCount: 1,
          },
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "running",
            harnessId,
            deliveryCount: 3,
          },
          {
            organizationId: orgId,
            capability: "review",
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
            capability: "review",
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "queued",
            repositoryId: repoA,
            targetHarnessId: harnessId,
          },
          {
            organizationId: orgId,
            capability: "system",
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
          enabledCapabilities: [],
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
          capability: "review",
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
            capability: "review",
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "queued",
          },
          {
            organizationId: orgId,
            capability: "review",
            type: "review.run",
            taskType: "review",
            pool: "short",
            status: "running",
            harnessId,
          },
          {
            organizationId: orgId,
            capability: "review",
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
          taskType: "review",
          pool: "short",
          status: "queued",
        })
        .returning();
      expect(await cancelJob(another!.id)).toMatchObject({ ok: false });
      expect(await jobRow(another!.id)).toMatchObject({ status: "queued" });
    });
  });
});
