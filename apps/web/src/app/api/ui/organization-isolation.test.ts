// Every `/api/ui` endpoint against two organizations: a user of one never gets a row of the
// other, gets a 404 on the other's resources, and only creates rows in their own. Each area
// adds its endpoints here as it moves from page loaders and server actions to `/api/ui`.
import { randomBytes } from "node:crypto";
import {
  addMember,
  closeDb,
  connectRepository,
  createDb,
  createHarnessEnrollment,
  createHostTool,
  createOrganization,
  enrollHarness,
  getHarnessOverview,
  harnesses,
  jobs,
  listHarnessHostTools,
  organizationMembers,
  setActiveOrganization,
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
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dispatch", () => ({
  getDispatcher: () => ({
    createAndPublish: async () => ({
      job: { id: "00000000-0000-4000-8000-000000000000" },
      created: true,
    }),
  }),
}));
vi.mock("@/lib/harnesses/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestHarnessVersion: async () => "9.9.9",
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
    requireSignedInUser: async () => current("member"),
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";
process.env.AUTH_SECRET = randomBytes(32).toString("base64");

const harnessList = await import("./harnesses/route");
const enrollments = await import("./harness-enrollments/route");
const enrollment = await import("./harness-enrollments/[id]/route");
const harnessDetail = await import("./harnesses/[id]/route");
const harnessSettings = await import("./harnesses/[id]/settings/route");
const harnessUpdate = await import("./harnesses/[id]/update/route");
const harnessRevoke = await import("./harnesses/[id]/revoke/route");
const harnessInstallables = await import("./harnesses/[id]/installables/route");
const harnessInstalls = await import("./harnesses/[id]/installs/route");
const harnessHostTools = await import("./harnesses/[id]/host-tools/route");
const pinnableRepositories = await import("./harnesses/pinnable-repositories/route");
const { readEnterOrganizationToken } = await import("@/lib/organizations/enter");

/** Calls `handler` as the signed-in user; resolves to the status and JSON body. */
async function call<P extends Record<string, string>>(
  handler: (request: Request, route: { params: Promise<P> }) => Promise<Response>,
  {
    body,
    params,
    path = "/api/ui",
    method = body === undefined ? "GET" : "POST",
  }: { body?: unknown; params?: P; path?: string; method?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
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
  repoId: string;
  repoPath: string;
  hostToolId: string;
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
    const connection = (await upsertScmConnection(db, {
      organizationId: org.id,
      provider: "github",
      name,
      baseUrl: "https://api.github.com",
      externalId: `${name}-installation`,
      credentials: {},
    }))!;
    const repoPath = `${name}/app`;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: `${name}-500`,
      fullPath: repoPath,
    });
    const tool = await createHostTool(db, org.id, { name: `${name}-tool` });
    if (!tool.ok) throw new Error("setup");
    return {
      name,
      adminId: admin!.id,
      memberId: member!.id,
      orgId: org.id,
      harnessId,
      enrollmentId: created.id,
      repoId: repo.id,
      repoPath,
      hostToolId: tool.hostTool.id,
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

  it("shows each organization's own harness pages to its admins, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      state.userId = own.adminId;
      const ownParams = { id: own.harnessId };
      const detail = await call(harnessDetail.GET, { params: ownParams });
      expect(detail).toMatchObject({ status: 200, body: { harness: { id: own.harnessId } } });
      const installables = await call(harnessInstallables.GET, { params: ownParams });
      expect(installables).toMatchObject({ status: 200, body: { installJobs: [] } });
      const hostTools = await call(harnessHostTools.GET, { params: ownParams });
      expect(hostTools).toMatchObject({
        status: 200,
        body: { hostTools: [{ hostToolId: own.hostToolId }] },
      });
      for (const { body } of [detail, installables, hostTools]) {
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
      }

      const otherParams = { id: other.harnessId };
      for (const handler of [harnessDetail.GET, harnessInstallables.GET, harnessHostTools.GET]) {
        expect(await call(handler, { params: otherParams })).toMatchObject({ status: 404 });
        expect(await call(handler, { params: { id: "not-a-uuid" } })).toMatchObject({
          status: 404,
        });
      }
      // The pins picker only finds the active organization's repositories.
      const search = await call(pinnableRepositories.GET, { path: "/api/ui?query=app" });
      expect(search).toMatchObject({
        status: 200,
        body: { repositories: [{ id: own.repoId, fullPath: own.repoPath }] },
      });

      // Harness pages are admin-only.
      state.userId = own.memberId;
      for (const handler of [harnessDetail.GET, harnessInstallables.GET, harnessHostTools.GET]) {
        expect(await call(handler, { params: ownParams })).toMatchObject({ status: 403 });
      }
      expect(await call(pinnableRepositories.GET)).toMatchObject({ status: 403 });
    }
  });

  it("refuses every harness change on the other organization's harness and repositories", async () => {
    state.userId = a.adminId;
    const theirs = { id: b.harnessId };
    const config = { maxConcurrency: 4, acceptedTaskTypes: ["query", "review"], poolLimits: {} };
    const refused = [
      await call(harnessSettings.PUT, { method: "PUT", params: theirs, body: { config } }),
      await call(harnessSettings.PUT, {
        method: "PUT",
        params: theirs,
        body: { version: "9.9.9" },
      }),
      // Neither the other's harness with our repository nor our harness with the other's repository.
      await call(harnessSettings.PUT, { method: "PUT", params: theirs, body: { pin: [a.repoId] } }),
      await call(harnessSettings.PUT, {
        method: "PUT",
        params: { id: a.harnessId },
        body: { pin: [b.repoId] },
      }),
      await call(harnessSettings.PUT, {
        method: "PUT",
        params: theirs,
        body: { unpin: [b.repoId] },
      }),
      await call(harnessUpdate.POST, { method: "POST", params: theirs }),
      await call(harnessInstalls.POST, { params: theirs, body: { name: "@omniralph/hello" } }),
      // The other's harness, the other's tool, or both.
      ...(await Promise.all(
        [
          [b.harnessId, a.hostToolId],
          [a.harnessId, b.hostToolId],
          [b.harnessId, b.hostToolId],
        ].map(([id, hostToolId]) =>
          call(harnessHostTools.PUT, {
            method: "PUT",
            params: { id: id! },
            body: { paths: [{ hostToolId, path: "/opt/x" }] },
          }),
        ),
      )),
      await call(harnessRevoke.POST, { method: "POST", params: theirs }),
      await call(harnessDetail.DELETE, { method: "DELETE", params: theirs }),
    ];
    for (const response of refused) expect(response.status).toBe(400);

    const other = (await getHarnessOverview(db, b.orgId, b.harnessId))!;
    expect(other).toMatchObject({
      maxConcurrency: null,
      desiredVersion: null,
      updateRequestVersion: null,
      revokedAt: null,
      deletedAt: null,
    });
    expect(other.pinnedRepositories).toEqual([]);
    expect(
      (await listHarnessHostTools(db, b.orgId, b.harnessId)).map((t) => t.configuredPath),
    ).toEqual([null]);
    expect(await db.select().from(jobs).where(eq(jobs.organizationId, b.orgId))).toEqual([]);

    // Its own harness still works.
    expect(
      await call(harnessSettings.PUT, {
        method: "PUT",
        params: { id: a.harnessId },
        body: { config, pin: [a.repoId] },
      }),
    ).toMatchObject({ status: 200, body: { ok: true, savedAt: expect.any(String) } });
    expect(
      await call(harnessHostTools.PUT, {
        method: "PUT",
        params: { id: a.harnessId },
        body: { paths: [{ hostToolId: a.hostToolId, path: "/opt/x" }] },
      }),
    ).toMatchObject({ status: 200 });
    expect(
      (await listHarnessHostTools(db, a.orgId, a.harnessId)).map((t) => t.configuredPath),
    ).toEqual(["/opt/x"]);
  });

  it("sends a member of both organizations to switch to the harness's organization", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-admin", email: "both@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "admin" },
      { organizationId: b.orgId, userId: user!.id, role: "admin" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;

    const open = (next: string) =>
      call(harnessDetail.GET, {
        params: { id: b.harnessId },
        path: `/api/ui?${new URLSearchParams({ next })}`,
      });
    const settings = `/harnesses/${b.harnessId}/settings`;
    const { status, body } = await open(settings);
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "enter_organization" });
    const token = new URL(body.enterPath as string, "http://localhost").searchParams.get("token");
    expect(await readEnterOrganizationToken(token, user!.id)).toEqual({
      organizationId: b.orgId,
      next: settings,
    });
    expect(JSON.stringify(body)).not.toContain(b.name);

    // Only back to the harness's own pages.
    const elsewhere = await open("/settings/members");
    const elsewhereToken = new URL(
      elsewhere.body.enterPath as string,
      "http://localhost",
    ).searchParams.get("token");
    expect(await readEnterOrganizationToken(elsewhereToken, user!.id)).toMatchObject({
      next: `/harnesses/${b.harnessId}`,
    });
  });
});
