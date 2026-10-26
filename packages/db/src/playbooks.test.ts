import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import {
  countActivePlaybookJobs,
  deletePlaybook,
  getStoredPlaybook,
  insertPlaybook,
  listRepositoryPlaybookBindings,
  listStoredPlaybooks,
  updatePlaybook,
} from "./playbooks.js";
import { jobs, organizations, playbooks, repositories, scmConnections, users } from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

const definition = { systemPrompt: "Find vulnerabilities.", promptTemplate: "Review {{diff}}" };
const requirements = { minAgentVersion: "0.40.0", installables: [], hostTools: ["git"] };

describe.skipIf(!databaseAvailable)("playbook queries", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a, b] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgA = a!.id;
    orgB = b!.id;
    await db.insert(users).values([
      { id: "admin-1", email: "admin@example.com" },
      { id: "admin-2", email: "admin2@example.com" },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("inserts, reads, lists, updates and deletes an organization's playbook, recording each write", async () => {
    const { result: row, changes: inserted } = await captureChanges(() =>
      insertPlaybook(db, orgA, {
        name: "Security review",
        role: "review",
        definition,
        requirements,
        createdBy: "admin-1",
      }),
    );
    expect(row).toMatchObject({
      organizationId: orgA,
      name: "Security review",
      role: "review",
      definition,
      requirements,
      createdBy: "admin-1",
      updatedBy: "admin-1",
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    const event = {
      resource: "settings",
      section: "playbooks",
      ids: [row.id],
      subjectId: row.id,
      organizationId: orgA,
    };
    expect(inserted).toEqual([expect.objectContaining(event)]);
    expect(await getStoredPlaybook(db, orgA, row.id)).toEqual(row);
    expect((await listStoredPlaybooks(db, orgA)).map((r) => r.id)).toContain(row.id);

    const { result: updated, changes: updates } = await captureChanges(() =>
      updatePlaybook(db, orgA, row.id, {
        name: "Renamed",
        role: "review-summary",
        definition: { ...definition, description: "x" },
        requirements: {},
        updatedBy: "admin-2",
      }),
    );
    expect(updated).toMatchObject({
      name: "Renamed",
      role: "review-summary",
      requirements: {},
      createdBy: "admin-1",
      updatedBy: "admin-2",
    });
    expect(updates).toEqual([expect.objectContaining(event)]);

    const { result: deleted, changes: deletes } = await captureChanges(() =>
      deletePlaybook(db, orgA, row.id),
    );
    expect(deleted).toBe(true);
    expect(deletes).toEqual([expect.objectContaining(event)]);
    expect(await getStoredPlaybook(db, orgA, row.id)).toBeNull();
    expect(await deletePlaybook(db, orgA, row.id)).toBe(false);
  });

  it("never reads, updates or deletes another organization's playbook", async () => {
    const row = await insertPlaybook(db, orgA, {
      name: "Mine",
      role: "chat-ask",
      definition,
      requirements: {},
      createdBy: null,
    });
    expect(await getStoredPlaybook(db, orgB, row.id)).toBeNull();
    expect((await listStoredPlaybooks(db, orgB)).map((r) => r.id)).not.toContain(row.id);
    const { result, changes } = await captureChanges(async () => ({
      updated: await updatePlaybook(db, orgB, row.id, {
        name: "Stolen",
        role: "chat-ask",
        definition,
        requirements: {},
        updatedBy: null,
      }),
      deleted: await deletePlaybook(db, orgB, row.id),
    }));
    expect(result).toEqual({ updated: null, deleted: false });
    expect(changes).toEqual([]);
    expect((await getStoredPlaybook(db, orgA, row.id))?.name).toBe("Mine");
  });

  it("treats a built-in ID as no row", async () => {
    expect(await getStoredPlaybook(db, orgA, "builtin:review-pr")).toBeNull();
    expect(await deletePlaybook(db, orgA, "builtin:review-pr")).toBe(false);
  });

  it("deletes an organization's playbooks with it", async () => {
    const [doomed] = await db.insert(organizations).values({ name: "Doomed" }).returning();
    await insertPlaybook(db, doomed!.id, {
      name: "P",
      role: "chat-ask",
      definition: {},
      requirements: {},
      createdBy: null,
    });
    await db.delete(organizations).where(eq(organizations.id, doomed!.id));
    expect(
      await db.select().from(playbooks).where(eq(playbooks.organizationId, doomed!.id)),
    ).toEqual([]);
  });

  it("lists the repositories with their playbook bindings", async () => {
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: orgA,
        provider: "github",
        name: "GitHub",
        baseUrl: "https://api.github.com",
        encryptedCredentials: "x",
      })
      .returning();
    const playbookId = "55555555-5555-4555-8555-555555555555";
    const repo = (externalId: string, values: Partial<typeof repositories.$inferInsert>) => ({
      organizationId: orgA,
      provider: "github" as const,
      externalId,
      fullPath: `acme/${externalId}`,
      connectionId: connection!.id,
      ...values,
    });
    await db
      .insert(repositories)
      .values([
        repo("b", { reviewPlaybookIds: ["builtin:review-pr", playbookId] }),
        repo("a", { correlationPlaybookId: playbookId, storyPlaybookId: playbookId }),
        repo("c", { requestPlaybookId: playbookId }),
        repo("d", {}),
      ]);
    expect(await listRepositoryPlaybookBindings(db, orgA)).toEqual([
      expect.objectContaining({
        fullPath: "acme/a",
        reviewPlaybookIds: ["builtin:review-pr"],
        correlationPlaybookId: playbookId,
        storyPlaybookId: playbookId,
        requestPlaybookId: "builtin:handle-request",
      }),
      expect.objectContaining({
        fullPath: "acme/b",
        reviewPlaybookIds: ["builtin:review-pr", playbookId],
        correlationPlaybookId: "builtin:correlate-findings",
      }),
      expect.objectContaining({ fullPath: "acme/c", requestPlaybookId: playbookId }),
      expect.objectContaining({ fullPath: "acme/d", storyPlaybookId: "builtin:implement-story" }),
    ]);
    expect(await listRepositoryPlaybookBindings(db, orgB)).toEqual([]);
  });

  it("counts the organization's queued and running jobs of a playbook", async () => {
    const playbookId = "44444444-4444-4444-8444-444444444444";
    const job = (
      organizationId: string,
      status: "queued" | "running" | "completed",
      id = playbookId,
    ) => ({
      organizationId,
      type: "chat.ask",
      taskType: "query" as const,
      taskId: id,
      status,
    });
    expect(await countActivePlaybookJobs(db, orgA, playbookId)).toBe(0);
    await db
      .insert(jobs)
      .values([
        job(orgA, "queued"),
        job(orgA, "running"),
        job(orgA, "completed"),
        job(orgA, "queued", "builtin:chat-ask"),
        job(orgB, "queued"),
      ]);
    expect(await countActivePlaybookJobs(db, orgA, playbookId)).toBe(2);
    expect(await countActivePlaybookJobs(db, orgB, playbookId)).toBe(1);
  });
});
