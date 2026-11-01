import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { connectRepository, upsertScmConnection } from "./repositories.js";
import {
  changeNumberOf,
  escapeLike,
  getSearchAgents,
  getSearchRepositories,
  listRecentItems,
  RECENT_ITEMS_CAP,
  recordRecentItem,
  searchAgents,
  searchRepositories,
  searchRuns,
} from "./search.js";
import {
  agents,
  organizations,
  ralphLanes,
  ralphRuns,
  repositories,
  reviewRuns,
  reviews,
  users,
} from "./schema.js";
import { eq } from "drizzle-orm";

describe("changeNumberOf", () => {
  it("reads a PR/MR number with or without its sign", () => {
    expect(changeNumberOf("12")).toBe(12);
    expect(changeNumberOf("#12")).toBe(12);
    expect(changeNumberOf(" !7 ")).toBe(7);
    expect(changeNumberOf("SOC-12")).toBeNull();
    expect(changeNumberOf("#")).toBeNull();
  });
});

describe("escapeLike", () => {
  it("escapes LIKE's wildcards", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("search", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let repo: string;
  let userId: string;
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  async function epic(values: {
    organizationId?: string;
    identifier: string;
    title: string;
    updated: number;
    repositoryId?: string | null;
  }) {
    const [run] = await db
      .insert(ralphRuns)
      .values({
        organizationId: values.organizationId ?? acme,
        trackerIssueId: `issue-${values.identifier}`,
        trackerIdentifier: values.identifier,
        trackerTitle: values.title,
        trackerSessionId: `session-${randomUUID()}`,
        kind: "children",
        mode: "epic",
        repositoryId: values.repositoryId === undefined ? repo : values.repositoryId,
        status: "running",
        createdAt: at(values.updated + 10),
        updatedAt: at(values.updated),
      })
      .returning();
    return run!.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a, b] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = a!.id;
    beta = b!.id;
    const [user] = await db.insert(users).values({ email: "ann@example.com" }).returning();
    userId = user!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: acme,
        provider: "gitlab",
        name: "acme",
        baseUrl: "https://gitlab.example.com",
        externalId: "search-1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repo = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "web",
        fullPath: "acme/platform/web",
      })
    ).id;
    await connectRepository(db, {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: "web-admin",
      fullPath: "acme/web-admin",
    });
    const gone = await connectRepository(db, {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: "web-old",
      fullPath: "acme/web-old",
    });
    await db
      .update(repositories)
      .set({ disconnectedAt: new Date() })
      .where(eq(repositories.id, gone.id));
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("ranks runs exact, then prefix, then substring, newest first within a tier", async () => {
    const substring = await epic({ identifier: "ENG-1", title: "Fix SOC-17 login", updated: 1 });
    const prefixOld = await epic({ identifier: "SOC-171", title: "Old", updated: 30 });
    const prefixNew = await epic({ identifier: "SOC-172", title: "New", updated: 5 });
    const exact = await epic({ identifier: "SOC-17", title: "Exact", updated: 60 });
    await epic({ organizationId: beta, identifier: "SOC-17", title: "Other org", updated: 0 });

    const hits = await searchRuns(db, { organizationIds: [acme], query: "soc-17", limit: 10 });
    expect(hits.map((h) => [h.entry.id, h.tier])).toEqual([
      [exact, 0],
      [prefixNew, 1],
      [prefixOld, 1],
      [substring, 2],
    ]);
    expect(
      await searchRuns(db, { organizationIds: [acme], query: "soc-17", limit: 2 }),
    ).toHaveLength(2);
    expect(await searchRuns(db, { organizationIds: [], query: "soc-17" })).toEqual([]);
  });

  it("finds a run by its PR/MR number and a review by its PR title", async () => {
    const run = await epic({ identifier: "PR-1", title: "With a merge request", updated: 2 });
    await db.insert(ralphLanes).values({
      runId: run,
      repositoryId: repo,
      branch: "omniralph/pr-1",
      baseBranch: "main",
      prNumber: 4321,
    });
    const [review] = await db
      .insert(reviewRuns)
      .values({
        organizationId: acme,
        repositoryId: repo,
        prNumber: 98765,
        headSha: "h",
        baseSha: "b",
        trigger: "webhook",
        mode: "full",
      })
      .returning();
    await db.insert(reviews).values({
      reviewRunId: review!.id,
      repositoryId: repo,
      prNumber: 98765,
      prTitle: "Tidy the onboarding wizard",
      headSha: "h",
      baseSha: "b",
      trigger: "webhook",
      budget: 1000,
    });

    const byNumber = await searchRuns(db, { organizationIds: [acme], query: "!4321" });
    expect(byNumber[0]).toMatchObject({ entry: { id: run }, tier: 0 });
    const byReview = await searchRuns(db, { organizationIds: [acme], query: "#98765" });
    expect(byReview[0]).toMatchObject({ entry: { id: review!.id, kind: "review" }, tier: 0 });
    const byTitle = await searchRuns(db, { organizationIds: [acme], query: "onboarding" });
    expect(byTitle.map((h) => h.entry.id)).toEqual([review!.id]);
  });

  it("treats LIKE wildcards in the query literally", async () => {
    await epic({ identifier: "PCT-1", title: "Discount 50% off", updated: 3 });
    expect(await searchRuns(db, { organizationIds: [acme], query: "50%" })).toHaveLength(1);
    expect(await searchRuns(db, { organizationIds: [acme], query: "%" })).toHaveLength(1);
    expect(await searchRuns(db, { organizationIds: [acme], query: "_" })).toHaveLength(0);
  });

  it("ranks repositories by name or full path and skips disconnected ones", async () => {
    const byName = await searchRepositories(db, { organizationIds: [acme], query: "WEB" });
    expect(byName.map((h) => [h.fullPath, h.tier])).toEqual([
      ["acme/platform/web", 0],
      ["acme/web-admin", 1],
    ]);
    const byPath = await searchRepositories(db, {
      organizationIds: [acme],
      query: "acme/web-admin",
    });
    expect(byPath.map((h) => [h.fullPath, h.tier])).toEqual([["acme/web-admin", 0]]);
    expect(await searchRepositories(db, { organizationIds: [beta], query: "web" })).toEqual([]);
    expect((await getSearchRepositories(db, [acme], [repo])).map((h) => h.fullPath)).toEqual([
      "acme/platform/web",
    ]);
    expect(await getSearchRepositories(db, [beta], [repo])).toEqual([]);
  });

  it("ranks agents by name and skips deleted ones", async () => {
    const [builder, builder2, deleted, other] = await db
      .insert(agents)
      .values([
        { organizationId: acme, name: "builder", liveOnline: true, lastHeartbeatAt: new Date() },
        { organizationId: acme, name: "builder-2", revokedAt: new Date() },
        { organizationId: acme, name: "builder-old", deletedAt: new Date() },
        { organizationId: beta, name: "builder" },
      ])
      .returning();
    const hits = await searchAgents(db, { organizationIds: [acme], query: "Build" });
    expect(hits.map((h) => h.tier)).toEqual([1, 1]);
    expect(new Set(hits.map((h) => h.id))).toEqual(new Set([builder!.id, builder2!.id]));
    expect(hits.find((h) => h.id === builder!.id)).toMatchObject({ online: true, revoked: false });
    expect(hits.find((h) => h.id === builder2!.id)).toMatchObject({ online: false, revoked: true });
    const exact = await searchAgents(db, { organizationIds: [acme], query: "builder" });
    expect(exact[0]).toMatchObject({ id: builder!.id, tier: 0 });
    expect(
      (await getSearchAgents(db, [acme], [builder!.id, deleted!.id, other!.id])).map((h) => h.id),
    ).toEqual([builder!.id]);
  });

  it("keeps each user's newest recent items, capped, filtered by organization", async () => {
    await recordRecentItem(db, { userId, kind: "repository", refId: repo, organizationId: acme });
    await recordRecentItem(db, {
      userId,
      kind: "settings",
      refId: "/settings/members",
      organizationId: null,
    });
    await recordRecentItem(db, { userId, kind: "run", refId: "beta-run", organizationId: beta });
    // Opening it again moves it to the top without a duplicate.
    await recordRecentItem(db, { userId, kind: "repository", refId: repo, organizationId: acme });

    const acmeItems = await listRecentItems(db, userId, [acme]);
    expect(acmeItems.map((i) => [i.kind, i.refId])).toEqual([
      ["repository", repo],
      ["settings", "/settings/members"],
    ]);
    expect((await listRecentItems(db, userId, [acme, beta])).map((i) => i.refId)).toEqual([
      repo,
      "beta-run",
      "/settings/members",
    ]);
    expect((await listRecentItems(db, userId, [])).map((i) => i.refId)).toEqual([
      "/settings/members",
    ]);

    for (let i = 0; i < RECENT_ITEMS_CAP + 5; i++) {
      await recordRecentItem(db, { userId, kind: "run", refId: `run-${i}`, organizationId: acme });
    }
    const all = await listRecentItems(db, userId, [acme, beta]);
    expect(all).toHaveLength(RECENT_ITEMS_CAP);
    expect(all[0]!.refId).toBe(`run-${RECENT_ITEMS_CAP + 4}`);
    expect(all.at(-1)!.refId).toBe("run-5");
  });
});
