// Every `/api/ui` endpoint against two organizations: a user of one never gets a row of the
// other, gets a 404 on the other's resources, and only creates rows in their own; opening a
// resource of another of their own organizations switches to it (`/api/organizations/enter`).
// Pages read no data (only the signed-in layout lists the user's organizations, tested here
// too), so this is where every page's organization isolation is checked.
import { randomBytes } from "node:crypto";
import {
  addMember,
  addOrganizationDomain,
  chatConnections,
  chatIdentities,
  closeDb,
  createInvitation,
  getActiveOrganization,
  getAllowedTaskTypeDefaults,
  getDesiredHarnessVersion,
  listHostTools,
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
  createReviewRun,
  createRun,
  createTriageRun,
  insertJob,
  enrollHarness,
  ensureChatThread,
  findings,
  getHarnessOverview,
  getRepository,
  getJob,
  getRun,
  harnesses,
  integrations as integrationRows,
  jobs,
  runActivities,
  listHarnessHostTools,
  mapThreadRun,
  recordWebhookEvent,
  organizationMembers,
  organizations,
  ralphRuns,
  reviewRuns,
  scmConnections,
  setActiveOrganization,
  settingsChanges,
  triageRuns,
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
import { eq, inArray } from "drizzle-orm";
import { jwtVerify } from "jose";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getBuiltinTask } from "@omniralph/tasks";
import { assertRole, type Role } from "@/lib/auth/roles";
import {
  ENTER_ORGANIZATION_PATH,
  ORGANIZATION_COOKIE,
  ORGANIZATION_SCOPE_COOKIE,
} from "@/lib/auth/routes";
import type { RoutingPreview } from "@/lib/api/routing-rules";
import type * as LinearClient from "@/lib/linear/client";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dispatch", () => ({
  getDispatcher: () => ({
    createAndPublish: async () => ({
      job: { id: "00000000-0000-4000-8000-000000000000" },
      created: true,
    }),
    cancel: async () => "cancel_requested",
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
  /** Each organization's Linear workspace, by organization ID (else none is connected). */
  linear: new Map<string, FakeLinearGateway>(),
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
vi.mock("@/lib/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) =>
      state.linear.get(options.organizationId) ?? actual.getLinearGateway(options),
  };
});
// The signed-in user with their real role in their active organization.
vi.mock("@/lib/auth/session", async () => {
  const { getActiveOrganization, listOrganizationsForUser } = await import("@omniralph/db");
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
    getCurrentUser: async () => (state.userId === null ? null : { id: state.userId }),
    requireUser: async (role: Role = "member") => current(role),
    requireSignedInUser: async () => current("member"),
    requirePageUser: async (role: Role = "member") => current(role),
    getOrganizationMemberships: async () =>
      state.userId === null
        ? []
        : (await listOrganizationsForUser(state.db, state.userId)).map(({ id, name, role }) => ({
            id,
            name,
            role,
          })),
    getOrganizationScope: async () => {
      const { organization, role } = await current("member");
      return { kind: "single", organization: { ...organization, role } };
    },
  };
});
// The signed-in layout's shell is a client component; the test reads the props it gets.
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("../../(app)/legacy-frame", () => ({ LegacyFrame: () => null }));

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
const runRetry = await import("./runs/[id]/retry/route");
const runAnswer = await import("./runs/[id]/answer/route");
const runTranscript = await import("./runs/[id]/attempts/[attemptId]/transcript/route");
const routingPreview = await import("./routing/preview/route");
const liveToken = await import("./live/token/route");
const reviewList = await import("./reviews/route");
const reviewDetail = await import("./reviews/[id]/route");
const reviewRerun = await import("./reviews/[id]/rerun/route");
const jobList = await import("./jobs/route");
const jobCancel = await import("./jobs/[id]/cancel/route");
const jobRerun = await import("./jobs/[id]/rerun/route");
const triageList = await import("./triage/route");
const triageDetail = await import("./triage/[id]/route");
const analytics = await import("./analytics/route");
const runAnalytics = await import("./analytics/runs/route");
const settingsHistory = await import("./settings-history/route");
const inboxFeed = await import("./inbox/route");
const inboxCounts = await import("./inbox/counts/route");
const inboxItem = await import("./inbox/items/[key]/route");
const connectionDeliveries = await import("./connections/[kind]/[id]/deliveries/route");
const deliveryDetail = await import("./deliveries/[id]/route");
const deliveryReplay = await import("./deliveries/[id]/replay/route");
const trackerStateMapping = await import("./trackers/[integrationId]/state-mapping/route");
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
const agentList = await import("./agents/route");
const agentDetail = await import("./agents/[id]/route");
const agentClone = await import("./agents/[id]/clone/route");
const agentFormOptions = await import("./agents/form-options/route");
const taskList = await import("./tasks/route");
const taskDetail = await import("./tasks/[id]/route");
const taskClone = await import("./tasks/[id]/clone/route");
const taskFormOptions = await import("./tasks/form-options/route");
const harnessDefaults = await import("./harness-defaults/route");
const hostToolCatalog = await import("./host-tools/route");
const hostTool = await import("./host-tools/[id]/route");
const { GET: enterOrganization } = await import("../../api/organizations/enter/route");
const { default: AppLayout } = await import("../../(app)/layout");
const { readEnterOrganizationToken, createEnterOrganizationPath } =
  await import("@/lib/organizations/enter");

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
      depth: "standard",
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

  // First: later tests add jobs, reviews and runs that these counts would include.
  it("counts only each organization's own reviews, findings, jobs and runs in analytics", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const all = await call(analytics.GET);
        expect(all).toMatchObject({
          status: 200,
          body: {
            repositories: [{ id: own.repoId, fullPath: own.repoPath }],
            analytics: {
              totals: { reviews: 1 },
              findingsBySeverity: { high: 1 },
              jobsByHarness: [{ agent: { id: own.harnessId }, total: 1 }],
            },
            ralph: { totals: { runs: 1 } },
            params: { days: 30, repositoryId: null },
          },
        });
        const repo = await call(analytics.GET, { path: `/api/ui?days=7&repo=${own.repoId}` });
        expect(repo).toMatchObject({
          status: 200,
          body: {
            analytics: { totals: { reviews: 1 } },
            params: { days: 7, repositoryId: own.repoId },
          },
        });
        // The other's repository as the filter is ignored.
        const theirs = await call(analytics.GET, { path: `/api/ui?repo=${other.repoId}` });
        expect(theirs).toMatchObject({
          status: 200,
          body: { analytics: { totals: { reviews: 1 } }, params: { repositoryId: null } },
        });
        for (const { body } of [all, repo, theirs]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }
      }
    }
    state.userId = null;
    expect((await call(analytics.GET)).status).toBe(401);
  });

  it("aggregates only each organization's own runs in run analytics, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const active = await call(runAnalytics.GET, { path: "/api/ui?days=7" });
        expect(active).toMatchObject({
          status: 200,
          body: { byOrganization: [{ organization: { id: own.orgId, name: own.name } }] },
        });
        const all = await call(runAnalytics.GET, { path: "/api/ui?organization=all" });
        expect(all).toMatchObject({
          status: 200,
          body: { byOrganization: [{ organization: { id: own.orgId } }] },
        });
        expect((all.body.byOrganization as unknown[]).length).toBe(1);
        const repo = await call(runAnalytics.GET, { path: `/api/ui?repository=${own.repoId}` });
        expect(repo.status).toBe(200);
        for (const { body } of [active, all, repo]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }
        expect(
          await call(runAnalytics.GET, { path: `/api/ui?repository=${other.repoId}` }),
        ).toMatchObject({ status: 404 });
        expect(
          await call(runAnalytics.GET, { path: `/api/ui?organization=${other.orgId}` }),
        ).toMatchObject({ status: 404 });
      }
    }
    state.userId = null;
    expect((await call(runAnalytics.GET)).status).toBe(401);
  });

  it("lists only each organization's own settings history, to members, and 404s on the other's", async () => {
    for (const tenant of [a, b]) {
      await db.insert(settingsChanges).values({
        organizationId: tenant.orgId,
        section: "repository.reviews",
        subjectId: tenant.repoId,
        actorName: `Admin of ${tenant.name}`,
        changes: [{ field: "onPush", label: "Review on push", before: "On", after: "Off" }],
      });
    }
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const path = (subject: string, extra = "") =>
          `/api/ui?section=repository.reviews&subject=${subject}${extra}`;
        const mine = await call(settingsHistory.GET, { path: path(own.repoId) });
        expect(mine).toMatchObject({
          status: 200,
          body: {
            latest: { organization: { id: own.orgId }, actor: { name: `Admin of ${own.name}` } },
          },
        });
        // The other's repository as the subject finds nothing, even with every organization.
        for (const extra of ["", "&organization=all"]) {
          expect(
            await call(settingsHistory.GET, { path: path(other.repoId, extra) }),
          ).toMatchObject({ status: 200, body: { latest: null, entries: [], next: null } });
        }
        for (const marker of markers(other)) {
          expect(JSON.stringify(mine.body)).not.toContain(marker);
        }
        expect(
          await call(settingsHistory.GET, {
            path: path(other.repoId, `&organization=${other.orgId}`),
          }),
        ).toMatchObject({ status: 404 });
      }
    }
    state.userId = null;
    expect(
      (await call(settingsHistory.GET, { path: "/api/ui?section=routing_rules" })).status,
    ).toBe(401);
  });

  it("lists only each organization's own Inbox items and counts, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const responses = [];
        for (const tab of ["needs-you", "problems", "running"]) {
          for (const organization of [undefined, "all", own.orgId]) {
            const query = new URLSearchParams({ tab, ...(organization && { organization }) });
            const response = await call(inboxFeed.GET, { path: `/api/ui?${query}` });
            expect(response.status).toBe(200);
            for (const item of response.body.items as { organization: { id: string } }[]) {
              expect(item.organization.id).toBe(own.orgId);
            }
            responses.push(response);
          }
        }
        const running = await call(inboxFeed.GET, { path: "/api/ui?tab=running&organization=all" });
        expect((running.body.items as { run: { id: string } }[]).map((i) => i.run.id)).toContain(
          own.triageRunId,
        );
        const count = await call(inboxCounts.GET, { path: "/api/ui?organization=all" });
        expect(count).toMatchObject({ status: 200 });
        expect(count.body.running).toBe((running.body.items as unknown[]).length);
        for (const { body } of [...responses, count]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }
        expect(
          await call(inboxFeed.GET, { path: `/api/ui?organization=${other.orgId}` }),
        ).toMatchObject({ status: 404 });
        expect(
          await call(inboxCounts.GET, { path: `/api/ui?organization=${other.orgId}` }),
        ).toMatchObject({ status: 404 });
      }
    }
    state.userId = null;
    expect((await call(inboxFeed.GET)).status).toBe(401);
    expect((await call(inboxCounts.GET)).status).toBe(401);
  });

  it("spans only the user's memberships with organization=all in the Inbox", async () => {
    // A third organization the user isn't a member of, with an item on every tab.
    const [owner, user] = await db
      .insert(users)
      .values([
        { id: "gamma-admin", email: "admin@gamma.io" },
        { id: "inbox-both-member", email: "inbox-both@alpha.io" },
      ])
      .returning();
    const c = await createOrganization(db, { name: "gamma", createdBy: owner!.id });
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "member" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    // Each organization gets a Needs you item (a stopped epic), a Problems item (a failed
    // triage run) and a Running item (its running epic; gamma a running triage run).
    const ralph: string[] = [];
    const triage: string[] = [];
    const items = new Map<string, string[]>();
    for (const [orgId, name, repositoryId] of [
      [a.orgId, a.name, a.repoId],
      [b.orgId, b.name, b.repoId],
      [c.id, "gamma", null],
    ] as const) {
      const { run: stopped } = await createRun(db, {
        organizationId: orgId,
        linearIssueId: `${name}-all-stopped-issue`,
        linearIdentifier: `${name.toUpperCase()}-77`,
        linearTitle: `${name} stopped for all`,
        linearUrl: null,
        linearAgentSessionId: `${name}-all-stopped-session`,
        kind: "children",
        repositoryId,
        branch: `${name}-all-stopped`,
        baseBranch: "main",
      });
      await updateRun(db, stopped.id, { status: "stopped" });
      ralph.push(stopped.id);
      const { run: failed } = await createTriageRun(db, {
        organizationId: orgId,
        linearIssueId: `${name}-all-failed-issue`,
        linearAgentSessionId: `${name}-all-failed-session`,
        trigger: "mention",
      });
      await db.update(triageRuns).set({ status: "failed" }).where(eq(triageRuns.id, failed.id));
      triage.push(failed.id);
      const ids = [stopped.id, failed.id];
      if (orgId === c.id) {
        const { run: running } = await createTriageRun(db, {
          organizationId: orgId,
          linearIssueId: "gamma-all-running-issue",
          linearAgentSessionId: "gamma-all-running-session",
          trigger: "mention",
        });
        await db.update(triageRuns).set({ status: "running" }).where(eq(triageRuns.id, running.id));
        triage.push(running.id);
        ids.push(running.id);
      }
      items.set(orgId, ids);
    }
    const cIds = [c.id, ...items.get(c.id)!];

    try {
      state.userId = user!.id;
      type Item = { organization: { id: string }; run: { id: string } | null };
      const feed = async (tab: string, organization: string) => {
        const response = await call(inboxFeed.GET, {
          path: `/api/ui?tab=${tab}&organization=${organization}`,
        });
        expect(response.status).toBe(200);
        return response;
      };
      const expected = {
        "needs-you": [items.get(a.orgId)![0], items.get(b.orgId)![0]],
        problems: [items.get(a.orgId)![1], items.get(b.orgId)![1]],
        running: [a.runId, b.runId],
      };
      for (const [tab, runIds] of Object.entries(expected)) {
        const all = await feed(tab, "all");
        const listed = all.body.items as Item[];
        expect(listed.map((i) => i.run?.id)).toEqual(expect.arrayContaining(runIds));
        expect(new Set(listed.map((i) => i.organization.id))).toEqual(new Set([a.orgId, b.orgId]));
        for (const marker of cIds) expect(JSON.stringify(all.body)).not.toContain(marker);
        // organization=all is exactly the union of the user's two organizations.
        const own = [
          ...((await feed(tab, a.orgId)).body.items as Item[]),
          ...((await feed(tab, b.orgId)).body.items as Item[]),
        ];
        expect(listed).toHaveLength(own.length);
      }
      const counts = await call(inboxCounts.GET, { path: "/api/ui?organization=all" });
      expect(counts.status).toBe(200);
      const countsOf = async (organization: string) =>
        (await call(inboxCounts.GET, { path: `/api/ui?organization=${organization}` })).body as {
          needsYou: number;
          problems: number;
          running: number;
        };
      const [countA, countB] = [await countsOf(a.orgId), await countsOf(b.orgId)];
      expect(counts.body).toEqual({
        needsYou: countA.needsYou + countB.needsYou,
        problems: countA.problems + countB.problems,
        running: countA.running + countB.running,
      });
      expect(countA.needsYou).toBeGreaterThan(0);
      expect(countA.problems).toBeGreaterThan(0);
      expect(countA.running).toBeGreaterThan(0);
      // Gamma isn't one of the user's organizations.
      expect(await call(inboxFeed.GET, { path: `/api/ui?organization=${c.id}` })).toMatchObject({
        status: 404,
      });
      expect(await call(inboxCounts.GET, { path: `/api/ui?organization=${c.id}` })).toMatchObject({
        status: 404,
      });
    } finally {
      await db.delete(ralphRuns).where(inArray(ralphRuns.id, ralph));
      await db.delete(triageRuns).where(inArray(triageRuns.id, triage));
      await db.delete(organizations).where(eq(organizations.id, c.id));
      await db.delete(users).where(inArray(users.id, [owner!.id, user!.id]));
    }
  });

  it("lets members act on their organization's Inbox items, and 404s on the other's", async () => {
    type Item = { key: string; actions: string[] };
    const itemsOf = async (userId: string): Promise<Item[]> => {
      state.userId = userId;
      const items: Item[] = [];
      for (const tab of ["needs-you", "problems", "running"]) {
        const response = await call(inboxFeed.GET, {
          path: `/api/ui?tab=${tab}&organization=all`,
        });
        items.push(...(response.body.items as Item[]));
      }
      return items;
    };
    const act = (key: string, body: Record<string, unknown>) =>
      call(inboxItem.POST, { params: { key: encodeURIComponent(key) }, body });
    const until = () => new Date(Date.now() + 3_600_000).toISOString();
    // A stopped epic in each organization: a Needs you item with Done, Snooze and Resume.
    const stopped: string[] = [];
    for (const own of [a, b]) {
      const { run } = await createRun(db, {
        organizationId: own.orgId,
        linearIssueId: `${own.name}-stopped-issue`,
        linearIdentifier: `${own.name.toUpperCase()}-9`,
        linearTitle: `${own.name} stopped epic`,
        linearUrl: null,
        linearAgentSessionId: `${own.name}-stopped-session`,
        kind: "children",
        repositoryId: own.repoId,
        branch: `${own.name}-stopped`,
        baseBranch: "main",
      });
      await updateRun(db, run.id, { status: "stopped" });
      stopped.push(run.id);
    }
    try {
      await actOnItems();
    } finally {
      await db.delete(ralphRuns).where(inArray(ralphRuns.id, stopped));
    }
    state.userId = null;
    expect((await act("stopped:x", { action: "done" })).status).toBe(401);

    async function actOnItems() {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const theirs = await itemsOf(other.memberId);
        expect(theirs.length).toBeGreaterThan(0);
        const mine = await itemsOf(own.memberId);
        const snoozable = mine.find((i) => i.actions.includes("snooze"));
        expect(snoozable, "the organization has an item to snooze").toBeDefined();
        // A member snoozes and restores their own organization's item.
        expect(await act(snoozable!.key, { action: "snooze", until: until() })).toMatchObject({
          status: 200,
          body: { key: snoozable!.key, state: "snoozed" },
        });
        expect(await act(snoozable!.key, { action: "restore" })).toMatchObject({ status: 200 });
        // Every action on the other organization's items finds nothing.
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          for (const { key } of theirs) {
            for (const action of [
              "done",
              "skip",
              "snooze",
              "restore",
              "start_anyway",
              "resume",
              "retry",
            ]) {
              expect(await act(key, { action, until: until() })).toMatchObject({
                status: 404,
                body: { error: "This item was already handled." },
              });
            }
          }
        }
      }
    }
  });

  it("lists and shows each organization's webhook deliveries to its members, and 404s on the other's", async () => {
    const linear = new Map<string, string>();
    const deliveries = new Map<string, { scm: string; linear: string }>();
    try {
      for (const own of [a, b]) {
        const integration = await saveIntegration(db, {
          organizationId: own.orgId,
          provider: "linear",
          externalId: `${own.name}-delivery-workspace`,
          name: `${own.name} workspace`,
          credentials: { accessToken: "t" },
          installedByUserId: null,
        });
        if (integration === "other_organization") throw new Error("setup");
        linear.set(own.orgId, integration.id);
        const record = (source: { scmConnectionId: string } | { integrationId: string }) =>
          recordWebhookEvent(db, {
            organizationId: own.orgId,
            provider: "scmConnectionId" in source ? "github" : "linear",
            source,
            repositoryId: "scmConnectionId" in source ? own.repoId : null,
            event: "pull_request.opened",
            rawBody: JSON.stringify({ marker: `${own.name}-delivery-payload` }),
            outcome: "ignored",
            reasonCode: "draft",
            reason: "Reviews of draft pull requests are off for this repo",
          });
        deliveries.set(own.orgId, {
          scm: await record({ scmConnectionId: own.connectionId }),
          linear: await record({ integrationId: integration.id }),
        });
      }
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const ownDeliveries = deliveries.get(own.orgId)!;
        const otherDeliveries = deliveries.get(other.orgId)!;
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const scm = await call(connectionDeliveries.GET, {
            params: { kind: "scm", id: own.connectionId },
          });
          const tracker = await call(connectionDeliveries.GET, {
            params: { kind: "linear", id: linear.get(own.orgId)! },
          });
          const shown = await call(deliveryDetail.GET, { params: { id: ownDeliveries.scm } });
          expect(scm.status).toBe(200);
          expect(tracker.status).toBe(200);
          expect(shown).toMatchObject({
            status: 200,
            body: { payload: { marker: `${own.name}-delivery-payload` } },
          });
          expect((scm.body.deliveries as { id: string }[]).map((d) => d.id)).toEqual([
            ownDeliveries.scm,
          ]);
          expect((tracker.body.deliveries as { id: string }[]).map((d) => d.id)).toEqual([
            ownDeliveries.linear,
          ]);
          for (const { body } of [scm, tracker, shown]) {
            for (const marker of [...markers(other), `${other.name}-delivery-payload`]) {
              expect(JSON.stringify(body)).not.toContain(marker);
            }
          }
          for (const params of [
            { kind: "scm", id: other.connectionId },
            { kind: "linear", id: linear.get(other.orgId)! },
          ]) {
            expect(await call(connectionDeliveries.GET, { params })).toMatchObject({
              status: 404,
            });
          }
          for (const id of [otherDeliveries.scm, otherDeliveries.linear]) {
            expect(await call(deliveryDetail.GET, { params: { id } })).toMatchObject({
              status: 404,
            });
            expect(
              await call(deliveryReplay.POST, { params: { id }, method: "POST" }),
            ).toMatchObject({ status: 404 });
          }
        }
        // A member replays their own organization's delivery.
        state.userId = own.memberId;
        const replayed = await call(deliveryReplay.POST, {
          params: { id: ownDeliveries.linear },
          method: "POST",
        });
        expect(replayed).toMatchObject({
          status: 200,
          body: {
            replayOfId: ownDeliveries.linear,
            organization: { id: own.orgId },
            replayedBy: { id: own.memberId },
          },
        });
        expect(
          (await call(deliveryDetail.GET, { params: { id: ownDeliveries.linear } })).body.replays,
        ).toEqual([expect.objectContaining({ id: replayed.body.id })]);
      }
      state.userId = null;
      expect(
        (await call(connectionDeliveries.GET, { params: { kind: "scm", id: a.connectionId } }))
          .status,
      ).toBe(401);
    } finally {
      for (const id of linear.values()) {
        await db.delete(integrationRows).where(eq(integrationRows.id, id));
      }
    }
  });

  it("shows each organization's own tracker state mapping to its members, saves it for its admins, and 404s on the other's", async () => {
    const linear = new Map<string, string>();
    const mapping = {
      ready: { types: ["unstarted", "started"] },
      needsRefining: { types: ["backlog"] },
      teams: {},
    };
    try {
      for (const own of [a, b]) {
        const integration = await saveIntegration(db, {
          organizationId: own.orgId,
          provider: "linear",
          externalId: `${own.name}-mapping-workspace`,
          name: `${own.name} workspace`,
          credentials: { accessToken: "t" },
          installedByUserId: null,
        });
        if (integration === "other_organization") throw new Error("setup");
        linear.set(own.orgId, integration.id);
        const workspace = new FakeLinearGateway();
        workspace.teams = [{ id: `${own.name}-team`, key: "ENG", name: `${own.name} team` }];
        state.linear.set(own.orgId, workspace);
      }
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const params = { integrationId: linear.get(own.orgId)! };
        const otherParams = { integrationId: linear.get(other.orgId)! };
        const path = `/api/ui/trackers/${params.integrationId}/state-mapping`;
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const shown = await call(trackerStateMapping.GET, { params, path });
          expect(shown.status).toBe(200);
          expect(shown.body).toMatchObject({ integrationId: params.integrationId });
          for (const marker of markers(other)) {
            expect(JSON.stringify(shown.body)).not.toContain(marker);
          }
          expect(JSON.stringify(shown.body)).not.toContain(`${other.name}-team`);
          expect(await call(trackerStateMapping.GET, { params: otherParams, path })).toMatchObject({
            status: 404,
          });
          expect(
            await call(trackerStateMapping.PUT, {
              params: otherParams,
              path,
              method: "PUT",
              body: mapping,
            }),
          ).toMatchObject({ status: 404 });
        }
        state.userId = own.memberId;
        expect(
          await call(trackerStateMapping.PUT, { params, path, method: "PUT", body: mapping }),
        ).toMatchObject({ status: 403 });
        state.userId = own.adminId;
        expect(
          await call(trackerStateMapping.PUT, { params, path, method: "PUT", body: mapping }),
        ).toMatchObject({ status: 200, body: { mapping } });
      }
      state.userId = null;
      expect(
        (
          await call(trackerStateMapping.GET, {
            params: { integrationId: linear.get(a.orgId)! },
          })
        ).status,
      ).toBe(401);
    } finally {
      state.linear.clear();
      for (const id of linear.values()) {
        await db.delete(integrationRows).where(eq(integrationRows.id, id));
      }
    }
  });

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
      // Harness pages are admin-only.
      state.userId = own.memberId;
      for (const handler of [harnessDetail.GET, harnessInstallables.GET, harnessHostTools.GET]) {
        expect(await call(handler, { params: ownParams })).toMatchObject({ status: 403 });
      }
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
        body: { config },
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
      expect(coding).toMatchObject({
        status: 200,
        body: { settings: { storyTaskId: "builtin:implement-story" } },
      });
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
      depth: "deep",
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
        body: { ...(coding.settings as object), storyTaskId: "builtin:handle-request" },
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
      reviewDepth: "standard",
      enabled: null,
      queryEnabled: null,
      ralphEnabled: null,
      storyTaskId: "builtin:implement-story",
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

  it("lists and shows each organization's own runs to its members, and 404s on the other's", async () => {
    // An attempt of each epic, with a transcript.
    const attempts = new Map<string, string>();
    for (const tenant of [a, b]) {
      const [job] = await db
        .insert(jobs)
        .values({
          organizationId: tenant.orgId,
          type: "ralph.story",
          taskType: "coding",
          ralphRunId: tenant.runId,
          ralphStoryId: tenant.storyId,
        })
        .returning();
      await db.insert(runActivities).values({
        jobId: job!.id,
        organizationId: tenant.orgId,
        type: "thought",
        body: tenant.name,
      });
      attempts.set(tenant.orgId, job!.id);
    }
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const [userId, role] of [
        [own.adminId, "admin"],
        [own.memberId, "member"],
      ] as const) {
        state.userId = userId;
        const list = await call(runList.GET);
        expect(list.status).toBe(200);
        // Its triage run (newer) and its epic; the legacy review job has no run.
        expect((list.body.runs as { id: string }[]).map((r) => r.id)).toEqual([
          own.triageRunId,
          own.runId,
        ]);
        expect(list.body.runs).toMatchObject([
          { kind: "triage", organization: { id: own.orgId, name: own.name, role } },
          { kind: "epic", organization: { id: own.orgId, name: own.name, role } },
        ]);
        // The other's repository as the filter finds nothing.
        const filtered = await call(runList.GET, {
          path: `/api/ui?repository=${other.repoId}`,
        });
        expect(filtered).toMatchObject({ status: 200, body: { runs: [], nextCursor: null } });
        // The other organization isn't one of theirs; all of theirs is only their own.
        expect(
          await call(runList.GET, { path: `/api/ui?organization=${other.orgId}` }),
        ).toMatchObject({ status: 404 });
        const all = await call(runList.GET, { path: "/api/ui?organization=all" });
        expect((all.body.runs as { id: string }[]).map((r) => r.id)).toEqual([
          own.triageRunId,
          own.runId,
        ]);
        for (const { body } of [filtered, all]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }

        const detail = await call(runDetail.GET, { params: { id: own.runId } });
        expect(detail).toMatchObject({
          status: 200,
          body: { id: own.runId, organization: { id: own.orgId, name: own.name, role } },
        });
        expect(JSON.stringify(detail.body)).toContain(own.storyId);
        const triageDetail = await call(runDetail.GET, { params: { id: own.triageRunId } });
        expect(triageDetail).toMatchObject({ status: 200, body: { id: own.triageRunId } });
        const ownAttempt = attempts.get(own.orgId)!;
        const otherAttempt = attempts.get(other.orgId)!;
        const transcript = await call(runTranscript.GET, {
          params: { id: own.runId, attemptId: ownAttempt },
        });
        expect(transcript).toMatchObject({ status: 200, body: { events: [{ body: own.name }] } });
        for (const { body } of [list, detail, triageDetail, transcript]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }

        for (const id of [other.runId, other.triageRunId, "not-a-uuid"]) {
          expect(await call(runDetail.GET, { params: { id } })).toMatchObject({ status: 404 });
        }
        // The other's attempt, through their run or through one's own.
        for (const [id, attemptId] of [
          [other.runId, otherAttempt],
          [own.runId, otherAttempt],
        ] as const) {
          expect(await call(runTranscript.GET, { params: { id, attemptId } })).toMatchObject({
            status: 404,
          });
        }
      }
    }
    await db.delete(jobs).where(inArray(jobs.id, [...attempts.values()]));
  });

  it("lists and shows each organization's own review runs and asks, and 404s on the other's", async () => {
    // Each organization: a review run with a pass and an attempt, and an ask from Slack.
    const seeded = new Map<string, { reviewRunId: string; askId: string; attempts: string[] }>();
    const jobIds: string[] = [];
    const reviewRunIds: string[] = [];
    const chatConnectionIds: string[] = [];
    for (const tenant of [a, b]) {
      const reviewRun = await createReviewRun(db, {
        organizationId: tenant.orgId,
        repositoryId: tenant.repoId,
        prNumber: 8,
        headSha: "c".repeat(40),
        baseSha: "d".repeat(40),
        trigger: "webhook",
        mode: "full",
        depth: "standard",
      });
      reviewRunIds.push(reviewRun.id);
      await createReview(db, {
        reviewRunId: reviewRun.id,
        repositoryId: tenant.repoId,
        prNumber: 8,
        prTitle: `${tenant.name} reviewed change`,
        headSha: "c".repeat(40),
        baseSha: "d".repeat(40),
        trigger: "webhook",
        depth: "standard",
        model: null,
        budget: 100_000,
      });
      const { job: reviewJob } = await insertJob(db, {
        organizationId: tenant.orgId,
        type: "review.task",
        taskType: "review",
        repositoryId: tenant.repoId,
        reviewRunId: reviewRun.id,
      });
      const connection = await saveChatConnection(db, {
        organizationId: tenant.orgId,
        platform: "slack",
        externalId: `${tenant.name}-runs-team`,
        name: `${tenant.name} runs Slack`,
        credentials: null,
        installedByUserId: null,
      });
      if (connection === "other_organization") throw new Error("setup");
      chatConnectionIds.push(connection.id);
      const thread = (await ensureChatThread(db, {
        connectionId: connection.id,
        externalThreadId: `slack:C${tenant.name.toUpperCase()}1:1.1`,
        channelId: `slack:C${tenant.name.toUpperCase()}1`,
        startedByExternalUserId: "U1",
      }))!;
      const { job: askJob } = await insertJob(db, {
        organizationId: tenant.orgId,
        type: "chat.ask",
        taskType: "query",
        repositoryId: tenant.repoId,
        payload: {
          trigger: { kind: "chat.request", context: { question: `${tenant.name} question` } },
        },
      });
      const ask = (await mapThreadRun(db, {
        organizationId: tenant.orgId,
        chatThreadId: thread.id,
        jobId: askJob.id,
      }))!;
      for (const job of [reviewJob, askJob]) {
        await db.insert(runActivities).values({
          jobId: job.id,
          organizationId: tenant.orgId,
          type: "thought",
          body: `${tenant.name} ${job.type}`,
        });
        jobIds.push(job.id);
      }
      seeded.set(tenant.orgId, {
        reviewRunId: reviewRun.id,
        askId: ask.id,
        attempts: [reviewJob.id, askJob.id],
      });
    }

    try {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const mine = seeded.get(own.orgId)!;
        const theirs = seeded.get(other.orgId)!;
        const theirMarkers = [
          ...markers(other),
          theirs.reviewRunId,
          theirs.askId,
          ...theirs.attempts,
          `${other.name} question`,
          `${other.name} reviewed change`,
        ];
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const lists = [];
          for (const path of [
            "/api/ui",
            "/api/ui?organization=all",
            `/api/ui?organization=${own.orgId}`,
          ]) {
            const list = await call(runList.GET, { path });
            expect(list.status).toBe(200);
            const runs = list.body.runs as {
              id: string;
              kind: string;
              organization: { id: string };
            }[];
            expect(new Set(runs.map((r) => r.id))).toEqual(
              new Set([own.triageRunId, own.runId, mine.reviewRunId, mine.askId]),
            );
            expect(runs.find((r) => r.id === mine.reviewRunId)).toMatchObject({ kind: "review" });
            expect(runs.find((r) => r.id === mine.askId)).toMatchObject({ kind: "ask" });
            lists.push(list);
          }
          for (const kind of ["review", "ask"]) {
            const byKind = await call(runList.GET, {
              path: `/api/ui?organization=all&kind=${kind}`,
            });
            expect(byKind.status).toBe(200);
            expect((byKind.body.runs as { id: string }[]).map((r) => r.id)).toEqual([
              kind === "review" ? mine.reviewRunId : mine.askId,
            ]);
            lists.push(byKind);
          }

          const details = [];
          for (const [id, attemptId] of [
            [mine.reviewRunId, mine.attempts[0]!],
            [mine.askId, mine.attempts[1]!],
          ] as const) {
            const detail = await call(runDetail.GET, { params: { id } });
            expect(detail).toMatchObject({
              status: 200,
              body: { id, organization: { id: own.orgId, name: own.name } },
            });
            const transcript = await call(runTranscript.GET, { params: { id, attemptId } });
            expect(transcript).toMatchObject({
              status: 200,
              body: { events: [{ body: expect.stringContaining(own.name) }] },
            });
            details.push(detail, transcript);
          }
          for (const { body } of [...lists, ...details]) {
            for (const marker of theirMarkers) expect(JSON.stringify(body)).not.toContain(marker);
          }

          // The other's review run and ask, and their attempts through one's own runs.
          for (const id of [theirs.reviewRunId, theirs.askId]) {
            expect(await call(runDetail.GET, { params: { id } })).toMatchObject({ status: 404 });
          }
          for (const [id, attemptId] of [
            [theirs.reviewRunId, theirs.attempts[0]!],
            [theirs.askId, theirs.attempts[1]!],
            [mine.reviewRunId, theirs.attempts[0]!],
            [mine.askId, theirs.attempts[1]!],
          ] as const) {
            expect(await call(runTranscript.GET, { params: { id, attemptId } })).toMatchObject({
              status: 404,
            });
          }
        }
      }
    } finally {
      await db.delete(jobs).where(inArray(jobs.id, jobIds));
      await db.delete(reviewRuns).where(inArray(reviewRuns.id, reviewRunIds));
      await db.delete(chatConnections).where(inArray(chatConnections.id, chatConnectionIds));
    }
  });

  it("refuses to stop the other organization's run, and lets its own members stop it", async () => {
    state.userId = a.adminId;
    expect(await call(runStop.POST, { method: "POST", params: { id: b.runId } })).toMatchObject({
      status: 404,
      body: { error: "That run doesn't exist." },
    });
    expect(
      await call(runStop.POST, { method: "POST", params: { id: b.triageRunId } }),
    ).toMatchObject({ status: 404 });
    expect(
      await call(runStop.POST, { method: "POST", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });
    expect((await getRun(db, b.runId))!.status).toBe("running");
    state.userId = b.memberId;
    expect(await call(runStop.POST, { method: "POST", params: { id: b.runId } })).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect((await getRun(db, b.runId))!.status).toBe("stopped");
    await updateRun(db, b.runId, { status: "running" });
  });

  it("refuses to retry the other organization's run, and lets its own members retry", async () => {
    const retry = (id: string) =>
      call(runRetry.POST, { params: { id }, body: { target: { kind: "run" } } });
    state.userId = a.memberId;
    expect(await retry(b.runId)).toMatchObject({
      status: 404,
      body: { error: "That run doesn't exist." },
    });
    expect(await retry("not-a-uuid")).toMatchObject({ status: 404 });
    state.userId = a.adminId;
    expect(await retry(b.runId)).toMatchObject({ status: 404 });
    expect((await getRun(db, b.runId))!.status).toBe("running");

    // Its own member reaches it: a running run has nothing to retry.
    state.userId = b.memberId;
    expect(await retry(b.runId)).toMatchObject({
      status: 400,
      body: { error: "This run is running, so there's nothing to retry." },
    });
    // Stopped, it resumes.
    await updateRun(db, b.runId, { status: "stopped" });
    // (Its organization has no Linear workspace: the run waits for the reconcile cron to advance it.)
    expect(await retry(b.runId)).toMatchObject({
      status: 200,
      body: { id: b.runId, status: "queued" },
    });
    expect((await getRun(db, b.runId))!.status).toBe("pending");
    await updateRun(db, b.runId, { status: "running" });
  });

  it("refuses to answer the other organization's run's question, and lets its own members answer", async () => {
    const { job } = await insertJob(db, {
      organizationId: b.orgId,
      type: "ralph.story",
      taskType: "coding",
      ralphRunId: b.runId,
    });
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    await updateRun(db, b.runId, {
      permission: {
        requestId: "req-isolation",
        jobId: job.id,
        tool: "Bash",
        detail: "",
        askedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    state.userId = b.memberId;
    const questionKey = (
      (await call(runDetail.GET, { params: { id: b.runId } })).body as {
        details: { question: { key: string } };
      }
    ).details.question.key;
    const answer = (id: string) =>
      call(runAnswer.POST, { params: { id }, body: { questionKey, optionId: "deny" } });
    for (const userId of [a.memberId, a.adminId]) {
      state.userId = userId;
      expect(await answer(b.runId)).toMatchObject({
        status: 404,
        body: { error: "That run doesn't exist." },
      });
    }
    expect((await getRun(db, b.runId))!.permission?.answer).toBeUndefined();

    state.userId = b.memberId;
    expect(await answer(b.runId)).toMatchObject({ status: 200, body: { id: b.runId } });
    expect((await getRun(db, b.runId))!.permission).toMatchObject({ answer: "denied" });
    await updateRun(db, b.runId, { permission: null });
    await db.delete(jobs).where(eq(jobs.id, job.id));
  });

  it("previews routing with only the organization's own runs and repositories", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      // A workspace that also has the other organization's issues: they still aren't its runs.
      const linear = new FakeLinearGateway();
      linear.add({ id: `${own.name}-issue`, identifier: "OWN-1", title: "Own" });
      linear.add({ id: `${other.name}-issue`, identifier: "SHARED-1", title: "Shared" });
      linear.add({ identifier: "SHARED-2", title: "Sub", parentId: `${other.name}-issue` });
      state.linear.set(own.orgId, linear);
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const { status, body } = await call(routingPreview.POST, {
          body: { identifiers: ["OWN-1", "SHARED-1", "SHARED-2"] },
        });
        expect(status).toBe(200);
        const [mine, shared, sub] = (body as unknown as RoutingPreview).results;
        expect(mine).toMatchObject({ outcome: "ask", run: { id: own.runId } });
        // The other's run doesn't route its sub-issue here either.
        expect(shared).toMatchObject({ outcome: "ask", run: null });
        expect(sub).toMatchObject({ outcome: "ask", run: null });
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
      }
    }
    state.linear.clear();
  });

  it("shows a member of both organizations a run of either, with its organization", async () => {
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

    // The other organization's run, without switching to it.
    const { status, body } = await call(runDetail.GET, { params: { id: b.runId } });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: b.runId,
      organization: { id: b.orgId, name: b.name, role: "member" },
    });
    expect(JSON.stringify(body)).toContain(b.storyId);
    for (const marker of markers(a)) expect(JSON.stringify(body)).not.toContain(marker);

    // The run list covers either organization, or both, without switching.
    const own = await call(runList.GET, { path: `/api/ui?organization=${b.orgId}` });
    expect((own.body.runs as { id: string }[]).map((r) => r.id)).toEqual([b.triageRunId, b.runId]);
    const all = await call(runList.GET, { path: "/api/ui?organization=all" });
    expect(all.status).toBe(200);
    expect(new Set((all.body.runs as { id: string }[]).map((r) => r.id))).toEqual(
      new Set([a.triageRunId, a.runId, b.triageRunId, b.runId]),
    );
    for (const run of all.body.runs as { id: string; organization: unknown }[]) {
      const tenant = [a.runId, a.triageRunId].includes(run.id) ? a : b;
      expect(run.organization).toEqual({ id: tenant.orgId, name: tenant.name, role: "member" });
    }
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

  it("refuses to re-run the other organization's review, and its own members reach it", async () => {
    const rerun = (id: string) =>
      call(reviewRerun.POST, { params: { id }, body: { mode: "fresh", depth: null } });
    state.userId = a.adminId;
    expect(await rerun(b.reviewId)).toMatchObject({
      status: 404,
      body: { error: "That review doesn't exist." },
    });
    expect(await rerun("not-a-uuid")).toMatchObject({ status: 404 });
    state.userId = b.memberId;
    expect(await rerun(b.reviewId)).not.toMatchObject({ status: 403 });
    expect(await rerun(b.reviewId)).not.toMatchObject({ status: 404 });
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

  it("refuses to cancel the other organization's job, and lets its own members cancel it", async () => {
    state.userId = a.adminId;
    expect(await call(jobCancel.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject({
      status: 400,
      body: { error: "That job doesn't exist." },
    });
    expect(
      await call(jobCancel.POST, { method: "POST", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });
    expect(await getJob(db, b.jobId)).toMatchObject({ status: "running", cancelRequested: false });
    state.userId = b.memberId;
    expect(await call(jobCancel.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject({
      status: 200,
      body: { ok: true },
    });
  });

  it("refuses to rerun the other organization's job, and its own members may rerun it", async () => {
    state.userId = a.adminId;
    expect(await call(jobRerun.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject({
      status: 400,
      body: { error: "That job doesn't exist." },
    });
    expect(
      await call(jobRerun.POST, { method: "POST", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });
    // A member reaches the job (a running one isn't rerun).
    state.userId = b.memberId;
    expect(await call(jobRerun.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject({
      status: 400,
      body: { error: expect.not.stringContaining("doesn't exist") },
    });
  });

  // Last: the triage jobs created here would show on the job lists above.
  it("lists and shows each organization's own triage runs to its members, and 404s on the other's", async () => {
    const triageJobIds = new Map<string, string>();
    for (const tenant of [a, b]) {
      const { job } = await insertJob(db, {
        organizationId: tenant.orgId,
        type: "triage.run",
        taskType: "query",
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

  it("lists only the user's own organizations in the signed-in layout", async () => {
    for (const own of [a, b]) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const layout = await AppLayout({ children: null });
        expect(layout.props.user).toMatchObject({
          scope: "single",
          organizations: [
            { id: own.orgId, name: own.name, role: userId === own.adminId ? "admin" : "member" },
          ],
        });
      }
    }
  });

  it("grants each user's live token only their own organization's change channel", async () => {
    vi.stubEnv("ABLY_API_KEY", "appId.keyId:s3cr3t");
    try {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const { status, body } = await call(liveToken.GET);
          expect(status).toBe(200);
          const { payload } = await jwtVerify(
            body.token as string,
            new TextEncoder().encode("s3cr3t"),
          );
          const capability = JSON.parse(payload["x-ably-capability"] as string) as object;
          expect(capability).toEqual({
            [`org:${own.orgId}:changes`]: ["subscribe"],
            [`user:${userId}:changes`]: ["subscribe"],
          });
          expect(JSON.stringify(capability)).not.toContain(other.orgId);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never switches a non-member to the other organization through the enter route", async () => {
    state.userId = a.adminId;
    state.cookies.clear();
    const enter = async (url: string) =>
      (await enterOrganization(new NextRequest(`http://localhost${url}`))).status;
    // Unsigned (a link from another site), signed for someone else, or signed for a.
    const unsigned = new URLSearchParams({ organization: b.orgId, next: "/" });
    expect(await enter(`${ENTER_ORGANIZATION_PATH}?${unsigned}`)).toBe(404);
    for (const userId of [b.adminId, a.adminId]) {
      const signed = await createEnterOrganizationPath({
        userId,
        organizationId: b.orgId,
        next: "/",
      });
      expect(await enter(signed)).toBe(404);
    }
    expect((await getActiveOrganization(db, a.adminId))?.id).toBe(a.orgId);
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBeUndefined();
  });

  it("opens another of the user's organizations' resources by switching to it", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-enter-admin", email: "both-enter@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "admin" },
      { organizationId: b.orgId, userId: user!.id, role: "admin" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;
    state.cookies.clear();

    // The run's page asks the API, which answers 409 with the signed path that switches to
    // the run's organization and comes back to the page, which then gets the run.
    const page = `/triage/${b.triageRunId}`;
    const open = () =>
      call(triageDetail.GET, {
        params: { id: b.triageRunId },
        path: `/api/ui?${new URLSearchParams({ next: page })}`,
      });
    const refused = await open();
    expect(refused.status).toBe(409);
    const enterPath = refused.body.enterPath as string;
    expect(enterPath).toMatch(new RegExp(`^${ENTER_ORGANIZATION_PATH}\\?token=`));
    expect((await getActiveOrganization(db, user!.id))?.id).toBe(a.orgId);
    const response = await enterOrganization(new NextRequest(`http://localhost${enterPath}`));
    expect(response.headers.get("location")).toBe(`http://localhost${page}`);
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(b.orgId);
    expect((await getActiveOrganization(db, user!.id))?.id).toBe(b.orgId);
    const opened = await open();
    expect(opened.status).toBe(200);
    expect(JSON.stringify(opened.body)).toContain(b.triageRunId);
    state.cookies.clear();
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
      expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(b.orgId);
      // One organization: not "All organizations".
      expect(state.cookies.get(ORGANIZATION_SCOPE_COOKIE) ?? "").toBe("");
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

  describe("agents and tasks", () => {
    /** Each tenant's own agent and a review task on it, created through the API. */
    const definitions = new Map<string, { agentId: string; taskId: string }>();
    const own = (tenant: Tenant) => definitions.get(tenant.name)!;
    const agentInput = (tenant: Tenant) => ({
      name: `${tenant.name}-agent-def`,
      systemPrompt: `${tenant.name} prompt`,
      taskTypes: ["review"],
    });
    const { id: _reviewPrId, ...reviewPr } = getBuiltinTask("builtin:review-pr")!;
    const taskInput = (tenant: Tenant, agentId: string) => ({
      ...reviewPr,
      name: `${tenant.name}-task-def`,
      agentId,
    });
    const definitionMarkers = (tenant: Tenant) => [
      own(tenant).agentId,
      own(tenant).taskId,
      `${tenant.name}-agent-def`,
      `${tenant.name}-task-def`,
    ];

    beforeAll(async () => {
      for (const tenant of [a, b]) {
        state.userId = tenant.adminId;
        const agent = await call(agentList.POST, { body: agentInput(tenant) });
        expect(agent).toMatchObject({ status: 200, body: { ok: true } });
        const agentId = agent.body.id as string;
        const task = await call(taskList.POST, { body: taskInput(tenant, agentId) });
        expect(task).toMatchObject({ status: 200, body: { ok: true } });
        definitions.set(tenant.name, { agentId, taskId: task.body.id as string });
      }
    });

    it("lists and shows each organization's own agents and tasks to its members, and 404s on the other's", async () => {
      for (const [mine, other] of [
        [a, b],
        [b, a],
      ] as const) {
        state.userId = mine.memberId;
        const agents = await call(agentList.GET);
        const tasks = await call(taskList.GET);
        expect(agents.status).toBe(200);
        expect(tasks.status).toBe(200);
        expect(agents.body.agents).toContainEqual(
          expect.objectContaining({ id: own(mine).agentId, builtin: false }),
        );
        expect(tasks.body.tasks).toContainEqual(
          expect.objectContaining({ id: own(mine).taskId, agentId: own(mine).agentId }),
        );

        const agent = await call(agentDetail.GET, { params: { id: own(mine).agentId } });
        expect(agent).toMatchObject({
          status: 200,
          body: { agent: { name: `${mine.name}-agent-def` }, tasks: [{ id: own(mine).taskId }] },
        });
        const task = await call(taskDetail.GET, { params: { id: own(mine).taskId } });
        expect(task).toMatchObject({
          status: 200,
          body: { task: { name: `${mine.name}-task-def` }, agentName: `${mine.name}-agent-def` },
        });
        // A built-in's "Used by" lists only this organization's tasks.
        const reviewer = await call(agentDetail.GET, {
          params: { id: encodeURIComponent("builtin:reviewer") },
        });
        expect(reviewer.status).toBe(200);

        for (const body of [agents.body, tasks.body, agent.body, task.body, reviewer.body]) {
          const json = JSON.stringify(body);
          for (const marker of definitionMarkers(other)) expect(json).not.toContain(marker);
        }
        for (const [handler, id] of [
          [agentDetail.GET, own(other).agentId],
          [taskDetail.GET, own(other).taskId],
          [agentDetail.GET, "not-a-uuid"],
          [taskDetail.GET, "builtin:nope"],
        ] as const) {
          expect(await call(handler, { params: { id } }), id).toMatchObject({ status: 404 });
        }
      }
    });

    it("gives each organization's form options to its admins only", async () => {
      state.userId = a.memberId;
      expect((await call(agentFormOptions.GET)).status).toBe(403);
      expect((await call(taskFormOptions.GET)).status).toBe(403);

      state.userId = a.adminId;
      const agents = await call(agentFormOptions.GET);
      expect(agents).toMatchObject({ status: 200, body: { harnessCount: expect.any(Number) } });
      const tasks = await call(taskFormOptions.GET);
      expect(tasks.status).toBe(200);
      expect(tasks.body.agents).toContainEqual(expect.objectContaining({ id: own(a).agentId }));
      for (const body of [agents.body, tasks.body]) {
        const json = JSON.stringify(body);
        for (const marker of [...definitionMarkers(b), ...markers(b)]) {
          expect(json).not.toContain(marker);
        }
      }
    });

    it("refuses every change to the other organization's agents and tasks, and members can't change any", async () => {
      state.userId = a.adminId;
      const missingAgent = { status: 400, body: { error: "That agent doesn't exist." } };
      const missingTask = { status: 400, body: { error: "That task doesn't exist." } };
      const agentParams = { params: { id: own(b).agentId } };
      const taskParams = { params: { id: own(b).taskId } };
      expect(
        await call(agentDetail.PUT, { ...agentParams, method: "PUT", body: agentInput(a) }),
      ).toEqual(missingAgent);
      expect(await call(agentDetail.DELETE, { ...agentParams, method: "DELETE" })).toEqual(
        missingAgent,
      );
      expect(await call(agentClone.POST, { ...agentParams, method: "POST" })).toEqual(missingAgent);
      expect(
        await call(taskDetail.PUT, {
          ...taskParams,
          method: "PUT",
          body: taskInput(a, own(a).agentId),
        }),
      ).toEqual(missingTask);
      expect(await call(taskDetail.DELETE, { ...taskParams, method: "DELETE" })).toEqual(
        missingTask,
      );
      expect(await call(taskClone.POST, { ...taskParams, method: "POST" })).toEqual(missingTask);
      // A task can't run on the other organization's agent.
      expect(await call(taskList.POST, { body: taskInput(a, own(b).agentId) })).toMatchObject({
        status: 400,
        body: { fieldErrors: { agentId: expect.any(String) } },
      });

      state.userId = a.memberId;
      const ownAgent = { params: { id: own(a).agentId } };
      const ownTask = { params: { id: own(a).taskId } };
      for (const response of [
        await call(agentList.POST, { body: agentInput(a) }),
        await call(agentDetail.PUT, { ...ownAgent, method: "PUT", body: agentInput(a) }),
        await call(agentDetail.DELETE, { ...ownAgent, method: "DELETE" }),
        await call(agentClone.POST, { ...ownAgent, method: "POST" }),
        await call(taskList.POST, { body: taskInput(a, own(a).agentId) }),
        await call(taskDetail.PUT, {
          ...ownTask,
          method: "PUT",
          body: taskInput(a, own(a).agentId),
        }),
        await call(taskDetail.DELETE, { ...ownTask, method: "DELETE" }),
        await call(taskClone.POST, { ...ownTask, method: "POST" }),
      ]) {
        expect(response.status).toBe(403);
      }

      // The other organization keeps its agent and task as they were.
      state.userId = b.memberId;
      expect(await call(agentDetail.GET, agentParams)).toMatchObject({
        status: 200,
        body: { agent: { name: `${b.name}-agent-def` } },
      });
      expect(await call(taskDetail.GET, taskParams)).toMatchObject({
        status: 200,
        body: { task: { name: `${b.name}-task-def` } },
      });
    });

    it("creates, changes, clones and deletes only the active organization's definitions", async () => {
      state.userId = a.adminId;
      const cloned = await call(taskClone.POST, {
        params: { id: own(a).taskId },
        method: "POST",
      });
      expect(cloned).toMatchObject({ status: 200, body: { ok: true } });
      const cloneId = cloned.body.id as string;
      expect(
        await call(taskDetail.PUT, {
          params: { id: cloneId },
          method: "PUT",
          body: { ...taskInput(a, own(a).agentId), name: "alpha-renamed" },
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(await call(taskDetail.DELETE, { params: { id: cloneId }, method: "DELETE" })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect((await call(taskDetail.GET, { params: { id: cloneId } })).status).toBe(404);

      const builtinClone = await call(agentClone.POST, {
        params: { id: encodeURIComponent("builtin:reviewer") },
        method: "POST",
      });
      expect(builtinClone).toMatchObject({ status: 200, body: { ok: true } });

      state.userId = b.memberId;
      const agents = JSON.stringify((await call(agentList.GET)).body);
      const tasks = JSON.stringify((await call(taskList.GET)).body);
      expect(agents).not.toContain(builtinClone.body.id as string);
      expect(tasks).not.toContain(cloneId);
      expect(tasks).toContain(own(b).taskId);
    });
  });
  describe("harness defaults", () => {
    it("shows each organization's own harness defaults and host tools to its admins only", async () => {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        state.userId = own.memberId;
        for (const handler of [harnessDefaults.GET, hostToolCatalog.GET]) {
          expect((await call(handler)).status).toBe(403);
        }

        state.userId = own.adminId;
        const defaults = await call(harnessDefaults.GET);
        expect(defaults).toMatchObject({ status: 200, body: { packageName: expect.any(String) } });

        const tools = await call(hostToolCatalog.GET);
        expect(tools.status).toBe(200);
        expect((tools.body.hostTools as { id: string }[]).map((t) => t.id)).toContain(
          own.hostToolId,
        );

        for (const body of [defaults.body, tools.body]) {
          const json = JSON.stringify(body);
          for (const marker of markers(other)) expect(json).not.toContain(marker);
        }
      }
    });

    it("refuses every change outside the active organization, and to members", async () => {
      state.userId = a.memberId;
      for (const response of [
        await call(harnessDefaults.PUT, { method: "PUT", body: { version: "1.4.0" } }),
        await call(hostToolCatalog.POST, { body: { name: "member-tool" } }),
        await call(hostTool.DELETE, { params: { id: a.hostToolId }, method: "DELETE" }),
      ]) {
        expect(response.status).toBe(403);
      }

      // The other organization's host tool doesn't exist here.
      state.userId = a.adminId;
      expect(
        await call(hostTool.DELETE, { params: { id: b.hostToolId }, method: "DELETE" }),
      ).toEqual({ status: 400, body: { error: "That host tool doesn't exist." } });
      expect((await listHostTools(db, b.orgId)).map((t) => t.id)).toContain(b.hostToolId);
      expect((await listHostTools(db, a.orgId)).map((t) => t.id)).toContain(a.hostToolId);
      expect(await getDesiredHarnessVersion(db, a.orgId)).not.toBe("1.4.0");
    });

    it("changes only the active organization's harness defaults and host tools", async () => {
      state.userId = a.adminId;
      expect(
        await call(harnessDefaults.PUT, {
          method: "PUT",
          body: { defaults: { allowedTaskTypes: ["review"], maxConcurrency: 3 }, version: "1.4.0" },
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      const added = await call(hostToolCatalog.POST, { body: { name: "beta-tool" } });
      // The other organization's tool name is no duplicate here.
      expect(added).toMatchObject({ status: 200, body: { ok: true } });
      expect(
        await call(hostTool.DELETE, {
          params: { id: added.body.hostToolId as string },
          method: "DELETE",
        }),
      ).toEqual({ status: 200, body: { ok: true } });

      expect(await getDesiredHarnessVersion(db, a.orgId)).toBe("1.4.0");
      expect(await getDesiredHarnessVersion(db, b.orgId)).not.toBe("1.4.0");
      expect(await getAllowedTaskTypeDefaults(db, a.orgId)).toEqual(["review"]);
      expect(await getAllowedTaskTypeDefaults(db, b.orgId)).toEqual(["query", "review", "coding"]);

      state.userId = b.adminId;
      expect((await call(harnessDefaults.GET)).body).toMatchObject({
        defaults: { allowedTaskTypes: ["query", "review", "coding"] },
      });
    });
  });
});
