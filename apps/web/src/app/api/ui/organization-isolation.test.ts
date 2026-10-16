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
  createRun,
  enrollHarness,
  getHarnessOverview,
  getRepository,
  getRun,
  harnesses,
  jobs,
  listHarnessHostTools,
  organizationMembers,
  scmConnections,
  setActiveOrganization,
  updateRun,
  upsertScmConnection,
  upsertStories,
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
const repositoryList = await import("./repositories/route");
const repositorySetup = await import("./repositories/setup/route");
const repository = await import("./repositories/[id]/route");
const repositoryWebhook = await import("./repositories/[id]/webhook/route");
const gitlabConnections = await import("./gitlab-connections/route");
const scmConnection = await import("./scm-connections/[id]/route");
const selectable = await import("./scm-connections/[id]/repositories/route");
const runList = await import("./runs/route");
const runDetail = await import("./runs/[id]/route");
const runStop = await import("./runs/[id]/stop/route");
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
  connectionId: string;
  repoId: string;
  repoPath: string;
  hostToolId: string;
  runId: string;
  storyId: string;
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
    const { run } = await createRun(db, {
      organizationId: org.id,
      linearIssueId: `${name}-issue`,
      linearIdentifier: `${name.toUpperCase()}-1`,
      linearTitle: `${name} epic`,
      linearUrl: null,
      linearAgentSessionId: `${name}-session`,
      kind: "children",
      repositoryId: repo.id,
      branch: `${name}-branch`,
      baseBranch: "main",
    });
    await updateRun(db, run.id, { status: "running" });
    const [story] = await upsertStories(db, run.id, [
      { linearIssueId: `${name}-story`, identifier: `${name.toUpperCase()}-2`, title: "Story" },
    ]);
    return {
      name,
      adminId: admin!.id,
      memberId: member!.id,
      orgId: org.id,
      harnessId,
      enrollmentId: created.id,
      connectionId: connection.id,
      repoId: repo.id,
      repoPath,
      hostToolId: tool.hostTool.id,
      runId: run.id,
      storyId: story!.id,
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
  it("lists each organization's own repositories, and its connections to its admins only", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const { status, body } = await call(repositoryList.GET);
        expect(status).toBe(200);
        expect((body.repositories as { id: string }[]).map((r) => r.id)).toEqual([own.repoId]);
        expect((body.connections as { id: string }[]).map((c) => c.id)).toEqual(
          userId === own.adminId ? [own.connectionId] : [],
        );
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
      }
      // The Connect buttons' setup is for admins.
      state.userId = own.memberId;
      expect(await call(repositorySetup.GET)).toMatchObject({ status: 403 });
    }
  });

  it("shows each organization's own connections to its admins, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      state.userId = own.adminId;
      const open = (id: string, provider = "github") =>
        call(scmConnection.GET, { params: { id }, path: `/api/ui?provider=${provider}` });
      expect(await open(own.connectionId)).toMatchObject({
        status: 200,
        body: { id: own.connectionId, provider: "github", name: own.name },
      });
      // The other code host's picker doesn't find it.
      expect(await open(own.connectionId, "gitlab")).toMatchObject({ status: 404 });
      expect(await open(other.connectionId)).toMatchObject({ status: 404 });
      expect(await open("not-a-uuid")).toMatchObject({ status: 404 });
      // The picker's list never asks the code host for another organization's connection.
      expect(
        await call(selectable.GET, {
          params: { id: other.connectionId },
          path: "/api/ui?provider=github",
        }),
      ).toMatchObject({ status: 404 });

      state.userId = own.memberId;
      expect(await open(own.connectionId)).toMatchObject({ status: 403 });
      expect(
        await call(selectable.GET, {
          params: { id: own.connectionId },
          path: "/api/ui?provider=github",
        }),
      ).toMatchObject({ status: 403 });
    }
  });

  it("refuses every repository and connection change on the other organization's rows", async () => {
    state.userId = a.adminId;
    const refused = [
      await call(repository.DELETE, { method: "DELETE", params: { id: b.repoId } }),
      await call(repositoryWebhook.POST, { method: "POST", params: { id: b.repoId } }),
      await call(scmConnection.DELETE, { method: "DELETE", params: { id: b.connectionId } }),
      await call(selectable.PUT, {
        method: "PUT",
        params: { id: b.connectionId },
        body: { provider: "github", selectedIds: [500] },
      }),
    ];
    for (const response of refused) expect(response.status).toBe(400);
    expect(await getRepository(db, b.repoId)).toMatchObject({
      disconnectedAt: null,
      enabled: null,
    });
    expect(
      await db.select().from(scmConnections).where(eq(scmConnections.id, b.connectionId)),
    ).toHaveLength(1);
    expect(
      await call(repository.DELETE, { method: "DELETE", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });

    // Members change nothing, in their own organization either.
    state.userId = a.memberId;
    for (const response of [
      await call(repository.DELETE, { method: "DELETE", params: { id: a.repoId } }),
      await call(repositoryWebhook.POST, { method: "POST", params: { id: a.repoId } }),
      await call(scmConnection.DELETE, { method: "DELETE", params: { id: a.connectionId } }),
      await call(selectable.PUT, {
        method: "PUT",
        params: { id: a.connectionId },
        body: { provider: "github", selectedIds: [] },
      }),
      await call(gitlabConnections.POST, {
        body: { baseUrl: "https://gitlab.example.com", token: "glpat-x" },
      }),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(await getRepository(db, a.repoId)).toMatchObject({ disconnectedAt: null });

    // An admin's own disconnect works, and the other organization still has its repository.
    state.userId = a.adminId;
    expect(
      await call(repository.DELETE, { method: "DELETE", params: { id: a.repoId } }),
    ).toMatchObject({ status: 200, body: { ok: true } });
    state.userId = b.memberId;
    expect(
      ((await call(repositoryList.GET)).body.repositories as { id: string }[]).map((r) => r.id),
    ).toEqual([b.repoId]);
  });

  it("sends a member of both organizations to switch to the connection's organization", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-connections-admin", email: "both-connections@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "admin" },
      { organizationId: b.orgId, userId: user!.id, role: "admin" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;

    const picker = `/repositories/github/${b.connectionId}`;
    const { status, body } = await call(scmConnection.GET, {
      params: { id: b.connectionId },
      path: `/api/ui?${new URLSearchParams({ provider: "github", next: picker })}`,
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "enter_organization" });
    const token = new URL(body.enterPath as string, "http://localhost").searchParams.get("token");
    expect(await readEnterOrganizationToken(token, user!.id)).toEqual({
      organizationId: b.orgId,
      next: picker,
    });
  });

  it("lists and shows each organization's own coding runs to its members, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const list = await call(runList.GET);
        expect(list.status).toBe(200);
        expect((list.body.runs as { id: string }[]).map((r) => r.id)).toEqual([own.runId]);
        expect(list.body.repositories).toMatchObject([{ id: own.repoId }]);
        // The other's repository as the filter finds nothing.
        const filtered = await call(runList.GET, {
          path: `/api/ui?repository=${other.repoId}`,
        });
        expect(filtered).toMatchObject({ status: 200, body: { runs: [], total: 0 } });

        const detail = await call(runDetail.GET, { params: { id: own.runId } });
        expect(detail).toMatchObject({ status: 200, body: { run: { id: own.runId } } });
        expect(JSON.stringify(detail.body)).toContain(own.storyId);
        for (const { body } of [list, detail]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }

        expect(await call(runDetail.GET, { params: { id: other.runId } })).toMatchObject({
          status: 404,
        });
        expect(await call(runDetail.GET, { params: { id: "not-a-uuid" } })).toMatchObject({
          status: 404,
        });
      }
    }
  });

  it("refuses to stop the other organization's run, and members can't stop runs", async () => {
    state.userId = a.adminId;
    expect(await call(runStop.POST, { method: "POST", params: { id: b.runId } })).toMatchObject({
      status: 400,
      body: { error: "That run doesn't exist." },
    });
    expect(
      await call(runStop.POST, { method: "POST", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });
    state.userId = b.memberId;
    expect(await call(runStop.POST, { method: "POST", params: { id: b.runId } })).toMatchObject({
      status: 403,
    });
    expect((await getRun(db, b.runId))!.status).toBe("running");
  });

  it("sends a member of both organizations to switch to the run's organization", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-runs-member", email: "both-runs@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "member" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;

    const page = `/coding/${b.runId}`;
    const { status, body } = await call(runDetail.GET, {
      params: { id: b.runId },
      path: `/api/ui?${new URLSearchParams({ next: page })}`,
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "enter_organization" });
    expect(JSON.stringify(body)).not.toContain(b.name);
    const token = new URL(body.enterPath as string, "http://localhost").searchParams.get("token");
    expect(await readEnterOrganizationToken(token, user!.id)).toEqual({
      organizationId: b.orgId,
      next: page,
    });
  });
});
