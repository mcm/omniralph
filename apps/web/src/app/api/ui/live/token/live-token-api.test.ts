import {
  closeDb,
  createDb,
  createUser,
  organizationMembers,
  organizations,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq } from "drizzle-orm";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth/session";
import { AuthorizationError } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as CurrentUser | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireSignedInUser: async () => {
    if (!state.user) throw new AuthorizationError("Sign in.", "unauthenticated");
    return state.user;
  },
  requireUser: async () => state.user,
}));

const { GET } = await import("./route");
const { LIVE_TOKEN_TTL_SECONDS } = await import("@/lib/live/token");

const KEY_NAME = "appId.keyId";
const KEY_SECRET = "s3cr3t-key-secret";

describe.skipIf(!testDatabaseAvailable())("GET /api/ui/live/token", () => {
  let testDb: TestDatabase;
  let userId: string;
  let orgA: string;
  let orgB: string;
  let otherOrg: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    state.db = createDb(testDb.uri);
    const user = await createUser(state.db, { email: "ada@example.com", name: "Ada" });
    const other = await createUser(state.db, { email: "bob@example.com", name: "Bob" });
    userId = user.id;
    const orgs = await state.db
      .insert(organizations)
      .values([{ name: "Alpha" }, { name: "Beta" }, { name: "Other" }])
      .returning();
    [orgA, orgB, otherOrg] = orgs.map((o) => o.id) as [string, string, string];
    await state.db.insert(organizationMembers).values([
      { organizationId: orgA, userId, role: "admin" },
      { organizationId: orgB, userId, role: "member" },
      { organizationId: otherOrg, userId: other.id, role: "admin" },
    ]);
    state.user = {
      id: userId,
      organization: { id: orgA, name: "Alpha" },
      role: "admin",
      name: "Ada",
      email: "ada@example.com",
      image: null,
      theme: null,
      showAdvanced: false,
      sound: { enabled: true, volume: 0.7 },
    };
  }, 180_000);

  afterAll(async () => {
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  afterEach(() => vi.unstubAllEnvs());

  async function token() {
    const response = await GET(new Request("http://localhost/api/ui/live/token"), {
      params: Promise.resolve({}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function capability(jwt: string) {
    const { payload } = await jwtVerify(jwt, new TextEncoder().encode(KEY_SECRET), {
      algorithms: ["HS256"],
    });
    return {
      payload,
      capability: JSON.parse(payload["x-ably-capability"] as string) as Record<string, string[]>,
    };
  }

  it("answers { token: null } when Ably is off", async () => {
    vi.stubEnv("ABLY_API_KEY", "");
    expect(await token()).toEqual({ status: 200, body: { token: null } });
  });

  it("signs a subscribe-only token for the user's change channels, valid an hour", async () => {
    vi.stubEnv("ABLY_API_KEY", `${KEY_NAME}:${KEY_SECRET}`);
    const { status, body } = await token();
    expect(status).toBe(200);
    const jwt = body.token as string;
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "HS256", typ: "JWT", kid: KEY_NAME });
    const { payload, capability: granted } = await capability(jwt);
    expect(payload["x-ably-clientId"]).toBe(userId);
    expect(payload.exp! - payload.iat!).toBe(LIVE_TOKEN_TTL_SECONDS);
    expect(LIVE_TOKEN_TTL_SECONDS).toBe(3600);
    expect(body.expiresAt).toBe(new Date(payload.exp! * 1000).toISOString());
    expect(granted).toEqual({
      [`org:${orgA}:changes`]: ["subscribe"],
      [`org:${orgB}:changes`]: ["subscribe"],
      [`user:${userId}:changes`]: ["subscribe"],
    });
    const channels = Object.keys(granted);
    // No other organization's channel, no wake channel, nothing but subscribe.
    expect(channels.some((c) => c.includes(otherOrg))).toBe(false);
    expect(channels).not.toContain(`org:${orgA}`);
    expect(channels).not.toContain(`org:${orgB}`);
    expect(channels.some((c) => c.startsWith("agent:") || c.includes("*"))).toBe(false);
    for (const operations of Object.values(granted)) expect(operations).toEqual(["subscribe"]);
    expect(JSON.stringify(granted)).not.toMatch(/publish|presence/);
  });

  it("leaves a removed membership out of the next token", async () => {
    vi.stubEnv("ABLY_API_KEY", `${KEY_NAME}:${KEY_SECRET}`);
    await state.db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.organizationId, orgB), eq(organizationMembers.userId, userId)),
      );
    const { capability: granted } = await capability((await token()).body.token as string);
    expect(Object.keys(granted).sort()).toEqual(
      [`org:${orgA}:changes`, `user:${userId}:changes`].sort(),
    );
  });

  it("answers 401 when signed out", async () => {
    const user = state.user;
    state.user = null;
    try {
      expect((await token()).status).toBe(401);
    } finally {
      state.user = user;
    }
  });
});
