// Personal API tokens: a member creates, lists and revokes their own, and the omniralph-prd
// plugin's feature routes accept them as that member in that organization, and nowhere else.
import {
  addMember,
  apiTokens,
  closeDb,
  createDb,
  createFeature,
  createOrganization,
  features,
  hashToken,
  removeMember,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokenListSchema, createdApiTokenSchema } from "@/lib/api/api-tokens";
import {
  featureDocumentSchema,
  featureListSchema,
  savedFeatureDocumentSchema,
  savedFeatureSchema,
} from "@/lib/api/features";
import { assertRole, AuthorizationError, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

interface SessionUser {
  id: string;
  organization: { id: string; name: string };
}

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  /** The signed-in user, or null when the request has no session. */
  session: null as SessionUser | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => {
    if (!state.session) throw new AuthorizationError("You must be signed in.", "unauthenticated");
    return assertRole(
      { ...state.session, role: "member", name: "Ada", email: null, image: null },
      role,
    );
  },
}));

const tokens = await import("./route");
const token = await import("./[id]/route");
const featureList = await import("../features/route");
const feature = await import("../features/[id]/route");
const document = await import("../features/[id]/documents/[kind]/route");

type Handler = (
  request: Request,
  route: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  handler: unknown,
  method: string,
  init: { params?: Record<string, string>; body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  const response = await (handler as Handler)(
    new Request("http://localhost/api/ui/x", {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
    { params: Promise.resolve(init.params ?? {}) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("/api/ui/api-tokens and token access", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: SessionUser;
  let otherOrgId: string;

  /** Creates a token as the signed-in `user`, then signs out. */
  const mint = async (user: SessionUser, name = "PRD plugin") => {
    state.session = user;
    const result = await call(tokens.POST, "POST", { body: { name } });
    state.session = null;
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return createdApiTokenSchema.parse(result.body);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values([
      { id: "token-user", name: "Ada" },
      { id: "colleague", name: "Grace" },
      { id: "stranger", name: "Linus" },
    ]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "token-user" });
    await addMember(db, { organizationId: org.id, userId: "colleague", role: "member" });
    // The token user isn't a member of the other organization.
    const other = await createOrganization(db, { name: "Other", createdBy: "stranger" });
    acme = { id: "token-user", organization: { id: org.id, name: "Acme" } };
    otherOrgId = other.id;
  });

  beforeEach(() => {
    state.session = null;
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  describe("managing tokens", () => {
    it("shows a new token once and stores only its hash", async () => {
      const created = await mint(acme, "  Laptop  ");
      expect(created.token).toMatch(/^omr_[A-Za-z0-9_-]{43}$/);
      expect(created.apiToken).toMatchObject({
        name: "Laptop",
        prefix: created.token.slice(0, 8),
        lastUsedAt: null,
      });

      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, created.apiToken.id));
      expect(row!.tokenHash).toBe(hashToken(created.token));
      expect(JSON.stringify(row)).not.toContain(created.token);

      state.session = acme;
      const listed = await call(tokens.GET, "GET");
      expect(JSON.stringify(listed.body)).not.toContain(created.token);
      expect(apiTokenListSchema.parse(listed.body).tokens.map((t) => t.id)).toContain(
        created.apiToken.id,
      );
    });

    it("lists and revokes only the member's own tokens in the active organization", async () => {
      const mine = await mint(acme);
      const colleague = { id: "colleague", organization: acme.organization };
      const theirs = await mint(colleague);

      state.session = acme;
      const ids = apiTokenListSchema
        .parse((await call(tokens.GET, "GET")).body)
        .tokens.map((t) => t.id);
      expect(ids).toContain(mine.apiToken.id);
      expect(ids).not.toContain(theirs.apiToken.id);

      expect(
        (await call(token.DELETE, "DELETE", { params: { id: theirs.apiToken.id } })).status,
      ).toBe(404);
      expect((await call(token.DELETE, "DELETE", { params: { id: "not-a-uuid" } })).status).toBe(
        404,
      );
      expect(
        (await call(token.DELETE, "DELETE", { params: { id: mine.apiToken.id } })).body,
      ).toEqual({ ok: true });
      const after = apiTokenListSchema.parse((await call(tokens.GET, "GET")).body);
      expect(after.tokens.map((t) => t.id)).not.toContain(mine.apiToken.id);
    });

    it("refuses a blank name", async () => {
      state.session = acme;
      const result = await call(tokens.POST, "POST", { body: { name: "  " } });
      expect(result.status).toBe(400);
      expect(result.body.fieldErrors).toEqual({ name: "Name the token." });
    });

    it("can't be managed with a token", async () => {
      const { token: value } = await mint(acme);
      expect((await call(tokens.GET, "GET", { bearer: value })).status).toBe(401);
      expect((await call(tokens.POST, "POST", { bearer: value, body: { name: "x" } })).status).toBe(
        401,
      );
    });
  });

  describe("the feature routes with a token", () => {
    it("create a feature and save its PRFAQ and Plan as the token's member", async () => {
      const { token: value } = await mint(acme);

      const created = await call(featureList.POST, "POST", {
        bearer: value,
        body: { name: "Checkout" },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const { feature: row } = savedFeatureSchema.parse(created.body);
      const [stored] = await db.select().from(features).where(eq(features.id, row.id));
      expect(stored).toMatchObject({
        organizationId: acme.organization.id,
        createdBy: "token-user",
      });

      const listed = featureListSchema.parse(
        (await call(featureList.GET, "GET", { bearer: value })).body,
      );
      expect(listed.features.map((f) => f.id)).toContain(row.id);

      const params = { id: row.id, kind: "plan" };
      const empty = featureDocumentSchema.parse(
        (await call(document.GET, "GET", { bearer: value, params })).body,
      );
      expect(empty.version).toBe(0);
      const saved = await call(document.PUT, "PUT", {
        bearer: value,
        params,
        body: { body: "# Plan", baseVersion: 0 },
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(savedFeatureDocumentSchema.parse(saved.body).document).toMatchObject({
        version: 1,
        body: "# Plan",
      });
      const stale = await call(document.PUT, "PUT", {
        bearer: value,
        params,
        body: { body: "# Older", baseVersion: 0 },
      });
      expect(stale).toMatchObject({ status: 409, body: { code: "stale_version" } });
    });

    it("never reach another organization's features", async () => {
      const { token: value } = await mint(acme);
      const createdTheirs = await createFeature(db, {
        organizationId: otherOrgId,
        name: "Secret",
        repositoryId: null,
        createdBy: "stranger",
      });
      if (createdTheirs.status !== "created") throw new Error("setup");
      const theirs = createdTheirs.feature;

      const listed = featureListSchema.parse(
        (await call(featureList.GET, "GET", { bearer: value })).body,
      );
      expect(listed.features.map((f) => f.id)).not.toContain(theirs.id);
      const params = { id: theirs.id, kind: "prfaq" };
      expect((await call(document.GET, "GET", { bearer: value, params })).status).toBe(404);
      expect(
        (
          await call(document.PUT, "PUT", {
            bearer: value,
            params,
            body: { body: "x", baseVersion: 0 },
          })
        ).status,
      ).toBe(404);
    });

    it("answer 401 to a revoked, unknown or malformed token, even with a session", async () => {
      const revoked = await mint(acme);
      state.session = acme;
      await call(token.DELETE, "DELETE", { params: { id: revoked.apiToken.id } });

      const unknown = `omr_${"A".repeat(43)}`;
      for (const bearer of [revoked.token, unknown, "omr_short", "not-a-token", ""]) {
        const result = await call(featureList.GET, "GET", { bearer });
        expect(result.status, bearer).toBe(401);
        expect(result.body.code, bearer).toBe("unauthenticated");
      }
      state.session = null;
      expect((await call(featureList.GET, "GET")).status).toBe(401);
    });

    it("stop working when the member leaves the organization", async () => {
      const colleague = { id: "colleague", organization: acme.organization };
      const { token: value } = await mint(colleague);
      expect((await call(featureList.GET, "GET", { bearer: value })).status).toBe(200);
      await removeMember(db, { organizationId: acme.organization.id, userId: "colleague" });
      expect((await call(featureList.GET, "GET", { bearer: value })).status).toBe(401);
    });

    it("aren't accepted by routes that don't take tokens", async () => {
      const { token: value } = await mint(acme);
      const theirs = featureListSchema.parse(
        (await call(featureList.GET, "GET", { bearer: value })).body,
      ).features[0];
      const id = theirs?.id ?? "00000000-0000-4000-8000-000000000000";
      expect((await call(feature.GET, "GET", { bearer: value, params: { id } })).status).toBe(401);
    });
  });
});
