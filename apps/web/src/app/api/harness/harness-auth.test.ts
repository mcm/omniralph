import { generateKeyPairSync } from "node:crypto";
import {
  agentRefreshTokens,
  agents,
  createAgentEnrollment,
  closeDb,
  createDb,
  jobs,
  listAgentAudit,
  organizations,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = SIGNING_KEY;

const { POST: enroll } = await import("./enroll/route");
const { POST: token } = await import("./token/route");
const { requireHarness, requireJob } = await import("@/lib/harness-auth/verify");
const { revokeAgent } = await import("@/lib/harness-auth/revoke");
const { getTokenSigner, LocalTokenSigner } = await import("@/lib/harness-auth/signer");

const databaseAvailable = testDatabaseAvailable();

let ipCounter = 0;

// The JWT audience before the harness rename, spelled out so the old name stays out of greps for leftovers.
const OLD_AUDIENCE = ["omniralph", "agent"].join("-");
const RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * Loops of sequential token requests (RSA signing + DB transactions) take ~0.5s alone, but
 * can pass the default 5s test timeout when every package's suite runs at once.
 */
const RATE_LIMIT_TEST_TIMEOUT_MS = 30_000;

/** One second into the next one-minute rate-limit window, from the (possibly faked) clock. */
function nextWindowStart(): number {
  return (Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) + 1) * RATE_LIMIT_WINDOW_MS + 1000;
}

/** A fresh client IP per test, so rate limits and lockouts don't leak between tests. */
function newIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function post(path: string, body: unknown, ip: string): Request {
  return new Request(`http://localhost/api/harness/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: JSON.stringify(body),
  });
}

function authed(accessToken: string, ip: string): Request {
  return new Request("http://localhost/api/harness/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": ip },
  });
}

describe.skipIf(!databaseAvailable)("harness auth", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    // Rate limits use fixed windows: freeze the clock just after a window starts so a
    // test can't straddle a window boundary.
    vi.useFakeTimers({ toFake: ["Date"], now: nextWindowStart() });
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function enrollNew(ip = newIp()) {
    const enrollment = await createAgentEnrollment(db, { organizationId: orgId, name: null });
    const res = await enroll(
      post(
        "enroll",
        {
          enrollmentToken: enrollment.token,
          name: "coder-1",
          version: "0.1.0",
        },
        ip,
      ),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { harnessId: string; refreshToken: string };
  }

  async function refresh(refreshToken: string, ip = newIp()) {
    return token(post("token", { refreshToken }, ip));
  }

  async function accessTokenFor() {
    const { harnessId, refreshToken } = await enrollNew();
    const res = await refresh(refreshToken);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    return { harnessId, accessToken: body.accessToken, refreshToken: body.refreshToken };
  }

  async function runningJob(harnessId: string, status: "running" | "completed" = "running") {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        status,
        agentId: harnessId,
      })
      .returning({ id: jobs.id });
    return job!.id;
  }

  describe("POST /api/harness/enroll", () => {
    it("consumes the enrollment token, creates the harness and audits it", async () => {
      const enrollment = await createAgentEnrollment(db, {
        organizationId: orgId,
        name: "Build box",
      });
      const ip = newIp();
      const body = {
        enrollmentToken: enrollment.token,
        name: "coder-1",
        version: "0.1.0",
      };
      const res = await enroll(post("enroll", body, ip));
      expect(res.status).toBe(200);
      const { harnessId, refreshToken } = (await res.json()) as {
        harnessId: string;
        refreshToken: string;
      };
      expect(refreshToken).toMatch(/^orr_[\w-]{43}$/);

      const [agent] = await db.select().from(agents).where(eq(agents.id, harnessId));
      // The harness joins the enrollment's organization.
      expect(agent).toMatchObject({
        organizationId: orgId,
        name: "Build box",
        reportedVersion: "0.1.0",
        revokedAt: null,
      });
      const tokens = await db
        .select()
        .from(agentRefreshTokens)
        .where(eq(agentRefreshTokens.agentId, harnessId));
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.tokenHash).not.toContain(refreshToken);

      const audit = await listAgentAudit(db, { agentId: harnessId, event: "enroll" });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.ip).toBe(ip);

      // Single use.
      const again = await enroll(post("enroll", body, ip));
      expect(again.status).toBe(401);
    });

    it("rejects expired and unknown enrollment tokens", async () => {
      const expired = await createAgentEnrollment(db, {
        organizationId: orgId,
        now: new Date(Date.now() - 61 * 60 * 1000),
      });
      const base = { name: "x", version: "0.1.0" };
      const ip = newIp();
      expect(
        (await enroll(post("enroll", { ...base, enrollmentToken: expired.token }, ip))).status,
      ).toBe(401);
      expect(
        (await enroll(post("enroll", { ...base, enrollmentToken: "ore_nope" }, ip))).status,
      ).toBe(401);
      expect((await enroll(post("enroll", { name: "x" }, ip))).status).toBe(400);
    });
  });

  describe("POST /api/harness/token", () => {
    it("rotates the refresh token and returns a 15-minute access token", async () => {
      const { harnessId, refreshToken } = await enrollNew();
      const ip = newIp();
      const res = await refresh(refreshToken, ip);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accessToken: string;
        expiresIn: number;
        refreshToken: string;
      };
      expect(body.expiresIn).toBe(900);
      expect(body.refreshToken).not.toBe(refreshToken);

      const principal = await requireHarness(authed(body.accessToken, ip));
      expect(principal).toEqual({ harnessId });

      // The new token works and belongs to the same family.
      const next = await refresh(body.refreshToken, ip);
      expect(next.status).toBe(200);
      const rows = await db
        .select()
        .from(agentRefreshTokens)
        .where(eq(agentRefreshTokens.agentId, harnessId));
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
      expect(rows.filter((r) => r.usedAt === null)).toHaveLength(1);
      expect(await listAgentAudit(db, { agentId: harnessId, event: "token_refresh" })).toHaveLength(
        2,
      );
    });

    it("revokes the family and the harness when a used refresh token is presented again", async () => {
      const { harnessId, refreshToken } = await enrollNew();
      const first = (await (await refresh(refreshToken)).json()) as {
        accessToken: string;
        refreshToken: string;
      };

      const reuse = await refresh(refreshToken);
      expect(reuse.status).toBe(401);
      expect(await reuse.json()).toEqual({ error: "refresh_token_reused" });

      const [agent] = await db.select().from(agents).where(eq(agents.id, harnessId));
      expect(agent!.revokedAt).not.toBeNull();
      const rows = await db
        .select()
        .from(agentRefreshTokens)
        .where(eq(agentRefreshTokens.agentId, harnessId));
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(await listAgentAudit(db, { agentId: harnessId, event: "refresh_reuse" })).toHaveLength(
        1,
      );

      // The legitimate holder's newer token and access token are dead too: re-enroll.
      expect((await refresh(first.refreshToken)).status).toBe(401);
      expect(await requireHarness(authed(first.accessToken, newIp()))).toBeInstanceOf(Response);
    });

    it("treats concurrent presentations of one token as reuse", async () => {
      const { harnessId, refreshToken } = await enrollNew();
      const statuses = await Promise.all([refresh(refreshToken), refresh(refreshToken)]).then((r) =>
        r.map((res) => res.status).sort(),
      );
      expect(statuses).toEqual([200, 401]);
      const [agent] = await db.select().from(agents).where(eq(agents.id, harnessId));
      expect(agent!.revokedAt).not.toBeNull();
    });

    it("rejects unknown refresh tokens", async () => {
      expect((await refresh("orr_unknown")).status).toBe(401);
    });
  });

  describe("requireHarness", () => {
    it("rejects missing, malformed and foreign-key tokens", async () => {
      const ip = newIp();
      const noHeader = new Request("http://localhost/api/harness/heartbeat", { method: "POST" });
      expect(((await requireHarness(noHeader)) as Response).status).toBe(401);
      expect(((await requireHarness(authed("not.a.jwt", ip))) as Response).status).toBe(401);

      const { harnessId } = await enrollNew();
      const other = new LocalTokenSigner({ env: {} });
      const forged = await other.signAccessToken(harnessId);
      expect(((await requireHarness(authed(forged, ip))) as Response).status).toBe(401);
    });

    it("rejects expired tokens", async () => {
      const { harnessId } = await enrollNew();
      const past = new LocalTokenSigner({
        privateKey: SIGNING_KEY,
        env: {},
        now: () => Date.now() - 901_000,
      });
      const res = await requireHarness(authed(await past.signAccessToken(harnessId), newIp()));
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(401);
    });

    it("rejects the wrong typ or aud", async () => {
      const { harnessId } = await enrollNew();
      const jobId = await runningJob(harnessId);
      const ip = newIp();
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        harnessId,
        scopes: ["credentials:read"],
      });
      expect(((await requireHarness(authed(jobToken, ip))) as Response).status).toBe(401);

      const sign = (claims: Record<string, unknown>) =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256" })
          .setIssuedAt()
          .setExpirationTime("15m")
          .sign(privateKey);
      const wrongAud = await sign({ typ: "harness", sub: harnessId, aud: "someone-else" });
      expect(((await requireHarness(authed(wrongAud, ip))) as Response).status).toBe(401);
      // Tokens for the old audience (before the harness rename) are no longer accepted.
      const oldAud = await sign({ typ: "harness", sub: harnessId, aud: OLD_AUDIENCE });
      expect(((await requireHarness(authed(oldAud, ip))) as Response).status).toBe(401);
      // Nor are access tokens of the old type.
      const oldTyp = await sign({ typ: "agent", sub: harnessId, aud: "omniralph-harness" });
      expect(((await requireHarness(authed(oldTyp, ip))) as Response).status).toBe(401);
      const noTyp = await sign({ sub: harnessId, aud: "omniralph-harness" });
      expect(((await requireHarness(authed(noTyp, ip))) as Response).status).toBe(401);
      // Sanity check: the same construction with the right claims passes.
      const ok = await sign({ typ: "harness", sub: harnessId, aud: "omniralph-harness" });
      expect(await requireHarness(authed(ok, ip))).toEqual({ harnessId });

      // A harness token isn't a job token either.
      const access = await getTokenSigner().signAccessToken(harnessId);
      expect(((await requireJob(authed(access, ip), "credentials:read")) as Response).status).toBe(
        401,
      );
    });

    it("rejects a revoked harness's unexpired access token immediately", async () => {
      const { harnessId, accessToken, refreshToken } = await accessTokenFor();
      const ip = newIp();
      expect(await requireHarness(authed(accessToken, ip))).toEqual({ harnessId });

      expect(await revokeAgent(harnessId, { revokedBy: null })).toBe(true);

      const res = await requireHarness(authed(accessToken, ip));
      expect((res as Response).status).toBe(401);
      expect((await refresh(refreshToken)).status).toBe(401);
      const rows = await db
        .select()
        .from(agentRefreshTokens)
        .where(eq(agentRefreshTokens.agentId, harnessId));
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(await listAgentAudit(db, { agentId: harnessId, event: "revoke" })).toHaveLength(1);
    });

    it("samples auth_failed audit rows to one per harness per minute", async () => {
      const { harnessId, accessToken } = await accessTokenFor();
      await revokeAgent(harnessId);
      for (let i = 0; i < 3; i++) await requireHarness(authed(accessToken, newIp()));
      const failures = await listAgentAudit(db, { agentId: harnessId, event: "auth_failed" });
      expect(failures).toHaveLength(1);
      expect(failures[0]!.detail).toMatchObject({ reason: "agent_revoked" });
    });
  });

  describe("requireJob", () => {
    it("accepts a running job's token with the right scope", async () => {
      const { harnessId } = await enrollNew();
      const jobId = await runningJob(harnessId);
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        harnessId,
        scopes: ["credentials:read"],
      });
      expect(await requireJob(authed(jobToken, newIp()), "credentials:read")).toEqual({
        jobId,
        harnessId,
        scopes: ["credentials:read"],
        // No kind claim: a legacy single token.
        kind: "legacy",
      });
    });

    it("returns a run token's kind and rejects an unknown kind", async () => {
      const { harnessId } = await enrollNew();
      const jobId = await runningJob(harnessId);
      for (const kind of ["lifecycle", "session"] as const) {
        const token = await getTokenSigner().signJobToken({
          jobId,
          harnessId,
          scopes: ["credentials:read"],
          kind,
        });
        expect(await requireJob(authed(token, newIp()), "credentials:read")).toMatchObject({
          jobId,
          kind,
        });
      }
      const forged = await getTokenSigner().signJobToken({
        jobId,
        harnessId,
        scopes: ["credentials:read"],
        kind: "admin" as never,
      });
      const res = await requireJob(authed(forged, newIp()), "credentials:read");
      expect((res as Response).status).toBe(401);
    });

    it("rejects the token once the job is no longer running", async () => {
      const { harnessId } = await enrollNew();
      const jobId = await runningJob(harnessId);
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        harnessId,
        scopes: ["credentials:read"],
      });
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, jobId));
      const res = await requireJob(authed(jobToken, newIp()), "credentials:read");
      expect((res as Response).status).toBe(401);
    });

    it("rejects the wrong scope, another harness's job and a revoked harness", async () => {
      const ip = newIp();
      const { harnessId } = await enrollNew();
      const jobId = await runningJob(harnessId);
      const noScope = await getTokenSigner().signJobToken({ jobId, harnessId, scopes: [] });
      expect(((await requireJob(authed(noScope, ip), "credentials:read")) as Response).status).toBe(
        401,
      );

      const { harnessId: otherAgent } = await enrollNew();
      const stolen = await getTokenSigner().signJobToken({
        jobId,
        harnessId: otherAgent,
        scopes: ["credentials:read"],
      });
      expect(((await requireJob(authed(stolen, ip), "credentials:read")) as Response).status).toBe(
        401,
      );

      const valid = await getTokenSigner().signJobToken({
        jobId,
        harnessId,
        scopes: ["credentials:read"],
      });
      await revokeAgent(harnessId);
      expect(((await requireJob(authed(valid, ip), "credentials:read")) as Response).status).toBe(
        401,
      );
    });
  });

  describe("rate limits", { timeout: RATE_LIMIT_TEST_TIMEOUT_MS }, () => {
    // Each test gets its own fresh, frozen window: counters from earlier tests can't leak in,
    // and however slow the run, the window can't roll over mid-test.
    beforeEach(() => {
      vi.setSystemTime(nextWindowStart());
    });

    it("limits /enroll to 10 per minute per IP", async () => {
      const ip = newIp();
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        statuses.push((await enroll(post("enroll", {}, ip))).status);
      }
      expect(statuses.every((s) => s === 400)).toBe(true);
      const res = await enroll(post("enroll", {}, ip));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another IP isn't affected.
      expect((await enroll(post("enroll", {}, newIp()))).status).toBe(400);
    });

    it("limits /token to 60 per minute per IP", async () => {
      const ip = newIp();
      const statuses = [];
      for (let i = 0; i < 61; i++) statuses.push((await token(post("token", {}, ip))).status);
      expect(statuses.slice(0, 60).every((s) => s === 400)).toBe(true);
      expect(statuses[60]).toBe(429);
    });

    it("limits /token to 30 per minute per harness", async () => {
      let { refreshToken } = await enrollNew();
      for (let i = 0; i < 30; i++) {
        const res = await refresh(refreshToken);
        expect(res.status).toBe(200);
        ({ refreshToken } = (await res.json()) as { refreshToken: string });
      }
      const limited = await refresh(refreshToken);
      expect(limited.status).toBe(429);
      // Still the same window: the limit holds even if the loop above was slow.
      expect(Number(limited.headers.get("retry-after"))).toBe(59);
    });

    it("locks an IP out for 10 minutes after 20 failed auth attempts", async () => {
      const { harnessId, accessToken } = await accessTokenFor();
      const ip = newIp();
      for (let i = 0; i < 20; i++) {
        expect(((await requireHarness(authed("garbage", ip))) as Response).status).toBe(401);
      }
      const locked = await requireHarness(authed(accessToken, ip));
      expect((locked as Response).status).toBe(429);
      expect(Number((locked as Response).headers.get("retry-after"))).toBeGreaterThan(500);
      expect((await refresh("orr_whatever", ip)).status).toBe(429);
      expect((await enroll(post("enroll", {}, ip))).status).toBe(429);
      // Other IPs are fine.
      expect(await requireHarness(authed(accessToken, newIp()))).toEqual({ harnessId });
    });

    it("doesn't lock an IP out for stale tokens it issued (TOOL-136)", async () => {
      const { harnessId, accessToken } = await accessTokenFor();
      const ip = newIp();
      // A job token still used after its job was canceled, and an expired access token:
      // both carry our signature, so they're stale clients, not guessing attempts.
      const jobId = await runningJob(harnessId);
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        harnessId,
        scopes: ["credentials:read"],
      });
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, jobId));
      const past = new LocalTokenSigner({
        privateKey: SIGNING_KEY,
        env: {},
        now: () => Date.now() - 901_000,
      });
      const expired = await past.signAccessToken(harnessId);
      for (let i = 0; i < 30; i++) {
        const res = await requireJob(authed(jobToken, ip), "credentials:read");
        expect((res as Response).status).toBe(401);
        expect(((await requireHarness(authed(expired, ip))) as Response).status).toBe(401);
      }
      // Harnesses behind that IP can still poll.
      expect(await requireHarness(authed(accessToken, ip))).toEqual({ harnessId });
    });
  });
});
