import { randomUUID } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import {
  answerRunPermissionRequest,
  createRunPermissionRequest,
  getRunPermissionRequest,
  insertRunActivity,
  listOpenRunPermissionRequests,
  listRecentRunActivities,
  listRunActivities,
} from "./runs.js";
import { jobs, organizations, runActivities, runPermissionRequests } from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("run activities and permission requests", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function newJob() {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "chat.ask",
        taskType: "query",
        pool: "short",
        taskId: "builtin:chat-ask",
        status: "running",
      })
      .returning();
    return job!.id;
  }

  describe("activities", () => {
    it("stores activities and lists a job's oldest first", async () => {
      const jobId = await newJob();
      const other = await newJob();
      await insertRunActivity(db, {
        jobId,
        organizationId: orgId,
        type: "thought",
        body: "Reading the code.",
        // Dropped: thoughts have no parameter.
        parameter: "ignored",
      });
      await insertRunActivity(db, {
        jobId: other,
        organizationId: orgId,
        type: "thought",
        body: "Elsewhere.",
      });
      await insertRunActivity(db, {
        jobId,
        organizationId: orgId,
        type: "action",
        body: "Grep",
        parameter: "TODO",
      });

      const listed = await listRunActivities(db, jobId);
      expect(listed.map(({ type, body, parameter }) => ({ type, body, parameter }))).toEqual([
        { type: "thought", body: "Reading the code.", parameter: null },
        { type: "action", body: "Grep", parameter: "TODO" },
      ]);
      expect(listed.every((a) => a.organizationId === orgId && a.jobId === jobId)).toBe(true);
      expect(await listRunActivities(db, randomUUID())).toEqual([]);
    });

    it("lists the latest activities of a run's jobs, oldest first, for the organization only", async () => {
      const first = await newJob();
      const second = await newJob();
      const elsewhere = await newJob();
      const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
      for (const [jobId, body, s] of [
        [first, "one", 1],
        [second, "two", 2],
        [elsewhere, "not this run", 3],
        [first, "three", 4],
      ] as const) {
        const row = await insertRunActivity(db, {
          jobId,
          organizationId: orgId,
          type: "thought",
          body,
        });
        await db
          .update(runActivities)
          .set({ createdAt: at(s) })
          .where(eq(runActivities.id, row.id));
      }
      const bodies = async (orgOf: string, ids: string[], limit: number) =>
        (await listRecentRunActivities(db, orgOf, ids, limit)).map((a) => a.body);
      expect(await bodies(orgId, [first, second], 10)).toEqual(["one", "two", "three"]);
      expect(await bodies(orgId, [first, second], 2)).toEqual(["two", "three"]);
      expect(await bodies(randomUUID(), [first, second], 10)).toEqual([]);
      expect(await bodies(orgId, [], 10)).toEqual([]);
    });

    it("rejects unknown types and goes away with the job", async () => {
      const jobId = await newJob();
      await expect(
        insertRunActivity(db, {
          jobId,
          organizationId: orgId,
          type: "response" as "thought",
          body: "Done",
        }),
      ).rejects.toThrow();
      await insertRunActivity(db, { jobId, organizationId: orgId, type: "thought", body: "Hi" });
      await db.delete(jobs).where(eq(jobs.id, jobId));
      expect(await db.select().from(runActivities).where(eq(runActivities.jobId, jobId))).toEqual(
        [],
      );
    });
  });

  describe("permission requests", () => {
    const askedAt = new Date("2026-10-11T10:00:00Z");
    const expiresAt = new Date("2026-10-11T10:10:00Z");

    it("creates a request once per job and request ID", async () => {
      const jobId = await newJob();
      const requestId = randomUUID();
      const first = await createRunPermissionRequest(db, {
        jobId,
        requestId,
        tool: "Bash",
        detail: "git push",
        askedAt,
        expiresAt,
      });
      expect(first.created).toBe(true);
      expect(first.request).toMatchObject({
        jobId,
        requestId,
        tool: "Bash",
        detail: "git push",
        askedAt,
        expiresAt,
        answer: null,
        answeredAt: null,
        answeredBy: null,
      });
      const again = await createRunPermissionRequest(db, {
        jobId,
        requestId,
        tool: "Other",
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      });
      expect(again).toEqual({ request: first.request, created: false });

      // The same request ID in another job is another request.
      const other = await newJob();
      expect(
        (await createRunPermissionRequest(db, { jobId: other, requestId, tool: "Bash", expiresAt }))
          .created,
      ).toBe(true);

      expect(await getRunPermissionRequest(db, jobId, requestId)).toEqual(first.request);
      expect(await getRunPermissionRequest(db, jobId, randomUUID())).toBeNull();
    });

    it("keeps the first answer", async () => {
      const jobId = await newJob();
      const requestId = randomUUID();
      await createRunPermissionRequest(db, { jobId, requestId, tool: "Bash", expiresAt });
      const answeredAt = new Date("2026-10-11T10:05:00Z");

      const first = await answerRunPermissionRequest(db, {
        jobId,
        requestId,
        answer: "allowed",
        answeredBy: "Ada",
        answeredAt,
      });
      expect(first.answered).toBe(true);
      expect(first.request).toMatchObject({ answer: "allowed", answeredBy: "Ada", answeredAt });

      const later = await answerRunPermissionRequest(db, {
        jobId,
        requestId,
        answer: "expired",
      });
      expect(later).toEqual({ request: first.request, answered: false });
      expect(await getRunPermissionRequest(db, jobId, requestId)).toEqual(first.request);

      expect(
        await answerRunPermissionRequest(db, { jobId, requestId: randomUUID(), answer: "denied" }),
      ).toEqual({ request: null, answered: false });
    });

    it("lists a run's open requests: unanswered and unexpired", async () => {
      const jobId = await newJob();
      const other = await newJob();
      const now = new Date();
      const later = new Date(now.getTime() + 60_000);
      const open = await createRunPermissionRequest(db, {
        jobId,
        requestId: randomUUID(),
        tool: "Bash",
        expiresAt: later,
      });
      const answered = randomUUID();
      await createRunPermissionRequest(db, {
        jobId,
        requestId: answered,
        tool: "Edit",
        expiresAt: later,
      });
      await answerRunPermissionRequest(db, { jobId, requestId: answered, answer: "denied" });
      await createRunPermissionRequest(db, {
        jobId,
        requestId: randomUUID(),
        tool: "Write",
        expiresAt: new Date(now.getTime() - 1_000),
      });
      await createRunPermissionRequest(db, {
        jobId: other,
        requestId: randomUUID(),
        tool: "Bash",
        expiresAt: later,
      });
      expect(await listOpenRunPermissionRequests(db, [jobId], now)).toEqual([open.request]);
      expect(await listOpenRunPermissionRequests(db, [], now)).toEqual([]);
    });

    it("rejects unknown answers and goes away with the job", async () => {
      const jobId = await newJob();
      const requestId = randomUUID();
      await createRunPermissionRequest(db, { jobId, requestId, tool: "Bash", expiresAt });
      await expect(
        answerRunPermissionRequest(db, { jobId, requestId, answer: "maybe" as "allowed" }),
      ).rejects.toThrow();
      await db.delete(jobs).where(eq(jobs.id, jobId));
      expect(
        await db.select().from(runPermissionRequests).where(eq(runPermissionRequests.jobId, jobId)),
      ).toEqual([]);
    });
  });
});
