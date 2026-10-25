// Settings change history: generic recording (any section's field map), paging, and the
// runs started since a change.
import { randomBytes } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import { connectRepository, upsertScmConnection } from "./repositories.js";
import {
  chatConnections,
  chatThreadRuns,
  chatThreads,
  integrations,
  jobs,
  organizations,
  ralphRuns,
  reviewRuns,
  settingsChanges,
  triageRuns,
  users,
} from "./schema.js";
import {
  countRunsSince,
  diffSettings,
  listSettingsChanges,
  recordSettingsChange,
  withSettingsChanges,
  type SettingsFields,
  type SettingsValues,
} from "./settings-changes.js";
import { seedReviewProfiles } from "./settings.js";

/** An arbitrary section: nothing in the recorder knows it. */
const FIELDS: SettingsFields = {
  color: { label: "Color" },
  tags: { label: "Tags" },
  enabled: { label: "Enabled" },
  apiKey: { label: "API key", secret: true },
};

describe("diffSettings", () => {
  it("keeps only the changed fields, in the map's order, with their labels", () => {
    expect(
      diffSettings(
        FIELDS,
        { color: "red", tags: ["a", "b"], enabled: true, apiKey: "k1" },
        { color: "blue", tags: ["a", "b"], enabled: false, apiKey: "k1" },
      ),
    ).toEqual([
      { field: "color", label: "Color", before: "red", after: "blue" },
      { field: "enabled", label: "Enabled", before: true, after: false },
    ]);
  });

  it("records secrets as changed, without their values", () => {
    expect(diffSettings(FIELDS, { apiKey: "old-secret" }, { apiKey: "new-secret" })).toEqual([
      { field: "apiKey", label: "API key", before: "changed", after: "changed" },
    ]);
  });

  it("reads a missing map or key as none, and ignores keys outside the map", () => {
    expect(diffSettings(FIELDS, null, { color: "red", other: "x" })).toEqual([
      { field: "color", label: "Color", before: null, after: "red" },
    ]);
    expect(diffSettings(FIELDS, { tags: ["a"] }, null)).toEqual([
      { field: "tags", label: "Tags", before: ["a"], after: null },
    ]);
    expect(diffSettings(FIELDS, { tags: ["a", "b"] }, { tags: ["a", "b"] })).toEqual([]);
  });
});

const databaseAvailable = testDatabaseAvailable();
const key = randomBytes(32);

describe.skipIf(!databaseAvailable)("settings changes", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let seq = 0;
  const actor = { userId: "user-1", name: "Ada Lovelace" };

  const organization = async (name: string) => {
    const [org] = await db.insert(organizations).values({ name }).returning();
    await seedReviewProfiles(db, org!.id);
    return org!.id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    orgId = await organization("Acme");
    otherOrgId = await organization("Other");
    await db.insert(users).values({ id: "user-1", name: "Ada Lovelace", email: "ada@acme.test" });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const subject = () => crypto.randomUUID();

  it("records one entry for an arbitrary section, and nothing when nothing changed", async () => {
    const subjectId = subject();
    const entry = await recordSettingsChange(db, {
      organizationId: orgId,
      section: "anything.at_all",
      subjectId,
      actor,
      fields: FIELDS,
      before: { color: "red", apiKey: "a" },
      after: { color: "red", apiKey: "b" },
    });
    expect(entry).toMatchObject({
      section: "anything.at_all",
      subjectId,
      actor,
      changes: [{ field: "apiKey", label: "API key", before: "changed", after: "changed" }],
    });
    const [row] = await db.select().from(settingsChanges).where(eq(settingsChanges.id, entry!.id));
    expect(JSON.stringify(row!.changes)).not.toMatch(/"a"|"b"/);

    const unchanged = await recordSettingsChange(db, {
      organizationId: orgId,
      section: "anything.at_all",
      subjectId,
      actor,
      fields: FIELDS,
      before: { color: "red" },
      after: { color: "red" },
    });
    expect(unchanged).toBeNull();
    const rows = await db
      .select()
      .from(settingsChanges)
      .where(eq(settingsChanges.subjectId, subjectId));
    expect(rows).toHaveLength(1);
  });

  it("publishes a settings change with section and subject only when the save commits", async () => {
    const subjectId = subject();
    let value = "red";
    const read = async (): Promise<SettingsValues> => ({ color: value });
    const tracked = {
      organizationId: orgId,
      section: "repository.reviews",
      subjectId,
      fields: FIELDS,
      read,
    };

    const { changes } = await captureChanges(() =>
      withSettingsChanges(db, actor, tracked, async () => {
        value = "blue";
      }),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "settings",
        section: "repository.reviews",
        subjectId,
        ids: [subjectId],
        organizationId: orgId,
      }),
    ]);

    const rolledBack = await captureChanges(() =>
      withSettingsChanges(db, actor, tracked, async (tx) => {
        value = "green";
        await tx.execute(sql`select 1`);
        throw new Error("save failed");
      }).catch(() => undefined),
    );
    expect(rolledBack.changes).toEqual([]);
    const page = await listSettingsChanges(db, {
      organizationIds: [orgId],
      section: "repository.reviews",
      subjectId,
    });
    expect(page.entries.map((e) => e.changes)).toEqual([
      [{ field: "color", label: "Color", before: "red", after: "blue" }],
    ]);
  });

  it("reads before and after on the save's transaction, with a field map built from the values", async () => {
    const subjectId = subject();
    const tracked = {
      organizationId: orgId,
      section: "custom.list",
      subjectId,
      fields: (before: SettingsValues | null, after: SettingsValues | null) =>
        Object.fromEntries(
          [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].map((k) => [
            k,
            { label: `Item ${k}` },
          ]),
        ),
      read: async (q: Database): Promise<SettingsValues> => {
        const rows = await q
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, otherOrgId));
        return { [rows[0]!.name]: "present" };
      },
    };
    await withSettingsChanges(db, actor, tracked, (tx) =>
      tx.update(organizations).set({ name: "Renamed" }).where(eq(organizations.id, otherOrgId)),
    );
    const page = await listSettingsChanges(db, {
      organizationIds: [orgId],
      section: "custom.list",
      subjectId,
    });
    expect(page.entries[0]!.changes).toEqual([
      { field: "Other", label: "Item Other", before: "present", after: null },
      { field: "Renamed", label: "Item Renamed", before: null, after: "present" },
    ]);
  });

  it("pages newest first, filtered by organization, section and subject", async () => {
    const subjectId = subject();
    const at = (s: string) => sql`${s}::timestamptz`;
    for (let i = 0; i < 5; i++) {
      await db.insert(settingsChanges).values({
        organizationId: orgId,
        section: "paged",
        subjectId,
        actorName: "Ada",
        // Two share a timestamp (to the microsecond).
        changedAt: at(i < 2 ? "2026-10-01T12:00:00.123456Z" : `2026-10-0${i}T12:00:00Z`) as never,
        changes: [{ field: "n", label: "N", before: i, after: i + 1 }],
      });
    }
    await db.insert(settingsChanges).values([
      { organizationId: orgId, section: "paged", subjectId: null, actorName: "Ada", changes: [] },
      { organizationId: otherOrgId, section: "paged", subjectId, actorName: "Eve", changes: [] },
      { organizationId: orgId, section: "elsewhere", subjectId, actorName: "Ada", changes: [] },
    ]);

    const seen: number[] = [];
    let cursor = null;
    do {
      const page = await listSettingsChanges(db, {
        organizationIds: [orgId],
        section: "paged",
        subjectId,
        cursor,
        limit: 2,
      });
      seen.push(...page.entries.map((e) => e.changes[0]!.before as number));
      cursor = page.next;
    } while (cursor);
    expect(seen.slice(0, 3)).toEqual([4, 3, 2]);
    expect(seen.slice(3).sort()).toEqual([0, 1]);

    const orgWide = await listSettingsChanges(db, { organizationIds: [orgId], section: "paged" });
    expect(orgWide.entries).toHaveLength(1);
    expect(orgWide.entries[0]!.subjectId).toBeNull();
    expect(
      (await listSettingsChanges(db, { organizationIds: [], section: "paged", subjectId })).entries,
    ).toEqual([]);
  });

  describe("countRunsSince", () => {
    const changedAt = new Date("2026-10-10T12:00:00Z");
    const before = new Date("2026-10-09T12:00:00Z");
    const after = new Date("2026-10-11T12:00:00Z");
    let org: string;
    let repoA: string;
    let repoB: string;
    let connectionId: string;
    let integrationId: string;
    let chatConnectionId: string;

    beforeAll(async () => {
      org = await organization("Counted");
      seq += 1;
      const connection = (await upsertScmConnection(
        db,
        {
          organizationId: org,
          provider: "github",
          name: "acme",
          baseUrl: "https://api.github.com",
          externalId: `counted-${seq}`,
          credentials: {},
        },
        key,
      ))!;
      connectionId = connection.id;
      const repo = (fullPath: string, externalId: string) =>
        connectRepository(db, { connectionId, provider: "github", externalId, fullPath });
      repoA = (await repo("acme/a", "a")).id;
      repoB = (await repo("acme/b", "b")).id;
      const [integration] = await db
        .insert(integrations)
        .values({
          organizationId: org,
          provider: "linear",
          externalId: "ws-counted",
          name: "Acme",
          encryptedCredentials: "x",
        })
        .returning();
      integrationId = integration!.id;
      const [chat] = await db
        .insert(chatConnections)
        .values({ organizationId: org, platform: "slack", externalId: "T-counted", name: "Acme" })
        .returning();
      chatConnectionId = chat!.id;
      const [thread] = await db
        .insert(chatThreads)
        .values({
          organizationId: org,
          connectionId: chatConnectionId,
          platform: "slack",
          externalThreadId: "thread-1",
          channelId: "C1",
          startedByExternalUserId: "U1",
        })
        .returning();

      let n = 0;
      const review = (repositoryId: string, createdAt: Date) =>
        db.insert(reviewRuns).values({
          organizationId: org,
          repositoryId,
          prNumber: 1,
          headSha: `h${++n}`,
          baseSha: "b",
          trigger: "webhook",
          mode: "full",
          createdAt,
        });
      const epic = (repositoryId: string, createdAt: Date) =>
        db.insert(ralphRuns).values({
          organizationId: org,
          repositoryId,
          kind: "children",
          linearIssueId: `issue-${++n}`,
          linearIdentifier: `ENG-${n}`,
          linearAgentSessionId: `session-${n}`,
          status: "completed",
          createdAt,
        });
      await review(repoA, before);
      await review(repoA, after);
      await review(repoA, after);
      await review(repoB, after);
      await epic(repoA, before);
      await epic(repoA, after);
      await db.insert(triageRuns).values({
        organizationId: org,
        linearIssueId: "issue-t",
        linearAgentSessionId: "session-t",
        trigger: "label",
        status: "completed",
        createdAt: after,
      });
      await db.insert(ralphRuns).values({
        organizationId: org,
        origin: "chat",
        mode: "request",
        kind: "single",
        chatThreadId: thread!.id,
        status: "completed",
        createdAt: after,
      });
      const [job] = await db
        .insert(jobs)
        .values({
          organizationId: org,
          type: "chat.ask",
          taskType: "query",
          pool: "short",
          payload: {},
          status: "completed",
        })
        .returning();
      await db.insert(chatThreadRuns).values({
        organizationId: org,
        chatThreadId: thread!.id,
        kind: "query",
        jobId: job!.id,
        createdAt: after,
      });
    });

    const count = (scope: Parameters<typeof countRunsSince>[3]) =>
      countRunsSince(db, org, changedAt, scope);

    it("counts runs of the organization started after the change, by kind and repository", async () => {
      expect(await count({})).toBe(7);
      expect(await count({ kinds: ["review"], repositoryId: repoA })).toBe(2);
      expect(await count({ kinds: ["epic", "request"], repositoryId: repoA })).toBe(1);
      expect(await count({ repositoryId: repoB })).toBe(1);
      expect(await count({ kinds: ["epic", "request", "triage"] })).toBe(3);
      expect(await countRunsSince(db, org, after, {})).toBe(0);
      expect(await countRunsSince(db, otherOrgId, changedAt, {})).toBe(0);
    });

    it("counts runs whose trigger came through a connection", async () => {
      expect(await count({ connectionId })).toBe(3);
      expect(await count({ connectionId: integrationId })).toBe(2);
      expect(await count({ connectionId: chatConnectionId })).toBe(2);
      expect(await count({ connectionId: crypto.randomUUID() })).toBe(0);
    });
  });
});
