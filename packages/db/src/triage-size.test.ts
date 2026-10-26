import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { organizations, triageRuns } from "./schema.js";
import { latestTriageSizes, triageIssueKey, triageSizesOf } from "./triage-size.js";

const databaseAvailable = testDatabaseAvailable();

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000);

describe.skipIf(!databaseAvailable)("triage sizes", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let session = 0;

  const triage = async (
    organizationId: string,
    linearIssueId: string,
    lastResult: Record<string, unknown> | null,
    createdMinutesAgo: number,
  ) => {
    session += 1;
    await db.insert(triageRuns).values({
      organizationId,
      linearIssueId,
      linearAgentSessionId: `session-${session}`,
      trigger: "label",
      status: "completed",
      lastResult,
      createdAt: ago(createdMinutesAgo),
      updatedAt: ago(createdMinutesAgo),
    });
  };
  const outcome = (size?: string) => ({
    summary: "s",
    error: null,
    outcome: { outcome: "prd", openQuestions: [], ...(size ? { size } : {}) },
  });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a, b] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = a!.id;
    beta = b!.id;
    // Resized: the newest triage with an outcome wins.
    await triage(acme, "resized", outcome("S"), 60);
    await triage(acme, "resized", outcome("XL"), 30);
    // A newer triage that failed (no outcome) leaves the last size in place.
    await triage(acme, "failed-since", outcome("M"), 60);
    await triage(acme, "failed-since", { summary: "s", error: "boom", outcome: null }, 10);
    // A newer triage still running (no result yet) does too.
    await triage(acme, "running-since", outcome("XS"), 60);
    await triage(acme, "running-since", null, 5);
    // An outcome without a size, and one with a size that isn't a t-shirt size.
    await triage(acme, "no-size", outcome(), 30);
    await triage(acme, "bad-size", outcome("XXL"), 30);
    // The same issue ID in another organization.
    await triage(beta, "resized", outcome("L"), 30);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("reads each issue's size from its newest triage with an outcome", async () => {
    const sizes = await latestTriageSizes(db, acme, [
      "resized",
      "failed-since",
      "running-since",
      "no-size",
      "bad-size",
      "never-triaged",
      "resized",
    ]);
    expect(Object.fromEntries(sizes)).toEqual({
      resized: "XL",
      "failed-since": "M",
      "running-since": "XS",
      "no-size": null,
      "bad-size": null,
      "never-triaged": null,
    });
  });

  it("reads only the organization's triage runs", async () => {
    expect(Object.fromEntries(await latestTriageSizes(db, beta, ["resized", "no-size"]))).toEqual({
      resized: "L",
      "no-size": null,
    });
  });

  it("returns an empty map without querying for no issues", async () => {
    expect((await latestTriageSizes(db, acme, [])).size).toBe(0);
  });

  it("reads issues of several organizations in one query", async () => {
    let queries = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "execute") return value;
        return (...args: unknown[]) => {
          queries += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const issues = [
      { organizationId: acme, linearIssueId: "resized" },
      { organizationId: beta, linearIssueId: "resized" },
      { organizationId: beta, linearIssueId: "failed-since" },
    ];
    const sizes = await triageSizesOf(counted, issues);
    expect(queries).toBe(1);
    expect(issues.map((issue) => sizes.get(triageIssueKey(issue)))).toEqual(["XL", "L", null]);
  });
});
