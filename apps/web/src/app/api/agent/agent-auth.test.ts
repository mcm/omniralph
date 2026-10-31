import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  agentRefreshTokens,
  agents,
  createAgentEnrollment,
  closeDb,
  createDb,
  hashToken,
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
import { AGENT_ACCESS_TOKEN_TTL_SECONDS } from "@omniralph/shared";
import { decodeJwt, SignJWT } from "jose";
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
const { requireAgent, requireJob } = await import("@/lib/agent-auth/verify");
const { revokeAgent } = await import("@/lib/agent-auth/revoke");
const { AGENT_REFRESH_TOKEN_TTL_SECONDS, getTokenSigner, LocalTokenSigner } =
  await import("@/lib/agent-auth/signer");

const databaseAvailable = testDatabaseAvailable();

let ipCounter = 0;

// The JWT audience and access-token type before the agent rename.
const OLD_AUDIENCE = "omniralph-harness";
const OLD_TYP = "harness";
// The job token claim that named the agent before the rename.
const OLD_JOB_CLAIM = "harnessId";
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
  return new Request(`http://localhost/api/agent/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: JSON.stringify(body),
  });
}

function authed(accessToken: string, ip: string): Request {
  return new Request("http://localhost/api/agent/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": ip },
  });
}

describe.skipIf(!databaseAvailable)("agent auth", () => {
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
    return (await res.json()) as { agentId: string; refreshToken: string };
  }

  async function refresh(refreshToken: string, ip = newIp()) {
    return token(post("token", { refreshToken }, ip));
  }

  async function accessTokenFor() {
    const { agentId, refreshToken } = await enrollNew();
    const res = await refresh(refreshToken);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    return { agentId, accessToken: body.accessToken, refreshToken: body.refreshToken };
  }

  async function runningJob(agentId: string, status: "running" | "completed" = "running") {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        status,
        agentId,
      })
      .returning({ id: jobs.id });
    return job!.id;
  }

  describe("POST /api/agent/enroll", () => {
    it("consumes the enrollment token, creates the agent and audits it", async () => {
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
      const { agentId, refreshToken } = (await res.json()) as {
        agentId: string;
        refreshToken: string;
      };
      // A signed refresh token of the first generation.
      expect(decodeJwt(refreshToken)).toMatchObject({ typ: "refresh", sub: agentId, gen: 1 });

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      // The agent joins the enrollment's organization.
      expect(agent).toMatchObject({
        organizationId: orgId,
        name: "Build box",
        reportedVersion: "0.1.0",
        revokedAt: null,
        refreshGeneration: 1,
      });
      expect(agent!.refreshTokenIdHash).not.toBe(decodeJwt(refreshToken).jti);

      const audit = await listAgentAudit(db, { agentId, event: "enroll" });
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

  /** A legacy opaque refresh token (from before TOOL-856) for a new agent. */
  async function legacyToken() {
    const { agentId } = await enrollNew();
    const refreshToken = `orr_${randomBytes(32).toString("base64url")}`;
    await db.insert(agentRefreshTokens).values({
      agentId,
      familyId: randomUUID(),
      tokenHash: hashToken(refreshToken),
    });
    return { agentId, refreshToken };
  }

  // Hot state is off here: refreshes rotate in Postgres (`refresh.test.ts` covers Redis).
  describe("POST /api/agent/token", () => {
    it("rotates the refresh token and returns a 15-minute access token", async () => {
      const { agentId, refreshToken } = await enrollNew();
      const ip = newIp();
      const res = await refresh(refreshToken, ip);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accessToken: string;
        expiresIn: number;
        refreshToken: string;
      };
      expect(body.expiresIn).toBe(900);
      const { exp, iat } = decodeJwt(body.accessToken);
      expect(exp! - iat!).toBe(900);
      expect(decodeJwt(body.refreshToken)).toMatchObject({ sub: agentId, gen: 2 });

      const principal = await requireAgent(authed(body.accessToken, ip));
      expect(principal).toEqual({ agentId });

      const next = await refresh(body.refreshToken, ip);
      expect(next.status).toBe(200);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.refreshGeneration).toBe(3);
      const audit = await listAgentAudit(db, { agentId, event: "token_refresh" });
      expect(audit.map((a) => a.detail)).toEqual([{ generation: 1 }, { generation: 2 }]);
    });

    it("revokes the agent when a used refresh token is presented again", async () => {
      const { agentId, refreshToken } = await enrollNew();
      const jobId = await runningJob(agentId);
      const first = (await (await refresh(refreshToken)).json()) as {
        accessToken: string;
        refreshToken: string;
      };

      const reuse = await refresh(refreshToken);
      expect(reuse.status).toBe(401);
      expect(await reuse.json()).toEqual({ error: "refresh_token_reused" });

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).not.toBeNull();
      expect(await listAgentAudit(db, { agentId, event: "refresh_reuse" })).toHaveLength(1);
      // Its running job goes back to the queue for another agent.
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(job).toMatchObject({ status: "queued", agentId: null });

      // The legitimate holder's newer token and access token are dead too: re-enroll.
      expect((await refresh(first.refreshToken)).status).toBe(401);
      expect(await requireAgent(authed(first.accessToken, newIp()))).toBeInstanceOf(Response);
    });

    it("treats another token of the current generation as reuse", async () => {
      const { agentId } = await enrollNew();
      // Signed by us, with the right generation but not the random ID on record.
      const copy = await getTokenSigner().signRefreshToken({
        agentId,
        generation: 1,
        tokenId: "x",
      });
      expect((await refresh(copy)).status).toBe(401);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).not.toBeNull();
    });

    it("accepts a newer generation than recorded once", async () => {
      // Postgres lags behind Redis until the daily flush: the agent's token is newer.
      const { agentId } = await enrollNew();
      const ahead = await getTokenSigner().signRefreshToken({
        agentId,
        generation: 7,
        tokenId: "y",
      });
      const res = await refresh(ahead);
      expect(res.status).toBe(200);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.refreshGeneration).toBe(8);
      // Whoever else holds that token is now behind.
      expect((await refresh(ahead)).status).toBe(401);
    });

    it("treats concurrent presentations of one token as reuse", async () => {
      const { agentId, refreshToken } = await enrollNew();
      const statuses = await Promise.all([refresh(refreshToken), refresh(refreshToken)]).then((r) =>
        r.map((res) => res.status).sort(),
      );
      expect(statuses).toEqual([200, 401]);
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).not.toBeNull();
    });

    it("rejects refresh tokens we didn't sign, access tokens and expired ones", async () => {
      const { agentId, accessToken } = await accessTokenFor();
      const forged = await new LocalTokenSigner({ env: {} }).signRefreshToken({
        agentId,
        generation: 99,
        tokenId: "z",
      });
      const past = new LocalTokenSigner({
        privateKey: SIGNING_KEY,
        env: {},
        now: () => Date.now() - (AGENT_REFRESH_TOKEN_TTL_SECONDS + 1) * 1000,
      });
      const expired = await past.signRefreshToken({ agentId, generation: 99, tokenId: "z" });
      for (const presented of [forged, accessToken, expired, "orr_unknown"]) {
        expect((await refresh(presented)).status).toBe(401);
      }
      // None of them revoked the agent.
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).toBeNull();
    });

    it("redeems a legacy refresh token once for a signed one", async () => {
      const { agentId, refreshToken } = await legacyToken();
      const res = await refresh(refreshToken);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { refreshToken: string };
      expect(decodeJwt(body.refreshToken)).toMatchObject({ sub: agentId, gen: 1 });
      expect((await refresh(body.refreshToken)).status).toBe(200);

      // Presenting the legacy token again is reuse.
      const reuse = await refresh(refreshToken);
      expect(await reuse.json()).toEqual({ error: "refresh_token_reused" });
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.revokedAt).not.toBeNull();
    });
  });

  describe("requireAgent", () => {
    it("rejects missing, malformed and foreign-key tokens", async () => {
      const ip = newIp();
      const noHeader = new Request("http://localhost/api/agent/heartbeat", { method: "POST" });
      expect(((await requireAgent(noHeader)) as Response).status).toBe(401);
      expect(((await requireAgent(authed("not.a.jwt", ip))) as Response).status).toBe(401);

      const { agentId } = await enrollNew();
      const other = new LocalTokenSigner({ env: {} });
      const forged = await other.signAccessToken(agentId);
      expect(((await requireAgent(authed(forged, ip))) as Response).status).toBe(401);
    });

    it("rejects expired tokens", async () => {
      const { agentId } = await enrollNew();
      const past = new LocalTokenSigner({
        privateKey: SIGNING_KEY,
        env: {},
        now: () => Date.now() - (AGENT_ACCESS_TOKEN_TTL_SECONDS + 1) * 1000,
      });
      const res = await requireAgent(authed(await past.signAccessToken(agentId), newIp()));
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(401);
    });

    it("rejects the wrong typ or aud", async () => {
      const { agentId } = await enrollNew();
      const jobId = await runningJob(agentId);
      const ip = newIp();
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        agentId,
        scopes: ["credentials:read"],
      });
      expect(((await requireAgent(authed(jobToken, ip))) as Response).status).toBe(401);

      const sign = (claims: Record<string, unknown>) =>
        new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256" })
          .setIssuedAt()
          .setExpirationTime("15m")
          .sign(privateKey);
      const wrongAud = await sign({ typ: "agent", sub: agentId, aud: "someone-else" });
      expect(((await requireAgent(authed(wrongAud, ip))) as Response).status).toBe(401);
      // Tokens for the old audience (before the agent rename) are no longer accepted.
      const oldAud = await sign({ typ: "agent", sub: agentId, aud: OLD_AUDIENCE });
      expect(((await requireAgent(authed(oldAud, ip))) as Response).status).toBe(401);
      // Nor are access tokens of the old type.
      const oldTyp = await sign({ typ: OLD_TYP, sub: agentId, aud: "omniralph-agent" });
      expect(((await requireAgent(authed(oldTyp, ip))) as Response).status).toBe(401);
      const noTyp = await sign({ sub: agentId, aud: "omniralph-agent" });
      expect(((await requireAgent(authed(noTyp, ip))) as Response).status).toBe(401);
      // Sanity check: the same construction with the right claims passes.
      const ok = await sign({ typ: "agent", sub: agentId, aud: "omniralph-agent" });
      expect(await requireAgent(authed(ok, ip))).toEqual({ agentId });

      // An agent token isn't a job token either.
      const access = await getTokenSigner().signAccessToken(agentId);
      expect(((await requireJob(authed(access, ip), "credentials:read")) as Response).status).toBe(
        401,
      );
    });

    it("rejects a revoked agent's unexpired access token immediately", async () => {
      const { agentId, accessToken, refreshToken } = await accessTokenFor();
      const ip = newIp();
      expect(await requireAgent(authed(accessToken, ip))).toEqual({ agentId });

      expect(await revokeAgent(agentId, { revokedBy: null })).toBe(true);

      const res = await requireAgent(authed(accessToken, ip));
      expect((res as Response).status).toBe(401);
      expect((await refresh(refreshToken)).status).toBe(401);
      const rows = await db
        .select()
        .from(agentRefreshTokens)
        .where(eq(agentRefreshTokens.agentId, agentId));
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(await listAgentAudit(db, { agentId, event: "revoke" })).toHaveLength(1);
    });

    it("samples auth_failed audit rows to one per agent per minute", async () => {
      const { agentId, accessToken } = await accessTokenFor();
      await revokeAgent(agentId);
      for (let i = 0; i < 3; i++) await requireAgent(authed(accessToken, newIp()));
      const failures = await listAgentAudit(db, { agentId, event: "auth_failed" });
      expect(failures).toHaveLength(1);
      expect(failures[0]!.detail).toMatchObject({ reason: "agent_revoked" });
    });
  });

  describe("requireJob", () => {
    it("accepts a running job's token with the right scope", async () => {
      const { agentId } = await enrollNew();
      const jobId = await runningJob(agentId);
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        agentId,
        scopes: ["credentials:read"],
      });
      expect(await requireJob(authed(jobToken, newIp()), "credentials:read")).toEqual({
        jobId,
        agentId,
        scopes: ["credentials:read"],
        // No kind claim: a legacy single token.
        kind: "legacy",
      });
    });

    it("returns a run token's kind and rejects an unknown kind", async () => {
      const { agentId } = await enrollNew();
      const jobId = await runningJob(agentId);
      for (const kind of ["lifecycle", "session"] as const) {
        const token = await getTokenSigner().signJobToken({
          jobId,
          agentId,
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
        agentId,
        scopes: ["credentials:read"],
        kind: "admin" as never,
      });
      const res = await requireJob(authed(forged, newIp()), "credentials:read");
      expect((res as Response).status).toBe(401);
    });

    it("rejects a job token that names its agent by the old harnessId claim", async () => {
      const { agentId } = await enrollNew();
      const jobId = await runningJob(agentId);
      const sign = (claims: Record<string, unknown>) =>
        new SignJWT({ typ: "job", sub: jobId, scopes: ["credentials:read"], ...claims })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuedAt()
          .setExpirationTime("15m")
          .sign(privateKey);
      const old = await sign({ [OLD_JOB_CLAIM]: agentId, aud: "omniralph-agent" });
      expect(
        ((await requireJob(authed(old, newIp()), "credentials:read")) as Response).status,
      ).toBe(401);
      const oldAud = await sign({ agentId, aud: OLD_AUDIENCE });
      expect(
        ((await requireJob(authed(oldAud, newIp()), "credentials:read")) as Response).status,
      ).toBe(401);
      // Sanity check: the same construction with the agent claims passes.
      const ok = await sign({ agentId, aud: "omniralph-agent" });
      expect(await requireJob(authed(ok, newIp()), "credentials:read")).toMatchObject({
        jobId,
        agentId,
      });
    });

    it("rejects the token once the job is no longer running", async () => {
      const { agentId } = await enrollNew();
      const jobId = await runningJob(agentId);
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        agentId,
        scopes: ["credentials:read"],
      });
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, jobId));
      const res = await requireJob(authed(jobToken, newIp()), "credentials:read");
      expect((res as Response).status).toBe(401);
    });

    it("rejects the wrong scope, another agent's job and a revoked agent", async () => {
      const ip = newIp();
      const { agentId } = await enrollNew();
      const jobId = await runningJob(agentId);
      const noScope = await getTokenSigner().signJobToken({ jobId, agentId, scopes: [] });
      expect(((await requireJob(authed(noScope, ip), "credentials:read")) as Response).status).toBe(
        401,
      );

      const { agentId: otherAgent } = await enrollNew();
      const stolen = await getTokenSigner().signJobToken({
        jobId,
        agentId: otherAgent,
        scopes: ["credentials:read"],
      });
      expect(((await requireJob(authed(stolen, ip), "credentials:read")) as Response).status).toBe(
        401,
      );

      const valid = await getTokenSigner().signJobToken({
        jobId,
        agentId,
        scopes: ["credentials:read"],
      });
      await revokeAgent(agentId);
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

    it("limits /token to 30 per minute per agent", async () => {
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
      const { agentId, accessToken } = await accessTokenFor();
      const ip = newIp();
      for (let i = 0; i < 20; i++) {
        expect(((await requireAgent(authed("garbage", ip))) as Response).status).toBe(401);
      }
      const locked = await requireAgent(authed(accessToken, ip));
      expect((locked as Response).status).toBe(429);
      expect(Number((locked as Response).headers.get("retry-after"))).toBeGreaterThan(500);
      expect((await refresh("orr_whatever", ip)).status).toBe(429);
      expect((await enroll(post("enroll", {}, ip))).status).toBe(429);
      // Other IPs are fine.
      expect(await requireAgent(authed(accessToken, newIp()))).toEqual({ agentId });
    });

    it("doesn't lock an IP out for stale tokens it issued (TOOL-136)", async () => {
      const { agentId, accessToken } = await accessTokenFor();
      const ip = newIp();
      // A job token still used after its job was canceled, and an expired access token:
      // both carry our signature, so they're stale clients, not guessing attempts.
      const jobId = await runningJob(agentId);
      const jobToken = await getTokenSigner().signJobToken({
        jobId,
        agentId,
        scopes: ["credentials:read"],
      });
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, jobId));
      const past = new LocalTokenSigner({
        privateKey: SIGNING_KEY,
        env: {},
        now: () => Date.now() - (AGENT_ACCESS_TOKEN_TTL_SECONDS + 1) * 1000,
      });
      const expired = await past.signAccessToken(agentId);
      for (let i = 0; i < 30; i++) {
        const res = await requireJob(authed(jobToken, ip), "credentials:read");
        expect((res as Response).status).toBe(401);
        expect(((await requireAgent(authed(expired, ip))) as Response).status).toBe(401);
      }
      // Agents behind that IP can still poll.
      expect(await requireAgent(authed(accessToken, ip))).toEqual({ agentId });
    });
  });
});
