import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeDb,
  createDb,
  createRun,
  createTriageRun,
  organizations,
  ralphRuns,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TrackerNotConnectedError,
  type WorkItem,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";

vi.mock("server-only", () => ({}));

const { createWorkItemResolver, workItemIdentifiers, WORK_ITEMS_CACHE_TTL_MS } =
  await import("./work-items");

const databaseAvailable = testDatabaseAvailable();

describe("workItemIdentifiers", () => {
  it("finds each identifier once, in order", () => {
    expect(
      workItemIdentifiers(
        "Fixed in ENG-12 (see ENG-12 and TOOL-639); not eng-3, A-, X1-, ab ENG-4x",
      ),
    ).toEqual(["ENG-12", "TOOL-639"]);
    expect(workItemIdentifiers("Nothing here.")).toEqual([]);
  });
});

describe("lib/ask", () => {
  it("imports nothing from @/lib/linear", () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["']@\/lib\/linear\//);
      expect(source, file).not.toMatch(/import\(\s*["']@\/lib\/linear\//);
    }
  });
});

describe.skipIf(!databaseAvailable)("createWorkItemResolver", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let issueRun: string;
  let triageRun: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    // ENG-1 has a coding run, then a newer triage run; ENG-2 has none.
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: "issue-1",
      linearIdentifier: "ENG-1",
      linearAgentSessionId: "session-1",
      kind: "children",
      repositoryId: null,
      branch: "omniralph/eng-1",
      baseBranch: "main",
    } as Parameters<typeof createRun>[1]);
    issueRun = run.id;
    await db
      .update(ralphRuns)
      .set({ createdAt: new Date("2026-10-01T00:00:00Z") })
      .where(eq(ralphRuns.id, run.id));
    const triage = await createTriageRun(db, {
      organizationId: orgId,
      linearIssueId: "issue-1",
      linearAgentSessionId: "session-2",
      trigger: "mention",
    });
    triageRun = triage.run.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const item = (identifier: string, id: string): WorkItem =>
    ({
      tracker: "linear",
      id,
      identifier,
      url: `https://linear.app/acme/issue/${identifier}`,
    }) as WorkItem;

  /** A tracker knowing ENG-1 and ENG-2, counting its lookups. */
  function fakeTracker() {
    const known = [item("ENG-1", "issue-1"), item("ENG-2", "issue-2")];
    const findByIdentifiers = vi.fn(async (identifiers: readonly string[]) =>
      known.filter((i) => identifiers.includes(i.identifier)),
    );
    const tracker = { kind: "linear", findByIdentifiers } as unknown as WorkItemTracker;
    return { tracker, findByIdentifiers };
  }

  it("returns the identifiers the tracker recognizes with their newest run, in one lookup", async () => {
    const { tracker, findByIdentifiers } = fakeTracker();
    const resolver = createWorkItemResolver({ db, getTracker: async () => tracker });

    expect(await resolver.resolve(orgId, ["ENG-2", "NOPE-1", "ENG-1", "ENG-2"])).toEqual([
      {
        tracker: "linear",
        identifier: "ENG-2",
        url: "https://linear.app/acme/issue/ENG-2",
        runId: null,
      },
      {
        tracker: "linear",
        identifier: "ENG-1",
        url: "https://linear.app/acme/issue/ENG-1",
        runId: triageRun,
      },
    ]);
    expect(findByIdentifiers).toHaveBeenCalledTimes(1);
    expect(findByIdentifiers).toHaveBeenCalledWith(["ENG-2", "NOPE-1", "ENG-1"]);
    expect(issueRun).not.toBe(triageRun);
    expect(await resolver.resolve(orgId, [])).toEqual([]);
    expect(findByIdentifiers).toHaveBeenCalledTimes(1);
  });

  it("caches what the tracker said for 10 minutes per organization", async () => {
    const { tracker, findByIdentifiers } = fakeTracker();
    let now = Date.parse("2026-10-27T12:00:00Z");
    const resolver = createWorkItemResolver({
      db,
      getTracker: async () => tracker,
      now: () => now,
    });

    await resolver.resolve(orgId, ["ENG-1", "NOPE-1"]);
    // Known and unknown identifiers alike are cached.
    expect(await resolver.resolve(orgId, ["NOPE-1", "ENG-1"])).toHaveLength(1);
    expect(findByIdentifiers).toHaveBeenCalledTimes(1);
    // Only identifiers not asked about yet are looked up.
    await resolver.resolve(orgId, ["ENG-1", "ENG-2"]);
    expect(findByIdentifiers).toHaveBeenCalledTimes(2);
    expect(findByIdentifiers).toHaveBeenLastCalledWith(["ENG-2"]);
    // Another organization has its own cache.
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    await resolver.resolve(other!.id, ["ENG-1"]);
    expect(findByIdentifiers).toHaveBeenCalledTimes(3);

    now += WORK_ITEMS_CACHE_TTL_MS - 1;
    await resolver.resolve(orgId, ["ENG-1"]);
    expect(findByIdentifiers).toHaveBeenCalledTimes(3);
    now += 1;
    await resolver.resolve(orgId, ["ENG-1"]);
    expect(findByIdentifiers).toHaveBeenCalledTimes(4);
  });

  it("returns nothing without a tracker, and retries after a tracker's failure", async () => {
    const notConnected = createWorkItemResolver({
      db,
      getTracker: async () => {
        throw new TrackerNotConnectedError();
      },
    });
    expect(await notConnected.resolve(orgId, ["ENG-1"])).toEqual([]);
    // The organization's real tracker: it has no Linear connection.
    expect(await createWorkItemResolver({ db }).resolve(orgId, ["ENG-1"])).toEqual([]);

    const { tracker, findByIdentifiers } = fakeTracker();
    findByIdentifiers.mockRejectedValueOnce(new Error("Linear is down"));
    const warn = vi.fn();
    const flaky = createWorkItemResolver({
      db,
      getTracker: async () => tracker,
      logger: { warn },
    });
    expect(await flaky.resolve(orgId, ["ENG-1"])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await flaky.resolve(orgId, ["ENG-1"])).toMatchObject([{ identifier: "ENG-1" }]);
    expect(findByIdentifiers).toHaveBeenCalledTimes(2);
  });
});
