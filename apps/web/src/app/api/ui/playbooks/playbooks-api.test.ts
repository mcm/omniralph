import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  agents,
  closeDb,
  connectRepository,
  createDb,
  insertPlaybook,
  jobs,
  organizations,
  playbooks,
  repositories,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { CLAUDE_CODE_TOOLS, INSTALL_JOB_TYPE } from "@omniralph/shared";
import {
  AGENT_TOOLS,
  BUILTIN_PLAYBOOKS,
  CUSTOM_PLAYBOOK_ROLES,
  getBuiltinPlaybook,
  TRACKER_TOOLS,
} from "@omniralph/tasks";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import { servedByRouteHandler } from "@/lib/testing/app-routes";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && {
        ...state.user,
        name: null,
        email: null,
        image: null,
        theme: null,
        showAdvanced: false,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const list = await import("./route");
const detail = await import("./[id]/route");
const clone = await import("./[id]/clone/route");
const formOptions = await import("./form-options/route");

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, method: string, id = "", body?: unknown) {
  const response = await handler(
    new Request("http://localhost/api/ui/playbooks", {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: encodeURIComponent(id) }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const getList = () => call(list.GET as Handler, "GET");
const create = (body: unknown) => call(list.POST as Handler, "POST", "", body);
const getOne = (id: string) => call(detail.GET, "GET", id);
const update = (id: string, body: unknown) => call(detail.PUT, "PUT", id, body);
const remove = (id: string) => call(detail.DELETE, "DELETE", id);
const cloneOf = (id: string) => call(clone.POST, "POST", id);
const getFormOptions = () => call(formOptions.GET as Handler, "GET");

/** A custom playbook's input: a copy of built-in `id` without its ID. */
function input(id: string, overrides: Record<string, unknown> = {}) {
  const { id: _id, ...fields } = getBuiltinPlaybook(id)!;
  return { ...fields, name: "Security review", ...overrides };
}

/** The `playbooks` settings change of playbook `id`. */
const playbookEvent = (id: string) =>
  expect.objectContaining({
    resource: "settings",
    section: "playbooks",
    ids: [id],
    subjectId: id,
    organizationId: state.orgId,
  });

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("/api/ui/playbooks", () => {
  let testDb: TestDatabase;
  let db: Database;
  let adminId: string;
  let memberId: string;
  let otherOrgId: string;
  let repoId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    state.orgId = org!.id;
    otherOrgId = other!.id;
    const [admin, member] = await db
      .insert(users)
      .values([
        { id: randomUUID(), email: "admin@acme.test" },
        { id: randomUUID(), email: "member@acme.test" },
      ])
      .returning();
    adminId = admin!.id;
    memberId = member!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: org!.id,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.user = { id: adminId, role: "admin" };
    await db.delete(jobs);
    await db
      .update(repositories)
      .set({
        reviewPlaybookIds: ["builtin:review-pr"],
        correlationPlaybookId: "builtin:correlate-findings",
        storyPlaybookId: "builtin:implement-story",
        requestPlaybookId: "builtin:handle-request",
      })
      .where(eq(repositories.id, repoId));
    await db.delete(playbooks);
  });

  describe("GET", () => {
    it("lists the built-ins, then the organization's own, with role, model and what uses each", async () => {
      state.user = { id: memberId, role: "member" };
      const theirs = await insertPlaybook(db, otherOrgId, {
        name: "Theirs",
        role: "chat-ask",
        definition: input("builtin:ask-about-code"),
        requirements: {},
        createdBy: null,
      });
      state.user = { id: adminId, role: "admin" };
      const created = await create(input("builtin:review-pr"));
      expect(created).toMatchObject({ status: 200, body: { ok: true } });
      const id = created.body.id as string;
      await db
        .update(repositories)
        .set({ reviewPlaybookIds: ["builtin:review-pr", id] })
        .where(eq(repositories.id, repoId));

      state.user = { id: memberId, role: "member" };
      const response = await getList();
      expect(response.status).toBe(200);
      const rows = response.body.playbooks as { id: string; builtin: boolean }[];
      expect(rows.map((row) => [row.id, row.builtin])).toEqual([
        ...BUILTIN_PLAYBOOKS.map((p) => [p.id, true]),
        [id, false],
      ]);
      expect(JSON.stringify(response.body)).not.toContain(theirs.id);
      expect(rows).toContainEqual({
        id,
        name: "Security review",
        description: expect.any(String),
        role: "review",
        builtin: false,
        model: null,
        usedBy: {
          repositories: [
            { id: repoId, fullPath: "acme/api", provider: "github", roles: ["review"] },
          ],
          chatPlaybooks: [],
          chatChannels: [],
          playbooks: [],
        },
      });
      expect(rows).toContainEqual(
        expect.objectContaining({
          id: "builtin:ask-about-code",
          role: "chat-ask",
          model: "claude-sonnet-5-5",
          usedBy: expect.objectContaining({ chatPlaybooks: ["ask"] }),
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          id: "builtin:describe-pr",
          usedBy: expect.objectContaining({
            playbooks: expect.arrayContaining([
              { id: "builtin:implement-story", name: expect.any(String), builtin: true },
            ]),
          }),
        }),
      );
    });

    it("returns one playbook, labelling a null budget No limit, and 404s on another organization's", async () => {
      state.user = { id: memberId, role: "member" };
      const builtin = await getOne("builtin:implement-story");
      expect(builtin).toMatchObject({
        status: 200,
        body: {
          playbook: { id: "builtin:implement-story", role: "story", tokenBudget: null },
          builtin: true,
          tokenBudgetLabel: "No limit",
          requirements: { minAgentVersion: expect.any(String) },
          usedBy: { repositories: [{ id: repoId, roles: ["story"] }] },
        },
      });
      expect((await getOne("builtin:ask-about-code")).body.tokenBudgetLabel).toBe("50,000 tokens");
      expect((await getOne("builtin:review-pr")).body.tokenBudgetLabel).toBe(
        "Set by the review depth",
      );

      const theirs = await insertPlaybook(db, otherOrgId, {
        name: "Theirs",
        role: "chat-ask",
        definition: input("builtin:ask-about-code"),
        requirements: {},
        createdBy: null,
      });
      for (const id of [theirs.id, randomUUID(), "builtin:nope", "not-a-uuid"]) {
        expect(await getOne(id), id).toMatchObject({ status: 404 });
      }
    });
  });

  describe("GET form-options", () => {
    beforeEach(async () => {
      await db.delete(agents);
      const models = (...names: string[]) =>
        names.map((name) => ({ value: `claude-${name}`, displayName: name }));
      await db.insert(agents).values([
        {
          organizationId: state.orgId,
          name: "a-builder",
          reportedModels: models("Opus 5.5", "Sonnet 5.5"),
          reportedInstallables: [{ name: "@omniralph/code-graph", version: "1.0.0" }],
          reportedHostTools: [
            { name: "opengrep", path: "/usr/bin/opengrep", source: "discovered", problem: null },
            // No path: not offered.
            { name: "semgrep", path: null, source: null, problem: "blocked" },
          ],
        },
        {
          organizationId: state.orgId,
          name: "b-builder",
          reportedModels: models("Sonnet 5.5"),
          reportedHostTools: [
            { name: "gh", path: "/opt/gh/bin/gh", source: "configured", problem: null },
            { name: "opengrep", path: "/opt/opengrep", source: "configured", problem: null },
          ],
        },
        {
          organizationId: state.orgId,
          name: "c-revoked",
          revokedAt: new Date(),
          reportedModels: models("Haiku 5.5"),
          reportedHostTools: [
            { name: "revoked-tool", path: "/usr/bin/x", source: "discovered", problem: null },
          ],
        },
        {
          organizationId: otherOrgId,
          name: "theirs",
          reportedModels: models("Fable 5.1"),
          reportedHostTools: [
            { name: "their-tool", path: "/usr/bin/x", source: "discovered", problem: null },
          ],
        },
      ]);
      await db.insert(jobs).values([
        {
          organizationId: state.orgId,
          type: INSTALL_JOB_TYPE,
          taskType: "system",
          status: "completed",
          payload: {},
          result: { name: "@omniralph/code-graph", mcpServers: ["graph", "search"] },
        },
        // Another organization's install says nothing about this one's servers.
        {
          organizationId: otherOrgId,
          type: INSTALL_JOB_TYPE,
          taskType: "system",
          status: "completed",
          payload: {},
          result: { name: "@omniralph/code-graph", mcpServers: ["theirs"] },
        },
      ]);
      await insertPlaybook(db, otherOrgId, {
        name: "Their PR description",
        role: "pr-description",
        definition: input("builtin:describe-pr"),
        requirements: {},
        createdBy: null,
      });
    });

    it("offers the custom roles, the organization's reported models, the tools, MCP servers and host tools", async () => {
      const mine = await insertPlaybook(db, state.orgId, {
        name: "Our PR description",
        role: "pr-description",
        definition: input("builtin:describe-pr"),
        requirements: { installables: [], hostTools: ["trivy", "gh"] },
        createdBy: null,
      });
      const response = await getFormOptions();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        roles: [...CUSTOM_PLAYBOOK_ROLES],
        // Non-revoked agents only, de-duplicated, by display name.
        models: [
          { value: "claude-Opus 5.5", displayName: "Opus 5.5" },
          { value: "claude-Sonnet 5.5", displayName: "Sonnet 5.5" },
        ],
        tools: {
          builtin: [...CLAUDE_CODE_TOOLS],
          agent: [...AGENT_TOOLS],
          tracker: [...TRACKER_TOOLS],
        },
        mcpServers: ["@omniralph/code-graph:graph", "@omniralph/code-graph:search"],
        prDescriptionPlaybooks: [
          expect.objectContaining({ id: "builtin:describe-pr", builtin: true }),
          { id: mine.id, name: "Our PR description", builtin: false },
        ],
        // Reported with a path by non-revoked agents, or required by a playbook: sorted, once each.
        hostTools: ["gh", "opengrep", "trivy"],
      });
      const roles = response.body.roles as string[];
      for (const builtinOnly of ["triage", "learn-rule", "reply-to-finding"]) {
        expect(roles).not.toContain(builtinOnly);
      }
      const json = JSON.stringify(response.body);
      for (const marker of [
        "Fable 5.1",
        "Haiku 5.5",
        "theirs",
        "Their PR description",
        "their-tool",
        "revoked-tool",
      ]) {
        expect(json).not.toContain(marker);
      }
    });

    it("is admin-only", async () => {
      state.user = { id: memberId, role: "member" };
      expect((await getFormOptions()).status).toBe(403);
    });
  });

  describe("writes", () => {
    it("are admin-only", async () => {
      const row = await insertPlaybook(db, state.orgId, {
        name: "Mine",
        role: "chat-ask",
        definition: input("builtin:ask-about-code"),
        requirements: {},
        createdBy: null,
      });
      state.user = { id: memberId, role: "member" };
      const { result, changes } = await captureChanges(async () => [
        await create(input("builtin:review-pr")),
        await update(row.id, input("builtin:ask-about-code", { name: "Renamed" })),
        await remove(row.id),
        await cloneOf(row.id),
      ]);
      for (const response of result) expect(response.status).toBe(403);
      expect(changes).toEqual([]);
      expect(await db.select().from(playbooks)).toHaveLength(1);
    });

    it("creates a playbook with its requirements, publishing its change event", async () => {
      const { result, changes } = await captureChanges(() =>
        create(input("builtin:ask-about-code", { requires: { hostTools: ["opengrep"] } })),
      );
      expect(result).toMatchObject({
        status: 200,
        body: {
          ok: true,
          id: expect.any(String),
          detail: { builtin: false, playbook: { name: "Security review", role: "chat-ask" } },
          summary: { name: "Security review", role: "chat-ask", builtin: false },
        },
      });
      const id = result.body.id as string;
      expect(changes).toEqual([playbookEvent(id)]);
      const [row] = await db.select().from(playbooks).where(eq(playbooks.id, id));
      expect(row).toMatchObject({
        organizationId: state.orgId,
        name: "Security review",
        role: "chat-ask",
        createdBy: adminId,
        requirements: expect.objectContaining({ hostTools: ["opengrep"] }),
      });
      expect(row!.definition).not.toHaveProperty("id");
      expect(row!.definition).not.toHaveProperty("role");
    });

    it("refuses an invalid playbook with field errors, saving nothing", async () => {
      const { result, changes } = await captureChanges(async () => [
        await create(input("builtin:review-pr", { model: "claude-opus-5-5" })),
        await create(input("builtin:triage")),
        await create({ ...input("builtin:ask-about-code"), sink: "chat-thread" }),
        await create("not an object"),
      ]);
      expect(result.map((r) => r.status)).toEqual([400, 400, 400, 400]);
      expect(result[0]!.body.fieldErrors).toEqual({ model: expect.stringContaining("depth") });
      expect(result[1]!.body.fieldErrors).toEqual({ role: expect.stringContaining("built-in") });
      expect(result[2]!.body.fieldErrors).toEqual({ sink: expect.any(String) });
      expect(changes).toEqual([]);
      expect(await db.select().from(playbooks)).toEqual([]);
    });

    it("updates a custom playbook, publishing its change event", async () => {
      const id = (await create(input("builtin:ask-about-code"))).body.id as string;
      const { result, changes } = await captureChanges(() =>
        update(id, input("builtin:ask-about-code", { name: "Renamed", model: "claude-opus-5-5" })),
      );
      // The answer carries the saved detail and list row, for the views' caches.
      expect(result).toEqual({
        status: 200,
        body: { ok: true, id, detail: (await getOne(id)).body, summary: expect.any(Object) },
      });
      expect(result.body.summary).toEqual(
        ((await getList()).body.playbooks as { id: string }[]).find((row) => row.id === id),
      );
      expect(changes).toEqual([playbookEvent(id)]);
      expect((await getOne(id)).body.playbook).toMatchObject({
        id,
        name: "Renamed",
        model: "claude-opus-5-5",
      });
    });

    it("clones a built-in or custom playbook, publishing the copy's change event", async () => {
      const { result, changes } = await captureChanges(() => cloneOf("builtin:review-pr"));
      expect(result).toMatchObject({ status: 200, body: { ok: true } });
      const id = result.body.id as string;
      expect(result.body.detail).toEqual((await getOne(id)).body);
      expect(result.body.summary).toMatchObject({ id, name: "Review a pull request copy" });
      expect(changes).toEqual([playbookEvent(id)]);
      expect((await getOne(id)).body).toMatchObject({
        builtin: false,
        playbook: {
          id,
          role: "review",
          promptTemplate: getBuiltinPlaybook("builtin:review-pr")!.promptTemplate,
        },
      });
      expect((await getOne(id)).body.playbook).toMatchObject({
        name: `${getBuiltinPlaybook("builtin:review-pr")!.name} copy`,
      });
      expect(await cloneOf(id)).toMatchObject({ status: 200, body: { ok: true } });
      // Built-in-only roles can't be copied.
      expect(await cloneOf("builtin:triage")).toMatchObject({ status: 400 });
      expect(await cloneOf(randomUUID())).toMatchObject({ status: 404 });
    });

    it("refuses to edit or delete a built-in", async () => {
      const { result, changes } = await captureChanges(async () => [
        await update("builtin:review-pr", input("builtin:review-pr")),
        await remove("builtin:review-pr"),
      ]);
      for (const response of result) {
        expect(response).toMatchObject({
          status: 409,
          body: {
            code: "builtin_read_only",
            error: "Built-in playbooks can't be changed; clone one to make your own.",
          },
        });
      }
      expect(changes).toEqual([]);
    });

    it("404s on another organization's playbook", async () => {
      const theirs = await insertPlaybook(db, otherOrgId, {
        name: "Theirs",
        role: "chat-ask",
        definition: input("builtin:ask-about-code"),
        requirements: {},
        createdBy: null,
      });
      for (const response of [
        await update(theirs.id, input("builtin:ask-about-code")),
        await remove(theirs.id),
        await cloneOf(theirs.id),
      ]) {
        expect(response.status).toBe(404);
      }
      const [row] = await db.select().from(playbooks).where(eq(playbooks.id, theirs.id));
      expect(row!.name).toBe("Theirs");
    });

    it("refuses a role change while a repo binds the playbook", async () => {
      const id = (await create(input("builtin:summarize-pr"))).body.id as string;
      await db
        .update(repositories)
        .set({ reviewPlaybookIds: [id] })
        .where(eq(repositories.id, repoId));
      const response = await update(id, input("builtin:ask-about-code"));
      expect(response).toMatchObject({
        status: 400,
        body: { fieldErrors: { role: expect.stringContaining("repo acme/api (review)") } },
      });
      // The same role is fine.
      expect(await update(id, input("builtin:summarize-pr", { name: "Renamed" }))).toMatchObject({
        status: 200,
        body: { ok: true, id, summary: { name: "Renamed", role: "review-summary" } },
      });
    });

    it("deletes an unused custom playbook, publishing its change event", async () => {
      const id = (await create(input("builtin:ask-about-code"))).body.id as string;
      const { result, changes } = await captureChanges(() => remove(id));
      expect(result).toEqual({ status: 200, body: { ok: true } });
      expect(changes).toEqual([playbookEvent(id)]);
      expect(await getOne(id)).toMatchObject({ status: 404 });
    });

    it("refuses to delete a playbook a repo binding or a queued or running job uses", async () => {
      const id = (await create(input("builtin:implement-story"))).body.id as string;
      await db.update(repositories).set({ storyPlaybookId: id }).where(eq(repositories.id, repoId));
      expect(await remove(id)).toMatchObject({
        status: 409,
        body: {
          code: "playbook_in_use",
          error: "Security review can't be deleted while it's used by repo acme/api (story).",
        },
      });

      await db
        .update(repositories)
        .set({ storyPlaybookId: "builtin:implement-story" })
        .where(eq(repositories.id, repoId));
      await db.insert(jobs).values({
        organizationId: state.orgId,
        type: "ralph.story",
        taskType: "coding",
        taskId: id,
        status: "running",
      });
      const { result, changes } = await captureChanges(() => remove(id));
      expect(result).toMatchObject({
        status: 409,
        body: {
          code: "playbook_in_use",
          error: "Security review can't be deleted while a run of it is queued or running.",
        },
      });
      expect(changes).toEqual([]);
      expect((await getOne(id)).status).toBe(200);

      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.taskId, id));
      expect(await remove(id)).toEqual({ status: 200, body: { ok: true } });
    });
  });
});

describe("/api/ui/agents", () => {
  const APP = join(__dirname, "../../..");
  const REMOVED = ["/api/ui/agents/form-options", "/api/ui/agents/x/clone", "/api/ui/tasks"];

  it("serves the agents (machines), not the definitions playbooks replaced", () => {
    expect(servedByRouteHandler("/api/ui/playbooks")).toBe(true);
    expect(servedByRouteHandler("/api/ui/playbooks/builtin%3Areview-pr/clone")).toBe(true);
    expect(servedByRouteHandler("/api/ui/agents")).toBe(true);
    for (const path of [
      "/api/ui/agents/x/clone",
      "/api/ui/agents/builtin%3Areview-pr/clone",
      "/api/ui/tasks",
      "/api/ui/tasks/form-options",
    ]) {
      expect(servedByRouteHandler(path), path).toBe(false);
    }
    // `form-options` would be read as an agent ID: no definition handler is left under it.
    expect(readdirSync(join(__dirname, "../agents")).sort()).toEqual([
      "[id]",
      "agents-api.test.ts",
      "fleet-api.test.ts",
      "organization-isolation.test.ts",
      "route.ts",
    ]);
  });

  it("has no client code, test or doc calling the definition routes", () => {
    const root = join(APP, "../../../..");
    const files = [
      ...walk(join(root, "apps/web/src")),
      ...walk(join(root, "apps/web/e2e")),
      ...walk(join(root, "apps/web/scripts")),
      ...walk(join(root, "docs")),
    ].filter((file) => file !== __filename);
    const callers = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return REMOVED.some((path) => text.includes(path));
    });
    expect(callers).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx?|mjs|md)$/.test(name) ? [path] : [];
  });
}
