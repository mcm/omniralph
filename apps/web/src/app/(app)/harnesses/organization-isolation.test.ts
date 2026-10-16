// Two organizations, each with a harness: an admin of one only changes their own harness
// defaults, version and host tool catalog (Settings › Harness defaults). The harness pages
// moved to `/api/ui`: see src/app/api/ui/organization-isolation.test.ts.
import {
  closeDb,
  connectRepository,
  createHarnessEnrollment,
  createDb,
  createHostTool,
  createOrganization,
  enrollHarness,
  getDesiredHarnessVersion,
  listHarnessHostTools,
  listHostTools,
  setDesiredHarnessVersion,
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
vi.mock("../settings/harnesses/harness-settings-view", () => ({ HarnessSettingsView: () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const { default: HarnessSettingsPage } = await import("../settings/harnesses/page");
const { default: HostToolsSettingsPage } = await import("../settings/harnesses/host-tools/page");
const { addHostTool, removeHostTool, setGlobalHarnessVersion, setOrganizationDefaults } =
  await import("../settings/harnesses/actions");

const databaseAvailable = testDatabaseAvailable();

interface Tenant {
  userId: string;
  orgId: string;
  harnessId: string;
  repoId: string;
}

describe.skipIf(!databaseAvailable)("organization isolation of harnesses", () => {
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
    const enrollment = await createHarnessEnrollment(db, {
      organizationId: org.id,
      name: `${name}-harness`,
    });
    const { harnessId } = (await enrollHarness(db, {
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
    return { userId: user!.id, orgId: org.id, harnessId, repoId: repo.id };
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

  it("keeps the desired harness version per organization", async () => {
    state.userId = a.userId;
    expect(await setGlobalHarnessVersion("1.4.0")).toEqual({ ok: true });
    expect(await getDesiredHarnessVersion(db, a.orgId)).toBe("1.4.0");
    expect(await getDesiredHarnessVersion(db, b.orgId)).toBeNull();
    expect((await HarnessSettingsPage()).props.desiredVersion).toBe("1.4.0");

    state.userId = b.userId;
    expect((await HarnessSettingsPage()).props.desiredVersion).toBeNull();
    await setDesiredHarnessVersion(db, b.orgId, "2.0.0", b.userId);
    expect(await getDesiredHarnessVersion(db, a.orgId)).toBe("1.4.0");
  });

  it("keeps task-type and concurrency defaults per organization", async () => {
    state.userId = a.userId;
    expect(
      await setOrganizationDefaults({ allowedTaskTypes: ["review"], maxConcurrency: 3 }),
    ).toEqual({ ok: true });
    expect((await HarnessSettingsPage()).props.defaults).toEqual({
      allowedTaskTypes: ["review"],
      maxConcurrency: 3,
    });

    // The other organization still has the built-in defaults.
    state.userId = b.userId;
    expect((await HarnessSettingsPage()).props.defaults).toEqual({
      allowedTaskTypes: ["query", "review", "coding"],
      maxConcurrency: 5,
    });
  });

  it("keeps host tools per organization", async () => {
    const theirs = await createHostTool(db, b.orgId, { name: "semgrep" });
    if (!theirs.ok) throw new Error("setup");
    state.userId = a.userId;
    // The same name in another organization is no duplicate.
    const ours = await addHostTool({ name: "semgrep", description: "ours" });
    if (!ours.ok) throw new Error(ours.error);
    expect((await listHostTools(db, a.orgId)).map((t) => t.id)).toEqual([ours.hostToolId]);
    expect((await HostToolsSettingsPage()).props.hostTools).toEqual([
      { id: ours.hostToolId, name: "semgrep", description: "ours" },
    ]);
    expect(await removeHostTool(theirs.hostTool.id)).toMatchObject({ ok: false });
    expect(await listHostTools(db, b.orgId)).toHaveLength(1);
    expect(
      (await listHarnessHostTools(db, b.orgId, b.harnessId)).map((t) => t.configuredPath),
    ).toEqual([null]);

    // Its own tool still works.
    expect(await removeHostTool(ours.hostToolId!)).toEqual({ ok: true });
  });
});
