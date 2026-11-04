// Personal API tokens: the per-member cap, who a token acts as, revoking and leaving.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import {
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  MAX_ACTIVE_API_TOKENS,
  revokeApiToken,
} from "./api-tokens.js";
import { closeDb, createDb, type Database } from "./client.js";
import { addMember, createOrganization, removeMember, updateMemberRole } from "./organizations.js";
import { apiTokens, users } from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("api tokens", () => {
  let testDb: TestDatabase;
  let db: Database;
  let seq = 0;

  const user = async () => {
    seq += 1;
    const [row] = await db
      .insert(users)
      .values({ name: `User ${seq}`, email: `user-${seq}@example.com` })
      .returning();
    return row!.id;
  };

  const create = (organizationId: string, userId: string, tokenHash = `hash-${++seq}`) =>
    createApiToken(db, { organizationId, userId, name: "Plugin", tokenHash, prefix: "omr_abcd" });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("acts as its member in its organization, with their current role", async () => {
    const owner = await user();
    const org = await createOrganization(db, { name: "Acme", createdBy: owner });
    const memberId = await user();
    await addMember(db, { organizationId: org.id, userId: memberId, role: "member" });
    await create(org.id, memberId, "member-token");

    expect(await authenticateApiToken(db, "member-token")).toMatchObject({
      user: { id: memberId, name: expect.stringMatching(/^User /) },
      organization: { id: org.id, name: "Acme" },
      role: "member",
    });
    await updateMemberRole(db, { organizationId: org.id, userId: memberId, role: "admin" });
    expect(await authenticateApiToken(db, "member-token")).toMatchObject({ role: "admin" });
    expect(await authenticateApiToken(db, "unknown")).toBeNull();
  });

  it("records when it was used, at most once a minute", async () => {
    const owner = await user();
    const org = await createOrganization(db, { name: "Used", createdBy: owner });
    await create(org.id, owner, "used-token");
    const lastUsed = async () =>
      (await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, "used-token")))[0]!
        .lastUsedAt;

    const first = new Date("2026-11-04T10:00:00Z");
    await authenticateApiToken(db, "used-token", first);
    expect(await lastUsed()).toEqual(first);
    await authenticateApiToken(db, "used-token", new Date("2026-11-04T10:00:30Z"));
    expect(await lastUsed()).toEqual(first);
    const later = new Date("2026-11-04T10:02:00Z");
    await authenticateApiToken(db, "used-token", later);
    expect(await lastUsed()).toEqual(later);
  });

  it("is only created for a member, up to the cap", async () => {
    const owner = await user();
    const org = await createOrganization(db, { name: "Cap", createdBy: owner });
    const outsider = await user();
    expect(await create(org.id, outsider)).toEqual({ status: "not_member" });

    for (let i = 0; i < MAX_ACTIVE_API_TOKENS; i += 1) {
      expect(await create(org.id, owner)).toMatchObject({ status: "created" });
    }
    expect(await create(org.id, owner)).toEqual({ status: "limit" });
    const [oldest] = (await listApiTokens(db, { organizationId: org.id, userId: owner })).slice(-1);
    await revokeApiToken(db, { organizationId: org.id, userId: owner, id: oldest!.id });
    expect(await create(org.id, owner)).toMatchObject({ status: "created" });
  });

  it("is revoked only by its own member in its organization, and then stops", async () => {
    const owner = await user();
    const org = await createOrganization(db, { name: "Revoke", createdBy: owner });
    const other = await user();
    const otherOrg = await createOrganization(db, { name: "Other", createdBy: other });
    await addMember(db, { organizationId: org.id, userId: other, role: "member" });
    const created = await create(org.id, owner, "revoke-token");
    if (created.status !== "created") throw new Error("not created");
    const id = created.token.id;

    expect(await revokeApiToken(db, { organizationId: org.id, userId: other, id })).toBe(false);
    expect(await revokeApiToken(db, { organizationId: otherOrg.id, userId: owner, id })).toBe(
      false,
    );
    expect(await authenticateApiToken(db, "revoke-token")).not.toBeNull();

    expect(await revokeApiToken(db, { organizationId: org.id, userId: owner, id })).toBe(true);
    expect(await revokeApiToken(db, { organizationId: org.id, userId: owner, id })).toBe(false);
    expect(await authenticateApiToken(db, "revoke-token")).toBeNull();
    expect(await listApiTokens(db, { organizationId: org.id, userId: owner })).toEqual([]);
  });

  it("stops for good when its member leaves the organization", async () => {
    const owner = await user();
    const org = await createOrganization(db, { name: "Leave", createdBy: owner });
    const memberId = await user();
    await addMember(db, { organizationId: org.id, userId: memberId, role: "member" });
    await create(org.id, memberId, "leaver-token");

    await removeMember(db, { organizationId: org.id, userId: memberId });
    expect(await authenticateApiToken(db, "leaver-token")).toBeNull();
    await addMember(db, { organizationId: org.id, userId: memberId, role: "member" });
    expect(await authenticateApiToken(db, "leaver-token")).toBeNull();
  });
});
