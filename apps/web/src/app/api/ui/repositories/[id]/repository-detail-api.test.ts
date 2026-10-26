// `GET /api/ui/repositories/{id}`: everything the Repos page shows for a repo of any of the
// user's organizations — header, status, every card and each card's latest change.
import { randomBytes } from "node:crypto";
import {
  agentRepoPins,
  agents,
  closeDb,
  connectRepository,
  createDb,
  createReviewRun,
  disconnectRepository,
  jobs,
  organizationMembers,
  organizations,
  repositories,
  saveIntegration,
  settingsChanges,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { REVIEW_DEPTH_IDS } from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { repositoryDetailSchema, type RepositoryDetail } from "@/lib/api/repositories";
import { assertRole, type Role } from "@/lib/auth/roles";
import { setRoutingRules, teamIs } from "@/lib/routing/testing";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => "9.9.9",
}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: "",
  showAdvanced: false,
  active: { id: "", name: "", role: "admin" as Role },
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  // The signed-in user works in `state.active`.
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: state.userId,
        organization: { id: state.active.id, name: state.active.name },
        role: state.active.role,
        name: null,
        email: null,
        image: null,
        theme: null,
        showAdvanced: state.showAdvanced,
      },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const route = await import("@/app/api/ui/repositories/[id]/route");

const databaseAvailable = testDatabaseAvailable();

async function get(id: string) {
  const response = await route.GET(new Request(`http://localhost/api/ui/repositories/${id}`), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

async function detail(id: string): Promise<RepositoryDetail> {
  const { status, body } = await get(id);
  expect(status).toBe(200);
  return repositoryDetailSchema.parse(body);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe.skipIf(!databaseAvailable)("GET /api/ui/repositories/{id}", () => {
  let testDb: TestDatabase;
  let db: Database;
  const org = { acme: "", beta: "", gamma: "" };
  const repo = { api: "", web: "", gone: "", beta: "", gamma: "" };
  const agent: Record<string, string> = {};

  async function createOrganization(name: string): Promise<string> {
    const [row] = await db.insert(organizations).values({ name }).returning();
    return row!.id;
  }

  async function connect(organizationId: string, fullPath: string): Promise<string> {
    const connection = await upsertScmConnection(db, {
      organizationId,
      provider: "github",
      name: `${fullPath}-installation`,
      baseUrl: "https://api.github.com",
      externalId: `${fullPath}-installation`,
      credentials: {},
    });
    const row = await connectRepository(db, {
      connectionId: connection!.id,
      provider: "github",
      externalId: `${fullPath}-${randomBytes(4).toString("hex")}`,
      fullPath,
    });
    return row.id;
  }

  /** A running attempt of a review run of `repositoryId` on `agentId`. */
  async function runningReview(agentId: string, repositoryId: string, organizationId = org.acme) {
    const run = await createReviewRun(db, {
      organizationId,
      repositoryId,
      prNumber: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook",
      mode: "full",
      depth: "standard",
    });
    await db.insert(jobs).values({
      organizationId,
      type: "review.run",
      taskType: "review",
      status: "running",
      agentId,
      repositoryId,
      reviewRunId: run.id,
    });
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;

    org.acme = await createOrganization("Acme");
    org.beta = await createOrganization("Beta");
    org.gamma = await createOrganization("Gamma");
    await db.insert(users).values([
      { id: "ada", email: "ada@acme.io" },
      { id: "bea", email: "bea@acme.io" },
    ]);
    await db.insert(organizationMembers).values([
      { organizationId: org.acme, userId: "ada", role: "admin" },
      { organizationId: org.beta, userId: "ada", role: "member" },
      { organizationId: org.acme, userId: "bea", role: "admin" },
    ]);
    state.userId = "ada";
    state.active = { id: org.acme, name: "Acme", role: "admin" };

    repo.api = await connect(org.acme, "acme/platform/api");
    repo.web = await connect(org.acme, "acme/web");
    repo.gone = await connect(org.acme, "acme/gone");
    await disconnectRepository(db, org.acme, repo.gone);
    repo.beta = await connect(org.beta, "beta-app");
    repo.gamma = await connect(org.gamma, "gamma/app");
    await db
      .update(repositories)
      .set({
        defaultBranch: "main",
        codingEnabled: false,
        askEnabled: false,
        reviewDepth: "deep",
        customInstructions: "Mind the migrations.",
        pathExcludes: ["vendor/**"],
        codingInstructions: "Run pnpm test.",
        historyRewrite: "always",
      })
      .where(eq(repositories.id, repo.api));

    // Acme's agents: one per state among the pins, one to pin, and two that can't be pinned.
    const now = new Date();
    const rows = await db
      .insert(agents)
      .values([
        { organizationId: org.acme, name: "atlas", lastHeartbeatAt: now, liveOnline: true },
        { organizationId: org.acme, name: "boreas", lastHeartbeatAt: now, liveOnline: true },
        { organizationId: org.acme, name: "ceres", lastHeartbeatAt: minutesAgo(30) },
        {
          organizationId: org.acme,
          name: "dione",
          lastHeartbeatAt: now,
          liveOnline: true,
          selfUpdate: "supported",
          updateRequestVersion: "2.0.0",
          updateRequestedAt: now,
        },
        {
          organizationId: org.acme,
          name: "erebus",
          lastHeartbeatAt: now,
          liveOnline: true,
          revokedAt: now,
        },
        { organizationId: org.acme, name: "fenrir", lastHeartbeatAt: now, liveOnline: true },
        {
          organizationId: org.acme,
          name: "gaia",
          lastHeartbeatAt: now,
          liveOnline: true,
          revokedAt: now,
        },
        {
          organizationId: org.acme,
          name: "hel",
          lastHeartbeatAt: now,
          liveOnline: true,
          revokedAt: now,
          deletedAt: now,
        },
        { organizationId: org.gamma, name: "gamma-agent", lastHeartbeatAt: now, liveOnline: true },
      ])
      .returning({ id: agents.id, name: agents.name });
    for (const row of rows) agent[row.name] = row.id;
    await db.insert(agentRepoPins).values(
      ["atlas", "boreas", "ceres", "dione", "erebus", "hel"].map((name) => ({
        agentId: agent[name]!,
        repositoryId: repo.api,
      })),
    );
    // atlas runs one of acme/platform/api's reviews and one of acme/web's.
    await runningReview(agent.atlas!, repo.api);
    await runningReview(agent.atlas!, repo.web);

    await saveIntegration(db, {
      organizationId: org.acme,
      provider: "linear",
      externalId: "acme-workspace",
      name: "Acme Linear",
      credentials: {},
      installedByUserId: null,
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("answers the repo's header, status and every card", async () => {
    const body = await detail(repo.api);
    expect(body.repository).toEqual({
      id: repo.api,
      organization: { id: org.acme, name: "Acme", role: "admin" },
      provider: "github",
      fullPath: "acme/platform/api",
      name: "api",
      group: "acme/platform",
      webUrl: "https://github.com/acme/platform/api",
      defaultBranch: "main",
    });
    expect(body.canEdit).toBe(true);
    // Its running review; atlas is online, so no problem.
    expect(body.status).toEqual({ running: 1, problems: [] });
    expect(body.reviews).toEqual({
      enabled: true,
      triggers: { onOpen: true, onPush: true, drafts: false },
      depth: "deep",
      pathExcludes: ["vendor/**"],
      reviewerInstructions: "Mind the migrations.",
    });
    expect(body.depths.map((depth) => depth.id)).toEqual([...REVIEW_DEPTH_IDS]);
    expect(body.depths[2]).toEqual({
      id: "deep",
      label: "Deep",
      summary: expect.any(String),
      details: {
        model: "Opus 5.5",
        tokenCap: "500k per review",
        reads: expect.any(String),
        comments: expect.any(String),
        typicalTime: "About 2× Standard",
      },
    });
    expect(body.coding).toEqual({
      enabled: false,
      workItemMatch: null,
      codingInstructions: "Run pnpm test.",
      openPullRequestEarly: false,
      historyRewrite: "always",
      respondToReviewsAndCi: true,
      roundLimits: { review: 3, fix: 3 },
      routingRules: [],
    });
    expect(body.trackers).toEqual([
      { tracker: "linear", id: expect.any(String), workspaceName: "Acme Linear" },
    ]);
    expect(body.ask).toEqual({ enabled: false });
    expect(body.playbooks.bindings).toEqual({
      review: ["builtin:review-pr"],
      correlation: "builtin:correlate-findings",
      story: "builtin:implement-story",
      request: "builtin:handle-request",
    });
    for (const [binding, bound] of [
      ["review", "builtin:review-pr"],
      ["correlation", "builtin:correlate-findings"],
      ["story", "builtin:implement-story"],
      ["request", "builtin:handle-request"],
    ] as const) {
      const choices = body.playbooks.choices[binding];
      expect(choices.map((choice) => choice.id)).toContain(bound);
      expect(choices.every((choice) => choice.builtin)).toBe(true);
    }
    // Each binding offers its own roles' playbooks only.
    expect(body.playbooks.choices.story.map((c) => c.id)).not.toContain("builtin:review-pr");
  });

  it("shows each pinned agent's state and its running attempts of this repo", async () => {
    const { agents: card } = await detail(repo.api);
    expect(card.pinned).toEqual([
      // atlas's attempt on acme/web doesn't count.
      { id: agent.atlas, name: "atlas", state: "running", runningForRepo: 1 },
      { id: agent.boreas, name: "boreas", state: "idle", runningForRepo: 0 },
      { id: agent.ceres, name: "ceres", state: "offline", runningForRepo: 0 },
      { id: agent.dione, name: "dione", state: "updating", runningForRepo: 0 },
      { id: agent.erebus, name: "erebus", state: "revoked", runningForRepo: 0 },
    ]);
    // Not pinned, revoked or deleted, and of the repo's organization only.
    expect(card.pinnable).toEqual([{ id: agent.fenrir, name: "fenrir" }]);

    const web = await detail(repo.web);
    expect(web.agents.pinned).toEqual([]);
    expect(web.agents.pinnable.map((a) => a.name)).toEqual([
      "atlas",
      "boreas",
      "ceres",
      "dione",
      "fenrir",
    ]);
  });

  it("lists every routing rule that targets the repo, and none when none does", async () => {
    expect((await detail(repo.api)).coding.routingRules).toEqual([]);
    await setRoutingRules(db, org.acme, [repo.web, teamIs("OPS")], [repo.api, teamIs("ENG")]);
    try {
      expect((await detail(repo.api)).coding.routingRules).toEqual([
        { position: 2, description: "Team is ENG" },
      ]);
      expect((await detail(repo.web)).coding.routingRules).toEqual([
        { position: 1, description: "Team is OPS" },
      ]);
    } finally {
      await setRoutingRules(db, org.acme);
    }
  });

  it("answers each card's latest change with the runs since, or null before any", async () => {
    const before = await detail(repo.web);
    expect(before.history).toEqual({
      reviews: null,
      coding: null,
      ask: null,
      agents: null,
      playbooks: null,
    });

    const change = (section: string, changedAt: Date, after: string, subjectId = repo.web) => ({
      organizationId: org.acme,
      section,
      subjectId,
      actorUserId: "ada",
      actorName: "Ada",
      changedAt,
      changes: [{ field: "depth", label: "Review depth", before: "Standard", after }],
    });
    const reviewedAt = minutesAgo(60);
    await db.insert(settingsChanges).values([
      change("repository.reviews", minutesAgo(120), "Quick"),
      change("repository.reviews", reviewedAt, "Deep"),
      change("repository.ask", minutesAgo(30), "On"),
      // Another repo's change never shows.
      change("repository.coding", minutesAgo(10), "On", repo.api),
    ]);
    try {
      const { history } = await detail(repo.web);
      expect(history.reviews).toMatchObject({
        organization: { id: org.acme, name: "Acme", role: "admin" },
        section: "repository.reviews",
        subjectId: repo.web,
        actor: { id: "ada", name: "Ada" },
        changedAt: reviewedAt.toISOString(),
        changes: [{ field: "depth", label: "Review depth", before: "Standard", after: "Deep" }],
        // acme/web's running review started since.
        runsSince: 1,
      });
      expect(history.ask).toMatchObject({ section: "repository.ask", runsSince: 0 });
      expect(history.coding).toBeNull();
      expect(history.agents).toBeNull();
      expect(history.playbooks).toBeNull();
    } finally {
      await db.delete(settingsChanges);
    }
  });

  it("answers the same body whatever the viewer's Show advanced settings preference", async () => {
    state.userId = "ada";
    state.showAdvanced = true;
    const shown = await get(repo.api);
    state.userId = "bea";
    state.showAdvanced = false;
    const hidden = await get(repo.api);
    state.userId = "ada";
    expect(shown.status).toBe(200);
    expect(hidden).toEqual(shown);
    expect(repositoryDetailSchema.parse(hidden.body).playbooks.choices.review).not.toEqual([]);
  });

  it("serves a member a repo of another of their organizations, read-only, while Acme is active", async () => {
    const body = await detail(repo.beta);
    expect(body.repository).toMatchObject({
      id: repo.beta,
      organization: { id: org.beta, name: "Beta", role: "member" },
      fullPath: "beta-app",
      name: "beta-app",
      group: null,
      defaultBranch: null,
    });
    expect(body.canEdit).toBe(false);
    // Beta's own data: no trackers, no agents (so none online), none of Acme's.
    expect(body.trackers).toEqual([]);
    expect(body.agents).toEqual({ pinned: [], pinnable: [] });
    expect(body.status.problems.map((p) => p.code)).toEqual(["no_agent_online"]);
    expect(JSON.stringify(body)).not.toContain(org.acme);
  });

  it("answers 404 for another organization's repo, a disconnected one and an unknown ID", async () => {
    for (const id of [repo.gamma, repo.gone, "00000000-0000-4000-8000-000000000001", "x"]) {
      expect((await get(id)).status, id).toBe(404);
    }
    // Leaving an organization loses its repos.
    await db.delete(organizationMembers).where(eq(organizationMembers.organizationId, org.beta));
    expect((await get(repo.beta)).status).toBe(404);
  });
});
