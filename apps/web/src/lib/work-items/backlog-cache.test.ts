import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createTriageRun,
  getRepository,
  organizations,
  recordWorkItemChange,
  saveIntegration,
  setTriageRunStatus,
  setTrackerLabels,
  setWorkItemRepository,
  clearWorkItemRepository,
  withSettingsChanges,
  upsertScmConnection,
  workItemOverrides,
  type Database,
} from "@omniralph/db";
import { captureChanges, type RecordedChange } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";
import { closeRedis, getRedis } from "@/lib/hot-state";
import { signBody } from "@omniralph/tracker/linear";
import type { OrganizationBacklog } from "./backlog";
import {
  affectsBacklog,
  cachedBacklog,
  dropBacklogCache,
  hasCachedBacklog,
  resetBacklogCache,
} from "./backlog-cache";

vi.mock("server-only", () => ({}));
// The card and rule saves' modules reach the session helpers (next-auth), unused here.
vi.mock("@/lib/auth/session", () => ({}));

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { handleLinearWebhook } = await import("@/lib/tracker/linear/ingest");
const { saveCodingCard } = await import("@/lib/repositories/cards");
const { saveRoutingRules } = await import("@/lib/routing/rules");
const { trackedTrackerLabels } = await import("@/lib/settings-history/sections");

const EMPTY: OrganizationBacklog = { entries: [], truncated: false };

/** Fills the organization's cache entry. */
const fill = async (organizationId: string) => {
  await cachedBacklog(organizationId, async () => EMPTY);
  expect(hasCachedBacklog(organizationId)).toBe(true);
};

/** The `work_item` changes among `changes`. */
const workItemChanges = (changes: RecordedChange[]) =>
  changes
    .filter((change) => change.resource === "work_item")
    .map(({ organizationId, ids }) => ({ organizationId, ids }));

describe("affectsBacklog", () => {
  it("is every work item, repository and connection change, and routing settings saves", () => {
    for (const resource of ["work_item", "repository", "connection"] as const) {
      expect(affectsBacklog({ resource })).toBe(true);
    }
    for (const section of ["routing_rules", "repository.coding", "connection"]) {
      expect(affectsBacklog({ resource: "settings", section })).toBe(true);
    }
    expect(affectsBacklog({ resource: "settings", section: "repository.reviews" })).toBe(false);
    for (const resource of ["run", "transcript", "agent", "inbox_state", "organization"] as const) {
      expect(affectsBacklog({ resource })).toBe(false);
    }
  });
});

describe("cachedBacklog in memory", () => {
  const org = randomUUID();
  beforeEach(() => resetBacklogCache());

  it("loads once while cached, and again after a drop", async () => {
    const load = vi.fn(async () => EMPTY);
    await Promise.all([cachedBacklog(org, load), cachedBacklog(org, load)]);
    await cachedBacklog(org, load);
    expect(load).toHaveBeenCalledTimes(1);
    await dropBacklogCache(org);
    await cachedBacklog(org, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("doesn't store a failed load, or one the cache was dropped during", async () => {
    await expect(
      cachedBacklog(org, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(hasCachedBacklog(org)).toBe(false);
    await cachedBacklog(org, async () => {
      void dropBacklogCache(org);
      return EMPTY;
    });
    expect(hasCachedBacklog(org)).toBe(false);
  });

  it("expires after five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await fill(org);
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      expect(hasCachedBacklog(org)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!(await testRedisAvailable()))("cachedBacklog in Redis", () => {
  let redis: TestRedis;
  const org = randomUUID();

  beforeAll(async () => {
    redis = await startTestRedis();
    vi.stubEnv("REDIS_URL", redis.url);
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    await redis?.stop();
  });

  it("shares an entry between instances and drops it for all of them", async () => {
    resetBacklogCache();
    const load = vi.fn(async () => EMPTY);
    await cachedBacklog(org, load);
    // Another instance (no local state) reads it from Redis.
    resetBacklogCache();
    expect(await cachedBacklog(org, load)).toEqual(EMPTY);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await getRedis().pttl(`backlog:${org}`)).toBeLessThanOrEqual(5 * 60_000);
    await dropBacklogCache(org);
    expect(await getRedis().exists(`backlog:${org}`)).toBe(0);
    await cachedBacklog(org, load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)(
  "what drops the Backlog cache and records a work_item change",
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let orgId: string;
    let repoId: string;

    beforeAll(async () => {
      testDb = await createTestDatabase();
      db = createDb(testDb.uri);
      const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
      orgId = org!.id;
      const connection = (await upsertScmConnection(
        db,
        {
          organizationId: orgId,
          provider: "github",
          name: "acme",
          baseUrl: "https://api.github.com",
          externalId: "1",
          credentials: {},
        },
        randomBytes(32),
      ))!;
      repoId = (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "github",
          externalId: "1",
          fullPath: "acme/api",
        })
      ).id;
      await saveIntegration(db, {
        organizationId: orgId,
        provider: "linear",
        externalId: "workspace-1",
        name: "Acme",
        credentials: { accessToken: "t" },
        installedByUserId: null,
      });
    }, 180_000);

    afterAll(async () => {
      if (db) await closeDb(db);
      await testDb?.stop();
    });

    beforeEach(async () => {
      resetBacklogCache();
      await fill(orgId);
    });

    it("a verified Linear Issue webhook for the organization", async () => {
      const body = JSON.stringify({
        type: "Issue",
        action: "update",
        organizationId: "workspace-1",
        webhookTimestamp: Date.now(),
        data: { id: "issue-1", identifier: "ENG-1", parentId: "issue-0" },
        updatedFrom: { stateId: "state-a" },
      });
      const deliver = (signature: string) =>
        handleLinearWebhook(
          new Request("https://omniralph.example.com/api/webhooks/linear", {
            method: "POST",
            headers: { "linear-signature": signature, "linear-delivery": randomUUID() },
            body,
          }),
          { db, secret: "secret", handle: async () => {} },
        );
      // Unverified: nothing.
      const rejected = await captureChanges(() => deliver("bad"));
      expect(rejected.result.status).toBe(401);
      expect(workItemChanges(rejected.changes)).toEqual([]);
      expect(hasCachedBacklog(orgId)).toBe(true);

      const { result, changes } = await captureChanges(() => deliver(signBody(body, "secret")));
      expect(result.status).toBe(200);
      expect(workItemChanges(changes)).toEqual([
        { organizationId: orgId, ids: ["linear-issue-1", "linear-issue-0"] },
      ]);
      expect(hasCachedBacklog(orgId)).toBe(false);
    });

    it("a run created for an issue", async () => {
      const { changes } = await captureChanges(() =>
        createRun(db, {
          organizationId: orgId,
          trackerIssueId: "issue-run",
          trackerIdentifier: "ENG-2",
          trackerSessionId: `session-${randomUUID()}`,
          kind: "children",
          repositoryId: repoId,
          branch: "feat/eng-2",
          baseBranch: "main",
        }),
      );
      expect(workItemChanges(changes)).toEqual([
        { organizationId: orgId, ids: ["linear-issue-run"] },
      ]);
      expect(hasCachedBacklog(orgId)).toBe(false);
    });

    it("a triage run changing status", async () => {
      const { run } = await createTriageRun(db, {
        organizationId: orgId,
        trackerIssueId: "issue-triage",
        trackerSessionId: `triage-${randomUUID()}`,
        trigger: "label",
      });
      await fill(orgId);
      const { changes } = await captureChanges(() => setTriageRunStatus(db, run.id, "running"));
      expect(workItemChanges(changes)).toEqual([
        { organizationId: orgId, ids: ["linear-issue-triage"] },
      ]);
      expect(hasCachedBacklog(orgId)).toBe(false);
    });

    it("a repo choice saved or cleared", async () => {
      const key = { organizationId: orgId, tracker: "linear" as const, externalId: "issue-choice" };
      const saved = await captureChanges(() =>
        setWorkItemRepository(db, { ...key, repositoryId: repoId, userId: null }),
      );
      expect(workItemChanges(saved.changes)).toEqual([
        { organizationId: orgId, ids: ["linear-issue-choice"] },
      ]);
      expect(hasCachedBacklog(orgId)).toBe(false);

      await fill(orgId);
      const cleared = await captureChanges(() => clearWorkItemRepository(db, key));
      expect(cleared.result).toBe(true);
      expect(workItemChanges(cleared.changes)).toEqual([
        { organizationId: orgId, ids: ["linear-issue-choice"] },
      ]);
      expect(hasCachedBacklog(orgId)).toBe(false);
    });

    it("not a repo choice whose transaction rolls back", async () => {
      const { changes } = await captureChanges(async () => {
        await db
          .transaction(async (tx) => {
            await setWorkItemRepository(tx, {
              organizationId: orgId,
              tracker: "linear",
              externalId: "issue-rolled-back",
              repositoryId: repoId,
              userId: null,
            });
            throw new Error("roll back");
          })
          .catch(() => undefined);
      });
      expect(changes).toEqual([]);
      expect(hasCachedBacklog(orgId)).toBe(true);
      expect(await db.select().from(workItemOverrides)).not.toContainEqual(
        expect.objectContaining({ externalId: "issue-rolled-back" }),
      );
    });

    it("a work item match save", async () => {
      const repository = (await getRepository(db, repoId))!;
      const { changes } = await captureChanges(() =>
        saveCodingCard(db, { userId: null, name: "Ada" }, repository, {
          codingEnabled: true,
          workItemMatch: {
            tracker: "linear",
            team: "ENG",
            project: null,
            withoutProject: false,
            labels: [],
          },
          codingInstructions: null,
          openPullRequestEarly: false,
          historyRewrite: "never",
          respondToReviewsAndCi: true,
          checks: [],
        }),
      );
      expect(changes.map((change) => change.resource)).toContain("repository");
      expect(hasCachedBacklog(orgId)).toBe(false);
    });

    it("a routing rules save", async () => {
      const { changes } = await captureChanges(() =>
        saveRoutingRules(
          db,
          orgId,
          [
            {
              repositoryId: repoId,
              query: {
                combinator: "and",
                rules: [{ field: "team", operator: "=", value: "ENG" }],
              },
            },
          ],
          { userId: null, name: "Ada" },
        ),
      );
      expect(changes).toContainEqual(
        expect.objectContaining({ resource: "settings", section: "routing_rules" }),
      );
      expect(hasCachedBacklog(orgId)).toBe(false);
    });

    it("a tracker labels save (blocked and manual labels)", async () => {
      const { changes } = await captureChanges(() =>
        withSettingsChanges(db, { userId: null, name: "Ada" }, trackedTrackerLabels(orgId), (tx) =>
          setTrackerLabels(
            tx,
            orgId,
            { manualLabels: ["by hand"], blockedLabels: ["on hold"] },
            null,
          ),
        ),
      );
      expect(changes).toContainEqual(
        expect.objectContaining({ resource: "settings", section: "routing_rules" }),
      );
      expect(hasCachedBacklog(orgId)).toBe(false);
    });

    it("not another organization's change", async () => {
      const other = randomUUID();
      await fill(other);
      await captureChanges(async () =>
        recordWorkItemChange(db, { organizationId: other, tracker: "linear", externalIds: ["x"] }),
      );
      expect(hasCachedBacklog(other)).toBe(false);
      expect(hasCachedBacklog(orgId)).toBe(true);
    });
  },
);
