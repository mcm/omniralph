import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureChanges,
  ChangeCollector,
  currentChangeCollector,
  recordChange,
  runWithChangeCollector,
  type Change,
} from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import { organizations } from "./schema.js";

const ORG = "0b7d9a2e-4c1f-4e8a-9b3d-5f6a7b8c9d0e";
const change = (id: string, extra: Partial<Change> = {}): Change => ({
  resource: "run",
  ids: [id],
  organizationId: ORG,
  ...extra,
});

describe("recordChange", () => {
  it("is a no-op outside a collector", () => {
    expect(currentChangeCollector()).toBeUndefined();
    expect(() => recordChange({}, change("a"))).not.toThrow();
  });

  it("collects changes and merges those that differ only in their IDs", async () => {
    const { changes } = await captureChanges(async () => {
      recordChange({}, change("a", { runId: "r1" }));
      recordChange({}, change("b", { runId: "r1" }));
      recordChange({}, change("a", { runId: "r1" }));
      recordChange({}, change("c", { runId: "r2" }));
      recordChange({}, change("u", { resource: "inbox_state", userId: "user-1" }));
      recordChange({}, { ...change("x"), ids: [] });
    });
    expect(changes.map(({ at: _at, ...rest }) => rest)).toEqual([
      { resource: "run", ids: ["a", "b"], organizationId: ORG, runId: "r1" },
      { resource: "run", ids: ["c"], organizationId: ORG, runId: "r2" },
      { resource: "inbox_state", ids: ["u"], organizationId: ORG, userId: "user-1" },
    ]);
    expect(changes[0]!.at).toBeInstanceOf(Date);
  });

  it("drains only what was recorded since the last drain", () => {
    const collector = new ChangeCollector();
    runWithChangeCollector(collector, () => recordChange({}, change("a")));
    expect(collector.drain()).toHaveLength(1);
    expect(collector.drain()).toEqual([]);
  });
});

describe.skipIf(!testDatabaseAvailable())("recordChange in transactions", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const ids = (changes: { ids: string[] }[]) => changes.flatMap((c) => c.ids);

  it("keeps a transaction's changes once it commits", async () => {
    const collector = new ChangeCollector();
    await runWithChangeCollector(collector, () =>
      db.transaction(async (tx) => {
        await tx.insert(organizations).values({ name: "Committed" });
        recordChange(tx, change("committed"));
        expect(collector.size).toBe(0);
      }),
    );
    expect(ids(collector.drain())).toEqual(["committed"]);
  });

  it("publishes nothing for a rolled-back transaction", async () => {
    const { changes } = await captureChanges(async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(organizations).values({ name: "Rolled back" });
          recordChange(tx, change("rolled-back"));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await expect(
        db.transaction(async (tx) => {
          recordChange(tx, change("tx-rollback"));
          tx.rollback();
        }),
      ).rejects.toThrow();
    });
    expect(changes).toEqual([]);
    expect(
      await db.select().from(organizations).where(eq(organizations.name, "Rolled back")),
    ).toEqual([]);
  });

  it("drops a rolled-back savepoint's changes and keeps the rest of its transaction", async () => {
    const { changes } = await captureChanges(() =>
      db.transaction(async (tx) => {
        recordChange(tx, change("outer"));
        await tx.transaction(async (sp) => {
          recordChange(sp, change("released"));
        });
        await tx
          .transaction(async (sp) => {
            recordChange(sp, change("savepoint-rolled-back"));
            throw new Error("nested");
          })
          .catch(() => {});
      }),
    );
    expect(ids(changes).sort()).toEqual(["outer", "released"]);
  });

  it("drops a released savepoint's changes when the transaction rolls back", async () => {
    const { changes } = await captureChanges(async () => {
      await db
        .transaction(async (tx) => {
          await tx.transaction(async (sp) => recordChange(sp, change("released")));
          throw new Error("outer");
        })
        .catch(() => {});
    });
    expect(changes).toEqual([]);
  });

  it("keeps a write on the client inside a transaction callback (committed on its own)", async () => {
    const { changes } = await captureChanges(async () => {
      await db
        .transaction(async () => {
          recordChange(db, change("client"));
          throw new Error("outer");
        })
        .catch(() => {});
    });
    expect(ids(changes)).toEqual(["client"]);
  });

  it("returns the transaction's result", async () => {
    const { result } = await captureChanges(() => db.transaction(async () => 42));
    expect(result).toBe(42);
    expect(await db.transaction(async () => "no collector")).toBe("no collector");
  });
});
