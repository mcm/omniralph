import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectionCredentials,
  connectRepository,
  createDb,
  organizations,
  scmConnections,
  updateScmConnectionCredentials,
  upsertScmConnection,
  type Database,
  type ScmConnection,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET } = await import("./gitlab-maintenance/route");

const databaseAvailable = testDatabaseAvailable();

const HEALTHY = "https://healthy.gitlab.example.com";
const BROKEN = "https://broken.gitlab.example.com";
const hookRequests: string[] = [];

/** The HEALTHY instance's bot: its current token (older ones are revoked) and expiry. */
let gitlab: {
  token: string;
  expiresAt: string;
  username: string;
  rotations: number;
  rotateStatus: number;
  rotateMessage: string;
};

const unauthorized = () => HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 });
const authorized = (request: Request) => request.headers.get("private-token") === gitlab.token;

const server = setupServer(
  http.all(`${HEALTHY}/api/v4/projects/:id/hooks*`, ({ request }) => {
    hookRequests.push(`${request.method} ${new URL(request.url).pathname}`);
  }),
  http.all(`${HEALTHY}/*`, ({ request }) => (authorized(request) ? undefined : unauthorized())),
  http.get(`${HEALTHY}/api/v4/user`, () =>
    HttpResponse.json({ id: 42, username: gitlab.username, name: "Omniralph" }),
  ),
  http.get(`${HEALTHY}/api/v4/personal_access_tokens/self`, () =>
    HttpResponse.json({ id: 7, scopes: ["api"], expires_at: gitlab.expiresAt }),
  ),
  http.post(`${HEALTHY}/api/v4/personal_access_tokens/self/rotate`, async ({ request }) => {
    const { expires_at } = (await request.json()) as { expires_at: string };
    // Slow enough for a concurrent run to list the connection meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (gitlab.rotateStatus !== 200) {
      return HttpResponse.json({ message: gitlab.rotateMessage }, { status: gitlab.rotateStatus });
    }
    gitlab.rotations += 1;
    gitlab.token = `glpat-rotated-${gitlab.rotations}`;
    gitlab.expiresAt = expires_at;
    return HttpResponse.json({ id: 7 + gitlab.rotations, token: gitlab.token, expires_at });
  }),
  http.get(`${HEALTHY}/api/v4/projects/10/hooks/100`, () =>
    HttpResponse.json({
      id: 100,
      merge_requests_events: true,
      note_events: true,
      pipeline_events: true,
      enable_ssl_verification: true,
    }),
  ),
  http.get(`${HEALTHY}/api/v4/projects/11/hooks/101`, () =>
    HttpResponse.json({ message: "404 Not Found" }, { status: 404 }),
  ),
  http.get(`${BROKEN}/api/v4/user`, () => HttpResponse.json({ message: "boom" }, { status: 500 })),
);

/** Today (UTC) + 7 days, the expiry rotated tokens get. */
const inAWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const cron = (secret?: string) =>
  GET(
    new Request("http://localhost/api/cron/gitlab-maintenance", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
  );

describe.skipIf(!databaseAvailable)("GET /api/cron/gitlab-maintenance", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    server.listen({ onUnhandledFrame: "error" });
  }, 120_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    hookRequests.length = 0;
    gitlab = {
      token: "glpat-bot",
      expiresAt: "2099-01-01",
      username: "service_account_group_12_omniralph",
      rotations: 0,
      rotateStatus: 200,
      rotateMessage: "",
    };
  });

  afterEach(async () => {
    await db.delete(scmConnections);
  });

  async function gitlabConnection(baseUrl: string, externalId: string): Promise<ScmConnection> {
    const connection = await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: `bot @ ${new URL(baseUrl).host}`,
      baseUrl,
      externalId,
      credentials: { token: "glpat-bot", webhookSecret: "secret" },
    });
    return connection!;
  }

  async function rowOf(id: string) {
    const [row] = await db.select().from(scmConnections).where(eq(scmConnections.id, id));
    return row!;
  }

  async function healthOf(id: string) {
    return (await rowOf(id)).health;
  }

  async function tokenOf(id: string) {
    return connectionCredentials<{ token: string; webhookSecret: string }>(await rowOf(id));
  }

  it("requires the cron secret", async () => {
    const connection = await gitlabConnection(HEALTHY, "42");
    expect((await cron()).status).toBe(401);
    expect((await cron("wrong")).status).toBe(401);
    expect(await healthOf(connection.id)).toBeNull();
  });

  it("replaces each connection's health; one failing check doesn't stop the others", async () => {
    const broken = await gitlabConnection(BROKEN, "1");
    const healthy = await gitlabConnection(HEALTHY, "42");
    const stale = { checkedAt: "2026-01-01T00:00:00.000Z", tokenExpiresAt: null, problems: [] };
    await db
      .update(scmConnections)
      .set({
        health: {
          ...stale,
          problems: [{ code: "token_invalid", message: "Old problem" }],
        },
      })
      .where(eq(scmConnections.id, healthy.id));
    await db.update(scmConnections).set({ health: stale }).where(eq(scmConnections.id, broken.id));
    const web = await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "10",
      fullPath: "acme/web",
      webhookId: "100",
    });
    const api = await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "11",
      fullPath: "acme/api",
      webhookId: "101",
    });
    // Disabled projects aren't checked.
    await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "12",
      fullPath: "acme/off",
      reviewsEnabled: false,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await cron("cron-secret");

    expect(await res.json()).toEqual({ rotated: 1, checked: 1, problems: 1, failed: 1 });
    // The broken connection's rotation and its check.
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
    const health = await healthOf(healthy.id);
    expect(health).toEqual({
      checkedAt: expect.any(String),
      tokenExpiresAt: inAWeek(),
      problems: [{ code: "webhook_missing", message: expect.any(String), repositoryId: api.id }],
    });
    expect(health!.problems.some((p) => p.repositoryId === web.id)).toBe(false);
    // The failed check keeps the previous health, plus the failed rotation.
    expect(await healthOf(broken.id)).toEqual({
      ...stale,
      problems: [{ code: "rotation_failed", message: "Rotating the bot token failed: boom" }],
    });
    expect(hookRequests.sort()).toEqual([
      "GET /api/v4/projects/10/hooks/100",
      "GET /api/v4/projects/11/hooks/101",
    ]);
  });

  it("records an empty problem list for a healthy connection", async () => {
    const healthy = await gitlabConnection(HEALTHY, "42");
    await connectRepository(db, {
      connectionId: healthy.id,
      provider: "gitlab",
      externalId: "10",
      fullPath: "acme/web",
      webhookId: "100",
    });
    expect(await (await cron("cron-secret")).json()).toEqual({
      rotated: 1,
      checked: 1,
      problems: 0,
      failed: 0,
    });
    expect(await healthOf(healthy.id)).toMatchObject({
      tokenExpiresAt: inAWeek(),
      problems: [],
    });
  });

  describe("bot token rotation", () => {
    it("rotates the token to expire in 7 days and stores it before the check", async () => {
      const connection = await gitlabConnection(HEALTHY, "42");

      expect(await (await cron("cron-secret")).json()).toEqual({
        rotated: 1,
        checked: 1,
        problems: 0,
        failed: 0,
      });

      expect(gitlab.rotations).toBe(1);
      expect(await tokenOf(connection.id)).toEqual({
        token: "glpat-rotated-1",
        webhookSecret: "secret",
        rotatedAt: expect.any(String),
      });
      // The check ran with the new token (the old one is revoked).
      expect(await healthOf(connection.id)).toMatchObject({
        tokenExpiresAt: inAWeek(),
        problems: [],
      });
    });

    it("rotates a connection once when two runs overlap", async () => {
      const connection = await gitlabConnection(HEALTHY, "42");

      const [first, second] = await Promise.all([cron("cron-secret"), cron("cron-secret")]);
      const totals = [await first.json(), await second.json()] as { rotated: number }[];

      expect(gitlab.rotations).toBe(1);
      expect(totals.map((t) => t.rotated).sort()).toEqual([0, 1]);
      expect(totals).toEqual([
        expect.objectContaining({ checked: 1, problems: 0, failed: 0 }),
        expect.objectContaining({ checked: 1, problems: 0, failed: 0 }),
      ]);
      expect((await tokenOf(connection.id)).token).toBe("glpat-rotated-1");
      expect(await healthOf(connection.id)).toMatchObject({ problems: [] });
    });

    it("doesn't rotate a token another run rotated less than an hour ago", async () => {
      const connection = await gitlabConnection(HEALTHY, "42");
      expect(await (await cron("cron-secret")).json()).toMatchObject({ rotated: 1 });

      // A second run that lists the connection after the first one finished.
      expect(await (await cron("cron-secret")).json()).toEqual({
        rotated: 0,
        checked: 1,
        problems: 0,
        failed: 0,
      });

      expect(gitlab.rotations).toBe(1);
      expect((await tokenOf(connection.id)).token).toBe("glpat-rotated-1");
    });

    it("rotates a token again once the last rotation is an hour old", async () => {
      const connection = await gitlabConnection(HEALTHY, "42");
      expect(await (await cron("cron-secret")).json()).toMatchObject({ rotated: 1 });
      await updateScmConnectionCredentials(db, connection.id, async (credentials) => ({
        ...credentials,
        rotatedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
      }));

      expect(await (await cron("cron-secret")).json()).toMatchObject({ rotated: 1 });

      expect(gitlab.rotations).toBe(2);
      expect((await tokenOf(connection.id)).token).toBe("glpat-rotated-2");
    });

    it("doesn't rotate a token stamped as rotated in the near future (clock skew)", async () => {
      const connection = await gitlabConnection(HEALTHY, "42");
      expect(await (await cron("cron-secret")).json()).toMatchObject({ rotated: 1 });
      await updateScmConnectionCredentials(db, connection.id, async (credentials) => ({
        ...credentials,
        rotatedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }));

      expect(await (await cron("cron-secret")).json()).toMatchObject({ rotated: 0 });

      expect(gitlab.rotations).toBe(1);
    });

    it("records rotation_unsupported on an instance without self-rotation and keeps the token", async () => {
      gitlab.rotateStatus = 404;
      gitlab.rotateMessage = "404 Not Found";
      const connection = await gitlabConnection(HEALTHY, "42");

      expect(await (await cron("cron-secret")).json()).toEqual({
        rotated: 0,
        checked: 1,
        problems: 1,
        failed: 0,
      });

      expect((await tokenOf(connection.id)).token).toBe("glpat-bot");
      expect(await healthOf(connection.id)).toEqual({
        checkedAt: expect.any(String),
        tokenExpiresAt: "2099-01-01",
        problems: [{ code: "rotation_unsupported", message: expect.any(String) }],
      });
    });

    it("records rotation_failed with GitLab's message and logs it", async () => {
      gitlab.rotateStatus = 400;
      gitlab.rotateMessage = "Token rotation is disabled";
      const connection = await gitlabConnection(HEALTHY, "42");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(await (await cron("cron-secret")).json()).toEqual({
        rotated: 0,
        checked: 1,
        problems: 1,
        failed: 0,
      });

      expect(errors).toHaveBeenCalledOnce();
      expect(errors.mock.calls[0]![0]).toContain("Rotating the bot token");
      errors.mockRestore();
      expect((await tokenOf(connection.id)).token).toBe("glpat-bot");
      expect((await healthOf(connection.id))!.problems).toEqual([
        {
          code: "rotation_failed",
          message: "Rotating the bot token failed: Token rotation is disabled",
        },
      ]);
    });

    it("doesn't rotate group or project access tokens", async () => {
      gitlab.username = "group_12_bot_0123abcd";
      const connection = await gitlabConnection(HEALTHY, "42");

      expect(await (await cron("cron-secret")).json()).toMatchObject({ rotated: 0, checked: 1 });

      expect(gitlab.rotations).toBe(0);
      expect((await tokenOf(connection.id)).token).toBe("glpat-bot");
      expect((await healthOf(connection.id))!.problems.map((p) => p.code)).toEqual([
        "access_token_bot",
      ]);
    });

    it("doesn't rotate tokens GitLab rejects", async () => {
      const connection = await gitlabConnection(HEALTHY, "42");
      gitlab.token = "glpat-someone-else";

      expect(await (await cron("cron-secret")).json()).toMatchObject({ rotated: 0, checked: 1 });

      expect(gitlab.rotations).toBe(0);
      expect((await healthOf(connection.id))!.problems.map((p) => p.code)).toEqual([
        "token_invalid",
      ]);
    });
  });
});
