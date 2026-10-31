// `GET /api/ui/repositories`: the Repos rail across the user's organizations, with each
// repo's switches and status (running work and problems).
import { randomBytes } from "node:crypto";
import {
  agentRepoPins,
  agents,
  closeDb,
  connectRepository,
  createDb,
  createReviewRun,
  disconnectRepository,
  insertJob,
  jobs,
  organizationMembers,
  organizations,
  repositories,
  reviewRuns,
  scmConnections,
  upsertScmConnection,
  users,
  type Database,
  type ScmConnectionHealth,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  repositoryListSchema,
  type RepositoryList,
  type RepositoryListItem,
} from "@/lib/api/repositories";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: "",
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
        showAdvanced: false,
      },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const route = await import("@/app/api/ui/repositories/route");

const databaseAvailable = testDatabaseAvailable();

async function list(organization?: string) {
  const query = organization === undefined ? "" : `?organization=${organization}`;
  const response = await route.GET(new Request(`http://localhost/api/ui/repositories${query}`), {
    params: Promise.resolve({}),
  });
  return { status: response.status, body: (await response.json()) as RepositoryList };
}

async function listed(organization?: string): Promise<RepositoryList> {
  const { status, body } = await list(organization);
  expect(status).toBe(200);
  return repositoryListSchema.parse(body);
}

const byPath = (list: RepositoryList) =>
  new Map(list.repositories.map((repo) => [repo.fullPath, repo]));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe.skipIf(!databaseAvailable)("GET /api/ui/repositories", () => {
  let testDb: TestDatabase;
  let db: Database;
  const org = { acme: "", beta: "", cyan: "" };
  const repo: Record<string, string> = {};
  let onlineAgent = "";
  let offlineAgent = "";
  let failedSyncJob = "";
  let gitlabHealth: ScmConnectionHealth;

  async function createOrganization(name: string): Promise<string> {
    const [row] = await db.insert(organizations).values({ name }).returning();
    return row!.id;
  }

  async function connection(
    organizationId: string,
    provider: "github" | "gitlab",
    externalId: string,
  ): Promise<string> {
    const row = await upsertScmConnection(db, {
      organizationId,
      provider,
      name: `${provider}-${externalId}`,
      baseUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.example.com",
      externalId,
      credentials: {},
    });
    return row!.id;
  }

  async function connect(
    connectionId: string,
    provider: "github" | "gitlab",
    fullPath: string,
  ): Promise<string> {
    const row = await connectRepository(db, {
      connectionId,
      provider,
      externalId: `${fullPath}-${randomBytes(4).toString("hex")}`,
      fullPath,
    });
    return row.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;

    org.acme = await createOrganization("Acme");
    org.beta = await createOrganization("Beta");
    org.cyan = await createOrganization("Cyan");
    await db.insert(users).values({ id: "rail-user", email: "rail@acme.io" });
    await db.insert(organizationMembers).values([
      { organizationId: org.acme, userId: "rail-user", role: "admin" },
      { organizationId: org.beta, userId: "rail-user", role: "member" },
    ]);
    state.userId = "rail-user";
    state.active = { id: org.acme, name: "Acme", role: "admin" };

    // Acme: a GitHub App installation and a GitLab connection, an online and an offline agent.
    const acmeGitHub = await connection(org.acme, "github", "1");
    const acmeGitLab = await connection(org.acme, "gitlab", "2");
    [{ id: onlineAgent }, { id: offlineAgent }] = (await db
      .insert(agents)
      .values([
        {
          organizationId: org.acme,
          name: "atlas",
          lastHeartbeatAt: minutesAgo(0),
          liveOnline: true,
        },
        { organizationId: org.acme, name: "boreas", lastHeartbeatAt: minutesAgo(30) },
      ])
      .returning({ id: agents.id })) as [{ id: string }, { id: string }];

    repo.healthy = await connect(acmeGitHub, "github", "acme/healthy");
    repo.running = await connect(acmeGitHub, "github", "acme/running");
    repo.sync = await connect(acmeGitHub, "github", "acme/sync");
    repo.pinnedOffline = await connect(acmeGitHub, "github", "acme/pinned-offline");
    repo.webhook = await connect(acmeGitLab, "gitlab", "platform/tools/hook");
    repo.gone = await connect(acmeGitHub, "github", "acme/gone");
    await disconnectRepository(db, org.acme, repo.gone);
    await db
      .update(repositories)
      .set({ codingEnabled: true, askEnabled: false })
      .where(eq(repositories.id, repo.healthy));

    // acme/running: a review in progress and one queued; a finished one doesn't count.
    for (const status of ["running", "queued", "completed"] as const) {
      const run = await createReviewRun(db, {
        organizationId: org.acme,
        repositoryId: repo.running,
        prNumber: 1,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "webhook",
        mode: "full",
        depth: "standard",
      });
      await db.update(reviewRuns).set({ status }).where(eq(reviewRuns.id, run.id));
    }

    // acme/sync: its latest checkout sync failed on atlas (an older one succeeded).
    const sync = async (status: "completed" | "failed", createdAt: Date) => {
      const { job } = await insertJob(db, {
        organizationId: org.acme,
        type: "repo.sync",
        taskType: "system",
        repositoryId: repo.sync,
        targetAgentId: onlineAgent,
      });
      await db.update(jobs).set({ status, createdAt }).where(eq(jobs.id, job.id));
      return job.id;
    };
    await sync("completed", minutesAgo(60));
    failedSyncJob = await sync("failed", minutesAgo(5));
    // A failed sync superseded by a successful one is no problem.
    const { job: oldFailure } = await insertJob(db, {
      organizationId: org.acme,
      type: "repo.sync",
      taskType: "system",
      repositoryId: repo.healthy,
    });
    await db
      .update(jobs)
      .set({ status: "failed", createdAt: minutesAgo(90) })
      .where(eq(jobs.id, oldFailure.id));
    const { job: newSuccess } = await insertJob(db, {
      organizationId: org.acme,
      type: "repo.sync",
      taskType: "system",
      repositoryId: repo.healthy,
      dedupeKey: "later",
    });
    await db
      .update(jobs)
      .set({ status: "completed", createdAt: minutesAgo(10) })
      .where(eq(jobs.id, newSuccess.id));

    // acme/pinned-offline: pinned to boreas only, which is offline.
    await db
      .insert(agentRepoPins)
      .values({ agentId: offlineAgent, repositoryId: repo.pinnedOffline });

    // The GitLab connection: the hook repo's webhook is missing; another project's is outdated.
    gitlabHealth = {
      checkedAt: new Date().toISOString(),
      tokenExpiresAt: "2099-01-01",
      problems: [
        {
          code: "webhook_missing",
          message: "platform/tools/hook has no Omniralph webhook.",
          repositoryId: repo.webhook,
        },
        {
          code: "webhook_events_outdated",
          message: "Another project's webhook lacks pipeline events.",
          repositoryId: "00000000-0000-4000-8000-000000000999",
        },
      ],
    };
    await db
      .update(scmConnections)
      .set({ health: gitlabHealth })
      .where(eq(scmConnections.id, acmeGitLab));

    // Beta (the user is a member): no agents, and a GitLab connection GitLab rejects.
    const betaGitHub = await connection(org.beta, "github", "3");
    const betaGitLab = await connection(org.beta, "gitlab", "4");
    repo.betaApp = await connect(betaGitHub, "github", "beta/app");
    repo.betaGitLab = await connect(betaGitLab, "gitlab", "rejected");
    await db
      .update(scmConnections)
      .set({
        health: {
          checkedAt: new Date().toISOString(),
          tokenExpiresAt: null,
          problems: [{ code: "token_invalid", message: "GitLab rejects the bot token." }],
        },
      })
      .where(eq(scmConnections.id, betaGitLab));

    // Cyan: the user isn't a member.
    const cyanGitHub = await connection(org.cyan, "github", "5");
    repo.cyan = await connect(cyanGitHub, "github", "cyan/secret");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("lists every organization's connected repos by organization name, then path", async () => {
    const all = await listed("all");
    expect(all.truncated).toBe(false);
    expect(all.repositories.map((r) => r.fullPath)).toEqual([
      "acme/healthy",
      "acme/pinned-offline",
      "acme/running",
      "acme/sync",
      "platform/tools/hook",
      "beta/app",
      "rejected",
    ]);
    expect(JSON.stringify(all)).not.toContain(repo.cyan);
    expect(JSON.stringify(all)).not.toContain("acme/gone");
  });

  it("answers each row's fields", async () => {
    const rows = byPath(await listed("all"));
    expect(rows.get("acme/healthy")).toEqual({
      id: repo.healthy!,
      organization: { id: org.acme, name: "Acme", role: "admin" },
      provider: "github",
      fullPath: "acme/healthy",
      name: "healthy",
      group: "acme",
      webUrl: "https://github.com/acme/healthy",
      reviewsEnabled: true,
      codingEnabled: true,
      askEnabled: false,
      status: { running: 0, problems: [] },
    } satisfies RepositoryListItem);
    expect(rows.get("platform/tools/hook")).toMatchObject({
      provider: "gitlab",
      name: "hook",
      group: "platform/tools",
      webUrl: "https://gitlab.example.com/platform/tools/hook",
    });
    expect(rows.get("rejected")).toMatchObject({
      organization: { id: org.beta, name: "Beta", role: "member" },
      name: "rejected",
      group: null,
    });
  });

  it("counts a repo's queued and running runs", async () => {
    const rows = byPath(await listed());
    expect(rows.get("acme/running")!.status).toEqual({ running: 2, problems: [] });
  });

  it("reports a failed checkout sync with Retry", async () => {
    const rows = byPath(await listed());
    expect(rows.get("acme/sync")!.status.problems).toEqual([
      {
        code: "sync_failed",
        message: "Couldn't update this repo's checkout on atlas.",
        action: { type: "post", label: "Retry", path: `/api/ui/jobs/${failedSyncJob}/rerun` },
      },
    ]);
  });

  it("reports a repo whose pinned agents are all offline, linking to the agent", async () => {
    const rows = byPath(await listed());
    expect(rows.get("acme/pinned-offline")!.status.problems).toEqual([
      {
        code: "no_agent_online",
        message: "No agent online",
        action: { type: "link", label: "Open agent", href: `/fleet/${offlineAgent}` },
      },
    ]);
  });

  it("reports a repo-specific webhook problem with Recreate webhook, and no other repo's", async () => {
    const rows = byPath(await listed());
    expect(rows.get("platform/tools/hook")!.status.problems).toEqual([
      {
        code: "webhook",
        message: "platform/tools/hook has no Omniralph webhook.",
        action: {
          type: "post",
          label: "Recreate webhook",
          path: `/api/ui/repositories/${repo.webhook}/webhook`,
        },
      },
    ]);
  });

  it("reports no agent online and a connection problem, in that order", async () => {
    const rows = byPath(await listed(org.beta));
    expect(rows.get("beta/app")!.status.problems).toEqual([
      { code: "no_agent_online", message: "No agent online" },
    ]);
    expect(rows.get("rejected")!.status.problems).toEqual([
      { code: "no_agent_online", message: "No agent online" },
      { code: "connection", message: "GitLab rejects the bot token." },
    ]);
  });

  it("lists the active organization by default, or the one asked for", async () => {
    const paths = (list: RepositoryList) => list.repositories.map((r) => r.fullPath);
    expect(paths(await listed())).toEqual([
      "acme/healthy",
      "acme/pinned-offline",
      "acme/running",
      "acme/sync",
      "platform/tools/hook",
    ]);
    expect(paths(await listed(org.beta))).toEqual(["beta/app", "rejected"]);
  });

  it("answers 404 for an organization the user isn't a member of", async () => {
    expect((await list(org.cyan)).status).toBe(404);
    expect((await list("not-an-id")).status).toBe(404);
  });

  it("issues the same number of queries for 1 repo as for 20", async () => {
    const solo = await createOrganization("Solo");
    await db
      .insert(organizationMembers)
      .values({ organizationId: solo, userId: "rail-user", role: "member" });
    const github = await connection(solo, "github", "6");
    const [{ id: agentId }] = (await db
      .insert(agents)
      .values({ organizationId: solo, name: "solo-agent", lastHeartbeatAt: minutesAgo(30) })
      .returning({ id: agents.id })) as [{ id: string }];
    const addRepo = async (n: number) => {
      const id = await connect(github, "github", `solo/repo-${String(n).padStart(2, "0")}`);
      await db.insert(agentRepoPins).values({ agentId, repositoryId: id });
      await insertJob(db, {
        organizationId: solo,
        type: "repo.sync",
        taskType: "system",
        repositoryId: id,
      });
    };
    const queries = async () => {
      const spy = vi.spyOn(db.$client, "query");
      try {
        const result = await listed(solo);
        return { count: spy.mock.calls.length, repos: result.repositories.length };
      } finally {
        spy.mockRestore();
      }
    };

    await addRepo(1);
    const one = await queries();
    for (let n = 2; n <= 20; n++) await addRepo(n);
    const twenty = await queries();
    expect(one.repos).toBe(1);
    expect(twenty.repos).toBe(20);
    expect(one.count).toBeGreaterThan(0);
    expect(twenty.count).toBe(one.count);
  });

  it("caps the list at 500 repos and says it was truncated", async () => {
    const big = await createOrganization("Zeta");
    await db
      .insert(organizationMembers)
      .values({ organizationId: big, userId: "rail-user", role: "member" });
    const github = await connection(big, "github", "7");
    await db.insert(repositories).values(
      Array.from({ length: 501 }, (_, n) => ({
        organizationId: big,
        connectionId: github,
        provider: "github" as const,
        externalId: `zeta-${n}`,
        fullPath: `zeta/repo-${String(n).padStart(3, "0")}`,
      })),
    );
    const result = await listed(big);
    expect(result.truncated).toBe(true);
    expect(result.repositories).toHaveLength(500);
    expect(result.repositories.at(-1)!.fullPath).toBe("zeta/repo-499");
  });
});
