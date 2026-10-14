import {
  chatChannelTaskSettings,
  chatConnections,
  closeDb,
  createDb,
  insertTaskDefinition,
  organizations,
  repositories,
  scmConnections,
  seedReviewProfiles,
  setChatTaskDefaults,
  type Database,
} from "@omniralph/db";
import { getBuiltinTask } from "@omniralph/tasks";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { findTaskReferrers, hasNoReferrers } = await import("./referrers");

const databaseAvailable = testDatabaseAvailable();

/** A stored definition from a built-in (the row holds `id` and `name`). */
function stored(builtinId: string, overrides: Record<string, unknown> = {}) {
  const { id: _id, name: _name, ...definition } = getBuiltinTask(builtinId)!;
  return { ...definition, ...overrides };
}

describe.skipIf(!databaseAvailable)("findTaskReferrers", () => {
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
    await seedReviewProfiles(db, organizationId);
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

  it("finds repositories, chat settings and coding tasks using a task, only in the organization", async () => {
    const describe = await insertTaskDefinition(db, orgId, {
      name: "Terse PR description",
      definition: stored("builtin:describe-pr"),
      requirements: {},
      createdBy: null,
    });
    const otherDescribe = await insertTaskDefinition(db, otherOrgId, {
      name: "Their description",
      definition: stored("builtin:describe-pr"),
      requirements: {},
      createdBy: null,
    });
    const id = describe.id;

    // Repositories: as a review task, as the correlation task, both, neither; and another org's.
    await repository(orgId, "acme/review", { reviewTaskIds: ["builtin:review-pr", id] });
    await repository(orgId, "acme/correlate", { correlationTaskId: id });
    await repository(orgId, "acme/both", { reviewTaskIds: [id], correlationTaskId: id });
    await repository(orgId, "acme/unrelated", {});
    await repository(otherOrgId, "other/review", { reviewTaskIds: [id], correlationTaskId: id });

    // Chat: the organization's choice and channel overrides; another org's too.
    await setChatTaskDefaults(
      db,
      orgId,
      { askAboutCode: id, startWork: "builtin:handle-request" },
      null,
    );
    await setChatTaskDefaults(db, otherOrgId, { askAboutCode: id, startWork: id }, null);
    await chatChannel(orgId, "acme", { askAboutCodeTaskId: id });
    await chatChannel(orgId, "acmeops", { startWorkTaskId: "builtin:handle-request" });
    await chatChannel(otherOrgId, "other", { askAboutCodeTaskId: id });

    // Coding tasks: one resolvable, one that no longer parses; another org's.
    const coding = await insertTaskDefinition(db, orgId, {
      name: "Careful coder",
      definition: stored("builtin:implement-story", { prDescriptionTaskId: id }),
      requirements: {},
      createdBy: null,
    });
    const broken = await insertTaskDefinition(db, orgId, {
      name: "Broken coder",
      definition: { taskType: "coding", prDescriptionTaskId: id },
      requirements: {},
      createdBy: null,
    });
    await insertTaskDefinition(db, otherOrgId, {
      name: "Their coder",
      definition: stored("builtin:implement-story", { prDescriptionTaskId: id }),
      requirements: {},
      createdBy: null,
    });

    const referrers = await findTaskReferrers(db, orgId, id);
    expect(referrers.repositories).toEqual([
      expect.objectContaining({ fullPath: "acme/both", reviewTask: true, correlationTask: true }),
      expect.objectContaining({
        fullPath: "acme/correlate",
        reviewTask: false,
        correlationTask: true,
        storyTask: false,
        requestTask: false,
      }),
      expect.objectContaining({
        fullPath: "acme/review",
        reviewTask: true,
        correlationTask: false,
      }),
    ]);
    expect(referrers.chatTasks).toEqual(["askAboutCode"]);
    expect(referrers.chatChannels).toEqual([
      expect.objectContaining({
        connectionName: "acme",
        channelId: "slack:CACME123",
        askAboutCode: true,
        startWork: false,
      }),
    ]);
    expect(referrers.codingTasks).toEqual([
      { id: coding.id, name: "Careful coder", builtin: false },
      { id: broken.id, name: "Broken coder", builtin: false },
    ]);
    expect(hasNoReferrers(referrers)).toBe(false);

    // The other organization's task is unused in this organization.
    expect(hasNoReferrers(await findTaskReferrers(db, orgId, otherDescribe.id))).toBe(true);
  });

  it("returns repositories using a task as their story or request task", async () => {
    const coder = await insertTaskDefinition(db, orgId, {
      name: "Coder",
      definition: stored("builtin:handle-request"),
      requirements: {},
      createdBy: null,
    });
    await repository(orgId, "acme/stories", { storyTaskId: coder.id });
    await repository(orgId, "acme/requests", { requestTaskId: coder.id });
    await repository(otherOrgId, "other/stories", { storyTaskId: coder.id });

    const referrers = await findTaskReferrers(db, orgId, coder.id);
    expect(referrers.repositories).toEqual([
      expect.objectContaining({
        fullPath: "acme/requests",
        reviewTask: false,
        correlationTask: false,
        storyTask: false,
        requestTask: true,
      }),
      expect.objectContaining({
        fullPath: "acme/stories",
        storyTask: true,
        requestTask: false,
      }),
    ]);
    expect(hasNoReferrers(referrers)).toBe(false);
  });

  it("counts built-in defaults: chat's default tasks and coding tasks' default PR description task", async () => {
    const [org] = await db.insert(organizations).values({ name: "Fresh" }).returning();
    const describeReferrers = await findTaskReferrers(db, org!.id, "builtin:describe-pr");
    expect(describeReferrers.codingTasks).toContainEqual(
      expect.objectContaining({ id: "builtin:implement-story", builtin: true }),
    );
    expect((await findTaskReferrers(db, org!.id, "builtin:handle-request")).chatTasks).toEqual([
      "startWork",
    ]);
  });
});
