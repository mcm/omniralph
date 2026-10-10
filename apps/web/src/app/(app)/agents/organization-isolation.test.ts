// Two organizations, each with an agent and a repository: an admin of one never sees or
// changes the other's agents, gets a 404 on their URLs, and only sets their own agent version.
import {
  agents,
  closeDb,
  connectRepository,
  createAgentEnrollment,
  createDb,
  createOrganization,
  enrollAgent,
  getAgentOverview,
  getDesiredAgentVersion,
  runMigrations,
  setDesiredAgentVersion,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
// Views are client components; the tests read the props the pages pass them.
vi.mock("./agents-view", () => ({ AgentsView: () => null }));
vi.mock("./[id]/agent-detail-view", () => ({ AgentDetailView: () => null }));
vi.mock("../settings/agents/agent-settings-view", () => ({ AgentSettingsView: () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const { default: AgentsPage } = await import("./page");
const { default: AgentPage } = await import("./[id]/page");
const { default: AgentSettingsPage } = await import("../settings/agents/page");
const {
  createEnrollment,
  deleteAgent,
  pinRepository,
  revokeAgent,
  setAgentDesiredVersion,
  unpinRepository,
  updateAgentConfig,
} = await import("./actions");
const { setGlobalAgentVersion } = await import("../settings/agents/actions");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

interface Tenant {
  userId: string;
  orgId: string;
  agentId: string;
  repoId: string;
}

/** Next.js `notFound()` throws an error whose digest marks a 404. */
const notFound = { digest: expect.stringContaining("404") };

describe.skipIf(!dockerAvailable)("organization isolation of agents", () => {
  let container: StartedPostgreSqlContainer;
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
      capabilities: ["review"],
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
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    a = await tenant("alpha", "1");
    b = await tenant("beta", "2");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("lists only the active organization's agents and 404s on the other's", async () => {
    state.userId = a.userId;
    const listed = (await AgentsPage()).props.agents as { id: string }[];
    expect(listed.map((r) => r.id)).toEqual([a.agentId]);
    const detail = await AgentPage(params(a.agentId));
    expect((detail.props.agent as { id: string }).id).toBe(a.agentId);
    await expect(AgentPage(params(b.agentId))).rejects.toMatchObject(notFound);
  });

  it("creates enrollments in the active organization", async () => {
    state.userId = b.userId;
    const created = await createEnrollment("beta-2");
    if (!created.ok) throw new Error(created.error);
    const { agentId } = (await enrollAgent(db, {
      enrollmentToken: created.token,
      name: "host",
      version: "1.0.0",
      capabilities: ["review"],
    }))!;
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.organizationId).toBe(b.orgId);
  });

  it("refuses every agent action on the other organization's agent", async () => {
    state.userId = a.userId;
    const config = { maxConcurrency: 4, enabledCapabilities: ["review"] };
    expect(await updateAgentConfig(b.agentId, config)).toMatchObject({ ok: false });
    expect(await setAgentDesiredVersion(b.agentId, "9.9.9")).toMatchObject({ ok: false });
    expect(await revokeAgent(b.agentId)).toMatchObject({ ok: false });
    expect(await deleteAgent(b.agentId)).toMatchObject({ ok: false });
    // Neither the other's agent with our repository nor our agent with the other's repository.
    expect(await pinRepository(b.agentId, a.repoId)).toMatchObject({ ok: false });
    expect(await pinRepository(a.agentId, b.repoId)).toMatchObject({ ok: false });
    expect(await unpinRepository(b.agentId, b.repoId)).toMatchObject({ ok: false });

    const other = (await getAgentOverview(db, b.orgId, b.agentId))!;
    expect(other).toMatchObject({ maxConcurrency: 1, desiredVersion: null, revokedAt: null });
    expect(other.pinnedRepositories).toEqual([]);

    // Its own agent and repository still work.
    expect(await updateAgentConfig(a.agentId, config)).toEqual({ ok: true });
    expect(await pinRepository(a.agentId, a.repoId)).toEqual({ ok: true });
  });

  it("keeps the desired agent version per organization", async () => {
    state.userId = a.userId;
    expect(await setGlobalAgentVersion("1.4.0")).toEqual({ ok: true });
    expect(await getDesiredAgentVersion(db, a.orgId)).toBe("1.4.0");
    expect(await getDesiredAgentVersion(db, b.orgId)).toBeNull();
    expect((await AgentSettingsPage()).props.desiredVersion).toBe("1.4.0");
    const listed = (await AgentsPage()).props.agents as { desiredVersion: string | null }[];
    expect(listed.map((r) => r.desiredVersion)).toEqual(["1.4.0"]);

    state.userId = b.userId;
    expect((await AgentSettingsPage()).props.desiredVersion).toBeNull();
    await setDesiredAgentVersion(db, b.orgId, "2.0.0", b.userId);
    expect(await getDesiredAgentVersion(db, a.orgId)).toBe("1.4.0");
  });
});
