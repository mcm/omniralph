// Every `/api/ui` endpoint against two organizations: a user of one never gets a row of the
// other, gets a 404 on the other's resources, and only creates rows in their own. Each area
// adds its endpoints here as it moves from page loaders and server actions to `/api/ui`.
import { randomBytes } from "node:crypto";
import {
  addMember,
  addOrganizationDomain,
  chatIdentities,
  closeDb,
  createInvitation,
  getActiveOrganization,
  getIntegration,
  getMembership,
  listChatChannelTaskSettings,
  listChatConnections,
  saveChatConnection,
  saveIntegration,
  upsertChatChannelTaskSetting,
  getOrganization,
  listChatIdentities,
  listOrganizationDomains,
  listPendingInvitationsForOrganization,
  connectRepository,
  createDb,
  createHarnessEnrollment,
  createCustomRule,
  createHostTool,
  listRepositoryRules,
  createOrganization,
  createReview,
  createRun,
  createTriageRun,
  insertJob,
  enrollHarness,
  findings,
  getHarnessOverview,
  getRepository,
  getJob,
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
// Disconnecting revokes tokens at Linear and Slack: never in tests.
vi.mock("@/lib/linear/oauth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeToken: async () => {},
}));
vi.mock("@/lib/chat/slack-oauth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeSlackToken: async () => {},
}));
vi.mock("@/lib/harnesses/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestHarnessVersion: async () => "9.9.9",
}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  cookies: new Map<string, string>(),
}));
// This browser's cookies (switching organizations sets one).
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void state.cookies.set(name, value),
  }),
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
const repositoryDetail = repository;
const repositoryWebhook = await import("./repositories/[id]/webhook/route");
const repositorySettings = await import("./repositories/[id]/settings/route");
const repositoryTaskTypes = await import("./repositories/[id]/task-types/route");
const repositoryCoding = await import("./repositories/[id]/coding/route");
const repositoryLinear = await import("./repositories/[id]/coding/linear/route");
const repositoryRules = await import("./repositories/[id]/rules/route");
const repositoryRule = await import("./repositories/[id]/rules/[ruleId]/route");
const gitlabConnections = await import("./gitlab-connections/route");
const scmConnection = await import("./scm-connections/[id]/route");
const selectable = await import("./scm-connections/[id]/repositories/route");
const runList = await import("./runs/route");
const runDetail = await import("./runs/[id]/route");
const runStop = await import("./runs/[id]/stop/route");
const reviewList = await import("./reviews/route");
const reviewDetail = await import("./reviews/[id]/route");
const reviewRerun = await import("./reviews/[id]/rerun/route");
const findingDismiss = await import("./findings/[id]/dismiss/route");
const findingRestore = await import("./findings/[id]/restore/route");
const jobList = await import("./jobs/route");
const jobCancel = await import("./jobs/[id]/cancel/route");
const triageList = await import("./triage/route");
const triageDetail = await import("./triage/[id]/route");
const organizationSettings = await import("./organization/route");
const organizationInvitations = await import("./organization/invitations/route");
const organizationInvitation = await import("./organization/invitations/[id]/route");
const organizationMember = await import("./organization/members/[userId]/route");
const organizationDomains = await import("./organization/domains/route");
const organizationDomain = await import("./organization/domains/[domain]/route");
const organizationLeave = await import("./organization/leave/route");
const organizationSwitch = await import("./organizations/switch/route");
const chatAccounts = await import("./chat-accounts/route");
const chatAccountUnlink = await import("./chat-accounts/unlink/route");
const integrations = await import("./integrations/route");
const linearIntegration = await import("./integrations/linear/route");
const slackIntegration = await import("./integrations/slack/[id]/route");
const discordIntegration = await import("./integrations/discord/[id]/route");
const chatTasks = await import("./integrations/chat-tasks/route");
const channelTasks = await import("./integrations/chat-connections/[id]/channels/route");
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
  ruleId: string;
  hostToolId: string;
  runId: string;
  storyId: string;
  reviewId: string;
  findingId: string;
  jobId: string;
  triageRunId: string;
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
    const rule = await createCustomRule(db, {
      repositoryId: repo.id,
      text: `${name} rule`,
      createdBy: admin!.id,
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
    const review = await createReview(db, {
      repositoryId: repo.id,
      prNumber: 7,
      prTitle: `${name} change`,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook",
      profileId: "standard",
      model: null,
      budget: 100_000,
    });
    const [finding] = await db
      .insert(findings)
      .values({
        reviewId: review.id,
        path: "src/app.ts",
        startLine: 1,
        endLine: 2,
        severity: "high",
        category: "bug",
        title: `${name} finding`,
        body: "Body",
        confidence: 0.9,
      })
      .returning();
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: org.id,
        type: "review.run",
        taskType: "review",
        pool: "short",
        status: "running",
        harnessId,
      })
      .returning();
    const { run: triageRun } = await createTriageRun(db, {
      organizationId: org.id,
      linearIssueId: `${name}-triage-issue`,
      linearAgentSessionId: `${name}-triage-session`,
      trigger: "mention",
    });
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
      ruleId: rule.id,
      hostToolId: tool.hostTool.id,
      runId: run.id,
      storyId: story!.id,
      reviewId: review.id,
      findingId: finding!.id,
      jobId: job!.id,
      triageRunId: triageRun.id,
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
        // Its own harnesses (an earlier test enrolled more), none of the other's (the markers).
        expect((body.harnesses as { id: string }[]).map((h) => h.id)).toContain(own.harnessId);
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
    expect(
      (await db.select().from(jobs).where(eq(jobs.organizationId, b.orgId))).map((j) => j.id),
    ).toEqual([b.jobId]);

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

  it("shows each organization's own repository settings tabs, Coding to admins only, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const { status, body } = await call(repositoryDetail.GET, { params: { id: own.repoId } });
        expect(status).toBe(200);
        expect(body).toMatchObject({ repository: { id: own.repoId, fullPath: own.repoPath } });
        // Its own harnesses (an earlier test enrolled more), none of the other's (the markers).
        expect((body.harnesses as { id: string }[]).map((h) => h.id)).toContain(own.harnessId);
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        expect(await call(repositoryDetail.GET, { params: { id: other.repoId } })).toMatchObject({
          status: 404,
        });
      }
      expect(await call(repositoryDetail.GET, { params: { id: "not-a-uuid" } })).toMatchObject({
        status: 404,
      });

      state.userId = own.adminId;
      const coding = await call(repositoryCoding.GET, { params: { id: own.repoId } });
      expect(coding).toMatchObject({ status: 200, body: { settings: { codingPath: "legacy" } } });
      for (const marker of markers(other))
        expect(JSON.stringify(coding.body)).not.toContain(marker);
      expect(await call(repositoryLinear.GET, { params: { id: own.repoId } })).toEqual({
        status: 200,
        body: { status: "disconnected" },
      });
      for (const handler of [repositoryCoding.GET, repositoryLinear.GET]) {
        expect(await call(handler, { params: { id: other.repoId } })).toMatchObject({
          status: 404,
        });
      }
      // Members see Review settings and Harnesses read-only; Coding is for admins.
      state.userId = own.memberId;
      for (const handler of [repositoryCoding.GET, repositoryLinear.GET]) {
        expect(await call(handler, { params: { id: own.repoId } })).toMatchObject({
          status: 403,
        });
      }
    }
  });

  it("refuses every repository settings save on the other organization's repository", async () => {
    const reviewSettings = {
      profileId: "deep",
      triggers: { onOpen: false, onPush: false, drafts: false },
      pathExcludes: [],
      customInstructions: "",
      pinnedHarnessIds: [],
      reviewTaskIds: ["builtin:review-pr"],
      correlationTaskId: "builtin:correlate-findings",
    };
    // A valid Coding form: the other organization's own.
    state.userId = b.adminId;
    const coding = (await call(repositoryCoding.GET, { params: { id: b.repoId } })).body;
    const saves = (id: string) => [
      call(repositorySettings.PUT, { method: "PUT", params: { id }, body: reviewSettings }),
      call(repositoryTaskTypes.PUT, {
        method: "PUT",
        params: { id },
        body: { query: false, review: false, coding: false },
      }),
      call(repositoryCoding.PUT, {
        method: "PUT",
        params: { id },
        body: { ...(coding.settings as object), codingPath: "tasks" },
      }),
    ];
    state.userId = a.adminId;
    for (const response of await Promise.all(saves(b.repoId))) {
      expect(response).toMatchObject({
        status: 400,
        body: { error: "That repository isn't connected." },
      });
    }
    for (const response of await Promise.all(saves("not-a-uuid"))) {
      expect(response.status).toBe(404);
    }
    // Members change nothing, in their own organization either.
    state.userId = b.memberId;
    for (const response of await Promise.all(saves(b.repoId))) expect(response.status).toBe(403);
    expect(await getRepository(db, b.repoId)).toMatchObject({
      profileId: "standard",
      enabled: null,
      queryEnabled: null,
      ralphEnabled: null,
      codingPath: "legacy",
    });
  });

  it("shows each organization's own repository rules to its members, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const { status, body } = await call(repositoryRules.GET, { params: { id: own.repoId } });
        expect(status).toBe(200);
        expect(body).toMatchObject({
          repository: { id: own.repoId, fullPath: own.repoPath },
          rules: [{ id: own.ruleId, kind: "custom", text: `${own.name} rule`, enabled: true }],
        });
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        expect(await call(repositoryRules.GET, { params: { id: other.repoId } })).toMatchObject({
          status: 404,
        });
      }
      expect(await call(repositoryRules.GET, { params: { id: "not-a-uuid" } })).toMatchObject({
        status: 404,
      });
    }
  });

  it("refuses every rule change on the other organization's repository, and members can't change rules", async () => {
    const ruleChanges = (id: string, ruleId: string) => [
      call(repositoryRule.PATCH, {
        method: "PATCH",
        params: { id, ruleId },
        body: { text: "Edited" },
      }),
      call(repositoryRule.PATCH, {
        method: "PATCH",
        params: { id, ruleId },
        body: { enabled: false },
      }),
      call(repositoryRule.DELETE, { method: "DELETE", params: { id, ruleId } }),
    ];
    const changes = (id: string, ruleId: string) => [
      call(repositoryRules.POST, { params: { id }, body: { text: "Sneaky rule" } }),
      ...ruleChanges(id, ruleId),
    ];
    state.userId = a.adminId;
    for (const response of await Promise.all(changes(b.repoId, b.ruleId))) {
      expect(response).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    }
    // The other organization's rule under the admin's own repository.
    for (const response of await Promise.all(ruleChanges(a.repoId, b.ruleId))) {
      expect(response).toMatchObject({ status: 400, body: { error: "That rule doesn't exist." } });
    }
    for (const response of await Promise.all(changes("not-a-uuid", b.ruleId))) {
      expect(response.status).toBe(404);
    }
    // Members change nothing, in their own organization either.
    state.userId = b.memberId;
    for (const response of await Promise.all(changes(b.repoId, b.ruleId))) {
      expect(response.status).toBe(403);
    }
    expect((await listRepositoryRules(db, b.repoId)).map((r) => [r.text, r.enabled])).toEqual([
      ["beta rule", true],
    ]);
  });

  it("sends a member of both organizations to switch to the repository's organization", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-repositories-admin", email: "both-repositories@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "admin" },
      { organizationId: b.orgId, userId: user!.id, role: "admin" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;

    for (const [tab, handler] of [
      ["settings", repositoryDetail.GET],
      ["harnesses", repositoryDetail.GET],
      ["coding", repositoryCoding.GET],
      ["rules", repositoryRules.GET],
    ] as const) {
      const page = `/repositories/${b.repoId}/${tab}`;
      const { status, body } = await call(handler, {
        params: { id: b.repoId },
        path: `/api/ui?${new URLSearchParams({ next: page })}`,
      });
      expect(status, page).toBe(409);
      expect(body).toMatchObject({ code: "enter_organization" });
      expect(JSON.stringify(body)).not.toContain(b.repoPath);
      const token = new URL(body.enterPath as string, "http://localhost").searchParams.get("token");
      expect(await readEnterOrganizationToken(token, user!.id)).toEqual({
        organizationId: b.orgId,
        next: page,
      });
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

  it("lists and shows each organization's own reviews to its members, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const list = await call(reviewList.GET);
        expect(list).toMatchObject({ status: 200, body: { repository: null, total: 1 } });
        expect((list.body.reviews as { id: string }[]).map((r) => r.id)).toEqual([own.reviewId]);
        const repositoryList = await call(reviewList.GET, {
          path: `/api/ui?repository=${own.repoId}`,
        });
        expect(repositoryList).toMatchObject({
          status: 200,
          body: { repository: { id: own.repoId }, reviews: [{ id: own.reviewId }] },
        });

        const detail = await call(reviewDetail.GET, { params: { id: own.reviewId } });
        expect(detail).toMatchObject({ status: 200, body: { review: { id: own.reviewId } } });
        expect(JSON.stringify(detail.body)).toContain(own.findingId);
        for (const { body } of [list, repositoryList, detail]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }

        expect(await call(reviewDetail.GET, { params: { id: other.reviewId } })).toMatchObject({
          status: 404,
        });
        expect(await call(reviewDetail.GET, { params: { id: "not-a-uuid" } })).toMatchObject({
          status: 404,
        });
        expect(
          await call(reviewList.GET, { path: `/api/ui?repository=${other.repoId}` }),
        ).toMatchObject({ status: 404 });
      }
    }
  });

  it("dismisses and restores only the organization's own findings", async () => {
    state.userId = a.memberId;
    const dismiss = (id: string) =>
      call(findingDismiss.POST, { params: { id }, body: { reason: "wont_fix" } });
    const restore = (id: string) => call(findingRestore.POST, { method: "POST", params: { id } });
    expect(await dismiss(b.findingId)).toMatchObject({
      status: 404,
      body: { error: "That finding doesn't exist." },
    });
    expect(await restore(b.findingId)).toMatchObject({ status: 404 });
    expect(await dismiss("not-a-uuid")).toMatchObject({ status: 404 });
    const [other] = await db.select().from(findings).where(eq(findings.id, b.findingId));
    expect(other!.status).toBe("open");

    expect(await dismiss(a.findingId)).toEqual({ status: 200, body: { ok: true } });
    expect(await restore(a.findingId)).toEqual({ status: 200, body: { ok: true } });
    const [own] = await db.select().from(findings).where(eq(findings.id, a.findingId));
    expect(own!.status).toBe("open");
  });

  it("refuses to re-run the other organization's review, and members can't re-run", async () => {
    const rerun = (id: string) =>
      call(reviewRerun.POST, { params: { id }, body: { mode: "fresh", profileId: null } });
    state.userId = a.adminId;
    expect(await rerun(b.reviewId)).toMatchObject({
      status: 404,
      body: { error: "That review doesn't exist." },
    });
    expect(await rerun("not-a-uuid")).toMatchObject({ status: 404 });
    state.userId = b.memberId;
    expect(await rerun(b.reviewId)).toMatchObject({ status: 403 });
  });

  it("sends a member of both organizations to switch to the review's organization", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-reviews-member", email: "both-reviews@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "member" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;

    const pages: [string, Promise<{ status: number; body: Record<string, unknown> }>][] = [];
    const reviewPage = `/reviews/${b.reviewId}`;
    pages.push([
      reviewPage,
      call(reviewDetail.GET, {
        params: { id: b.reviewId },
        path: `/api/ui?${new URLSearchParams({ next: reviewPage })}`,
      }),
    ]);
    const repositoryPage = `/repositories/${b.repoId}/reviews?status=queued`;
    pages.push([
      repositoryPage,
      call(reviewList.GET, {
        path: `/api/ui?${new URLSearchParams({ repository: b.repoId, next: repositoryPage })}`,
      }),
    ]);
    for (const [page, response] of pages) {
      const { status, body } = await response;
      expect(status, page).toBe(409);
      expect(body).toMatchObject({ code: "enter_organization" });
      expect(JSON.stringify(body)).not.toContain(b.name);
      const token = new URL(body.enterPath as string, "http://localhost").searchParams.get("token");
      expect(await readEnterOrganizationToken(token, user!.id)).toEqual({
        organizationId: b.orgId,
        next: page,
      });
    }
  });

  it("lists each organization's own jobs to its members, and none of the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const list = await call(jobList.GET);
        expect(list.status).toBe(200);
        expect((list.body.jobs as { id: string }[]).map((j) => j.id)).toEqual([own.jobId]);
        const running = await call(jobList.GET, { path: "/api/ui?status=running" });
        expect((running.body.jobs as { id: string }[]).map((j) => j.id)).toEqual([own.jobId]);
        // A link to the other's job opens no page for it.
        const linked = await call(jobList.GET, { path: `/api/ui?job=${other.jobId}` });
        expect(linked).toMatchObject({ status: 200, body: { targetJobId: null } });
        const target = await call(jobList.GET, { path: `/api/ui?job=${own.jobId}` });
        expect(target).toMatchObject({ status: 200, body: { targetJobId: own.jobId } });
        for (const { body } of [list, running, linked, target]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }
      }
    }
  });

  it("refuses to cancel the other organization's job, and members can't cancel jobs", async () => {
    state.userId = a.adminId;
    expect(await call(jobCancel.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject({
      status: 400,
      body: { error: "That job doesn't exist." },
    });
    expect(
      await call(jobCancel.POST, { method: "POST", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });
    state.userId = b.memberId;
    expect(await call(jobCancel.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject({
      status: 403,
    });
    expect(await getJob(db, b.jobId)).toMatchObject({ status: "running", cancelRequested: false });
  });

  // Last: the triage jobs created here would show on the job lists above.
  it("lists and shows each organization's own triage runs to its members, and 404s on the other's", async () => {
    const triageJobIds = new Map<string, string>();
    for (const tenant of [a, b]) {
      const { job } = await insertJob(db, {
        organizationId: tenant.orgId,
        type: "triage.run",
        taskType: "query",
        pool: "short",
        payload: {
          trigger: {
            kind: "linear.triage",
            context: {
              triageRunId: tenant.triageRunId,
              issue: {
                identifier: `${tenant.name.toUpperCase()}-9`,
                title: `${tenant.name} issue`,
              },
            },
          },
        },
      });
      triageJobIds.set(tenant.name, job.id);
    }
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const list = await call(triageList.GET);
        expect(list.status).toBe(200);
        expect(list.body.runs).toMatchObject([
          { id: own.triageRunId, issue: { identifier: `${own.name.toUpperCase()}-9` } },
        ]);
        const queued = await call(triageList.GET, { path: "/api/ui?status=queued" });
        expect((queued.body.runs as { id: string }[]).map((r) => r.id)).toEqual([own.triageRunId]);
        const failed = await call(triageList.GET, { path: "/api/ui?status=failed" });
        expect(failed).toMatchObject({ status: 200, body: { runs: [], total: 0 } });

        const detail = await call(triageDetail.GET, { params: { id: own.triageRunId } });
        expect(detail).toMatchObject({ status: 200, body: { run: { id: own.triageRunId } } });
        expect((detail.body.run as { jobs: { id: string }[] }).jobs.map((j) => j.id)).toEqual([
          triageJobIds.get(own.name),
        ]);
        for (const { body } of [list, queued, detail]) {
          const json = JSON.stringify(body);
          for (const marker of markers(other)) expect(json).not.toContain(marker);
          expect(json).not.toContain(triageJobIds.get(other.name));
        }

        expect(await call(triageDetail.GET, { params: { id: other.triageRunId } })).toMatchObject({
          status: 404,
        });
        expect(await call(triageDetail.GET, { params: { id: "not-a-uuid" } })).toMatchObject({
          status: 404,
        });
      }
    }
  });

  it("sends a member of both organizations to switch to the triage run's organization", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-triage-member", email: "both-triage@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "member" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;

    const page = `/triage/${b.triageRunId}`;
    const { status, body } = await call(triageDetail.GET, {
      params: { id: b.triageRunId },
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

  describe("organization settings, the organization switcher and chat accounts", () => {
    /** Each tenant's pending invitation, email domain and the admin's linked chat account. */
    const extras = new Map<string, { invitationId: string; domain: string; chatUserId: string }>();

    beforeAll(async () => {
      for (const own of [a, b]) {
        const domain = `${own.name}-mail.io`;
        expect(await addOrganizationDomain(db, own.orgId, domain)).toBe("added");
        const invited = await createInvitation(db, {
          organizationId: own.orgId,
          email: `invitee@${domain}`,
          role: "member",
          invitedBy: own.adminId,
        });
        if (invited.status !== "created") throw new Error(invited.status);
        const chatUserId = `${own.name}-slack-user`;
        await db.insert(chatIdentities).values({
          organizationId: own.orgId,
          platform: "slack",
          externalUserId: chatUserId,
          userId: own.adminId,
          source: "manual",
          displayName: `${own.name} on Slack`,
        });
        extras.set(own.name, { invitationId: invited.invitation.id, domain, chatUserId });
      }
    });

    const extra = (tenant: Tenant) => extras.get(tenant.name)!;
    const otherMarkers = (other: Tenant) => [
      ...markers(other),
      other.adminId,
      other.memberId,
      ...Object.values(extra(other)),
    ];

    it("shows each organization its own settings, and its invitations only to admins", async () => {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const { status, body } = await call(organizationSettings.GET);
          expect(status).toBe(200);
          expect(body).toMatchObject({
            organization: { id: own.orgId, name: own.name },
            isAdmin: userId === own.adminId,
            currentUserId: userId,
            domains: [extra(own).domain],
            invitations:
              userId === own.adminId ? [{ id: extra(own).invitationId, role: "member" }] : [],
          });
          const members = body.members as { id: string }[];
          expect(members.map((m) => m.id)).toEqual(
            expect.arrayContaining([own.adminId, own.memberId]),
          );
          // Users of both organizations (added by earlier tests) are members of both.
          const json = JSON.stringify({
            ...body,
            members: members.filter((m) => !m.id.startsWith("both-")),
          });
          for (const marker of otherMarkers(other)) expect(json).not.toContain(marker);
        }
      }
    });

    it("refuses every organization change outside the active organization, and to members", async () => {
      state.userId = a.adminId;
      const failed = { status: 400, body: { error: expect.any(String) } };
      expect(
        await call(organizationInvitation.DELETE, {
          method: "DELETE",
          params: { id: extra(b).invitationId },
        }),
      ).toMatchObject(failed);
      expect(
        await call(organizationMember.PATCH, {
          method: "PATCH",
          params: { userId: b.memberId },
          body: { role: "admin" },
        }),
      ).toMatchObject({ status: 400, body: { error: "That user is no longer a member." } });
      expect(
        await call(organizationMember.DELETE, { method: "DELETE", params: { userId: b.adminId } }),
      ).toMatchObject(failed);
      expect(
        await call(organizationDomain.DELETE, {
          method: "DELETE",
          params: { domain: extra(b).domain },
        }),
      ).toMatchObject(failed);
      expect(
        await call(organizationInvitation.DELETE, { method: "DELETE", params: { id: "nope" } }),
      ).toMatchObject({ status: 404 });

      // Changes of the active organization stay in it.
      expect(
        await call(organizationSettings.PATCH, { method: "PATCH", body: { name: "Renamed" } }),
      ).toMatchObject({ status: 200 });
      expect(await getOrganization(db, a.orgId)).toMatchObject({ name: "Renamed" });
      expect(await getOrganization(db, b.orgId)).toMatchObject({ name: b.name });
      await call(organizationSettings.PATCH, { method: "PATCH", body: { name: a.name } });
      expect(
        await call(organizationSettings.PATCH, {
          method: "PATCH",
          body: { allowDomainJoin: true },
        }),
      ).toMatchObject({ status: 200 });
      expect(await getOrganization(db, b.orgId)).toMatchObject({ allowDomainJoin: false });
      await call(organizationSettings.PATCH, { method: "PATCH", body: { allowDomainJoin: false } });
      expect(
        await call(organizationDomains.POST, { body: { domain: "added-by-alpha.io" } }),
      ).toMatchObject({ status: 200 });
      expect(await listOrganizationDomains(db, b.orgId)).toEqual([extra(b).domain]);
      await call(organizationDomain.DELETE, {
        method: "DELETE",
        params: { domain: "added-by-alpha.io" },
      });

      // Members change nothing.
      state.userId = a.memberId;
      const forbidden = { status: 403 };
      for (const request of [
        call(organizationSettings.PATCH, { method: "PATCH", body: { name: "Hijacked" } }),
        call(organizationSettings.PATCH, { method: "PATCH", body: { allowDomainJoin: true } }),
        call(organizationInvitations.POST, {
          body: { email: `x@${extra(a).domain}`, role: "admin" },
        }),
        call(organizationInvitation.DELETE, {
          method: "DELETE",
          params: { id: extra(a).invitationId },
        }),
        call(organizationMember.PATCH, {
          method: "PATCH",
          params: { userId: a.memberId },
          body: { role: "admin" },
        }),
        call(organizationMember.DELETE, { method: "DELETE", params: { userId: a.adminId } }),
        call(organizationDomains.POST, { body: { domain: "evil.io" } }),
        call(organizationDomain.DELETE, { method: "DELETE", params: { domain: extra(a).domain } }),
      ]) {
        expect(await request).toMatchObject(forbidden);
      }

      for (const own of [a, b]) {
        expect(await getOrganization(db, own.orgId)).toMatchObject({
          name: own.name,
          allowDomainJoin: false,
        });
        expect(
          (await listPendingInvitationsForOrganization(db, own.orgId)).map((i) => i.id),
        ).toEqual([extra(own).invitationId]);
        expect(await listOrganizationDomains(db, own.orgId)).toEqual([extra(own).domain]);
        expect(await getMembership(db, own.orgId, own.adminId)).toMatchObject({ role: "admin" });
        expect(await getMembership(db, own.orgId, own.memberId)).toMatchObject({ role: "member" });
      }
    });

    it("switches only to the user's own organizations", async () => {
      state.userId = a.adminId;
      state.cookies.clear();
      expect(await call(organizationSwitch.POST, { body: { organizationId: b.orgId } })).toEqual({
        status: 400,
        body: { error: "You are not a member of that organization." },
      });
      expect(await getActiveOrganization(db, a.adminId)).toMatchObject({ id: a.orgId });
      expect(state.cookies.size).toBe(0);

      const [user] = await db
        .insert(users)
        .values({ id: "both-switch-member", email: "both-switch@alpha.io" })
        .returning();
      await db.insert(organizationMembers).values([
        { organizationId: a.orgId, userId: user!.id, role: "member" },
        { organizationId: b.orgId, userId: user!.id, role: "admin" },
      ]);
      await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
      state.userId = user!.id;
      expect(await call(organizationSwitch.POST, { body: { organizationId: b.orgId } })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(await getActiveOrganization(db, user!.id)).toMatchObject({
        id: b.orgId,
        role: "admin",
      });
      expect([...state.cookies.values()]).toEqual([b.orgId]);
      // The settings follow the active organization.
      expect((await call(organizationSettings.GET)).body).toMatchObject({
        organization: { id: b.orgId },
        isAdmin: true,
      });

      // Leaving switches to the user's other organization.
      expect(await call(organizationLeave.POST, { body: {} })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(await getMembership(db, b.orgId, user!.id)).toBeNull();
      expect(await getActiveOrganization(db, user!.id)).toMatchObject({ id: a.orgId });
      expect(await getMembership(db, a.orgId, a.adminId)).toMatchObject({ role: "admin" });
    });

    it("lists and unlinks only the user's own chat accounts", async () => {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        state.userId = own.adminId;
        const { status, body } = await call(chatAccounts.GET);
        expect(status).toBe(200);
        expect(body).toMatchObject({
          identities: [
            {
              organizationId: own.orgId,
              organizationName: own.name,
              externalUserId: extra(own).chatUserId,
            },
          ],
        });
        const json = JSON.stringify(body);
        for (const marker of otherMarkers(other)) expect(json).not.toContain(marker);

        expect(
          await call(chatAccountUnlink.POST, {
            body: {
              organizationId: other.orgId,
              platform: "slack",
              externalUserId: extra(other).chatUserId,
            },
          }),
        ).toEqual({ status: 400, body: { error: "That chat account isn't linked to you." } });
        expect(await listChatIdentities(db, other.adminId)).toHaveLength(1);

        state.userId = own.memberId;
        expect((await call(chatAccounts.GET)).body).toEqual({ identities: [] });
      }

      state.userId = a.adminId;
      expect(
        await call(chatAccountUnlink.POST, {
          body: { organizationId: a.orgId, platform: "slack", externalUserId: extra(a).chatUserId },
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(await listChatIdentities(db, a.adminId)).toEqual([]);
      expect(await listChatIdentities(db, b.adminId)).toHaveLength(1);
    });
  });

  describe("integrations", () => {
    /** Each tenant's Slack workspace and Discord server, one channel of each with its own tasks. */
    const chat = new Map<string, { slackId: string; discordId: string }>();
    const extra = (own: Tenant) => chat.get(own.name)!;
    const markersOf = (own: Tenant) => [
      ...markers(own),
      extra(own).slackId,
      extra(own).discordId,
      `${own.name}-linear`,
      `${own.name}-slack`,
      `${own.name}-discord`,
    ];

    beforeAll(async () => {
      for (const own of [a, b]) {
        expect(
          await saveIntegration(db, {
            organizationId: own.orgId,
            provider: "linear",
            externalId: `${own.name}-linear`,
            name: `${own.name}-linear workspace`,
            credentials: { accessToken: `lin_${own.name}` },
            installedByUserId: own.adminId,
          }),
        ).not.toBe("other_organization");
        const connection = async (platform: "slack" | "discord") => {
          const saved = await saveChatConnection(db, {
            organizationId: own.orgId,
            platform,
            externalId: `${own.name}-${platform}`,
            name: `${own.name}-${platform} workspace`,
            credentials: platform === "slack" ? { botToken: `xoxb-${own.name}` } : null,
            installedByUserId: own.adminId,
          });
          if (saved === "other_organization") throw new Error("setup");
          await upsertChatChannelTaskSetting(db, {
            organizationId: own.orgId,
            connectionId: saved.id,
            channelId:
              platform === "slack"
                ? `slack:C${own.name.toUpperCase()}`
                : `discord:${saved.externalId}:1`,
            askAboutCodeTaskId: "builtin:ask-about-code",
            startWorkTaskId: null,
            updatedBy: own.adminId,
          });
          return saved.id;
        };
        chat.set(own.name, {
          slackId: await connection("slack"),
          discordId: await connection("discord"),
        });
      }
    });

    it("shows each organization's own integrations to its admins only, and none of the other's", async () => {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        state.userId = own.adminId;
        const { status, body } = await call(integrations.GET);
        expect(status).toBe(200);
        expect(body).toMatchObject({
          linear: { workspaceId: `${own.name}-linear` },
          slack: [{ id: extra(own).slackId, installedBy: `admin@${own.name}.io` }],
          discord: [{ id: extra(own).discordId }],
        });
        const connections = (
          body.chatTasks as { connections: { id: string; channels: unknown[] }[] }
        ).connections;
        expect(connections.map((c) => [c.id, c.channels.length])).toEqual(
          expect.arrayContaining([
            [extra(own).slackId, 1],
            [extra(own).discordId, 1],
          ]),
        );
        const json = JSON.stringify(body);
        for (const marker of markersOf(other)) expect(json).not.toContain(marker);

        state.userId = own.memberId;
        expect(await call(integrations.GET)).toMatchObject({ status: 403 });
      }
    });

    it("refuses every integration change on the other organization's connections, and to members", async () => {
      const valid = { askAboutCode: "builtin:ask-about-code", startWork: "builtin:handle-request" };
      state.userId = a.adminId;
      const otherSlack = { id: extra(b).slackId };
      const otherDiscord = { id: extra(b).discordId };
      expect(await call(slackIntegration.DELETE, { method: "DELETE", params: otherSlack })).toEqual(
        { status: 400, body: { error: "That Slack workspace isn't connected." } },
      );
      expect(
        await call(discordIntegration.DELETE, { method: "DELETE", params: otherDiscord }),
      ).toEqual({ status: 400, body: { error: "That Discord server isn't connected." } });
      expect(
        await call(channelTasks.PUT, {
          method: "PUT",
          params: otherSlack,
          body: { channel: "C0123ABCD", ...valid },
        }),
      ).toEqual({ status: 400, body: { error: "That chat connection isn't connected." } });
      expect(
        await call(channelTasks.DELETE, {
          method: "DELETE",
          params: otherSlack,
          body: { channelId: "slack:CBETA" },
        }),
      ).toEqual({ status: 400, body: { error: "That channel has no task overrides." } });
      // Another organization's id under its own platform's route, and a non-uuid.
      expect(
        await call(slackIntegration.DELETE, { method: "DELETE", params: otherDiscord }),
      ).toMatchObject({ status: 400 });
      expect(
        await call(slackIntegration.DELETE, { method: "DELETE", params: { id: "nope" } }),
      ).toMatchObject({ status: 404 });
      expect(
        await call(channelTasks.PUT, { method: "PUT", params: { id: "nope" }, body: {} }),
      ).toMatchObject({ status: 404 });

      // Members can't change anything.
      state.userId = b.memberId;
      for (const result of [
        await call(linearIntegration.DELETE, { method: "DELETE" }),
        await call(slackIntegration.DELETE, { method: "DELETE", params: otherSlack }),
        await call(discordIntegration.DELETE, { method: "DELETE", params: otherDiscord }),
        await call(chatTasks.PUT, { method: "PUT", body: valid }),
        await call(channelTasks.PUT, {
          method: "PUT",
          params: otherSlack,
          body: { channel: "C0123ABCD", ...valid },
        }),
        await call(channelTasks.DELETE, {
          method: "DELETE",
          params: otherSlack,
          body: { channelId: "slack:CBETA" },
        }),
      ]) {
        expect(result).toMatchObject({ status: 403 });
      }

      expect(await listChatConnections(db, b.orgId)).toHaveLength(2);
      expect(await listChatChannelTaskSettings(db, b.orgId)).toHaveLength(2);
      expect(await getIntegration(db, b.orgId, "linear")).not.toBeNull();
    });

    it("changes only the active organization's integrations", async () => {
      state.userId = a.adminId;
      const chosen = {
        askAboutCode: "builtin:ask-about-code",
        startWork: "builtin:handle-request",
      };
      expect(await call(chatTasks.PUT, { method: "PUT", body: chosen })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(
        await call(channelTasks.PUT, {
          method: "PUT",
          params: { id: extra(a).slackId },
          body: { channel: "C0123ABCD", askAboutCode: null, startWork: "builtin:handle-request" },
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(
        await call(channelTasks.DELETE, {
          method: "DELETE",
          params: { id: extra(a).slackId },
          body: { channelId: "slack:CALPHA" },
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(
        (await listChatChannelTaskSettings(db, a.orgId)).map((t) => t.channelId).sort(),
      ).toEqual([`discord:alpha-discord:1`, "slack:C0123ABCD"]);

      expect(
        await call(slackIntegration.DELETE, { method: "DELETE", params: { id: extra(a).slackId } }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(await call(linearIntegration.DELETE, { method: "DELETE" })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(await call(linearIntegration.DELETE, { method: "DELETE" })).toEqual({
        status: 400,
        body: { error: "No Linear workspace is connected." },
      });
      expect(await call(integrations.GET)).toMatchObject({
        status: 200,
        body: { linear: null, slack: [], discord: [{ id: extra(a).discordId }] },
      });

      // The other organization keeps everything.
      expect(await getIntegration(db, b.orgId, "linear")).not.toBeNull();
      expect(await listChatConnections(db, b.orgId)).toHaveLength(2);
      expect(await listChatChannelTaskSettings(db, b.orgId)).toHaveLength(2);
    });
  });
});
