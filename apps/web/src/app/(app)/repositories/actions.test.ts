import { randomBytes } from "node:crypto";
import {
  agentRepoPins,
  agents,
  connectionCredentials,
  closeDb,
  createDb,
  organizations,
  repositories,
  reviews,
  runMigrations,
  scmConnections,
  seedReviewProfiles,
  users,
  type Database,
} from "@omniralph/db";
import { GitHubAppAuth } from "@omniralph/scm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  githubAuth: undefined as unknown,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  // The signed-in user works in `state.orgId`.
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/scm/github-app", () => ({ getGitHubAppAuth: () => state.githubAuth }));

const {
  connectGitLab,
  disconnectRepository,
  removeScmConnection,
  saveGitHubRepositories,
  saveGitLabProjects,
  setRepositoryEnabled,
} = await import("./actions");

const GITLAB = "https://gitlab.example.com";
const API = `${GITLAB}/api/v4`;
const TOKEN = "glpat-bot-token";

interface HookRequest {
  projectId: string;
  body: Record<string, unknown>;
}

const hookRequests: HookRequest[] = [];
const deletedHooks: string[] = [];
const projects: Record<string, { id: number; path_with_namespace: string; web_url: string }> = {
  "acme/api": { id: 101, path_with_namespace: "acme/api", web_url: `${GITLAB}/acme/api` },
  "acme/sub/web": {
    id: 102,
    path_with_namespace: "acme/sub/web",
    web_url: `${GITLAB}/acme/sub/web`,
  },
};
let nextHookId = 9000;

function authorized(request: Request): boolean {
  return request.headers.get("private-token") === TOKEN;
}

const server = setupServer(
  http.get(`${API}/user`, ({ request }) =>
    authorized(request)
      ? HttpResponse.json({ id: 77, username: "service_account_group_12_omniralph", name: "Omniralph" })
      : HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 }),
  ),
  http.get(`${API}/personal_access_tokens/self`, () =>
    HttpResponse.json({ id: 5, name: "omniralph", scopes: ["api"], active: true, revoked: false }),
  ),
  http.get(`${API}/projects/:path`, ({ params }) => {
    const project = projects[decodeURIComponent(String(params.path))];
    return project
      ? HttpResponse.json(project)
      : HttpResponse.json({ message: "404 Project Not Found" }, { status: 404 });
  }),
  http.post(`${API}/projects/:id/hooks`, async ({ request, params }) => {
    hookRequests.push({
      projectId: String(params.id),
      body: (await request.json()) as Record<string, unknown>,
    });
    return HttpResponse.json({ id: nextHookId++, url: "x" }, { status: 201 });
  }),
  http.delete(`${API}/projects/:id/hooks/:hookId`, ({ params }) => {
    deletedHooks.push(`${String(params.id)}/${String(params.hookId)}`);
    return new HttpResponse(null, { status: 204 });
  }),
);

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("repository server actions", () => {
  let container: StartedPostgreSqlContainer;
  const adminId = "admin-1";
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.APP_URL = "https://omniralph.example.com/";
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    state.db = createDb(container.getConnectionUri());
    await state.db.insert(users).values([
      { id: adminId, email: "admin@example.com" },
      { id: "member-1", email: "member@example.com" },
    ]);
    const [org, other] = await state.db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    await seedReviewProfiles(state.db, orgId);
    await seedReviewProfiles(state.db, otherOrgId);
    // After Testcontainers is done talking to Docker over HTTP.
    server.listen({ onUnhandledFrame: "error" });
  }, 180_000);

  beforeEach(() => {
    state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
    state.orgId = orgId;
    hookRequests.length = 0;
    deletedHooks.length = 0;
  });

  afterEach(async () => {
    server.resetHandlers();
    await state.db.delete(scmConnections);
  });

  afterAll(async () => {
    server.close();
    if (state.db) await closeDb(state.db);
    await container?.stop();
  });

  const form = { baseUrl: `${GITLAB}/`, token: TOKEN, projectPaths: "acme/api\nacme/sub/web" };
  const connected = { ok: true, connectionId: expect.any(String) };

  it("rejects a token GitLab doesn't accept and stores nothing", async () => {
    const result = await connectGitLab({ ...form, token: "glpat-wrong" });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("rejected the access token"),
    });
    expect(await state.db.select().from(scmConnections)).toEqual([]);
    expect(hookRequests).toEqual([]);
  });

  it("rejects a token without the api scope", async () => {
    server.use(
      http.get(`${API}/personal_access_tokens/self`, () =>
        HttpResponse.json({ id: 5, scopes: ["read_api"], active: true, revoked: false }),
      ),
    );
    const result = await connectGitLab(form);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("api scope") });
    expect(await state.db.select().from(scmConnections)).toEqual([]);
  });

  it("rejects a project access token, which can't mint clone tokens", async () => {
    server.use(
      http.get(`${API}/user`, () => HttpResponse.json({ id: 78, username: "project_101_bot_9f3c", name: "Bot" })),
    );
    const result = await connectGitLab(form);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("service account's personal access token") });
    expect(await state.db.select().from(scmConnections)).toEqual([]);
    expect(hookRequests).toEqual([]);
  });

  it("rejects unknown projects before creating any webhook", async () => {
    const result = await connectGitLab({ ...form, projectPaths: "acme/api\nacme/missing" });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("acme/missing") });
    expect(hookRequests).toEqual([]);
    expect(await state.db.select().from(scmConnections)).toEqual([]);
  });

  it("stores the token encrypted and creates a project webhook per project", async () => {
    expect(await connectGitLab(form)).toEqual(connected);

    const [connection] = await state.db.select().from(scmConnections);
    expect(connection).toMatchObject({
      organizationId: orgId,
      provider: "gitlab",
      baseUrl: GITLAB,
      externalId: "77",
      createdBy: adminId,
    });
    expect(connection!.encryptedCredentials).not.toContain(TOKEN);
    const credentials = connectionCredentials<{ token: string; webhookSecret: string }>(
      connection!,
    );
    expect(credentials.token).toBe(TOKEN);
    expect(credentials.webhookSecret.length).toBeGreaterThanOrEqual(32);

    expect(hookRequests.map((r) => r.projectId)).toEqual(["101", "102"]);
    for (const { body } of hookRequests) {
      expect(body).toMatchObject({
        url: "https://omniralph.example.com/api/webhooks/gitlab",
        merge_requests_events: true,
        note_events: true,
        pipeline_events: true,
        push_events: false,
        enable_ssl_verification: true,
        token: credentials.webhookSecret,
      });
    }

    const repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
    expect(repos.map((r) => [r.fullPath, r.externalId, r.enabled, r.webhookId !== null])).toEqual([
      ["acme/api", "101", true, true],
      ["acme/sub/web", "102", true, true],
    ]);

    // Reconnecting keeps the secret and replaces each project's webhook.
    const oldHooks = repos.map((r) => `${r.externalId}/${r.webhookId}`);
    expect(await connectGitLab(form)).toEqual(connected);
    expect(await state.db.select().from(scmConnections)).toHaveLength(1);
    expect(hookRequests.at(-1)?.body.token).toBe(credentials.webhookSecret);
    expect(deletedHooks.sort()).toEqual(oldHooks.sort());
  });

  it("reports projects whose webhook GitLab refuses", async () => {
    server.use(
      http.post(`${API}/projects/102/hooks`, () =>
        HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }),
      ),
    );
    const result = await connectGitLab(form);
    expect(result).toEqual({ ...connected, warning: expect.stringContaining("acme/sub/web") });
    const repos = await state.db.select().from(repositories);
    expect(repos.map((r) => r.fullPath)).toEqual(["acme/api"]);
  });

  describe("picking GitLab projects from a list", () => {
    let listQueries: URLSearchParams[] = [];

    beforeEach(() => {
      listQueries = [];
      server.use(
        http.get(`${API}/projects`, ({ request }) => {
          listQueries.push(new URL(request.url).searchParams);
          return HttpResponse.json(
            Object.values(projects).map((project) => ({ ...project, visibility: "private" })),
          );
        }),
      );
    });

    async function connectWithoutProjects(): Promise<string> {
      const result = await connectGitLab({ ...form, projectPaths: "" });
      expect(result).toEqual(connected);
      return (result as { connectionId: string }).connectionId;
    }

    it("connects without project paths: stores the connection and creates no webhook", async () => {
      const connectionId = await connectWithoutProjects();
      const [connection] = await state.db.select().from(scmConnections);
      expect(connection).toMatchObject({ id: connectionId, provider: "gitlab", baseUrl: GITLAB });
      expect(hookRequests).toEqual([]);
      expect(await state.db.select().from(repositories)).toEqual([]);
    });

    it("connects selected projects the bot maintains, with one webhook each, and disables the others", async () => {
      const connectionId = await connectWithoutProjects();

      expect(await saveGitLabProjects(connectionId, [101, 102, 999])).toEqual({ ok: true });
      expect(listQueries[0]?.get("min_access_level")).toBe("40");
      expect(hookRequests.map((r) => r.projectId).sort()).toEqual(["101", "102"]);
      let repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.enabled, r.webhookId !== null])).toEqual([
        ["acme/api", true, true],
        ["acme/sub/web", true, true],
      ]);

      // Deselecting disables; reselecting re-enables without another webhook.
      expect(await saveGitLabProjects(connectionId, [102])).toEqual({ ok: true });
      repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.enabled])).toEqual([
        ["acme/api", false],
        ["acme/sub/web", true],
      ]);
      expect(await saveGitLabProjects(connectionId, [101, 102])).toEqual({ ok: true });
      repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => r.enabled)).toEqual([true, true]);
      expect(hookRequests).toHaveLength(2);
      expect(deletedHooks).toEqual([]);
    });

    it("leaves connected projects the list doesn't show enabled", async () => {
      // acme/sub/web is connected by path but drops out of the list (e.g. archived).
      expect(await connectGitLab(form)).toEqual(connected);
      const [connection] = await state.db.select().from(scmConnections);
      server.use(
        http.get(`${API}/projects`, () =>
          HttpResponse.json([{ ...projects["acme/api"], visibility: "private" }]),
        ),
      );

      expect(await saveGitLabProjects(connection!.id, [])).toEqual({ ok: true });
      const repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.enabled])).toEqual([
        ["acme/api", false],
        ["acme/sub/web", true],
      ]);
    });

    it("creates a new webhook for a disconnected project that's selected again", async () => {
      const connectionId = await connectWithoutProjects();
      await saveGitLabProjects(connectionId, [101]);
      const [repo] = await state.db.select().from(repositories);
      expect(await disconnectRepository(repo!.id)).toEqual({ ok: true });

      expect(await saveGitLabProjects(connectionId, [101])).toEqual({ ok: true });
      const [reconnected] = await state.db.select().from(repositories);
      expect(reconnected).toMatchObject({ enabled: true, disconnectedAt: null });
      expect(reconnected!.webhookId).not.toBe(repo!.webhookId);
      expect(hookRequests).toHaveLength(2);
    });

    it("reports projects whose webhook GitLab refuses", async () => {
      server.use(
        http.post(`${API}/projects/102/hooks`, () =>
          HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }),
        ),
      );
      const connectionId = await connectWithoutProjects();
      expect(await saveGitLabProjects(connectionId, [101, 102])).toEqual({
        ok: true,
        warning: expect.stringContaining("acme/sub/web"),
      });
      const repos = await state.db.select().from(repositories);
      expect(repos.map((r) => r.fullPath)).toEqual(["acme/api"]);
    });

    it("refuses another organization's connection and members", async () => {
      const connectionId = await connectWithoutProjects();
      state.orgId = otherOrgId;
      expect(await saveGitLabProjects(connectionId, [101])).toMatchObject({ ok: false });
      state.orgId = orgId;
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await saveGitLabProjects(connectionId, [101])).toMatchObject({ ok: false });
      expect(hookRequests).toEqual([]);
      expect(await state.db.select().from(repositories)).toEqual([]);
    });
  });

  it("disconnecting disables the repo, removes pins, deletes the webhook and keeps reviews", async () => {
    await connectGitLab({ ...form, projectPaths: "acme/api" });
    const [repo] = await state.db.select().from(repositories);
    const [agent] = await state.db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning();
    await state.db.insert(agentRepoPins).values({ agentId: agent!.id, repositoryId: repo!.id });
    await state.db.insert(reviews).values({
      repositoryId: repo!.id,
      prNumber: 3,
      headSha: "h",
      baseSha: "b",
      trigger: "webhook",
      budget: 1,
    });

    expect(await disconnectRepository(repo!.id)).toEqual({ ok: true });
    expect(deletedHooks).toEqual([`101/${repo!.webhookId}`]);
    const [after] = await state.db.select().from(repositories).where(eq(repositories.id, repo!.id));
    expect(after).toMatchObject({ enabled: false, webhookId: null });
    expect(after!.disconnectedAt).not.toBeNull();
    expect(await state.db.select().from(agentRepoPins)).toEqual([]);
    expect(
      await state.db.select().from(reviews).where(eq(reviews.repositoryId, repo!.id)),
    ).toHaveLength(1);
    expect(await setRepositoryEnabled(repo!.id, true)).toMatchObject({ ok: false });
    await state.db.delete(agents);
  });

  it("still disconnects when the webhook can't be deleted, with a warning", async () => {
    await connectGitLab({ ...form, projectPaths: "acme/api" });
    const [repo] = await state.db.select().from(repositories);
    server.use(
      http.delete(`${API}/projects/:id/hooks/:hookId`, () =>
        HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 }),
      ),
    );
    const result = await disconnectRepository(repo!.id);
    expect(result).toEqual({ ok: true, warning: expect.stringContaining("couldn't be deleted") });
    const [after] = await state.db.select().from(repositories);
    expect(after!.disconnectedAt).not.toBeNull();
  });

  it("toggles reviews for a repository", async () => {
    await connectGitLab({ ...form, projectPaths: "acme/api" });
    const [repo] = await state.db.select().from(repositories);
    expect(await setRepositoryEnabled(repo!.id, false)).toEqual({ ok: true });
    const [after] = await state.db.select().from(repositories);
    expect(after!.enabled).toBe(false);
  });

  it("refuses members", async () => {
    state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
    expect(await connectGitLab(form)).toEqual({
      ok: false,
      error: expect.stringContaining("admin"),
    });
    expect(await disconnectRepository("00000000-0000-0000-0000-000000000000")).toMatchObject({
      ok: false,
    });
    expect(await setRepositoryEnabled("00000000-0000-0000-0000-000000000000", true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("admin"),
    });
    expect(hookRequests).toEqual([]);
  });

  it("enables only selected repositories the GitHub installation can access", async () => {
    const GITHUB = "https://api.github.com";
    state.githubAuth = new GitHubAppAuth({
      appId: "1",
      signer: {
        sign: async () => ({ token: "app.jwt.token", expiresAt: new Date(Date.now() + 600_000) }),
      },
    });
    server.use(
      http.post(`${GITHUB}/app/installations/7/access_tokens`, () =>
        HttpResponse.json({
          token: "ghs_x",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
      http.get(`${GITHUB}/installation/repositories`, () =>
        HttpResponse.json({
          total_count: 2,
          repositories: [
            {
              id: 1,
              full_name: "acme/one",
              private: true,
              html_url: "https://github.com/acme/one",
            },
            {
              id: 2,
              full_name: "acme/two",
              private: false,
              html_url: "https://github.com/acme/two",
            },
          ],
        }),
      ),
    );
    const [connection] = await state.db
      .insert(scmConnections)
      .values({
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: GITHUB,
        externalId: "7",
        encryptedCredentials: "x",
      })
      .returning();

    expect(await saveGitHubRepositories(connection!.id, [1, 2, 999])).toEqual({ ok: true });
    let repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
    expect(repos.map((r) => [r.fullPath, r.enabled])).toEqual([
      ["acme/one", true],
      ["acme/two", true],
    ]);

    expect(await saveGitHubRepositories(connection!.id, [2])).toEqual({ ok: true });
    repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
    expect(repos.map((r) => [r.fullPath, r.enabled])).toEqual([
      ["acme/one", false],
      ["acme/two", true],
    ]);
  });

  it("refuses a GitLab connection that belongs to another organization", async () => {
    expect(await connectGitLab({ ...form, projectPaths: "acme/api" })).toEqual(connected);
    const hooks = hookRequests.length;
    state.orgId = otherOrgId;
    expect(await connectGitLab({ ...form, projectPaths: "acme/api" })).toEqual({
      ok: false,
      error: expect.stringContaining("another organization"),
    });
    expect(hookRequests).toHaveLength(hooks);
    const connections = await state.db.select().from(scmConnections);
    expect(connections.map((c) => c.organizationId)).toEqual([orgId]);
  });

  it("doesn't find another organization's repositories and connections", async () => {
    await connectGitLab({ ...form, projectPaths: "acme/api" });
    const [repo] = await state.db.select().from(repositories);
    const [connection] = await state.db.select().from(scmConnections);
    state.orgId = otherOrgId;
    const notConnected = { ok: false, error: "That repository isn't connected." };
    expect(await setRepositoryEnabled(repo!.id, false)).toEqual(notConnected);
    expect(await disconnectRepository(repo!.id)).toEqual(notConnected);
    expect(await saveGitHubRepositories(connection!.id, [1])).toEqual({
      ok: false,
      error: "That GitHub installation isn't connected.",
    });
    expect(deletedHooks).toEqual([]);
    const [after] = await state.db.select().from(repositories);
    expect(after).toMatchObject({ enabled: true, disconnectedAt: null });
  });
  describe("removing a connection", () => {
    it("deletes the GitLab webhooks, repositories and connection so another organization can connect it", async () => {
      expect(await connectGitLab(form)).toEqual(connected);
      const [connection] = await state.db.select().from(scmConnections);
      const repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos).toHaveLength(2);
      // A disconnected repository has no webhook left to delete.
      expect(await disconnectRepository(repos[1]!.id)).toMatchObject({ ok: true });
      deletedHooks.length = 0;

      // Members and other organizations can't remove it.
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await removeScmConnection(connection!.id)).toEqual({
        ok: false,
        error: expect.stringContaining("admin"),
      });
      state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
      state.orgId = otherOrgId;
      expect(await removeScmConnection(connection!.id)).toEqual({
        ok: false,
        error: "That connection doesn't exist.",
      });
      expect(deletedHooks).toEqual([]);
      expect(await state.db.select().from(scmConnections)).toHaveLength(1);

      state.orgId = orgId;
      expect(await removeScmConnection(connection!.id)).toEqual({ ok: true });
      expect(deletedHooks).toEqual([`101/${repos[0]!.webhookId}`]);
      expect(await state.db.select().from(scmConnections)).toEqual([]);
      expect(await state.db.select().from(repositories)).toEqual([]);

      // The same instance and token user can now be connected from another organization.
      state.orgId = otherOrgId;
      expect(await connectGitLab({ ...form, projectPaths: "acme/api" })).toEqual(connected);
      const [moved] = await state.db.select().from(scmConnections);
      expect(moved).toMatchObject({ organizationId: otherOrgId, externalId: "77" });
      const [movedRepo] = await state.db.select().from(repositories);
      expect(movedRepo).toMatchObject({ organizationId: otherOrgId, fullPath: "acme/api" });
    });

    it("still removes the connection when a webhook can't be deleted, with a warning", async () => {
      await connectGitLab({ ...form, projectPaths: "acme/api" });
      const [connection] = await state.db.select().from(scmConnections);
      server.use(
        http.delete(`${API}/projects/:id/hooks/:hookId`, () =>
          HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }),
        ),
      );
      const result = await removeScmConnection(connection!.id);
      expect(result).toEqual({ ok: true, warning: expect.stringContaining("acme/api") });
      expect(await state.db.select().from(scmConnections)).toEqual([]);
    });

    it("removes a GitHub installation with its repositories and reviews", async () => {
      const [connection] = await state.db
        .insert(scmConnections)
        .values({
          organizationId: orgId,
          provider: "github",
          name: "acme",
          baseUrl: "https://api.github.com",
          externalId: "8",
          encryptedCredentials: "x",
        })
        .returning();
      const [repo] = await state.db
        .insert(repositories)
        .values({
          organizationId: orgId,
          provider: "github",
          externalId: "1",
          fullPath: "acme/one",
          connectionId: connection!.id,
        })
        .returning();
      await state.db.insert(reviews).values({
        repositoryId: repo!.id,
        prNumber: 1,
        headSha: "a",
        baseSha: "b",
        trigger: "webhook",
        budget: 1,
      });

      expect(await removeScmConnection(connection!.id)).toEqual({ ok: true });
      expect(await state.db.select().from(scmConnections)).toEqual([]);
      expect(await state.db.select().from(repositories)).toEqual([]);
      expect(await state.db.select().from(reviews)).toEqual([]);
    });
  });
});
