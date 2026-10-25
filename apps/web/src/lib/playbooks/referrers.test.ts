import {
  chatChannelTaskSettings,
  chatConnections,
  closeDb,
  createDb,
  insertPlaybook,
  organizations,
  repositories,
  scmConnections,
  setChatPlaybookDefaults,
  type Database,
} from "@omniralph/db";
import { getBuiltinPlaybook } from "@omniralph/tasks";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { findPlaybookReferrers, hasNoReferrers } = await import("./referrers");

const databaseAvailable = testDatabaseAvailable();

/** A stored playbook from a built-in (the row holds `id`, `name` and `role`). */
function stored(builtinId: string, overrides: Record<string, unknown> = {}) {
  const { id: _id, name: _name, role, ...definition } = getBuiltinPlaybook(builtinId)!;
  return { role, definition: { ...definition, ...overrides } };
}

describe.skipIf(!databaseAvailable)("findPlaybookReferrers", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function repository(organizationId: string, fullPath: string, values: object) {
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId,
        provider: "github",
        name: fullPath,
        baseUrl: "https://api.github.com",
        externalId: fullPath,
        encryptedCredentials: "unused",
      })
      .returning();
    await db.insert(repositories).values({
      organizationId,
      provider: "github",
      externalId: fullPath,
      fullPath,
      connectionId: connection!.id,
      ...values,
    });
  }

  async function chatChannel(organizationId: string, name: string, values: object) {
    const [connection] = await db
      .insert(chatConnections)
      .values({ organizationId, platform: "slack", externalId: name, name })
      .returning();
    await db.insert(chatChannelTaskSettings).values({
      organizationId,
      connectionId: connection!.id,
      channelId: `slack:C${name.toUpperCase()}123`,
      ...values,
    });
  }

  it("finds repositories, chat settings and coding playbooks using a playbook, only in the organization", async () => {
    const describe = await insertPlaybook(db, orgId, {
      name: "Terse PR description",
      ...stored("builtin:describe-pr"),
      requirements: {},
      createdBy: null,
    });
    const otherDescribe = await insertPlaybook(db, otherOrgId, {
      name: "Their description",
      ...stored("builtin:describe-pr"),
      requirements: {},
      createdBy: null,
    });
    const id = describe.id;

    // Repositories: as a review playbook, as the correlation playbook, both, neither; and another org's.
    await repository(orgId, "acme/review", { reviewPlaybookIds: ["builtin:review-pr", id] });
    await repository(orgId, "acme/correlate", { correlationPlaybookId: id });
    await repository(orgId, "acme/both", { reviewPlaybookIds: [id], correlationPlaybookId: id });
    await repository(orgId, "acme/unrelated", {});
    await repository(otherOrgId, "other/review", {
      reviewPlaybookIds: [id],
      correlationPlaybookId: id,
    });

    // Chat: the organization's choice and channel overrides; another org's too.
    await setChatPlaybookDefaults(
      db,
      orgId,
      { ask: id, startWork: "builtin:handle-request" },
      null,
    );
    await setChatPlaybookDefaults(db, otherOrgId, { ask: id, startWork: id }, null);
    await chatChannel(orgId, "acme", { askPlaybookId: id });
    await chatChannel(orgId, "acmeops", { startWorkPlaybookId: "builtin:handle-request" });
    await chatChannel(otherOrgId, "other", { askPlaybookId: id });

    // Coding playbooks: one resolvable, one that no longer parses; another org's.
    const coding = await insertPlaybook(db, orgId, {
      name: "Careful coder",
      ...stored("builtin:implement-story", { coding: { prDescriptionPlaybookId: id } }),
      requirements: {},
      createdBy: null,
    });
    const broken = await insertPlaybook(db, orgId, {
      name: "Broken coder",
      role: "story",
      definition: { coding: { prDescriptionPlaybookId: id } },
      requirements: {},
      createdBy: null,
    });
    await insertPlaybook(db, otherOrgId, {
      name: "Their coder",
      ...stored("builtin:implement-story", { coding: { prDescriptionPlaybookId: id } }),
      requirements: {},
      createdBy: null,
    });

    const referrers = await findPlaybookReferrers(db, orgId, id);
    expect(referrers.repositories).toEqual([
      expect.objectContaining({ fullPath: "acme/both", roles: ["review", "correlation"] }),
      expect.objectContaining({ fullPath: "acme/correlate", roles: ["correlation"] }),
      expect.objectContaining({ fullPath: "acme/review", roles: ["review"] }),
    ]);
    expect(referrers.chatPlaybooks).toEqual(["ask"]);
    expect(referrers.chatChannels).toEqual([
      expect.objectContaining({
        connectionName: "acme",
        channelId: "slack:CACME123",
        roles: ["ask"],
      }),
    ]);
    expect(referrers.playbooks).toEqual([
      { id: coding.id, name: "Careful coder", builtin: false },
      { id: broken.id, name: "Broken coder", builtin: false },
    ]);
    expect(hasNoReferrers(referrers)).toBe(false);

    // The other organization's playbook is unused in this organization.
    expect(hasNoReferrers(await findPlaybookReferrers(db, orgId, otherDescribe.id))).toBe(true);
  });

  it("returns repositories binding a playbook as their story or request playbook", async () => {
    const coder = await insertPlaybook(db, orgId, {
      name: "Coder",
      ...stored("builtin:handle-request"),
      requirements: {},
      createdBy: null,
    });
    await repository(orgId, "acme/stories", { storyPlaybookId: coder.id });
    await repository(orgId, "acme/requests", { requestPlaybookId: coder.id });
    await repository(otherOrgId, "other/stories", { storyPlaybookId: coder.id });

    const referrers = await findPlaybookReferrers(db, orgId, coder.id);
    expect(referrers.repositories).toEqual([
      expect.objectContaining({ fullPath: "acme/requests", roles: ["request"] }),
      expect.objectContaining({ fullPath: "acme/stories", roles: ["story"] }),
    ]);
    expect(hasNoReferrers(referrers)).toBe(false);
  });

  it("counts built-in defaults: chat's default playbooks and coding playbooks' default PR description playbook", async () => {
    const [org] = await db.insert(organizations).values({ name: "Fresh" }).returning();
    const describeReferrers = await findPlaybookReferrers(db, org!.id, "builtin:describe-pr");
    expect(describeReferrers.playbooks).toContainEqual(
      expect.objectContaining({ id: "builtin:implement-story", builtin: true }),
    );
    expect(
      (await findPlaybookReferrers(db, org!.id, "builtin:handle-request")).chatPlaybooks,
    ).toEqual(["startWork"]);
  });
});
