// Search and jump's ranking across kinds, the Settings pages, the Backlog's time budget and
// the recent items (`lib/search/search.ts`), over a test database; the Backlog is stubbed
// (the organization isolation test covers it end to end).
import { randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  closeDb,
  connectRepository,
  createDb,
  organizations,
  ralphLanes,
  ralphRuns,
  recordRecentItem,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { searchQuerySchema, searchResponseSchema, type SearchResponse } from "@/lib/api/search";
import type { ScopedOrganization } from "@/lib/api/scope";
import type { WorkItemRow } from "@/lib/api/work-items";
import type { BacklogSearchEntry } from "@/lib/work-items/backlog";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({}));
const backlog = vi.hoisted(() => ({
  entries: [] as BacklogSearchEntry[],
  pending: false,
}));
vi.mock("@/lib/work-items/backlog", () => ({
  loadBacklogSearchEntries: async (
    _deps: unknown,
    organizations: ReadonlyArray<{ id: string }>,
  ): Promise<BacklogSearchEntry[]> => {
    if (backlog.pending) return new Promise(() => {});
    const ids = new Set(organizations.map((o) => o.id));
    return backlog.entries.filter((entry) => ids.has(entry.row.organization.id));
  },
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { loadRecentResults, matchTier, search, searchEverything } = await import("./search");

describe("matchTier", () => {
  it("is 0 for equal, 1 for a prefix, 2 for a substring, case-insensitively", () => {
    expect(matchTier("soc-17", "SOC-17")).toBe(0);
    expect(matchTier("soc-17", "SOC-171")).toBe(1);
    expect(matchTier("soc-17", "Fix SOC-17 login")).toBe(2);
    expect(matchTier("soc-17", "SOC-18", null)).toBeNull();
    expect(matchTier("x", "SOC-18", "fix")).toBe(2);
    expect(matchTier("  ", "anything")).toBeNull();
  });

  it("takes the best match of several values", () => {
    expect(matchTier("web", "acme/web-admin", "web")).toBe(0);
  });
});

describe("searchQuerySchema", () => {
  it("trims the query and defaults the limit", () => {
    expect(searchQuerySchema.parse({ q: "  SOC-1 " })).toEqual({ q: "SOC-1", limit: 5 });
    expect(searchQuerySchema.parse({})).toEqual({ q: "", limit: 5 });
  });

  it("refuses a bad limit, a long query and an unknown organization", () => {
    expect(searchQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ limit: "21" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ limit: "two" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "x".repeat(201) }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ organization: "acme" }).success).toBe(false);
  });
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("search", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: ScopedOrganization;
  let beta: ScopedOrganization;
  let userId: string;
  const repo: Record<string, string> = {};
  const run: Record<string, string> = {};
  let agentId: string;
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

  function workItem(
    organization: ScopedOrganization,
    identifier: string,
    title: string,
    updated: number,
  ): BacklogSearchEntry {
    const row: WorkItemRow = {
      id: `linear-${identifier.toLowerCase()}`,
      tracker: "linear",
      identifier,
      title,
      url: `https://linear.app/acme/issue/${identifier}`,
      organization,
      repository: null,
      size: null,
      group: "ready",
      blocked: false,
      blockers: [],
      triageRunning: false,
      source: { kind: "team", id: "team-1", name: "SOC" },
    };
    return { row, updatedAt: at(updated).toISOString() };
  }

  async function epic(identifier: string, title: string, repositoryId: string, updated: number) {
    const [row] = await db
      .insert(ralphRuns)
      .values({
        organizationId: acme.id,
        trackerIssueId: `issue-${identifier}`,
        trackerIdentifier: identifier,
        trackerTitle: title,
        trackerSessionId: `session-${randomUUID()}`,
        kind: "children",
        mode: "epic",
        repositoryId,
        status: "running",
        createdAt: at(updated + 5),
        updatedAt: at(updated),
      })
      .returning();
    return row!.id;
  }

  const deps = () => ({ db, backlogBudgetMs: 50 });
  const kinds = (response: SearchResponse) => response.groups.map((group) => group.id);
  const ids = (response: SearchResponse, kind: string) =>
    response.groups.find((group) => group.id === kind)?.results.map((r) => r.id) ?? [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a, b] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = { id: a!.id, name: "Acme", role: "admin" };
    beta = { id: b!.id, name: "Beta", role: "member" };
    const [user] = await db.insert(users).values({ email: "ann@example.com" }).returning();
    userId = user!.id;
    const connection = (await upsertScmConnection(db, {
      organizationId: acme.id,
      provider: "gitlab",
      name: "acme",
      baseUrl: "https://gitlab.example.com",
      externalId: "search-web",
      credentials: {},
    }))!;
    for (const path of ["acme/web", "acme/api"]) {
      repo[path] = (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "gitlab",
          externalId: path,
          fullPath: path,
        })
      ).id;
    }
    run.followUp = await epic("ENG-5", "Follow up on SOC-1719", repo["acme/api"]!, 1);
    run.webOnly = await epic("ENG-6", "Tidy the header", repo["acme/web"]!, 2);
    run.withMr = await epic("ENG-7", "Ship the MR", repo["acme/api"]!, 3);
    await db.insert(ralphLanes).values({
      runId: run.withMr,
      repositoryId: repo["acme/api"]!,
      branch: "omniralph/eng-7",
      baseBranch: "main",
      prNumber: 4242,
    });
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: acme.id, name: "builder", lastHeartbeatAt: at(180) })
      .returning();
    agentId = agent!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    backlog.pending = false;
    backlog.entries = [
      workItem(acme, "SOC-1719", "Add a logout button", 10),
      workItem(acme, "SOC-17190", "Split the logout flow", 5),
      workItem(beta, "SOC-1719", "Beta's own item", 1),
    ];
  });

  it("puts an exact identifier match first overall, ahead of looser matches of other kinds", async () => {
    const response = searchResponseSchema.parse(
      await searchEverything(deps(), [acme], "soc-1719", 5),
    );
    expect(kinds(response)).toEqual(["workItem", "run"]);
    // Exact, then prefix; never the other organization's item.
    expect(ids(response, "workItem")).toEqual(["linear-soc-1719", "linear-soc-17190"]);
    expect(response.groups[0]!.results[0]).toMatchObject({
      kind: "workItem",
      href: "/backlog/linear-soc-1719",
    });
    expect(ids(response, "run")).toEqual([run.followUp]);
  });

  it("puts an exact repo name first, then the runs in that repo", async () => {
    const response = await searchEverything(deps(), [acme], "WEB", 5);
    expect(kinds(response)[0]).toBe("repository");
    expect(response.groups[0]!.results[0]).toMatchObject({
      kind: "repository",
      id: repo["acme/web"],
      href: `/repos/${repo["acme/web"]}`,
      repository: { fullPath: "acme/web", provider: "gitlab", organization: { name: "Acme" } },
    });
    expect(ids(response, "run")).toEqual([run.webOnly]);
  });

  it("finds a run by its MR number, an agent by its name, and a Settings page", async () => {
    const byNumber = await searchEverything(deps(), [acme], "!4242", 5);
    expect(byNumber.groups[0]).toMatchObject({
      id: "run",
      results: [{ kind: "run", id: run.withMr, href: `/runs/${run.withMr}` }],
    });
    const byAgent = await searchEverything(deps(), [acme], "builder", 5);
    expect(byAgent.groups[0]).toMatchObject({
      id: "agent",
      results: [
        {
          id: agentId,
          href: `/fleet/${agentId}`,
          agent: { name: "builder", status: { label: "Offline 3h", tone: "fail" } },
        },
      ],
    });
    const members = await searchEverything(deps(), [acme], "members", 5);
    expect(members.groups[0]).toMatchObject({
      id: "settings",
      results: [{ id: "/settings/members", href: "/settings/members" }],
    });
    // A keyword finds a page, below a title match.
    const theme = await searchEverything(deps(), [acme], "dark mode", 5);
    expect(ids(theme, "settings")).toEqual(["/settings/profile"]);
    // A later word of the title is a prefix match.
    const rules = await searchEverything(deps(), [acme], "rules", 5);
    expect(ids(rules, "settings")).toEqual(["/settings/advanced/routing"]);
  });

  it("caps each kind at the limit", async () => {
    const response = await searchEverything(deps(), [acme], "acme", 1);
    expect(ids(response, "repository")).toHaveLength(1);
    expect(ids(response, "run")).toHaveLength(1);
  });

  it("answers without work items when the Backlog takes longer than its budget", async () => {
    backlog.pending = true;
    const started = Date.now();
    const response = await searchEverything(deps(), [acme], "soc-1719", 5);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(kinds(response)).toEqual(["run"]);
  });

  it("answers no groups when nothing matches", async () => {
    expect(await searchEverything(deps(), [acme], "zzzz", 5)).toEqual({
      mode: "results",
      groups: [],
    });
  });

  it("answers the recent items, still there and in scope, newest first, at most five", async () => {
    const gone = randomUUID();
    for (const [kind, refId, organizationId] of [
      ["run", gone, acme.id],
      ["work_item", "linear-soc-1719", acme.id],
      ["settings", "/settings/nope", null],
      ["run", run.webOnly!, acme.id],
      ["agent", agentId, acme.id],
      ["work_item", "linear-soc-gone", acme.id],
      ["repository", repo["acme/web"]!, acme.id],
      ["settings", "/settings/members", null],
    ] as const) {
      await recordRecentItem(db, { userId, kind, refId, organizationId });
    }
    const recent = searchResponseSchema.parse(await loadRecentResults(deps(), userId, [acme]));
    expect(recent.mode).toBe("recent");
    expect(recent.groups).toHaveLength(1);
    expect(recent.groups[0]!.label).toBe("Recent");
    expect(recent.groups[0]!.results.map((r) => [r.kind, r.id])).toEqual([
      ["settings", "/settings/members"],
      ["repository", repo["acme/web"]],
      ["agent", agentId],
      ["run", run.webOnly],
      ["workItem", "linear-soc-1719"],
    ]);
    // Another organization's scope shows only the Settings pages.
    const other = await loadRecentResults(deps(), userId, [beta]);
    expect(ids(other, "recent")).toEqual(["/settings/members"]);
    // A short query answers the recent items; a longer one searches.
    expect((await search(deps(), userId, [acme], { q: "s", limit: 5 })).mode).toBe("recent");
    expect((await search(deps(), userId, [acme], { q: "so", limit: 5 })).mode).toBe("results");
  });
});
