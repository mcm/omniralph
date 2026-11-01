import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { connectRepository, upsertScmConnection } from "./repositories.js";
import { getResourceOrganizationId } from "./resource-organization.js";
import {
  listRunIndex,
  RUN_KINDS,
  RUN_ORIGIN_MAP,
  RUN_STATUS_MAP,
  runStatusSql,
  unifiedRunStatus,
  type RunKind,
} from "./run-index.js";
import {
  chatConnections,
  chatThreadRuns,
  chatThreads,
  jobs,
  jobStatus,
  organizations,
  ralphRunMode,
  ralphRunOrigin,
  ralphRunStatus,
  reviewRuns,
  reviewRunStatus,
  reviewTrigger,
  triageRuns,
  triageRunStatus,
  triageRunTrigger,
} from "./schema.js";

/** Every source status of every kind, and what it maps to (PRD "Unified run model"). */
const EXPECTED: Record<RunKind, [readonly string[], Record<string, string>]> = {
  epic: [ralphRunStatus.enumValues, { pending: "queued" }],
  request: [ralphRunStatus.enumValues, { pending: "queued" }],
  review: [reviewRunStatus.enumValues, { correlating: "running" }],
  triage: [triageRunStatus.enumValues, {}],
  ask: [jobStatus.enumValues, { canceled: "stopped", expired: "failed" }],
};

describe("unifiedRunStatus", () => {
  it.each(RUN_KINDS)("maps every %s source status", (kind) => {
    const [sources, renamed] = EXPECTED[kind];
    expect(Object.keys(RUN_STATUS_MAP[kind]).sort()).toEqual([...sources].sort());
    for (const source of sources) {
      expect(unifiedRunStatus(kind, source)).toBe(renamed[source] ?? source);
    }
  });

  it("refuses a status the kind doesn't have", () => {
    expect(() => unifiedRunStatus("review", "stopped")).toThrow(/Unknown review run status/);
  });

  it("maps every origin of every source", () => {
    expect(Object.keys(RUN_ORIGIN_MAP.ralph).sort()).toEqual(
      ralphRunOrigin.enumValues
        .flatMap((o) => ralphRunMode.enumValues.map((m) => `${o}:${m}`))
        .sort(),
    );
    expect(Object.keys(RUN_ORIGIN_MAP.review).sort()).toEqual([...reviewTrigger.enumValues].sort());
    expect(Object.keys(RUN_ORIGIN_MAP.triage).sort()).toEqual(
      [...triageRunTrigger.enumValues].sort(),
    );
  });
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("run index", () => {
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

  it("maps statuses in SQL exactly as unifiedRunStatus does", async () => {
    for (const kind of RUN_KINDS) {
      for (const source of EXPECTED[kind][0]) {
        const result = await db.execute<{ status: string }>(
          sql`select ${runStatusSql(kind, sql`${source}::text`)} as status`,
        );
        expect([kind, source, result.rows[0]!.status]).toEqual([
          kind,
          source,
          unifiedRunStatus(kind, source),
        ]);
      }
    }
  });

  it("pages through runs sharing a created_at, each exactly once", async () => {
    // Microseconds the JS Date can't hold: the cursor must keep them.
    const at = sql`'2026-10-01T12:00:00.123456Z'::timestamptz`;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const [run] = await db
        .insert(triageRuns)
        .values({
          organizationId: orgId,
          trackerIssueId: `issue-${i}`,
          trackerSessionId: `session-${i}`,
          trigger: "label",
          status: "completed",
          createdAt: i < 5 ? at : sql`'2026-10-01T12:00:00.123455Z'::timestamptz`,
        })
        .returning();
      ids.push(run!.id);
    }

    const seen: string[] = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const { runs, next } = await listRunIndex(db, {
        organizationIds: [orgId],
        cursor,
        limit: 2,
      });
      seen.push(...runs.map((r) => r.id));
      if (!next) break;
      cursor = next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(ids));
    // The five newer ones first (by ID, descending), then the two older ones.
    expect(seen.slice(0, 5).sort()).toEqual(ids.slice(0, 5).sort());
    expect(seen.slice(0, 5)).toEqual([...seen.slice(0, 5)].sort().reverse());
  });

  it("lists nothing without organizations", async () => {
    expect(await listRunIndex(db, { organizationIds: [] })).toEqual({ runs: [], next: null });
  });

  it("resolves the organization of a review run and an ask (getResourceOrganizationId)", async () => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "resource-1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const repository = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "resource-repo",
      fullPath: "acme/api",
    });
    const [review] = await db
      .insert(reviewRuns)
      .values({
        organizationId: orgId,
        repositoryId: repository.id,
        prNumber: 1,
        headSha: "h",
        baseSha: "b",
        trigger: "webhook",
        mode: "full",
      })
      .returning();
    const [chat] = await db
      .insert(chatConnections)
      .values({ organizationId: orgId, platform: "slack", externalId: "T-res", name: "Acme" })
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        organizationId: orgId,
        connectionId: chat!.id,
        platform: "slack",
        externalThreadId: "thread-res",
        channelId: "C1",
        startedByExternalUserId: "U1",
      })
      .returning();
    const [job] = await db
      .insert(jobs)
      .values({ organizationId: orgId, type: "chat.ask", taskType: "query" })
      .returning();
    const [ask] = await db
      .insert(chatThreadRuns)
      .values({ organizationId: orgId, chatThreadId: thread!.id, kind: "query", jobId: job!.id })
      .returning();

    expect(await getResourceOrganizationId(db, "review_run", review!.id)).toBe(orgId);
    expect(await getResourceOrganizationId(db, "ask_run", ask!.id)).toBe(orgId);
    // Unknown IDs, and IDs of another resource, resolve to nothing.
    expect(await getResourceOrganizationId(db, "review_run", ask!.id)).toBeNull();
    expect(await getResourceOrganizationId(db, "ask_run", review!.id)).toBeNull();
    expect(await getResourceOrganizationId(db, "ask_run", crypto.randomUUID())).toBeNull();
  });
});
