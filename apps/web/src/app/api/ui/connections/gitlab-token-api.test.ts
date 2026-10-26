import { randomBytes } from "node:crypto";
import {
  captureChanges,
  closeDb,
  connectionCredentials,
  createDb,
  listSettingsChanges,
  organizationMembers,
  organizations,
  scmConnections,
  upsertScmConnection,
  users,
  type Database,
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
import { gitLabTokenResultSchema } from "@/lib/api/connections";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const rotateRoute = await import("./gitlab/[id]/rotate/route");
const replaceRoute = await import("./gitlab/[id]/route");
const { changeMessage } = await import("@/lib/live/publisher");

const GITLAB = "https://gitlab.example.com";
const BOT_USER_ID = 42;

const admin: TestUser = { id: "admin-1", role: "admin", name: "Ada", email: null, image: null };
const member: TestUser = { id: "member-1", role: "member", name: "Mia", email: null, image: null };

/** The instance's bot: its current token (older ones are revoked), user, expiry and rotation. */
let gitlab: {
  token: string;
  /** Tokens of another GitLab user (a different account). */
  otherUserTokens: string[];
  username: string;
  expiresAt: string;
  rotations: number;
  rotateStatus: number;
};

const unauthorized = () => HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 });
const tokenOf = (request: Request) => request.headers.get("private-token") ?? "";

const server = setupServer(
  http.get(`${GITLAB}/api/v4/user`, ({ request }) => {
    const token = tokenOf(request);
    if (gitlab.otherUserTokens.includes(token)) {
      return HttpResponse.json({ id: 7, username: "someone-else", name: "Someone" });
    }
    if (token !== gitlab.token) return unauthorized();
    return HttpResponse.json({ id: BOT_USER_ID, username: gitlab.username, name: "Omniralph" });
  }),
  http.get(`${GITLAB}/api/v4/personal_access_tokens/self`, ({ request }) => {
    const token = tokenOf(request);
    if (token !== gitlab.token && !gitlab.otherUserTokens.includes(token)) return unauthorized();
    return HttpResponse.json({ id: 7, scopes: ["api"], expires_at: gitlab.expiresAt });
  }),
  http.post(`${GITLAB}/api/v4/personal_access_tokens/self/rotate`, async ({ request }) => {
    if (tokenOf(request) !== gitlab.token) return unauthorized();
    if (gitlab.rotateStatus !== 200) {
      return HttpResponse.json({ message: "404 Not Found" }, { status: gitlab.rotateStatus });
    }
    const { expires_at } = (await request.json()) as { expires_at: string };
    gitlab.rotations += 1;
    gitlab.token = `glpat-rotated-${gitlab.rotations}`;
    gitlab.expiresAt = expires_at;
    return HttpResponse.json({ id: 7 + gitlab.rotations, token: gitlab.token, expires_at });
  }),
);

/** Today (UTC) + 7 days, the expiry rotated tokens get. */
const inAWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function rotate(id: string) {
  return rotateRoute.POST(
    new Request(`http://localhost/api/ui/connections/gitlab/${id}/rotate`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

function replace(id: string, token: string) {
  return replaceRoute.PUT(
    new Request(`http://localhost/api/ui/connections/gitlab/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** Runs `fn` and answers its response with the live events it published. */
async function withEvents(fn: () => Promise<Response>) {
  const { result, changes } = await captureChanges(fn);
  return {
    status: result.status,
    body: (await result.json()) as Record<string, unknown>,
    events: changes.map((change) => changeMessage(change).event),
  };
}

describe.skipIf(!testDatabaseAvailable())("GitLab connection token routes", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let other: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, betaOrg, otherOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }, { name: "Other" }])
      .returning();
    acme = acmeOrg!.id;
    beta = betaOrg!.id;
    other = otherOrg!.id;
    state.orgId = acme;
    await db.insert(users).values([
      { id: admin.id, name: admin.name, email: "ada@acme.io" },
      { id: member.id, name: member.name, email: "mia@acme.io" },
    ]);
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: admin.id, role: "admin" },
      { organizationId: beta, userId: admin.id, role: "member" },
      { organizationId: acme, userId: member.id, role: "member" },
    ]);
    server.listen({ onUnhandledFrame: "error" });
  }, 120_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = admin;
    gitlab = {
      token: "glpat-bot",
      otherUserTokens: ["glpat-other-user"],
      username: "service_account_group_12_omniralph",
      expiresAt: "2099-01-01",
      rotations: 0,
      rotateStatus: 200,
    };
  });

  afterEach(async () => {
    await db.delete(scmConnections);
  });

  async function connection(organizationId = acme, provider: "gitlab" | "github" = "gitlab") {
    return (await upsertScmConnection(db, {
      organizationId,
      provider,
      name: "bot @ gitlab.example.com",
      baseUrl: provider === "gitlab" ? GITLAB : "https://api.github.com",
      externalId: String(BOT_USER_ID),
      credentials: { token: "glpat-bot", webhookSecret: "hook-secret" },
      botUsername: "bot",
    }))!;
  }

  async function credentialsOf(id: string) {
    const [row] = await db.select().from(scmConnections).where(eq(scmConnections.id, id));
    return connectionCredentials<{ token: string; webhookSecret: string; rotatedAt?: string }>(
      row!,
    );
  }

  async function historyOf(id: string) {
    const page = await listSettingsChanges(db, {
      organizationIds: [acme],
      section: "connection",
      subjectId: id,
    });
    return page.entries.map((entry) => entry.changes);
  }

  describe("POST /api/ui/connections/gitlab/{id}/rotate", () => {
    it("rotates the bot token now, re-checks and answers the new health with one connection event", async () => {
      const { id } = await connection();
      // A rotation within the hour (the cron's) doesn't stop an admin's rotate.
      await db
        .update(scmConnections)
        .set({
          health: { checkedAt: "2026-01-01T00:00:00.000Z", tokenExpiresAt: null, problems: [] },
        })
        .where(eq(scmConnections.id, id));

      const { status, body, events } = await withEvents(() => rotate(id));

      expect(status).toBe(200);
      expect(gitLabTokenResultSchema.parse(body)).toEqual(body);
      expect(body).toEqual({ health: { state: "expiring", expiresAt: inAWeek(), problems: [] } });
      expect(gitlab.rotations).toBe(1);
      expect(await credentialsOf(id)).toEqual({
        token: "glpat-rotated-1",
        webhookSecret: "hook-secret",
        rotatedAt: expect.any(String),
      });
      expect(events.filter((event) => event.resource === "connection")).toEqual([
        expect.objectContaining({ resource: "connection", ids: [id], organizationId: acme }),
      ]);
      expect(await historyOf(id)).toEqual([
        [{ field: "credentials", label: "Credentials", before: "changed", after: "changed" }],
      ]);

      // Again right away: an admin's rotate isn't held back by the last hour's rotation.
      expect((await rotate(id)).status).toBe(200);
      expect(gitlab.rotations).toBe(2);
    });

    it("refuses with today's message when the instance can't rotate tokens", async () => {
      gitlab.rotateStatus = 404;
      const { id } = await connection();

      const { status, body } = await withEvents(() => rotate(id));

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "rotation_unsupported" });
      expect(body.error).toContain(
        "This GitLab instance can't rotate the bot token automatically (no self-rotation endpoint).",
      );
      expect((await credentialsOf(id)).token).toBe("glpat-bot");
      expect(await historyOf(id)).toEqual([]);
      // The check still ran and recorded the problem.
      const [row] = await db.select().from(scmConnections).where(eq(scmConnections.id, id));
      expect(row!.health!.problems.map((p) => p.code)).toEqual(["rotation_unsupported"]);
    });

    it("refuses a group or project access token with today's message", async () => {
      gitlab.username = "group_12_bot_0123abcd";
      const { id } = await connection();

      const { status, body } = await withEvents(() => rotate(id));

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "access_token_bot" });
      expect(body.error).toContain("is a group or project access token");
      expect(gitlab.rotations).toBe(0);
      expect((await credentialsOf(id)).token).toBe("glpat-bot");
    });

    it("refuses members (403), and other organizations' and non-GitLab connections (404)", async () => {
      const { id } = await connection();
      state.user = member;
      expect((await rotate(id)).status).toBe(403);
      state.user = admin;
      await db.delete(scmConnections);
      const inBeta = await connection(beta);
      expect((await rotate(inBeta.id)).status).toBe(403);
      await db.delete(scmConnections);
      const inOther = await connection(other);
      expect((await rotate(inOther.id)).status).toBe(404);
      await db.delete(scmConnections);
      const github = await connection(acme, "github");
      expect((await rotate(github.id)).status).toBe(404);
      expect((await rotate("not-a-uuid")).status).toBe(404);
      expect(gitlab.rotations).toBe(0);
    });
  });

  describe("PUT /api/ui/connections/gitlab/{id}", () => {
    it("stores a new token of the same GitLab user encrypted, keeps the webhook secret and re-checks", async () => {
      const { id } = await connection();
      // The new token of the same bot user (GitLab now accepts only it).
      gitlab.token = "glpat-new";

      const { status, body, events } = await withEvents(() => replace(id, "  glpat-new  "));

      expect(status).toBe(200);
      expect(body).toEqual({ health: { state: "healthy", expiresAt: "2099-01-01", problems: [] } });
      expect(await credentialsOf(id)).toEqual({ token: "glpat-new", webhookSecret: "hook-secret" });
      const [row] = await db.select().from(scmConnections).where(eq(scmConnections.id, id));
      expect(row!.encryptedCredentials).not.toContain("glpat-new");
      expect(events.filter((event) => event.resource === "connection")).toEqual([
        expect.objectContaining({ resource: "connection", ids: [id], organizationId: acme }),
      ]);
      expect(await historyOf(id)).toEqual([
        [{ field: "credentials", label: "Credentials", before: "changed", after: "changed" }],
      ]);
      expect(gitlab.rotations).toBe(0);
    });

    it("refuses a token of a different GitLab user and keeps the old one", async () => {
      const { id } = await connection();

      const { status, body, events } = await withEvents(() => replace(id, "glpat-other-user"));

      expect(status).toBe(400);
      expect(body.error).toBe(
        "This token belongs to a different GitLab user. Add it as a new connection.",
      );
      expect((await credentialsOf(id)).token).toBe("glpat-bot");
      expect(events).toEqual([]);
      expect(await historyOf(id)).toEqual([]);
    });

    it("refuses a token GitLab rejects with its message, and an empty token", async () => {
      const { id } = await connection();
      const rejected = await replace(id, "glpat-revoked");
      expect(rejected.status).toBe(400);
      expect(((await rejected.json()) as { error: string }).error).toBe(
        "GitLab rejected the access token (invalid, expired or revoked).",
      );
      expect((await replace(id, "  ")).status).toBe(400);
      expect((await credentialsOf(id)).token).toBe("glpat-bot");
    });

    it("refuses members (403), and other organizations' connections (404)", async () => {
      const { id } = await connection();
      gitlab.token = "glpat-new";
      state.user = member;
      expect((await replace(id, "glpat-new")).status).toBe(403);
      expect((await credentialsOf(id)).token).toBe("glpat-bot");
      state.user = admin;
      await db.delete(scmConnections);
      const inOther = await connection(other);
      expect((await replace(inOther.id, "glpat-new")).status).toBe(404);
      expect((await credentialsOf(inOther.id)).token).toBe("glpat-bot");
    });
  });
});
