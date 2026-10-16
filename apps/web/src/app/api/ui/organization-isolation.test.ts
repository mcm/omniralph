// Every `/api/ui` endpoint against two organizations: a user of one never gets a row of the
// other, gets a 404 on the other's resources, and only creates rows in their own. Each area
// adds its endpoints here as it moves from page loaders and server actions to `/api/ui`.
import { randomBytes } from "node:crypto";
import {
  addMember,
  closeDb,
  createDb,
  createHarnessEnrollment,
  createOrganization,
  enrollHarness,
  harnesses,
  setActiveOrganization,
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
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

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
    requireSignedInUser: async () => current("member"),
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const harnessList = await import("./harnesses/route");
const enrollments = await import("./harness-enrollments/route");
const enrollment = await import("./harness-enrollments/[id]/route");

/** Calls `handler` as the signed-in user; resolves to the status and JSON body. */
async function call<P extends Record<string, string>>(
  handler: (request: Request, route: { params: Promise<P> }) => Promise<Response>,
  { body, params, path = "/api/ui" }: { body?: unknown; params?: P; path?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params ?? ({} as P)) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const databaseAvailable = testDatabaseAvailable();

/** One organization's rows; every name contains `name`. */
interface Tenant {
  name: string;
  adminId: string;
  memberId: string;
  orgId: string;
  harnessId: string;
  enrollmentId: string;
}

describe.skipIf(!databaseAvailable)("organization isolation of /api/ui", () => {
  let testDb: TestDatabase;
  let db: Database;
  let a: Tenant;
  let b: Tenant;

  async function tenant(name: string): Promise<Tenant> {
    const [admin, member] = await db
      .insert(users)
      .values([
        { id: `${name}-admin`, email: `admin@${name}.io` },
        { id: `${name}-member`, email: `member@${name}.io` },
      ])
      .returning();
    const org = await createOrganization(db, { name, createdBy: admin!.id });
    expect(
      await addMember(db, { organizationId: org.id, userId: member!.id, role: "member" }),
    ).toBe("added");
    await setActiveOrganization(db, { userId: member!.id, organizationId: org.id });
    const created = await createHarnessEnrollment(db, {
      organizationId: org.id,
      name: `${name}-harness`,
    });
    const { harnessId } = (await enrollHarness(db, {
      enrollmentToken: created.token,
      name: "host",
      version: "1.0.0",
    }))!;
    return {
      name,
      adminId: admin!.id,
      memberId: member!.id,
      orgId: org.id,
      harnessId,
      enrollmentId: created.id,
    };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    a = await tenant("alpha");
    b = await tenant("beta");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** IDs and names of `tenant`'s rows: none of them may show up in the other's responses. */
  const markers = (tenant: Tenant) =>
    Object.values(tenant).filter((value) => value !== tenant.adminId && value !== tenant.memberId);

  it("lists each organization's own harnesses to its members, and none of the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const { status, body } = await call(harnessList.GET);
        expect(status).toBe(200);
        expect((body.harnesses as { id: string }[]).map((h) => h.id)).toEqual([own.harnessId]);
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
      }
    }
  });

  it("creates enrollments in the active organization, for admins only", async () => {
    state.userId = b.memberId;
    expect(await call(enrollments.POST, { body: { name: "beta-2" } })).toMatchObject({
      status: 403,
    });

    state.userId = b.adminId;
    const { status, body } = await call(enrollments.POST, { body: { name: "beta-2" } });
    expect(status).toBe(200);
    expect(body.command).toBe(
      `omniralph-harness enroll --server https://omniralph.example.com --token ${body.token}`,
    );
    const { harnessId } = (await enrollHarness(db, {
      enrollmentToken: body.token as string,
      name: "host",
      version: "1.0.0",
    }))!;
    const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
    expect(row).toMatchObject({ organizationId: b.orgId, name: "beta-2" });

    // Only its own organization sees the enrollment and its harness.
    const params = { id: body.id as string };
    expect(await call(enrollment.GET, { params })).toMatchObject({
      status: 200,
      body: { id: body.id, harness: { id: harnessId, name: "beta-2" } },
    });
    state.userId = a.adminId;
    expect(await call(enrollment.GET, { params })).toMatchObject({ status: 404 });
  });

  it("404s on the other organization's enrollment", async () => {
    state.userId = a.adminId;
    expect(await call(enrollment.GET, { params: { id: a.enrollmentId } })).toMatchObject({
      status: 200,
      body: { harness: { id: a.harnessId } },
    });
    expect(await call(enrollment.GET, { params: { id: b.enrollmentId } })).toMatchObject({
      status: 404,
    });
    expect(await call(enrollment.GET, { params: { id: "not-a-uuid" } })).toMatchObject({
      status: 404,
    });
    // Enrollments are admin-only.
    state.userId = a.memberId;
    expect(await call(enrollment.GET, { params: { id: a.enrollmentId } })).toMatchObject({
      status: 403,
    });
  });
});
