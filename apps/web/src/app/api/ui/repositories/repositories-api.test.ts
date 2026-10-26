import { randomBytes } from "node:crypto";
import {
  harnessRepoPins,
  harnesses,
  connectionCredentials,
  closeDb,
  createDb,
  organizations,
  repositories,
  reviews,
  scmConnections,
  scmCredentialCache,
  setAllowedTaskTypeDefaults,
  users,
  type Database,
} from "@omniralph/db";
import { GitHubAppAuth } from "@omniralph/scm";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq, isNull } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

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

const gitlabConnections = await import("@/app/api/ui/gitlab-connections/route");
const repository = await import("@/app/api/ui/repositories/[id]/route");
const repositoryWebhook = await import("@/app/api/ui/repositories/[id]/webhook/route");
const scmConnection = await import("@/app/api/ui/scm-connections/[id]/route");
const selection = await import("@/app/api/ui/scm-connections/[id]/repositories/route");

type Result = { ok: true; warning?: string; connectionId?: string } | { ok: false; error: string };

/** Calls an `/api/ui` handler as the Repositories pages do; answers its result as an `ActionResult`. */
async function call(
  handler: (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>,
  method: string,
  id: string,
  body?: unknown,
): Promise<Result> {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  return response.ok ? (json as Result) : { ok: false, error: json.error as string };
}

// The Repositories pages' requests, under the names of the server actions they replace.
const connectGitLab = (form: { baseUrl: string; token: string }) =>
  call(gitlabConnections.POST as Parameters<typeof call>[0], "POST", "", form);
const disconnectRepository = (id: string) => call(repository.DELETE, "DELETE", id);
const recreateGitLabWebhook = (id: string) => call(repositoryWebhook.POST, "POST", id);
const removeScmConnection = (id: string) => call(scmConnection.DELETE, "DELETE", id);
const saveGitHubRepositories = (id: string, selectedIds: number[]) =>
  call(selection.PUT, "PUT", id, { provider: "github", selectedIds });
const saveGitLabProjects = (id: string, selectedIds: number[]) =>
  call(selection.PUT, "PUT", id, { provider: "gitlab", selectedIds });

const GITLAB = "https://gitlab.example.com";
const API = `${GITLAB}/api/v4`;
const TOKEN = "glpat-bot-token";

interface HookRequest {
  projectId: string;
  body: Record<string, unknown>;
}

const hookRequests: HookRequest[] = [];
const deletedHooks: string[] = [];
/** Project access tokens minted, as `<project ID>/<scope>`. */
const mintedTokens: string[] = [];
let nextTokenId = 500;
const listQueries: URLSearchParams[] = [];
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
      ? HttpResponse.json({
          id: 77,
          username: "service_account_group_12_omniralph",
          name: "Omniralph",
        })
      : HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 }),
  ),
  http.get(`${API}/personal_access_tokens/self`, () =>
    HttpResponse.json({ id: 5, name: "omniralph", scopes: ["api"], active: true, revoked: false }),
  ),
  http.get(`${API}/projects`, ({ request }) => {
    listQueries.push(new URL(request.url).searchParams);
    return HttpResponse.json(
      Object.values(projects).map((project) => ({ ...project, visibility: "private" })),
    );
  }),
  http.post(`${API}/projects/:id/hooks`, async ({ request, params }) => {
    hookRequests.push({
      projectId: String(params.id),
      body: (await request.json()) as Record<string, unknown>,
    });
    return HttpResponse.json({ id: nextHookId++, url: "x" }, { status: 201 });
  }),
  http.post(`${API}/projects/:id/access_tokens`, async ({ request, params }) => {
    const body = (await request.json()) as { scopes: string[]; expires_at: string };
    mintedTokens.push(`${String(params.id)}/${body.scopes.join(",")}`);
    const id = nextTokenId++;
    return HttpResponse.json(
      { id, token: `glpat-project-${id}`, scopes: body.scopes, expires_at: body.expires_at },
      { status: 201 },
    );
  }),
  http.delete(`${API}/projects/:id/hooks/:hookId`, ({ params }) => {
    deletedHooks.push(`${String(params.id)}/${String(params.hookId)}`);
    return new HttpResponse(null, { status: 204 });
  }),
);

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("repository and connection handlers", () => {
  let testDb: TestDatabase;
  const adminId = "admin-1";
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.APP_URL = "https://omniralph.example.com/";
    testDb = await createTestDatabase();
    state.db = createDb(testDb.uri);
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
    server.listen({ onUnhandledFrame: "error" });
  }, 180_000);

  beforeEach(() => {
    state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
    state.orgId = orgId;
    hookRequests.length = 0;
    deletedHooks.length = 0;
    mintedTokens.length = 0;
    listQueries.length = 0;
  });

  afterEach(async () => {
    server.resetHandlers();
    await state.db.delete(scmConnections);
  });

  afterAll(async () => {
    server.close();
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  const form = { baseUrl: `${GITLAB}/`, token: TOKEN };
  const connected = { ok: true, connectionId: expect.any(String) };

  /** Connects GitLab, then picks the given projects. Returns the connection's ID. */
  async function connectGitLabProjects(projectIds: number[] = []): Promise<string> {
    const result = await connectGitLab(form);
    expect(result).toEqual(connected);
    const { connectionId } = result as { connectionId: string };
    if (projectIds.length > 0) {
      expect(await saveGitLabProjects(connectionId, projectIds)).toEqual({ ok: true });
    }
    return connectionId;
  }

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
      http.get(`${API}/user`, () =>
        HttpResponse.json({ id: 78, username: "project_101_bot_9f3c", name: "Bot" }),
      ),
    );
    const result = await connectGitLab(form);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("service account's personal access token"),
    });
    expect(await state.db.select().from(scmConnections)).toEqual([]);
    expect(hookRequests).toEqual([]);
  });

  it("stores the token encrypted without creating any webhook", async () => {
    expect(await connectGitLab(form)).toEqual(connected);

    const [connection] = await state.db.select().from(scmConnections);
    expect(connection).toMatchObject({
      organizationId: orgId,
      provider: "gitlab",
      name: "service_account_group_12_omniralph @ gitlab.example.com",
      baseUrl: GITLAB,
      externalId: "77",
      botUsername: "service_account_group_12_omniralph",
      createdBy: adminId,
    });
    expect(connection!.encryptedCredentials).not.toContain(TOKEN);
    const credentials = connectionCredentials<{ token: string; webhookSecret: string }>(
      connection!,
    );
    expect(credentials.token).toBe(TOKEN);
    expect(credentials.webhookSecret.length).toBeGreaterThanOrEqual(32);
    expect(hookRequests).toEqual([]);
    expect(await state.db.select().from(repositories)).toEqual([]);
  });

  it("keeps the webhook secret and the project webhooks when connecting again", async () => {
    await connectGitLabProjects([101, 102]);
    const [connection] = await state.db.select().from(scmConnections);
    const { webhookSecret } = connectionCredentials<{ webhookSecret: string }>(connection!);

    expect(await connectGitLab(form)).toEqual(connected);
    const connections = await state.db.select().from(scmConnections);
    expect(connections).toHaveLength(1);
    expect(connectionCredentials<{ webhookSecret: string }>(connections[0]!).webhookSecret).toBe(
      webhookSecret,
    );
    expect(hookRequests).toHaveLength(2);
    expect(deletedHooks).toEqual([]);
  });

  it("stores the bot username when connecting again", async () => {
    expect(await connectGitLab(form)).toEqual(connected);
    // A connection from before bot usernames were stored.
    await state.db.update(scmConnections).set({ botUsername: null });

    expect(await connectGitLab(form)).toEqual(connected);
    const [connection] = await state.db.select().from(scmConnections);
    expect(connection!.botUsername).toBe("service_account_group_12_omniralph");
  });

  describe("picking GitLab projects from a list", () => {
    it("connects selected projects the bot maintains, with one webhook each, and disables the others", async () => {
      const connectionId = await connectGitLabProjects();

      expect(await saveGitLabProjects(connectionId, [101, 102, 999])).toEqual({ ok: true });
      expect(listQueries[0]?.get("min_access_level")).toBe("40");
      expect(hookRequests.map((r) => r.projectId).sort()).toEqual(["101", "102"]);
      // Each project's clone token was minted (and cached) before it was connected.
      expect(mintedTokens.sort()).toEqual(["101/read_repository", "102/read_repository"]);
      expect(await state.db.select().from(scmCredentialCache)).toHaveLength(2);
      const [connection] = await state.db.select().from(scmConnections);
      const { webhookSecret } = connectionCredentials<{ webhookSecret: string }>(connection!);
      for (const { body } of hookRequests) {
        expect(body).toMatchObject({
          url: "https://omniralph.example.com/api/webhooks/gitlab",
          merge_requests_events: true,
          note_events: true,
          pipeline_events: true,
          push_events: false,
          enable_ssl_verification: true,
          token: webhookSecret,
        });
      }
      let repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.reviewsEnabled, r.webhookId !== null])).toEqual([
        ["acme/api", true, true],
        ["acme/sub/web", true, true],
      ]);

      // Deselecting disables; reselecting re-enables without another webhook.
      expect(await saveGitLabProjects(connectionId, [102])).toEqual({ ok: true });
      repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.reviewsEnabled])).toEqual([
        ["acme/api", false],
        ["acme/sub/web", true],
      ]);
      expect(await saveGitLabProjects(connectionId, [101, 102])).toEqual({ ok: true });
      repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => r.reviewsEnabled)).toEqual([true, true]);
      expect(hookRequests).toHaveLength(2);
      expect(deletedHooks).toEqual([]);
      // acme/api was re-enabled with its still-valid cached clone token.
      expect(mintedTokens).toHaveLength(2);
    });

    it("doesn't connect a project that can't mint clone tokens, and connects the others", async () => {
      server.use(
        http.post(`${API}/projects/102/access_tokens`, () =>
          HttpResponse.json(
            {
              message:
                "400 Bad request - User does not have permission to create project access token",
            },
            { status: 400 },
          ),
        ),
      );
      const connectionId = await connectGitLabProjects();

      const result = await saveGitLabProjects(connectionId, [101, 102]);
      expect(result).toEqual({
        ok: true,
        warning: expect.stringContaining(
          "acme/sub/web: The GitLab bot token can't create project access tokens on acme/sub/web.",
        ),
      });
      expect(result.ok && result.warning).not.toContain("acme/api:");
      expect(hookRequests.map((r) => r.projectId)).toEqual(["101"]);
      const repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.reviewsEnabled, r.disconnectedAt !== null])).toEqual([
        ["acme/api", true, false],
        ["acme/sub/web", false, true],
      ]);
    });

    it("doesn't re-enable a project that can no longer mint clone tokens", async () => {
      const connectionId = await connectGitLabProjects([101]);
      expect(await saveGitLabProjects(connectionId, [])).toEqual({ ok: true });
      // No cached token to reuse, so a new one must be minted, and GitLab refuses.
      await state.db.delete(scmCredentialCache);
      server.use(
        http.post(`${API}/projects/101/access_tokens`, () =>
          HttpResponse.json(
            {
              message:
                "403 Forbidden - User does not have permission to create project access token",
            },
            { status: 403 },
          ),
        ),
      );

      expect(await saveGitLabProjects(connectionId, [101])).toEqual({
        ok: true,
        warning: expect.stringContaining(
          "acme/api: The GitLab bot token can't create project access tokens",
        ),
      });
      const [repo] = await state.db.select().from(repositories);
      expect(repo).toMatchObject({ reviewsEnabled: false, disconnectedAt: null });
      expect(hookRequests).toHaveLength(1);
      expect(deletedHooks).toEqual([]);
    });

    it("leaves connected projects the list doesn't show enabled", async () => {
      // acme/sub/web is connected but then drops out of the list (e.g. archived).
      const connectionId = await connectGitLabProjects([101, 102]);
      server.use(
        http.get(`${API}/projects`, () =>
          HttpResponse.json([{ ...projects["acme/api"], visibility: "private" }]),
        ),
      );

      expect(await saveGitLabProjects(connectionId, [])).toEqual({ ok: true });
      const repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.reviewsEnabled])).toEqual([
        ["acme/api", false],
        ["acme/sub/web", true],
      ]);
    });

    it("creates a new webhook for a disconnected project that's selected again", async () => {
      const connectionId = await connectGitLabProjects();
      await saveGitLabProjects(connectionId, [101]);
      const [repo] = await state.db.select().from(repositories);
      expect(await disconnectRepository(repo!.id)).toEqual({ ok: true });

      expect(await saveGitLabProjects(connectionId, [101])).toEqual({ ok: true });
      const [reconnected] = await state.db.select().from(repositories);
      expect(reconnected).toMatchObject({ reviewsEnabled: true, disconnectedAt: null });
      expect(reconnected!.webhookId).not.toBe(repo!.webhookId);
      expect(hookRequests).toHaveLength(2);
    });

    it("reports projects whose webhook GitLab refuses", async () => {
      server.use(
        http.post(`${API}/projects/102/hooks`, () =>
          HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }),
        ),
      );
      const connectionId = await connectGitLabProjects();
      expect(await saveGitLabProjects(connectionId, [101, 102])).toEqual({
        ok: true,
        warning: expect.stringContaining("acme/sub/web"),
      });
      const repos = await state.db
        .select()
        .from(repositories)
        .where(isNull(repositories.disconnectedAt));
      expect(repos.map((r) => r.fullPath)).toEqual(["acme/api"]);
    });

    it("refuses another organization's connection and members", async () => {
      const connectionId = await connectGitLabProjects();
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
    await connectGitLabProjects([101]);
    const [repo] = await state.db.select().from(repositories);
    const [agent] = await state.db
      .insert(harnesses)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning();
    await state.db.insert(harnessRepoPins).values({ harnessId: agent!.id, repositoryId: repo!.id });
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
    expect(after).toMatchObject({ reviewsEnabled: false, webhookId: null });
    expect(after!.disconnectedAt).not.toBeNull();
    expect(await state.db.select().from(harnessRepoPins)).toEqual([]);
    expect(
      await state.db.select().from(reviews).where(eq(reviews.repositoryId, repo!.id)),
    ).toHaveLength(1);
    // It isn't connected any more.
    expect(await disconnectRepository(repo!.id)).toMatchObject({ ok: false });
    await state.db.delete(harnesses);
  });

  it("still disconnects when the webhook can't be deleted, with a warning", async () => {
    await connectGitLabProjects([101]);
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

  it("refuses members", async () => {
    state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
    expect(await connectGitLab(form)).toEqual({
      ok: false,
      error: expect.stringContaining("admin"),
    });
    expect(await disconnectRepository("00000000-0000-0000-0000-000000000000")).toMatchObject({
      ok: false,
    });
    expect(await recreateGitLabWebhook("00000000-0000-0000-0000-000000000000")).toMatchObject({
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
    expect(repos.map((r) => [r.fullPath, r.reviewsEnabled])).toEqual([
      ["acme/one", true],
      ["acme/two", true],
    ]);

    expect(await saveGitHubRepositories(connection!.id, [2])).toEqual({ ok: true });
    repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
    expect(repos.map((r) => [r.fullPath, r.reviewsEnabled])).toEqual([
      ["acme/one", false],
      ["acme/two", true],
    ]);

    // Ticking turns reviews on, whatever the organization's task types.
    try {
      await setAllowedTaskTypeDefaults(state.db, orgId, ["query", "coding"], null);
      expect(await saveGitHubRepositories(connection!.id, [1, 2])).toEqual({ ok: true });
      repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.reviewsEnabled])).toEqual([
        ["acme/one", true],
        ["acme/two", true],
      ]);
    } finally {
      await setAllowedTaskTypeDefaults(state.db, orgId, null, null);
    }
  });

  it("refuses a GitLab connection that belongs to another organization", async () => {
    await connectGitLabProjects([101]);
    const hooks = hookRequests.length;
    state.orgId = otherOrgId;
    expect(await connectGitLab(form)).toEqual({
      ok: false,
      error: expect.stringContaining("another organization"),
    });
    expect(hookRequests).toHaveLength(hooks);
    const connections = await state.db.select().from(scmConnections);
    expect(connections.map((c) => c.organizationId)).toEqual([orgId]);
  });

  it("doesn't find another organization's repositories and connections", async () => {
    await connectGitLabProjects([101]);
    const [repo] = await state.db.select().from(repositories);
    const [connection] = await state.db.select().from(scmConnections);
    state.orgId = otherOrgId;
    const notConnected = { ok: false, error: "That repository isn't connected." };
    expect(await disconnectRepository(repo!.id)).toEqual(notConnected);
    expect(await saveGitHubRepositories(connection!.id, [1])).toEqual({
      ok: false,
      error: "That GitHub installation isn't connected.",
    });
    expect(deletedHooks).toEqual([]);
    const [after] = await state.db.select().from(repositories);
    expect(after).toMatchObject({ reviewsEnabled: true, disconnectedAt: null });
  });
  describe("recreating a GitLab webhook", () => {
    /** Connects acme/api and acme/sub/web and records webhook problems for both. */
    async function withWebhookProblems() {
      const connectionId = await connectGitLabProjects([101, 102]);
      const repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      const [api, web] = repos;
      await state.db
        .update(scmConnections)
        .set({
          health: {
            checkedAt: "2026-10-07T04:45:00.000Z",
            tokenExpiresAt: "2026-10-14",
            problems: [
              { code: "rotation_unsupported", message: "Can't rotate." },
              { code: "webhook_missing", message: "acme/api: none", repositoryId: api!.id },
              { code: "webhook_events_outdated", message: "acme/sub/web", repositoryId: web!.id },
            ],
          },
        })
        .where(eq(scmConnections.id, connectionId));
      hookRequests.length = 0;
      return { connectionId, api: api!, web: web! };
    }

    async function health(connectionId: string) {
      const [row] = await state.db
        .select()
        .from(scmConnections)
        .where(eq(scmConnections.id, connectionId));
      return row!.health;
    }

    it("deletes the stored webhook, creates a new one like the picker and clears the problem", async () => {
      const { connectionId, api, web } = await withWebhookProblems();

      expect(await recreateGitLabWebhook(api.id)).toEqual({ ok: true });

      expect(deletedHooks).toEqual([`101/${api.webhookId}`]);
      expect(hookRequests).toHaveLength(1);
      expect(hookRequests[0]).toMatchObject({
        projectId: "101",
        body: {
          url: "https://omniralph.example.com/api/webhooks/gitlab",
          merge_requests_events: true,
          note_events: true,
          pipeline_events: true,
          enable_ssl_verification: true,
        },
      });
      const [after] = await state.db.select().from(repositories).where(eq(repositories.id, api.id));
      expect(after!.webhookId).not.toBe(api.webhookId);
      expect(after!.webhookId).toMatch(/^\d+$/);
      expect(after).toMatchObject({ reviewsEnabled: true, disconnectedAt: null });
      expect((await health(connectionId))!.problems).toEqual([
        { code: "rotation_unsupported", message: "Can't rotate." },
        { code: "webhook_events_outdated", message: "acme/sub/web", repositoryId: web.id },
      ]);
    });

    it("creates a webhook for a project without a stored one", async () => {
      const { connectionId, api } = await withWebhookProblems();
      await state.db
        .update(repositories)
        .set({ webhookId: null })
        .where(eq(repositories.id, api.id));

      expect(await recreateGitLabWebhook(api.id)).toEqual({ ok: true });
      expect(deletedHooks).toEqual([]);
      expect(hookRequests.map((r) => r.projectId)).toEqual(["101"]);
      expect((await health(connectionId))!.problems.map((p) => p.code)).toEqual([
        "rotation_unsupported",
        "webhook_events_outdated",
      ]);
    });

    it("keeps the problem when GitLab refuses the new webhook", async () => {
      const { connectionId, api } = await withWebhookProblems();
      server.use(
        http.post(`${API}/projects/101/hooks`, () =>
          HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }),
        ),
      );
      expect(await recreateGitLabWebhook(api.id)).toEqual({
        ok: false,
        error: expect.stringContaining("Maintainer"),
      });
      const [after] = await state.db.select().from(repositories).where(eq(repositories.id, api.id));
      expect(after!.webhookId).toBeNull();
      expect((await health(connectionId))!.problems).toHaveLength(3);
    });

    it("refuses members and doesn't touch GitLab", async () => {
      const { connectionId, api } = await withWebhookProblems();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await recreateGitLabWebhook(api.id)).toMatchObject({ ok: false });
      expect(deletedHooks).toEqual([]);
      expect(hookRequests).toEqual([]);
      expect((await health(connectionId))!.problems).toHaveLength(3);
    });

    it("refuses another organization's project", async () => {
      const { connectionId, api } = await withWebhookProblems();
      state.orgId = otherOrgId;
      expect(await recreateGitLabWebhook(api.id)).toEqual({
        ok: false,
        error: "That GitLab project isn't connected.",
      });
      expect(deletedHooks).toEqual([]);
      expect(hookRequests).toEqual([]);
      const [after] = await state.db.select().from(repositories).where(eq(repositories.id, api.id));
      expect(after!.webhookId).toBe(api.webhookId);
      expect((await health(connectionId))!.problems).toHaveLength(3);
    });
  });

  describe("removing a connection", () => {
    it("deletes the GitLab webhooks, repositories and connection so another organization can connect it", async () => {
      await connectGitLabProjects([101, 102]);
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
      await connectGitLabProjects([101]);
      const [moved] = await state.db.select().from(scmConnections);
      expect(moved).toMatchObject({ organizationId: otherOrgId, externalId: "77" });
      const [movedRepo] = await state.db.select().from(repositories);
      expect(movedRepo).toMatchObject({ organizationId: otherOrgId, fullPath: "acme/api" });
    });

    it("still removes the connection when a webhook can't be deleted, with a warning", async () => {
      await connectGitLabProjects([101]);
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
