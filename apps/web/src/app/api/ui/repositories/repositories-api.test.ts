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
  scmConnections,
  scmCredentialCache,
  listWorkItemMatches,
  saveWorkItemMatch,
  setRepositorySwitches,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
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
vi.mock("@/lib/scm/github-app", () => ({
  getGitHubAppAuth: () => state.githubAuth,
  // The GitHub App isn't configured here.
  getGitHubInstallUrl: async () => null,
  githubInstallPath: (organizationId: string) =>
    `/repositories/github/install?organization=${organizationId}`,
}));

const gitlabConnections = await import("@/app/api/ui/gitlab-connections/route");
const repository = await import("@/app/api/ui/repositories/[id]/route");
const repositoryWebhook = await import("@/app/api/ui/repositories/[id]/webhook/route");
const scmConnection = await import("@/app/api/ui/scm-connections/[id]/route");
const scmConnectionList = await import("@/app/api/ui/scm-connections/route");
const selection = await import("@/app/api/ui/scm-connections/[id]/repositories/route");
const setup = await import("@/app/api/ui/repositories/setup/route");

type Result =
  | {
      ok: true;
      warning?: string;
      connectionId?: string;
      added?: { id: string; fullPath: string }[];
    }
  | { ok: false; error: string; status: number };

/** Calls an `/api/ui` handler as the Repositories pages do; answers its result as an `ActionResult`. */
async function call(
  handler: (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>,
  method: string,
  id: string,
  body?: unknown,
  path = "/api/ui",
): Promise<Result> {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  return response.ok
    ? (json as Result)
    : { ok: false, error: json.error as string, status: response.status };
}

/** Calls a GET handler with `query`; answers its status and JSON. */
async function get(
  handler: (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>,
  query: Record<string, string>,
  id = "",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`http://localhost/api/ui?${new URLSearchParams(query)}`),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// The Repos page's requests.
const connectGitLab = (form: { baseUrl: string; token: string; organizationId?: string }) =>
  call(gitlabConnections.POST as Parameters<typeof call>[0], "POST", "", form);
const disconnectRepository = (id: string) => call(repository.DELETE, "DELETE", id);
const recreateGitLabWebhook = (id: string) => call(repositoryWebhook.POST, "POST", id);
const removeScmConnection = (id: string) => call(scmConnection.DELETE, "DELETE", id);
/** The add result without its rail rows (asserted on their own). */
function withoutRows(result: Result): Result {
  if (!result.ok) return result;
  const { repositories: _rows, ...rest } = result as Result & { repositories?: unknown };
  return rest;
}
const addGitHubRepositories = (id: string, ids: number[], organizationId = state.orgId) =>
  call(selection.POST, "POST", id, { provider: "github", ids, organizationId }).then(withoutRows);
const addGitLabProjects = (id: string, ids: number[], organizationId = state.orgId) =>
  call(selection.POST, "POST", id, { provider: "gitlab", ids, organizationId }).then(withoutRows);

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
/** The default branch `GET /projects/:id` answers per project ID; a project not here fails. */
const defaultBranches: Record<string, string> = { "101": "main" };

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
  http.get(`${API}/projects/:id`, ({ params }) => {
    const branch = defaultBranches[String(params.id)];
    return branch
      ? HttpResponse.json({ id: Number(params.id), default_branch: branch })
      : HttpResponse.json({ message: "500 Internal Server Error" }, { status: 500 });
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
  const connected = {
    ok: true,
    connectionId: expect.any(String),
    // The sheet adds it to its list from the response.
    connection: {
      id: expect.any(String),
      provider: "gitlab",
      name: "service_account_group_12_omniralph @ gitlab.example.com",
      host: "gitlab.example.com",
      health: { state: expect.any(String), problems: expect.any(Array) },
    },
  };

  /** Connects GitLab, then adds the given projects. Returns the connection's ID. */
  async function connectGitLabProjects(projectIds: number[] = []): Promise<string> {
    const result = await connectGitLab(form);
    expect(result).toEqual(connected);
    const { connectionId } = result as { connectionId: string };
    if (projectIds.length > 0) {
      expect(await addGitLabProjects(connectionId, projectIds)).toMatchObject({
        ok: true,
        added: expect.any(Array),
      });
    }
    return connectionId;
  }

  /** The connection's repositories as `[fullPath, connected, reviews, coding, ask]`, by path. */
  async function repoStates() {
    const rows = await state.db.select().from(repositories).orderBy(repositories.fullPath);
    return rows.map((r) => [
      r.fullPath,
      r.disconnectedAt === null,
      r.reviewsEnabled,
      r.codingEnabled,
      r.askEnabled,
    ]);
  }

  it("rejects a token GitLab doesn't accept and stores nothing", async () => {
    const result = await connectGitLab({ ...form, token: "glpat-wrong" });
    expect(result).toEqual({
      ok: false,
      status: 400,
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
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining("api scope") });
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
      status: 400,
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

  describe("adding GitLab projects from a list", () => {
    it("connects the given projects the bot maintains, with one webhook each, Reviews and Ask on and Coding off", async () => {
      const connectionId = await connectGitLabProjects();

      const { result, changes } = await captureChanges(() =>
        addGitLabProjects(connectionId, [101, 102, 999]),
      );
      expect(result).toEqual({
        ok: true,
        added: [
          { id: expect.any(String), fullPath: "acme/api" },
          { id: expect.any(String), fullPath: "acme/sub/web" },
        ],
        warning: expect.stringContaining("One project isn't among the projects the bot maintains."),
      });
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
      expect(await repoStates()).toEqual([
        ["acme/api", true, true, false, true],
        ["acme/sub/web", true, true, false, true],
      ]);
      const rows = await state.db.select().from(repositories);
      expect(rows.every((r) => r.webhookId !== null)).toBe(true);
      // Published after commit: each added repo (and so the organization's list).
      const repositoryChanges = changes.filter((c) => c.resource === "repository");
      expect(repositoryChanges.flatMap((c) => c.ids).sort()).toEqual(
        expect.arrayContaining(rows.map((r) => r.id).sort()),
      );
      expect(repositoryChanges.every((c) => c.organizationId === orgId)).toBe(true);
    });

    it("is add-only: a connected repo not in ids stays connected, and adding it again changes nothing", async () => {
      const connectionId = await connectGitLabProjects([101]);
      // An admin turned its reviews off since.
      await state.db.update(repositories).set({ reviewsEnabled: false });

      expect(await addGitLabProjects(connectionId, [102])).toEqual({
        ok: true,
        added: [{ id: expect.any(String), fullPath: "acme/sub/web" }],
      });
      expect(await repoStates()).toEqual([
        ["acme/api", true, false, false, true],
        ["acme/sub/web", true, true, false, true],
      ]);

      const { result, changes } = await captureChanges(() =>
        addGitLabProjects(connectionId, [101, 102]),
      );
      expect(result).toEqual({ ok: true, added: [] });
      expect(changes.filter((c) => c.resource === "repository")).toEqual([]);
      // Untouched: no new webhook or clone token, and its switches are kept.
      expect(hookRequests).toHaveLength(2);
      expect(deletedHooks).toEqual([]);
      expect(mintedTokens).toHaveLength(2);
      expect(await repoStates()).toEqual([
        ["acme/api", true, false, false, true],
        ["acme/sub/web", true, true, false, true],
      ]);
    });

    it("answers the added projects' Repos rail rows, so the sheet adds them without a refetch", async () => {
      const connectionId = await connectGitLabProjects([101]);

      const result = (await call(selection.POST, "POST", connectionId, {
        provider: "gitlab",
        ids: [101, 102],
        organizationId: state.orgId,
      })) as Result & { repositories?: Record<string, unknown>[] };
      expect(result).toMatchObject({
        ok: true,
        added: [{ id: expect.any(String), fullPath: "acme/sub/web" }],
      });
      const [added] = result.ok ? result.added! : [];
      // Only the repo just added, not acme/api (connected before).
      expect(result.repositories).toEqual([
        {
          id: added!.id,
          organization: { id: state.orgId, name: expect.any(String), role: "admin" },
          provider: "gitlab",
          fullPath: "acme/sub/web",
          name: "web",
          group: "acme/sub",
          webUrl: `${GITLAB}/acme/sub/web`,
          reviewsEnabled: true,
          codingEnabled: false,
          askEnabled: true,
          status: { running: 0, problems: expect.any(Array) },
        },
      ]);
    });

    it("stores each added project's default branch, and adds it without one when GitLab can't say", async () => {
      const connectionId = await connectGitLabProjects();

      expect(await addGitLabProjects(connectionId, [101, 102])).toMatchObject({ ok: true });
      const repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
      expect(repos.map((r) => [r.fullPath, r.reviewsEnabled, r.defaultBranch])).toEqual([
        ["acme/api", true, "main"],
        // GET /projects/102 fails: the project is still added, with no default branch.
        ["acme/sub/web", true, null],
      ]);
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

      const result = await addGitLabProjects(connectionId, [101, 102]);
      expect(result).toEqual({
        ok: true,
        added: [{ id: expect.any(String), fullPath: "acme/api" }],
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

    it("doesn't reconnect a removed project that can no longer mint clone tokens", async () => {
      const connectionId = await connectGitLabProjects([101]);
      const [repo] = await state.db.select().from(repositories);
      expect(await disconnectRepository(repo!.id)).toEqual({ ok: true });
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

      expect(await addGitLabProjects(connectionId, [101])).toEqual({
        ok: true,
        added: [],
        warning: expect.stringContaining(
          "acme/api: The GitLab bot token can't create project access tokens",
        ),
      });
      expect(await repoStates()).toEqual([["acme/api", false, false, false, false]]);
      expect(hookRequests).toHaveLength(1);
    });

    it("leaves connected projects the list doesn't show connected", async () => {
      // acme/sub/web is connected but then drops out of the list (e.g. archived).
      const connectionId = await connectGitLabProjects([102]);
      server.use(
        http.get(`${API}/projects`, () =>
          HttpResponse.json([{ ...projects["acme/api"], visibility: "private" }]),
        ),
      );

      expect(await addGitLabProjects(connectionId, [101])).toMatchObject({ ok: true });
      expect(await repoStates()).toEqual([
        ["acme/api", true, true, false, true],
        ["acme/sub/web", true, true, false, true],
      ]);
    });

    it("reconnects a removed project with a new webhook and Coding off", async () => {
      const connectionId = await connectGitLabProjects([101]);
      const [repo] = await state.db.select().from(repositories);
      await saveWorkItemMatch(state.db, {
        organizationId: orgId,
        repositoryId: repo!.id,
        userId: null,
        match: { tracker: "linear", team: "SOC", project: null, withoutProject: false, labels: [] },
      });
      await setRepositorySwitches(state.db, orgId, repo!.id, { coding: true });
      expect(await disconnectRepository(repo!.id)).toEqual({ ok: true });

      expect(await addGitLabProjects(connectionId, [101])).toEqual({
        ok: true,
        added: [{ id: repo!.id, fullPath: "acme/api" }],
      });
      const [reconnected] = await state.db.select().from(repositories);
      expect(reconnected).toMatchObject({
        reviewsEnabled: true,
        askEnabled: true,
        codingEnabled: false,
        disconnectedAt: null,
      });
      expect(reconnected!.webhookId).not.toBe(repo!.webhookId);
      expect(hookRequests).toHaveLength(2);
      // The match went with the removal: Coding can't be turned on again without a new one.
      expect(await listWorkItemMatches(state.db, orgId)).toEqual([]);
    });

    it("reports projects whose webhook GitLab refuses", async () => {
      server.use(
        http.post(`${API}/projects/102/hooks`, () =>
          HttpResponse.json({ message: "403 Forbidden" }, { status: 403 }),
        ),
      );
      const connectionId = await connectGitLabProjects();
      expect(await addGitLabProjects(connectionId, [101, 102])).toEqual({
        ok: true,
        added: [{ id: expect.any(String), fullPath: "acme/api" }],
        warning: expect.stringContaining("acme/sub/web"),
      });
      const repos = await state.db
        .select()
        .from(repositories)
        .where(isNull(repositories.disconnectedAt));
      expect(repos.map((r) => r.fullPath)).toEqual(["acme/api"]);
    });

    it("checks admin in the given organization and refuses another organization's connection", async () => {
      const connectionId = await connectGitLabProjects();
      // An organization the user isn't a member of.
      expect(await addGitLabProjects(connectionId, [101], otherOrgId)).toMatchObject({
        ok: false,
        status: 404,
      });
      // Admin of the other organization, naming it: the connection isn't one of its.
      state.orgId = otherOrgId;
      expect(await addGitLabProjects(connectionId, [101], otherOrgId)).toMatchObject({
        ok: false,
        status: 400,
      });
      state.orgId = orgId;
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await addGitLabProjects(connectionId, [101])).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(hookRequests).toEqual([]);
      expect(await state.db.select().from(repositories)).toEqual([]);
    });

    it("has no PUT that saves a selection (which disabled unselected repos)", () => {
      expect("PUT" in selection).toBe(false);
    });

    it("rejects unknown keys and an empty list", async () => {
      const connectionId = await connectGitLabProjects();
      expect(
        await call(selection.POST, "POST", connectionId, {
          provider: "gitlab",
          ids: [101],
          organizationId: orgId,
          selectedIds: [101],
        }),
      ).toMatchObject({ ok: false, status: 400 });
      expect(await addGitLabProjects(connectionId, [])).toMatchObject({ ok: false, status: 400 });
      expect(hookRequests).toEqual([]);
    });
  });

  describe("listing a connection's repositories for the picker", () => {
    it("marks the connected ones, in the given organization", async () => {
      const connectionId = await connectGitLabProjects([101]);
      const listed = await get(
        selection.GET,
        { provider: "gitlab", organization: orgId },
        connectionId,
      );
      expect(listed.status).toBe(200);
      expect(
        (listed.body.repos as { fullPath: string; connected: boolean }[]).map((r) => [
          r.fullPath,
          r.connected,
        ]),
      ).toEqual([
        ["acme/api", true],
        ["acme/sub/web", false],
      ]);
      // A removed repo isn't connected any more.
      const [repo] = await state.db.select().from(repositories);
      await disconnectRepository(repo!.id);
      const again = await get(selection.GET, { provider: "gitlab" }, connectionId);
      expect((again.body.repos as { connected: boolean }[]).map((r) => r.connected)).toEqual([
        false,
        false,
      ]);
    });

    it("checks admin in the given organization", async () => {
      const connectionId = await connectGitLabProjects();
      expect(
        (await get(selection.GET, { provider: "gitlab", organization: otherOrgId }, connectionId))
          .status,
      ).toBe(404);
      expect(
        (await get(selection.GET, { provider: "gitlab", organization: "not-a-uuid" }, connectionId))
          .status,
      ).toBe(404);
      // The other provider's picker doesn't find it.
      expect((await get(selection.GET, { provider: "github" }, connectionId)).status).toBe(404);
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(
        (await get(selection.GET, { provider: "gitlab", organization: orgId }, connectionId))
          .status,
      ).toBe(403);
      expect(listQueries).toEqual([]);
    });
  });

  describe("listing the organization's connections", () => {
    const at = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const checkedAt = new Date().toISOString();

    async function insertConnection(
      name: string,
      provider: "github" | "gitlab",
      health: unknown,
      organizationId = orgId,
    ) {
      const [row] = await state.db
        .insert(scmConnections)
        .values({
          organizationId,
          provider,
          name,
          baseUrl: provider === "github" ? "https://api.github.com" : GITLAB,
          externalId: `${name}-id`,
          encryptedCredentials: "x",
          health: health as never,
        })
        .returning();
      return row!.id;
    }

    it("lists each connection with its host and health, by name", async () => {
      const github = await insertConnection("a-github", "github", null);
      const notChecked = await insertConnection("b-not-checked", "gitlab", null);
      const healthy = await insertConnection("c-healthy", "gitlab", {
        checkedAt,
        tokenExpiresAt: at(200),
        problems: [],
      });
      const expiring = await insertConnection("d-expiring", "gitlab", {
        checkedAt,
        tokenExpiresAt: at(5),
        problems: [{ code: "token_expiring", message: "Expires soon." }],
      });
      const attention = await insertConnection("e-attention", "gitlab", {
        checkedAt,
        tokenExpiresAt: null,
        problems: [
          {
            code: "webhook_missing",
            message: "The webhook of acme/api is gone.",
            repositoryId: "r1",
          },
          { code: "token_invalid", message: "GitLab refuses the bot token." },
        ],
      });
      await insertConnection("other-org", "gitlab", null, otherOrgId);

      const { status, body } = await get(scmConnectionList.GET, { organization: orgId });
      expect(status).toBe(200);
      expect(body.connections).toEqual([
        {
          id: github,
          provider: "github",
          name: "a-github",
          host: "github.com",
          health: { state: "connected", problems: [] },
        },
        {
          id: notChecked,
          provider: "gitlab",
          name: "b-not-checked",
          host: "gitlab.example.com",
          health: { state: "not_checked", problems: [] },
        },
        {
          id: healthy,
          provider: "gitlab",
          name: "c-healthy",
          host: "gitlab.example.com",
          health: { state: "healthy", expiresAt: expect.any(String), problems: [] },
        },
        {
          id: expiring,
          provider: "gitlab",
          name: "d-expiring",
          host: "gitlab.example.com",
          health: expect.objectContaining({ state: "expiring", expiresAt: expect.any(String) }),
        },
        {
          id: attention,
          provider: "gitlab",
          name: "e-attention",
          host: "gitlab.example.com",
          health: {
            state: "needs_attention",
            problems: [
              {
                code: "webhook_missing",
                sentence: "The webhook of acme/api is gone.",
                repositoryId: "r1",
              },
              { code: "token_invalid", sentence: "GitLab refuses the bot token." },
            ],
          },
        },
      ]);
      // The active organization without the parameter.
      expect((await get(scmConnectionList.GET, {})).body.connections).toHaveLength(5);
    });

    it("is for admins of that organization", async () => {
      await insertConnection("own", "gitlab", null);
      expect((await get(scmConnectionList.GET, { organization: otherOrgId })).status).toBe(404);
      expect((await get(scmConnectionList.GET, { organization: "all" })).status).toBe(404);
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect((await get(scmConnectionList.GET, { organization: orgId })).status).toBe(403);
    });
  });

  describe("the Connect buttons' setup", () => {
    it("is for admins of the given organization", async () => {
      const own = await get(setup.GET, { organization: orgId });
      expect(own).toMatchObject({ status: 200, body: { defaultGitLabUrl: expect.any(String) } });
      expect((await get(setup.GET, { organization: otherOrgId })).status).toBe(404);
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect((await get(setup.GET, {})).status).toBe(403);
    });
  });

  it("connects GitLab to the given organization and publishes the connection", async () => {
    const { result, changes } = await captureChanges(() =>
      connectGitLab({ ...form, organizationId: orgId }),
    );
    expect(result).toEqual(connected);
    const { connectionId } = result as { connectionId: string };
    expect(changes).toContainEqual(
      expect.objectContaining({
        resource: "connection",
        ids: [connectionId],
        organizationId: orgId,
      }),
    );
    // An organization the admin isn't a member of.
    expect(await connectGitLab({ ...form, organizationId: otherOrgId })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect((await state.db.select().from(scmConnections)).map((c) => c.organizationId)).toEqual([
      orgId,
    ]);
  });

  it("removing turns off Reviews, Coding and Ask, deletes the match, pins and webhook, and keeps reviews", async () => {
    await connectGitLabProjects([101]);
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
    await saveWorkItemMatch(state.db, {
      organizationId: orgId,
      repositoryId: repo!.id,
      userId: null,
      match: { tracker: "linear", team: "SOC", project: null, withoutProject: false, labels: [] },
    });
    await setRepositorySwitches(state.db, orgId, repo!.id, { coding: true });

    const { result, changes } = await captureChanges(() => disconnectRepository(repo!.id));
    expect(result).toEqual({ ok: true });
    expect(deletedHooks).toEqual([`101/${repo!.webhookId}`]);
    const [after] = await state.db.select().from(repositories).where(eq(repositories.id, repo!.id));
    expect(after).toMatchObject({
      reviewsEnabled: false,
      codingEnabled: false,
      askEnabled: false,
      webhookId: null,
    });
    expect(after!.disconnectedAt).not.toBeNull();
    expect(await listWorkItemMatches(state.db, orgId)).toEqual([]);
    expect(await state.db.select().from(agentRepoPins)).toEqual([]);
    expect(
      await state.db.select().from(reviews).where(eq(reviews.repositoryId, repo!.id)),
    ).toHaveLength(1);
    // The repo (its detail and the organization's list) and the unpinned agent.
    expect(changes).toContainEqual(
      expect.objectContaining({ resource: "repository", ids: [repo!.id], organizationId: orgId }),
    );
    expect(changes).toContainEqual(expect.objectContaining({ resource: "agent" }));
    // It isn't connected any more.
    expect(await disconnectRepository(repo!.id)).toMatchObject({ ok: false, status: 404 });
    await state.db.delete(agents);
  });

  it("still removes the repo when the webhook can't be deleted, with a warning", async () => {
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
    expect(after).toMatchObject({ reviewsEnabled: false, codingEnabled: false, askEnabled: false });
    expect(after!.disconnectedAt).not.toBeNull();
  });

  it("refuses members", async () => {
    await connectGitLabProjects([101]);
    const [repo] = await state.db.select().from(repositories);
    state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
    expect(await connectGitLab(form)).toEqual({
      ok: false,
      status: 403,
      error: expect.stringContaining("admin"),
    });
    expect(await disconnectRepository(repo!.id)).toMatchObject({ ok: false, status: 403 });
    // An unknown repository is not found, for members too.
    expect(await disconnectRepository("00000000-0000-0000-0000-000000000000")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await recreateGitLabWebhook("00000000-0000-0000-0000-000000000000")).toMatchObject({
      ok: false,
    });
    expect(deletedHooks).toEqual([]);
    expect(await repoStates()).toEqual([["acme/api", true, true, false, true]]);
  });

  it("adds only the given repositories the GitHub installation can access", async () => {
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
      http.get(`${GITHUB}/app/installations/7`, () =>
        HttpResponse.json({
          id: 7,
          account: { login: "acme", type: "Organization" },
          target_type: "Organization",
          repository_selection: "selected",
          html_url: "https://github.com/settings/installations/7",
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

    expect(await addGitHubRepositories(connection!.id, [1, 999])).toEqual({
      ok: true,
      added: [{ id: expect.any(String), fullPath: "acme/one" }],
      warning: expect.stringContaining("can't access one of the repositories"),
    });
    let repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
    // The adapter can't read the default branches here (no GitHub App configured): the
    // repositories are added all the same, without one.
    expect(repos.map((r) => [r.fullPath, r.reviewsEnabled, r.defaultBranch])).toEqual([
      ["acme/one", true, null],
    ]);

    // Add-only: acme/one, with its reviews turned off since, stays as it is.
    await state.db.update(repositories).set({ reviewsEnabled: false });
    expect(await addGitHubRepositories(connection!.id, [2])).toEqual({
      ok: true,
      added: [{ id: expect.any(String), fullPath: "acme/two" }],
    });
    expect(await addGitHubRepositories(connection!.id, [1, 2])).toEqual({ ok: true, added: [] });
    expect(await repoStates()).toEqual([
      ["acme/one", true, false, false, true],
      ["acme/two", true, true, false, true],
    ]);

    // A removed repo comes back with Reviews and Ask on and Coding off.
    repos = await state.db.select().from(repositories).orderBy(repositories.fullPath);
    expect(await disconnectRepository(repos[0]!.id)).toEqual({ ok: true });
    expect(await addGitHubRepositories(connection!.id, [1])).toEqual({
      ok: true,
      added: [{ id: repos[0]!.id, fullPath: "acme/one" }],
    });
    expect(await repoStates()).toEqual([
      ["acme/one", true, true, false, true],
      ["acme/two", true, true, false, true],
    ]);
    const listed = await get(
      selection.GET,
      { provider: "github", organization: orgId },
      connection!.id,
    );
    expect(
      (listed.body.repos as { fullPath: string; connected: boolean }[]).map((r) => r.connected),
    ).toEqual([true, true]);
  });

  it("refuses a GitLab connection that belongs to another organization", async () => {
    await connectGitLabProjects([101]);
    const hooks = hookRequests.length;
    state.orgId = otherOrgId;
    expect(await connectGitLab(form)).toEqual({
      ok: false,
      status: 400,
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
    expect(await disconnectRepository(repo!.id)).toMatchObject({ ok: false, status: 404 });
    expect(await addGitHubRepositories(connection!.id, [1])).toEqual({
      ok: false,
      status: 400,
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

      const { result, changes } = await captureChanges(() => recreateGitLabWebhook(api.id));
      expect(result).toEqual({ ok: true });
      // The repo (its webhook) and the connection (its health) changed.
      expect(changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: "repository",
            ids: [api.id],
            organizationId: state.orgId,
          }),
          expect.objectContaining({
            resource: "connection",
            ids: [connectionId],
            organizationId: state.orgId,
          }),
        ]),
      );

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
        status: 400,
        error: expect.stringContaining("Maintainer"),
      });
      const [after] = await state.db.select().from(repositories).where(eq(repositories.id, api.id));
      expect(after!.webhookId).toBeNull();
      expect((await health(connectionId))!.problems).toHaveLength(3);
    });

    it("refuses members and doesn't touch GitLab", async () => {
      const { connectionId, api } = await withWebhookProblems();
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await recreateGitLabWebhook(api.id)).toMatchObject({
        ok: false,
        error: expect.stringContaining("admin"),
      });
      expect(deletedHooks).toEqual([]);
      expect(hookRequests).toEqual([]);
      expect((await health(connectionId))!.problems).toHaveLength(3);
    });

    it("refuses another organization's project", async () => {
      const { connectionId, api } = await withWebhookProblems();
      state.orgId = otherOrgId;
      const { result, changes } = await captureChanges(() => recreateGitLabWebhook(api.id));
      expect(result).toEqual({ ok: false, status: 404, error: expect.any(String) });
      expect(changes).toEqual([]);
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
        status: 403,
        error: expect.stringContaining("admin"),
      });
      state.user = { id: adminId, role: "admin", name: null, email: null, image: null };
      state.orgId = otherOrgId;
      expect(await removeScmConnection(connection!.id)).toEqual({
        ok: false,
        status: 400,
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
