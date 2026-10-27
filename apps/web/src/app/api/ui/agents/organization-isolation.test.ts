// Two organizations, each with an agent: an admin of one only changes their own agent
// defaults, version and host tool catalog (through their
// `/api/ui` handlers). The agent pages
// moved to `/api/ui`: see src/app/api/ui/organization-isolation.test.ts.
import {
  closeDb,
  connectRepository,
  createAgentEnrollment,
  createDb,
  createHostTool,
  createOrganization,
  enrollAgent,
  getDesiredAgentVersion,
  listAgentHostTools,
  listHostTools,
  setDesiredAgentVersion,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { callAction } from "@/lib/api/test-call";
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
vi.mock("@/lib/dispatch", () => ({
  getDispatcher: () => ({
    createAndPublish: async () => ({ job: { id: "00000000-0000-4000-8000-000000000000" } }),
  }),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const defaultsRoute = await import("@/app/api/ui/agent-defaults/route");
const hostToolsRoute = await import("@/app/api/ui/host-tools/route");
const hostToolRoute = await import("@/app/api/ui/host-tools/[id]/route");

// Agent defaults (`/api/ui/agent-defaults`) requests, under the names of the server actions they replace.
const setGlobalAgentVersion = (version: string) =>
  callAction(defaultsRoute.PUT, "PUT", {}, { version });
const setOrganizationDefaults = (defaults: unknown) =>
  callAction(defaultsRoute.PUT, "PUT", {}, { defaults });
const addHostTool = async (input: { name: string; description?: string }) =>
  (await callAction(hostToolsRoute.POST, "POST", {}, input)) as ActionResult & {
    hostToolId?: string;
  };
const removeHostTool = (id: string) => callAction(hostToolRoute.DELETE, "DELETE", { id });

/** A GET handler's JSON body. */
async function get(
  handler: (
    request: Request,
    route: { params: Promise<Record<string, string>> },
  ) => Promise<Response>,
) {
  const response = await handler(new Request("http://localhost/api/ui"), {
    params: Promise.resolve({}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}
const agentDefaults = () => get(defaultsRoute.GET);
const hostToolCatalog = () => get(hostToolsRoute.GET);

const databaseAvailable = testDatabaseAvailable();

interface Tenant {
  userId: string;
  orgId: string;
  agentId: string;
  repoId: string;
}

describe.skipIf(!databaseAvailable)("organization isolation of agents", () => {
  let testDb: TestDatabase;
  let db: Database;
  let a: Tenant;
  let b: Tenant;

  async function tenant(name: string, installationId: string): Promise<Tenant> {
    const [user] = await db
      .insert(users)
      .values({ id: `${name}-admin`, email: `admin@${name}.io` })
      .returning();
    const org = await createOrganization(db, { name, createdBy: user!.id });
    const enrollment = await createAgentEnrollment(db, {
      organizationId: org.id,
      name: `${name}-agent`,
    });
    const { agentId } = (await enrollAgent(db, {
      enrollmentToken: enrollment.token,
      name: "host",
      version: "1.0.0",
    }))!;
    const connection = (await upsertScmConnection(db, {
      organizationId: org.id,
      provider: "github",
      name,
      baseUrl: "https://api.github.com",
      externalId: installationId,
      credentials: {},
    }))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "500",
      fullPath: "shared/app",
    });
    return { userId: user!.id, orgId: org.id, agentId, repoId: repo.id };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    a = await tenant("alpha", "1");
    b = await tenant("beta", "2");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("keeps the desired agent version per organization", async () => {
    state.userId = a.userId;
    expect(await setGlobalAgentVersion("2.4.0")).toEqual({
      ok: true,
      versionPolicy: { mode: "pinned", version: "2.4.0", target: "2.4.0" },
    });
    expect(await getDesiredAgentVersion(db, a.orgId)).toBe("2.4.0");
    expect(await getDesiredAgentVersion(db, b.orgId)).toBeNull();
    expect((await agentDefaults()).desiredVersion).toBe("2.4.0");

    state.userId = b.userId;
    expect((await agentDefaults()).desiredVersion).toBeNull();
    await setDesiredAgentVersion(db, b.orgId, "2.0.0", b.userId);
    expect(await getDesiredAgentVersion(db, a.orgId)).toBe("2.4.0");
  });

  it("keeps concurrency defaults per organization", async () => {
    state.userId = a.userId;
    expect(await setOrganizationDefaults({ maxConcurrency: 3 })).toEqual({ ok: true });
    expect((await agentDefaults()).defaults).toEqual({ maxConcurrency: 3 });

    // The other organization still has the built-in defaults.
    state.userId = b.userId;
    expect((await agentDefaults()).defaults).toEqual({ maxConcurrency: 5 });
  });

  it("keeps host tools per organization", async () => {
    const theirs = await createHostTool(db, b.orgId, { name: "semgrep" });
    if (!theirs.ok) throw new Error("setup");
    state.userId = a.userId;
    // The same name in another organization is no duplicate.
    const ours = await addHostTool({ name: "semgrep", description: "ours" });
    if (!ours.ok) throw new Error(ours.error);
    expect((await listHostTools(db, a.orgId)).map((t) => t.id)).toEqual([ours.hostToolId]);
    expect((await hostToolCatalog()).hostTools).toEqual([
      { id: ours.hostToolId, name: "semgrep", description: "ours" },
    ]);
    expect(await removeHostTool(theirs.hostTool.id)).toMatchObject({ ok: false });
    expect(await listHostTools(db, b.orgId)).toHaveLength(1);
    expect((await listAgentHostTools(db, b.orgId, b.agentId)).map((t) => t.configuredPath)).toEqual(
      [null],
    );

    // Its own tool still works.
    expect(await removeHostTool(ours.hostToolId!)).toEqual({ ok: true });
  });
});
