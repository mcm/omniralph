import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  disconnectRepository,
  ensureLane,
  organizations,
  ralphRuns,
  repositories,
  replaceRoutingRules,
  seedReviewProfiles,
  upsertScmConnection,
  upsertStories,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { RoutingQuery } from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { ROUTED_BY_SELECTION } from "@/lib/ralph/repository-selection";
import { createRouter, MAX_ROUTE_HOPS, resolveRoute, type RouteDeps } from "./resolve";

vi.mock("server-only", () => ({}));

const databaseAvailable = testDatabaseAvailable();

const labels = (...values: string[]): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "labels", operator: "containsAny", value: values }],
});
const team = (key: string): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "team", operator: "=", value: key }],
});

describe.skipIf(!databaseAvailable)("resolveRoute", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let api: string;
  let web: string;
  let docs: string;
  let linear: FakeLinearGateway;

  const deps = (): RouteDeps => ({ db, organizationId: orgId, linear });
  const rules = async (...list: Array<[string, RoutingQuery]>) => {
    const saved = await replaceRoutingRules(
      db,
      orgId,
      list.map(([repositoryId, query]) => ({ repositoryId, query })),
    );
    expect(saved.ok).toBe(true);
  };
  const runOf = (issueId: string, identifier: string, repositoryId: string, routedBy: string) =>
    createRun(db, {
      organizationId: orgId,
      linearIssueId: issueId,
      linearIdentifier: identifier,
      linearAgentSessionId: `session-${identifier}-${randomBytes(4).toString("hex")}`,
      kind: "children",
      mode: "epic",
      repositoryId,
      routedBy,
      branch: `feat/${identifier}`,
      baseBranch: "main",
    }).then((r) => r.run);

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
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
    const repo = async (externalId: string, fullPath: string, ralphEnabled: boolean) => {
      const { id } = await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId,
        fullPath,
      });
      await db.update(repositories).set({ ralphEnabled }).where(eq(repositories.id, id));
      return id;
    };
    api = await repo("1", "acme/api", true);
    web = await repo("2", "acme/web", true);
    docs = await repo("3", "acme/docs", false);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(ralphRuns);
    await rules();
    linear = new FakeLinearGateway();
  });

  it("asks when there are no rules", async () => {
    const issue = linear.add({ title: "Anything", labels: ["backend"] });
    expect(await resolveRoute(deps(), issue.id)).toEqual({ ask: true });
    expect((await createRouter(deps())).hasCustomRules).toBe(false);
    await rules([api, labels("backend")]);
    expect((await createRouter(deps())).hasCustomRules).toBe(true);
  });

  it("takes the first rule that matches, in order", async () => {
    await rules([web, labels("frontend")], [api, labels("backend")], [web, labels("backend")]);
    const issue = linear.add({ title: "API", labels: ["Backend"] });
    expect(await resolveRoute(deps(), issue.id)).toMatchObject({
      repository: { id: api, fullPath: "acme/api" },
      by: "rule 2 (Labels contains any of backend)",
      rule: 2,
    });
    // An issue no rule matches asks.
    const other = linear.add({ title: "Docs", labels: ["docs"] });
    expect(await resolveRoute(deps(), other.id)).toEqual({ ask: true });
  });

  it("makes an issue manual when its rule's repository has coding off", async () => {
    await rules([docs, labels("docs")], [api, team("ENG")]);
    const issue = linear.add({ title: "Write docs", labels: ["docs"] });
    expect(await resolveRoute(deps(), issue.id)).toMatchObject({
      manual: { id: docs, fullPath: "acme/docs" },
      by: "rule 1 (Labels contains any of docs)",
      rule: 1,
    });
  });

  it("skips a rule whose repository is disconnected", async () => {
    const { id: gone } = await connectRepository(db, {
      connectionId: (await db.select().from(repositories).where(eq(repositories.id, api)))[0]!
        .connectionId,
      provider: "github",
      externalId: "gone",
      fullPath: "acme/gone",
    });
    await rules([gone, team("ENG")], [web, team("ENG")]);
    await disconnectRepository(db, orgId, gone);
    const issue = linear.add({ title: "Any" });
    expect(await resolveRoute(deps(), issue.id)).toMatchObject({ repository: { id: web } });
  });

  it("tests the parent's fields", async () => {
    await rules([
      web,
      {
        combinator: "and",
        rules: [{ field: "parent.labels", operator: "containsAny", value: ["ui"] }],
      },
    ]);
    const epic = linear.add({ identifier: "ENG-10", title: "Epic", labels: ["UI"] });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    expect(await resolveRoute(deps(), story.id)).toMatchObject({
      repository: { id: web },
      by: "rule 1 (Parent › Labels contains any of ui)",
    });
  });

  it("routes a sub-issue of a run's epic to the epic's repository", async () => {
    // The epic's own rule would route elsewhere: its run's repository wins.
    await rules([web, labels("epic")]);
    const epic = linear.add({ identifier: "ENG-10", title: "Epic", labels: ["epic"] });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    await runOf(epic.id, "ENG-10", api, "rule 4 (Team is ENG)");
    expect(await resolveRoute(deps(), story.id)).toEqual({
      repository: expect.objectContaining({ id: api }),
      by: "sub-issue of ENG-10 → rule 4 (Team is ENG)",
    });
  });

  it("keeps the epic run's selection for its sub-issues", async () => {
    const epic = linear.add({ identifier: "ENG-10", title: "Epic" });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    await runOf(epic.id, "ENG-10", web, ROUTED_BY_SELECTION);
    expect(await resolveRoute(deps(), story.id)).toMatchObject({
      repository: { id: web },
      by: "sub-issue of ENG-10 → your selection",
    });
  });

  it("uses the parent's story lane when the parent has no run of its own", async () => {
    const epic = linear.add({ identifier: "ENG-10", title: "Epic" });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    const task = linear.add({ identifier: "ENG-12", title: "Task", parentId: story.id });
    const run = await runOf(epic.id, "ENG-10", api, "rule 1 (Team is ENG)");
    const lane = await ensureLane(db, {
      runId: run.id,
      repositoryId: web,
      branch: "feat/web",
      baseBranch: "main",
    });
    await upsertStories(db, run.id, [
      { linearIssueId: story.id, identifier: "ENG-11", title: "Story", laneId: lane.id },
    ]);
    expect(await resolveRoute(deps(), task.id)).toMatchObject({
      repository: { id: web },
      by: "sub-issue of ENG-11 → story of ENG-10",
    });
  });

  it("resolves the parent with the rules when Omniralph has no repository for it", async () => {
    await rules([web, labels("ui")]);
    const epic = linear.add({ identifier: "ENG-10", title: "Epic", labels: ["ui"] });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    expect(await resolveRoute(deps(), story.id)).toEqual({
      repository: expect.objectContaining({ id: web }),
      by: "sub-issue of ENG-10 → rule 1 (Labels contains any of ui)",
    });
  });

  it("propagates a parent's manual route", async () => {
    await rules([docs, labels("docs")]);
    const epic = linear.add({ identifier: "ENG-10", title: "Epic", labels: ["docs"] });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    expect(await resolveRoute(deps(), story.id)).toEqual({
      manual: expect.objectContaining({ id: docs }),
      by: "sub-issue of ENG-10 → rule 1 (Labels contains any of docs)",
    });
  });

  it("falls through to ask when the parent would ask", async () => {
    const epic = linear.add({ identifier: "ENG-10", title: "Epic" });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    expect(await resolveRoute(deps(), story.id)).toEqual({ ask: true });
  });

  it("counts a cycle as no result", async () => {
    await rules([api, labels("never")]);
    const a = linear.add({ id: "issue-a", identifier: "ENG-1", title: "A", parentId: "issue-b" });
    linear.add({ id: "issue-b", identifier: "ENG-2", title: "B", parentId: "issue-a" });
    expect(await resolveRoute(deps(), a.id)).toEqual({ ask: true });
    expect(linear.routingLoads).toEqual(["issue-a", "issue-b"]);
  });

  it(`stops after ${MAX_ROUTE_HOPS} hops`, async () => {
    await rules([api, labels("top")]);
    // ENG-0 (labelled) <- ENG-1 <- ... <- ENG-n: ENG-n is n hops from the match.
    const chain = (n: number) => {
      linear = new FakeLinearGateway();
      let parentId: string | undefined;
      for (let i = 0; i <= n; i++) {
        parentId = linear.add({
          id: `issue-${i}`,
          identifier: `ENG-${i}`,
          title: `Issue ${i}`,
          labels: i === 0 ? ["top"] : [],
          ...(parentId && { parentId }),
        }).id;
      }
      return parentId!;
    };
    const within = chain(MAX_ROUTE_HOPS);
    expect(await resolveRoute(deps(), within)).toMatchObject({ repository: { id: api } });
    const beyond = chain(MAX_ROUTE_HOPS + 1);
    expect(await resolveRoute(deps(), beyond)).toEqual({ ask: true });
  });

  it("loads each issue once per router", async () => {
    await rules([api, team("ENG")]);
    const issue = linear.add({ title: "Once" });
    const router = await createRouter(deps());
    await router.resolve(issue.id);
    await router.resolve(issue.id);
    expect(linear.routingLoads).toEqual([issue.id]);
  });
});
