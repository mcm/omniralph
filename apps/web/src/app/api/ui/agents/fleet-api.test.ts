// Fleet's reads: `GET /api/ui/agents` (rows and summary, by organization scope) and
// `GET /api/ui/agents/{id}` (running now, recent work, security), over agents in every
// state across two organizations.
import { randomBytes, randomUUID } from "node:crypto";
import {
  agentAudit,
  agentRepoPins,
  agents,
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  jobs,
  organizationMembers,
  ralphRuns,
  ralphStories,
  setActiveOrganization,
  setDesiredAgentVersion,
  TRACK_LATEST_AGENT_VERSION,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  agentDetailSchema,
  agentListSchema,
  type AgentDetail,
  type AgentList,
} from "@/lib/api/agents";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
// The signed-in user with their real role in their active organization.
vi.mock("@/lib/auth/session", async () => {
  const { getActiveOrganization } = await import("@omniralph/db");
  const current = async (role: Role) => {
    const active = state.userId ? await getActiveOrganization(state.db, state.userId) : null;
    return assertRole(
      state.userId === null
        ? null
        : {
            id: state.userId,
            organization: active ? { id: active.id, name: active.name } : null,
            role: active?.role ?? null,
            name: null,
            email: null,
            image: null,
            theme: null,
            showAdvanced: false,
          },
      role,
    );
  };
  return {
    requireUser: async (role: Role = "member") => current(role),
    requirePageUser: async (role: Role = "member") => current(role),
  };
});
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => "2.1.0",
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const listRoute = await import("@/app/api/ui/agents/route");
const defaultsRoute = await import("@/app/api/ui/agent-defaults/route");
const detailRoute = await import("@/app/api/ui/agents/[id]/route");
const revokeRoute = await import("@/app/api/ui/agents/[id]/revoke/route");
const installsRoute = await import("@/app/api/ui/agents/[id]/installs/route");

async function list(organization?: string) {
  const query = organization ? `?organization=${organization}` : "";
  const response = await listRoute.GET(new Request(`http://localhost/api/ui/agents${query}`), {
    params: Promise.resolve({}),
  });
  const body = (await response.json()) as AgentList;
  if (response.ok) agentListSchema.parse(body);
  return { status: response.status, body };
}

async function detail(id: string) {
  const response = await detailRoute.GET(new Request(`http://localhost/api/ui/agents/${id}`), {
    params: Promise.resolve({ id }),
  });
  const body = (await response.json()) as AgentDetail;
  if (response.ok) agentDetailSchema.parse(body);
  return { status: response.status, body };
}

/** The ⋯ menu's actions on one agent: install a package, revoke, remove. */
async function act(action: "install" | "revoke" | "remove", id: string) {
  const params = { params: Promise.resolve({ id }) };
  const url = `http://localhost/api/ui/agents/${id}`;
  const response =
    action === "install"
      ? await installsRoute.POST(
          new Request(`${url}/installs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "ripgrep" }),
          }),
          params,
        )
      : action === "revoke"
        ? await revokeRoute.POST(new Request(`${url}/revoke`, { method: "POST" }), params)
        : await detailRoute.DELETE(new Request(url, { method: "DELETE" }), params);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The paths of every field named `type` in a schema (`[]` for an array's element). */
function typePaths(schema: z.ZodType, path = ""): string[] {
  const def = (schema as unknown as { def: Record<string, unknown> }).def;
  switch (def.type) {
    case "object":
      return Object.entries(def.shape as Record<string, z.ZodType>).flatMap(([key, value]) => [
        ...(key === "type" ? [`${path}.type`] : []),
        ...typePaths(value, `${path}.${key}`),
      ]);
    case "array":
      return typePaths(def.element as z.ZodType, `${path}[]`);
    case "nullable":
    case "optional":
      return typePaths(def.innerType as z.ZodType, path);
    case "record":
      return typePaths(def.valueType as z.ZodType, `${path}{}`);
    default:
      return [];
  }
}

/** Every string in `value` that isn't under a `type` key, with its path. */
function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      key === "type" ? [] : strings(item, `${path}.${key}`),
    );
  }
  return [];
}

const RAW_JOB_TYPES = ["worktree.cleanup", "repo.sync", "ralph.story", "install"];
function expectNoRawJobType(body: unknown) {
  for (const [path, text] of strings(body)) {
    for (const type of RAW_JOB_TYPES) {
      const raw = type.includes(".") ? text.includes(type) : text === type;
      expect(raw, `${path}: ${text}`).toBe(false);
    }
  }
}

const databaseAvailable = testDatabaseAvailable();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;

describe.skipIf(!databaseAvailable)("Fleet API", () => {
  let testDb: TestDatabase;
  let db: Database;
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ids: Record<string, string> = {};
  let alpha: { id: string; adminId: string; memberId: string; repoIds: string[] };
  let beta: { id: string; adminId: string };
  const bothId = "both-member";
  let epicId: string;
  const storyIds: string[] = [];

  async function agent(
    name: string,
    organizationId: string,
    values: Partial<typeof agents.$inferInsert>,
  ) {
    const [row] = await db
      .insert(agents)
      .values({ organizationId, name, ...values })
      .returning();
    ids[name] = row!.id;
    return row!.id;
  }

  async function job(values: Partial<typeof jobs.$inferInsert> & { type: string }) {
    const [row] = await db
      .insert(jobs)
      .values({ organizationId: alpha.id, taskType: "system", payload: {}, ...values })
      .returning();
    return row!.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values([
      { id: "alpha-admin", email: "admin@alpha.io" },
      { id: "alpha-member", email: "member@alpha.io" },
      { id: "beta-admin", email: "admin@beta.io" },
      { id: bothId, email: "both@alpha.io" },
    ]);
    const alphaOrg = await createOrganization(db, { name: "Alpha", createdBy: "alpha-admin" });
    const betaOrg = await createOrganization(db, { name: "Beta", createdBy: "beta-admin" });
    await db.insert(organizationMembers).values([
      { organizationId: alphaOrg.id, userId: "alpha-member", role: "member" },
      { organizationId: alphaOrg.id, userId: bothId, role: "member" },
      { organizationId: betaOrg.id, userId: bothId, role: "admin" },
    ]);
    await setActiveOrganization(db, { userId: "alpha-member", organizationId: alphaOrg.id });
    await setActiveOrganization(db, { userId: bothId, organizationId: alphaOrg.id });

    const connection = (await upsertScmConnection(db, {
      organizationId: alphaOrg.id,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    const repoIds: string[] = [];
    for (const name of ["api", "billing", "docs", "portal", "web"]) {
      repoIds.push(
        (
          await connectRepository(db, {
            connectionId: connection.id,
            provider: "gitlab",
            externalId: name,
            fullPath: `acme/${name}`,
          })
        ).id,
      );
    }
    alpha = { id: alphaOrg.id, adminId: "alpha-admin", memberId: "alpha-member", repoIds };
    beta = { id: betaOrg.id, adminId: "beta-admin" };
    await setDesiredAgentVersion(db, alpha.id, "2.0.3", null);
    await setDesiredAgentVersion(db, beta.id, TRACK_LATEST_AGENT_VERSION, null);

    const tokenRefresh = {
      failingSince: ago(2 * MINUTE).toISOString(),
      consecutiveFailures: 3,
      lastError: "network",
      accessTokenExpiresAt: ago(-MINUTE).toISOString(),
      refreshTokenExpiresAt: null,
    };
    const online = {
      liveOnline: true,
      lastHeartbeatAt: ago(10_000),
      selfUpdate: "supported" as const,
    };
    await agent("a-running", alpha.id, {
      ...online,
      reportedVersion: "2.0.3",
      reportedMaxConcurrency: 4,
      reportedHost: { hostname: "coder-ws", coder: { owner: "steve", workspace: "omniralph" } },
    });
    await agent("b-idle", alpha.id, {
      ...online,
      reportedVersion: "2.0.3",
      reportedAcceptedTaskTypes: ["review"],
      reportedModels: [{ value: "claude-opus-5-5", displayName: "Opus 5.5" }],
      reportedInstallables: [{ name: "gh", version: "2.0.0" }],
      reportedHost: { hostname: "build-01", coder: null },
      reportedTokenRefresh: tokenRefresh,
    });
    await agent("c-offline", alpha.id, {
      liveOnline: false,
      lastHeartbeatAt: ago(3 * DAY + MINUTE),
      reportedVersion: "2.0.3",
    });
    await agent("d-never", alpha.id, {});
    await agent("e-revoked", alpha.id, {
      lastHeartbeatAt: ago(DAY),
      revokedAt: ago(DAY),
      reportedVersion: "2.0.3",
    });
    await agent("f-failed", alpha.id, {
      ...online,
      reportedVersion: "2.0.2",
      failedVersions: ["2.0.3"],
    });
    await agent("z-beta", beta.id, { ...online, reportedVersion: "2.1.0" });

    await db
      .insert(agentRepoPins)
      .values(repoIds.map((repositoryId) => ({ agentId: ids["b-idle"]!, repositoryId })));
    await db
      .insert(agentRepoPins)
      .values({ agentId: ids["a-running"]!, repositoryId: repoIds[0]! });

    // An epic of three stories: a-running builds the second.
    epicId = randomUUID();
    await db.insert(ralphRuns).values({
      id: epicId,
      organizationId: alpha.id,
      linearIssueId: "issue-epic",
      linearIdentifier: "SOC-1700",
      linearTitle: "Billing exports",
      linearUrl: "https://linear.app/acme/issue/SOC-1700/billing-exports",
      linearAgentSessionId: "session-epic",
      kind: "children",
      repositoryId: repoIds[1],
      status: "running",
    });
    for (const [position, identifier] of ["SOC-1719", "SOC-1720", "SOC-1721"].entries()) {
      const [story] = await db
        .insert(ralphStories)
        .values({
          runId: epicId,
          linearIssueId: `issue-${identifier}`,
          identifier,
          title: `Story ${identifier}`,
          position,
        })
        .returning();
      storyIds.push(story!.id);
    }
    await job({
      type: "ralph.story",
      taskType: "coding",
      status: "running",
      agentId: ids["a-running"],
      ralphRunId: epicId,
      ralphStoryId: storyIds[1],
      repositoryId: repoIds[1],
      startedAt: ago(5 * MINUTE),
    });

    // b-idle's history: 12 finished attempts (only the last 10 show), and one still queued.
    const finished = (
      minutes: number,
      values: Partial<typeof jobs.$inferInsert> & { type: string },
    ) =>
      job({
        agentId: ids["b-idle"],
        startedAt: ago(minutes * MINUTE + 90_000),
        finishedAt: ago(minutes * MINUTE),
        ...values,
      });
    for (let i = 0; i < 8; i++) {
      await finished(100 + i, { type: "repo.sync", status: "completed", repositoryId: repoIds[2] });
    }
    await finished(4, {
      type: "ralph.story",
      taskType: "coding",
      status: "completed",
      ralphRunId: epicId,
      ralphStoryId: storyIds[0],
      repositoryId: repoIds[1],
    });
    await finished(3, { type: "install", status: "completed", payload: { name: "gh" } });
    await finished(2, {
      type: "repo.sync",
      status: "failed",
      error: "clone failed",
      repositoryId: repoIds[2],
    });
    await finished(1, {
      type: "worktree.cleanup",
      status: "completed",
      payload: { identifier: "SOC-1719" },
      ralphRunId: epicId,
      ralphStoryId: storyIds[0],
    });
    await job({ type: "repo.sync", status: "queued", agentId: null, targetAgentId: ids["b-idle"] });
    // b-idle's installs: one queued, one failed today, one failed two days ago.
    await job({
      type: "install",
      status: "queued",
      agentId: null,
      targetAgentId: ids["b-idle"],
      payload: { name: "ripgrep" },
      createdAt: ago(MINUTE),
    });
    await job({
      type: "install",
      status: "failed",
      agentId: ids["b-idle"],
      targetAgentId: ids["b-idle"],
      payload: { name: "jq" },
      error: "Not on the allow-list",
      createdAt: ago(5 * HOUR),
      startedAt: ago(5 * HOUR),
      finishedAt: ago(5 * HOUR),
    });
    await job({
      type: "install",
      status: "failed",
      agentId: ids["b-idle"],
      targetAgentId: ids["b-idle"],
      payload: { name: "yq" },
      error: "Not on the allow-list",
      createdAt: ago(2 * DAY),
      startedAt: ago(2 * DAY),
      finishedAt: ago(2 * DAY),
    });

    await db.insert(agentAudit).values([
      { agentId: ids["b-idle"], event: "token_refresh", createdAt: ago(40 * DAY) },
      { agentId: ids["b-idle"], event: "token_refresh", createdAt: ago(2 * MINUTE) },
      { agentId: ids["b-idle"], event: "refresh_reuse", createdAt: ago(DAY) },
      // The latest refresh rejection is the newest auth_failed row on /api/agent/token, at
      // any age: not the newer failure on another path.
      {
        agentId: ids["b-idle"],
        event: "auth_failed",
        detail: { reason: "agent_revoked", path: "/api/agent/heartbeat" },
        createdAt: ago(2 * DAY),
      },
      {
        agentId: ids["b-idle"],
        event: "auth_failed",
        detail: { reason: "refresh_expired", path: "/api/agent/token" },
        createdAt: ago(40 * DAY),
      },
      {
        agentId: ids["b-idle"],
        event: "auth_failed",
        detail: { reason: "refresh_wrong_typ", path: "/api/agent/token" },
        createdAt: ago(41 * DAY),
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("lists the organization's agents with their organization, status, host and pins", async () => {
    state.userId = alpha.memberId;
    const { status, body } = await list();
    expect(status).toBe(200);
    const organization = { id: alpha.id, name: "Alpha", role: "member" };
    expect(body.agents.map((a) => [a.name, a.status.label, a.online])).toEqual([
      ["a-running", "Running 1 of 4", true],
      ["b-idle", "Idle", true],
      ["c-offline", "Offline 3d", false],
      ["d-never", "Never connected", false],
      ["f-failed", "Update failed", true],
      ["e-revoked", "Revoked", false],
    ]);
    expect(body.agents.map((a) => a.status.tone)).toEqual([
      "run",
      "good",
      "fail",
      "neutral",
      "fail",
      "neutral",
    ]);
    for (const row of body.agents) expect(row.organization).toEqual(organization);
    const byName = Object.fromEntries(body.agents.map((a) => [a.name, a]));
    expect(byName["a-running"]).toMatchObject({
      id: ids["a-running"],
      runningCount: 1,
      slots: { running: 1, max: 4 },
      version: "2.0.3",
      host: { hostname: "coder-ws", coder: { owner: "steve", workspace: "omniralph" } },
      lastHeartbeatAt: ago(10_000).toISOString(),
      pinnedRepositories: [expect.objectContaining({ provider: "gitlab", fullPath: "acme/api" })],
    });
    expect(byName["b-idle"]!.pinnedRepositories.map((p) => p.fullPath)).toEqual([
      "acme/api",
      "acme/billing",
      "acme/docs",
      "acme/portal",
      "acme/web",
    ]);
    expect(byName["b-idle"]).toMatchObject({ runningCount: 0, host: { hostname: "build-01" } });
    expect(byName["d-never"]).toMatchObject({ host: null, lastHeartbeatAt: null, version: null });
    expect(body.agents.some((a) => a.id === ids["z-beta"])).toBe(false);
    expectNoRawJobType(body);
  });

  it("summarizes the organization's non-revoked agents", async () => {
    state.userId = alpha.adminId;
    for (const organization of [undefined, alpha.id]) {
      const { body } = await list(organization);
      expect(body.summary).toEqual({
        total: 5,
        online: 3,
        offline: 2,
        busy: 1,
        versionPolicy: { mode: "pinned", version: "2.0.3", target: "2.0.3" },
        versions: { onTarget: 2, behind: 0, pinned: 0, updateFailed: 1 },
        acceptedKinds: { limited: 1, total: 5 },
      });
    }
  });

  it("lists every membership's agents under all organizations, with each organization's role", async () => {
    state.userId = bothId;
    const { status, body } = await list("all");
    expect(status).toBe(200);
    expect(body.agents.map((a) => [a.name, a.organization.name, a.organization.role])).toEqual([
      ["a-running", "Alpha", "member"],
      ["b-idle", "Alpha", "member"],
      ["c-offline", "Alpha", "member"],
      ["d-never", "Alpha", "member"],
      ["f-failed", "Alpha", "member"],
      ["e-revoked", "Alpha", "member"],
      ["z-beta", "Beta", "admin"],
    ]);
    // Different policies: the cell reads "Varies by organization".
    expect(body.summary).toEqual({
      total: 6,
      online: 4,
      offline: 2,
      busy: 1,
      versionPolicy: null,
      versions: { onTarget: 3, behind: 0, pinned: 0, updateFailed: 1 },
      acceptedKinds: { limited: 1, total: 6 },
    });
    // One organization of the two.
    const betaOnly = await list(beta.id);
    expect(betaOnly.body.agents.map((a) => a.name)).toEqual(["z-beta"]);
    expect(betaOnly.body.summary.versionPolicy).toEqual({
      mode: "latest",
      version: null,
      target: "2.1.0",
    });

    // The same policy everywhere is shared; z-beta is then behind it.
    await setDesiredAgentVersion(db, beta.id, "2.0.3", null);
    try {
      const same = await list("all");
      expect(same.body.summary.versionPolicy).toEqual({
        mode: "pinned",
        version: "2.0.3",
        target: "2.0.3",
      });
      expect(same.body.summary.versions).toEqual({
        onTarget: 2,
        behind: 1,
        pinned: 0,
        updateFailed: 1,
      });

      // Pinned on the agent: on its own target, never behind.
      await db
        .update(agents)
        .set({ reportedVersionPin: "2.0.9" })
        .where(eq(agents.id, ids["z-beta"]!));
      const pinned = await list("all");
      expect(pinned.body.summary.versions).toEqual({
        onTarget: 2,
        behind: 0,
        pinned: 1,
        updateFailed: 1,
      });
      expect(pinned.body.agents.find((a) => a.name === "z-beta")).toMatchObject({
        versionPin: "2.0.9",
        desiredVersion: "2.0.9",
        tracksLatest: false,
      });
    } finally {
      await db
        .update(agents)
        .set({ reportedVersionPin: null })
        .where(eq(agents.id, ids["z-beta"]!));
      await setDesiredAgentVersion(db, beta.id, TRACK_LATEST_AGENT_VERSION, null);
    }
  });

  it("answers 404 for an organization outside the user's memberships", async () => {
    state.userId = beta.adminId;
    expect((await list(alpha.id)).status).toBe(404);
    expect((await list(randomUUID())).status).toBe(404);
    expect((await list("not-an-id")).status).toBe(404);
    const all = await list("all");
    expect(all.body.agents.map((a) => a.name)).toEqual(["z-beta"]);
  });

  it("shows a member what an agent runs now, its recent work and its security", async () => {
    state.userId = alpha.memberId;
    const running = await detail(ids["a-running"]!);
    expect(running.status).toBe(200);
    expect(running.body.agent).toMatchObject({
      id: ids["a-running"],
      organization: { id: alpha.id, name: "Alpha", role: "member" },
      status: { kind: "running", label: "Running 1 of 4" },
    });
    expect(running.body.runningNow).toEqual([
      {
        id: expect.any(String),
        type: "ralph.story",
        label: "Building SOC-1720",
        run: { id: epicId, kind: "epic", title: "Billing exports" },
        repository: { id: alpha.repoIds[1], provider: "gitlab", fullPath: "acme/billing" },
        workItem: {
          id: "linear-issue-epic",
          tracker: "linear",
          identifier: "SOC-1700",
          url: "https://linear.app/acme/issue/SOC-1700/billing-exports",
        },
        step: "Story 2 of 3",
        startedAt: ago(5 * MINUTE).toISOString(),
      },
    ]);

    const idle = await detail(ids["b-idle"]!);
    expect(idle.status).toBe(200);
    expect(idle.body.runningNow).toEqual([]);
    expect(idle.body.recentWork).toHaveLength(10);
    expect(idle.body.recentWork.slice(0, 5)).toEqual([
      {
        id: expect.any(String),
        type: "worktree.cleanup",
        label: "Cleaned up the SOC-1719 worktree",
        status: "completed",
        durationMs: 90_000,
        finishedAt: ago(MINUTE).toISOString(),
        run: { id: epicId, kind: "epic", title: "Billing exports" },
      },
      expect.objectContaining({
        type: "repo.sync",
        label: "Couldn't sync docs",
        status: "failed",
        run: null,
      }),
      expect.objectContaining({ type: "install", label: "Installed gh", run: null }),
      expect.objectContaining({
        type: "ralph.story",
        label: "Built SOC-1719",
        run: expect.objectContaining({ id: epicId }),
      }),
      expect.objectContaining({ type: "repo.sync", label: "Synced docs" }),
    ]);
    expect(idle.body.models).toEqual([{ value: "claude-opus-5-5", displayName: "Opus 5.5" }]);
    expect(idle.body.installables).toEqual([{ name: "gh", version: "2.0.0" }]);
    expect(idle.body.installs).toEqual([
      {
        id: expect.any(String),
        name: "ripgrep",
        state: "installing",
        error: null,
        createdAt: ago(MINUTE).toISOString(),
      },
      {
        id: expect.any(String),
        name: "jq",
        state: "failed",
        error: "Not on the allow-list",
        createdAt: ago(5 * HOUR).toISOString(),
      },
    ]);
    expect(idle.body.security).toEqual({
      reuseAlerts30d: 1,
      lastReuseAt: ago(DAY).toISOString(),
      lastRefreshRejection: { at: ago(40 * DAY).toISOString(), reason: "refresh_expired" },
      tokenRefresh: {
        failingSince: ago(2 * MINUTE).toISOString(),
        consecutiveFailures: 3,
        lastError: "network",
        accessTokenExpiresAt: ago(-MINUTE).toISOString(),
        refreshTokenExpiresAt: null,
      },
    });
    // Newest first (the two 40-day-old events tie).
    expect(idle.body.audit.map((a) => a.event).slice(0, 3)).toEqual([
      "token_refresh",
      "refresh_reuse",
      "auth_failed",
    ]);
    expect(idle.body.audit).toHaveLength(6);
    expect(idle.body.audit.every((entry) => entry.actor === null)).toBe(true);

    const never = await detail(ids["d-never"]!);
    expect(never.body).toMatchObject({
      runningNow: [],
      recentWork: [],
      installs: [],
      security: {
        reuseAlerts30d: 0,
        lastReuseAt: null,
        lastRefreshRejection: null,
        tokenRefresh: null,
      },
    });
  });

  it("keeps raw job types in `type` fields only", async () => {
    expect(typePaths(agentDetailSchema).sort()).toEqual([
      ".agent.runningJobs[].type",
      ".recentWork[].type",
      ".runningNow[].type",
    ]);
    expect(typePaths(agentListSchema)).toEqual([".agents[].runningJobs[].type"]);
    state.userId = alpha.memberId;
    for (const name of ["a-running", "b-idle"]) {
      const { body } = await detail(ids[name]!);
      expectNoRawJobType(body);
    }
  });

  it("reads an agent of any membership, and 404s for others' and unknown agents", async () => {
    // A member of both organizations, working in Alpha, reads Beta's agent without switching.
    state.userId = bothId;
    const theirs = await detail(ids["z-beta"]!);
    expect(theirs.status).toBe(200);
    expect(theirs.body.agent.organization).toEqual({ id: beta.id, name: "Beta", role: "admin" });

    state.userId = beta.adminId;
    for (const id of [ids["b-idle"]!, randomUUID(), "not-an-id"]) {
      const { status, body } = await detail(id);
      expect(status).toBe(404);
      expect(JSON.stringify(body)).not.toContain("b-idle");
    }

    // A deleted agent is gone.
    state.userId = alpha.adminId;
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, ids["e-revoked"]!));
    expect((await detail(ids["e-revoked"]!)).status).toBe(404);
  });

  it("carries the version policy's latest change with one organization in scope", async () => {
    const putVersion = async (version: string) => {
      const response = await defaultsRoute.PUT(
        new Request("http://localhost/api/ui/agent-defaults", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version }),
        }),
        { params: Promise.resolve({}) },
      );
      return { status: response.status, body: (await response.json()) as unknown };
    };
    state.userId = alpha.adminId;
    expect((await list(alpha.id)).body.versionHistory).toBeNull();

    // An admin pins Alpha to 2.0.4 from Fleet: the answer carries the policy it set.
    expect(await putVersion("2.0.4")).toEqual({
      status: 200,
      body: { ok: true, versionPolicy: { mode: "pinned", version: "2.0.4", target: "2.0.4" } },
    });
    try {
      for (const userId of [alpha.adminId, alpha.memberId]) {
        state.userId = userId;
        const { body } = await list(alpha.id);
        expect(body.summary.versionPolicy).toEqual({
          mode: "pinned",
          version: "2.0.4",
          target: "2.0.4",
        });
        expect(body.versionHistory).toMatchObject({
          organization: { id: alpha.id },
          section: "agent_defaults",
          actor: { id: alpha.adminId },
          changes: [{ before: "2.0.3", after: "2.0.4" }],
        });
      }
      // Several organizations: no single history.
      state.userId = bothId;
      expect((await list("all")).body.versionHistory).toBeNull();
    } finally {
      state.userId = alpha.adminId;
      await putVersion("2.0.3");
    }
  });

  it("lets only admins of the agent's own organization install, revoke and remove it", async () => {
    const before = async (id: string) =>
      (await db.select().from(agents).where(eq(agents.id, id)))[0]!;

    // A member of Alpha who is an admin of Beta (working in Alpha): forbidden on Alpha's agents.
    state.userId = bothId;
    for (const action of ["install", "revoke", "remove"] as const) {
      expect((await act(action, ids["c-offline"]!)).status).toBe(403);
    }
    // Beta's admin isn't a member of Alpha: not found, for Alpha's agents and unknown ones.
    state.userId = beta.adminId;
    for (const action of ["install", "revoke", "remove"] as const) {
      for (const id of [ids["c-offline"]!, randomUUID(), "not-an-id"]) {
        expect((await act(action, id)).status).toBe(404);
      }
    }
    expect(await before(ids["c-offline"]!)).toMatchObject({ revokedAt: null, deletedAt: null });

    // An admin of Beta acts on Beta's agent without switching organizations.
    state.userId = bothId;
    const zBeta = ids["z-beta"]!;
    expect(await act("install", zBeta)).toEqual({
      status: 200,
      body: { ok: true, jobId: expect.any(String) },
    });
    expect(await act("revoke", zBeta)).toEqual({ status: 200, body: { ok: true } });
    expect((await before(zBeta)).revokedAt).not.toBeNull();
    const revoked = await detail(zBeta);
    expect(revoked.body.agent.status.label).toBe("Revoked");
    // The audit log names who revoked it (their email: they have no name).
    expect(revoked.body.audit.find((entry) => entry.event === "revoke")).toMatchObject({
      actor: "both@alpha.io",
    });
    expect(await act("remove", zBeta)).toEqual({ status: 200, body: { ok: true } });
    expect((await before(zBeta)).deletedAt).not.toBeNull();
    expect((await detail(zBeta)).status).toBe(404);
  });
});
