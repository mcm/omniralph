// Every `/api/ui` endpoint against two organizations: a user of one never gets a row of the
// other, gets a 404 on the other's resources, and only creates rows in their own; opening a
// resource of another of their own organizations switches to it (`/api/organizations/enter`).
// Pages read no data (only the signed-in layout lists the user's organizations, tested here
// too), so this is where every page's organization isolation is checked.
import { randomBytes, randomUUID } from "node:crypto";
import {
  addMember,
  addOrganizationDomain,
  chatConnections,
  chatIdentities,
  closeDb,
  createInvitation,
  getActiveOrganization,
  getDesiredAgentVersion,
  getIntegration,
  getMembership,
  listChatChannelPlaybookSettings,
  listChatConnections,
  saveChatConnection,
  saveIntegration,
  upsertChatChannelPlaybookSetting,
  getOrganization,
  listChatIdentities,
  listOrganizationDomains,
  listPendingInvitationsForOrganization,
  agentRepoPins,
  connectRepository,
  repositories,
  createDb,
  createAgentEnrollment,
  createCustomRule,
  listRepositoryRules,
  createOrganization,
  createReview,
  createReviewRun,
  createRun,
  createTriageRun,
  createWebChatThread,
  appendWebMessage,
  chatThreads,
  chatWebMessages,
  insertJob,
  enrollAgent,
  ensureChatThread,
  findings,
  getAgentOverview,
  getRepository,
  getJob,
  getRun,
  agents,
  integrations as integrationRows,
  jobs,
  runActivities,
  mapThreadRun,
  recordWebhookEvent,
  webhookEvents,
  organizationMembers,
  organizations,
  ralphRuns,
  reviewRuns,
  connectionCredentials,
  scmConnections,
  setActiveOrganization,
  settingsChanges,
  triageRuns,
  updateRun,
  upsertScmConnection,
  upsertStories,
  updateStory,
  users,
  saveWorkItemMatch,
  workItemMatches,
  workItemShareLinks as workItemShareLinkRows,
  createWorkItemShareLink,
  listActiveWorkItemShareLinks,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { jwtVerify } from "jose";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getBuiltinPlaybook } from "@omniralph/tasks";
import { assertRole, type Role } from "@/lib/auth/roles";
import {
  ENTER_ORGANIZATION_PATH,
  ORGANIZATION_COOKIE,
  ORGANIZATION_SCOPE_COOKIE,
} from "@/lib/auth/routes";
import type { RoutingPreview } from "@/lib/api/routing-rules";
import type * as LinearClient from "@/lib/tracker/linear/client";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type * as Adapters from "@/lib/scm/adapters";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { CANCEL_REQUESTED_WARNING } from "@/lib/jobs/cancel";

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
vi.mock("@/lib/tracker/linear/oauth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeToken: async () => {},
}));
vi.mock("@/lib/chat/slack-oauth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revokeSlackToken: async () => {},
}));
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => "9.9.9",
}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  cookies: new Map<string, string>(),
  /** Each organization's Linear workspace, by organization ID (else none is connected). */
  linear: new Map<string, FakeLinearGateway>(),
  /** The code host, when a test sets one (else the real adapters). */
  scm: null as FakeScmAdapter | null,
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
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) =>
      state.linear.get(options.organizationId) ?? actual.getLinearGateway(options),
  };
});
vi.mock("@/lib/scm/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof Adapters>();
  return {
    ...actual,
    scmAdapterFor: (...args: Parameters<typeof actual.scmAdapterFor>) =>
      state.scm?.asAdapter() ?? actual.scmAdapterFor(...args),
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
vi.mock("../../(app)/page-frame", () => ({ PageFrame: () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";
process.env.AUTH_SECRET = randomBytes(32).toString("base64");

const agentList = await import("./agents/route");
const enrollments = await import("./agent-enrollments/route");
const enrollment = await import("./agent-enrollments/[id]/route");
const agentDetail = await import("./agents/[id]/route");
const agentRevoke = await import("./agents/[id]/revoke/route");
const agentInstallables = await import("./agents/[id]/installables/route");
const agentInstalls = await import("./agents/[id]/installs/route");
const repositoryList = await import("./repositories/route");
const repositorySetup = await import("./repositories/setup/route");
const repository = await import("./repositories/[id]/route");
const repositoryDetail = repository;
const repositoryWebhook = await import("./repositories/[id]/webhook/route");
const repositoryReviews = await import("./repositories/[id]/reviews/route");
const repositoryAsk = await import("./repositories/[id]/ask/route");
const repositoryAgents = await import("./repositories/[id]/agents/route");
const repositoryPlaybooks = await import("./repositories/[id]/playbooks/route");
const repositoryCoding = await import("./repositories/[id]/coding/route");
const repositoryMatchCheck = await import("./repositories/[id]/coding/match-check/route");
const repositoryTrackerOptions = await import("./repositories/[id]/coding/tracker-options/route");
const repositoryRules = await import("./repositories/[id]/rules/route");

/** A valid Coding card save that changes a repo's defaults (Rewrite history: Always). */
const CODING_CARD = {
  codingEnabled: false,
  workItemMatch: null,
  codingInstructions: null,
  openPullRequestEarly: false,
  historyRewrite: "always",
  respondToReviewsAndCi: true,
  checks: [],
};
const repositoryRule = await import("./repositories/[id]/rules/[ruleId]/route");
const gitlabConnections = await import("./gitlab-connections/route");
const scmConnection = await import("./scm-connections/[id]/route");
const selectable = await import("./scm-connections/[id]/repositories/route");
const scmConnectionList = await import("./scm-connections/route");
const runList = await import("./runs/route");
const runFilterOptions = await import("./runs/filter-options/route");
const runDetail = await import("./runs/[id]/route");
const runStop = await import("./runs/[id]/stop/route");
const runRetry = await import("./runs/[id]/retry/route");
const runAnswer = await import("./runs/[id]/answer/route");
const runTranscript = await import("./runs/[id]/attempts/[attemptId]/transcript/route");
const runSession = await import("./runs/[id]/session/route");
const runStepDiff = await import("./runs/[id]/steps/[stepId]/diff/route");
const runFindings = await import("./runs/[id]/findings/route");
const routingPreview = await import("./routing/preview/route");
const liveToken = await import("./live/token/route");
const jobCancel = await import("./jobs/[id]/cancel/route");
const jobRerun = await import("./jobs/[id]/rerun/route");
const runAnalytics = await import("./analytics/runs/route");
const settingsHistory = await import("./settings-history/route");
const backlogList = await import("./backlog/route");
const backlogCounts = await import("./backlog/counts/route");
const backlogUpNext = await import("./backlog/up-next/route");
const { resetBacklogCache } = await import("@/lib/work-items/backlog-cache");
const workItemDetail = await import("./work-items/[id]/route");
const workItemPrd = await import("./work-items/[id]/prd/route");
const workItemStart = await import("./work-items/[id]/start/route");
const workItemTriage = await import("./work-items/[id]/triage/route");
const workItemRepository = await import("./work-items/[id]/repository/route");
const workItemMove = await import("./work-items/[id]/move/route");
const workItemCancel = await import("./work-items/[id]/cancel/route");
const workItemCreate = await import("./work-items/route");
const workItemTargets = await import("./work-items/targets/route");
const workItemShareLinks = await import("./work-items/[id]/share-links/route");
const shareLinkRevoke = await import("./share-links/[linkId]/route");
const inboxFeed = await import("./inbox/route");
const inboxCounts = await import("./inbox/counts/route");
const inboxItem = await import("./inbox/items/[key]/route");
const connectionList = await import("./connections/route");
const navIndicators = await import("./nav-indicators/route");
const connectionDeliveries = await import("./connections/[kind]/[id]/deliveries/route");
const gitlabRotate = await import("./connections/gitlab/[id]/rotate/route");
const gitlabToken = await import("./connections/gitlab/[id]/route");
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
const linearIntegration = await import("./integrations/linear/route");
const slackIntegration = await import("./integrations/slack/[id]/route");
const discordIntegration = await import("./integrations/discord/[id]/route");
const chatPlaybooks = await import("./integrations/chat-tasks/route");
const channelPlaybooks = await import("./integrations/chat-connections/[id]/channels/route");
const playbookList = await import("./playbooks/route");
const playbookDetail = await import("./playbooks/[id]/route");
const playbookClone = await import("./playbooks/[id]/clone/route");
const playbookFormOptions = await import("./playbooks/form-options/route");
const agentDefaults = await import("./agent-defaults/route");
const askChats = await import("./ask/chats/route");
const askChat = await import("./ask/chats/[id]/route");
const askChatMessages = await import("./ask/chats/[id]/messages/route");
const askChatActions = await import("./ask/chats/[id]/actions/route");
const askRepositories = await import("./ask/repositories/route");
const searchRoute = await import("./search/route");
const searchRecent = await import("./search/recent/route");
const { GET: enterOrganization } = await import("../../api/organizations/enter/route");
const { default: AppLayout } = await import("../../(app)/layout");
const { createEnterOrganizationPath } = await import("@/lib/organizations/enter");

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
  agentId: string;
  enrollmentId: string;
  connectionId: string;
  repoId: string;
  repoPath: string;
  ruleId: string;
  /** A host tool its agent reports with a path. */
  hostToolName: string;
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
    const created = await createAgentEnrollment(db, {
      organizationId: org.id,
      name: `${name}-agent`,
    });
    const { agentId } = (await enrollAgent(db, {
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
    const hostToolName = `${name}-hosttool`;
    await db
      .update(agents)
      .set({
        reportedHostTools: [
          { name: hostToolName, path: `/opt/${hostToolName}`, source: "configured", problem: null },
        ],
      })
      .where(eq(agents.id, agentId));
    const { run } = await createRun(db, {
      organizationId: org.id,
      trackerIssueId: `${name}-issue`,
      trackerIdentifier: `${name.toUpperCase()}-1`,
      trackerTitle: `${name} epic`,
      trackerUrl: null,
      trackerSessionId: `${name}-session`,
      kind: "children",
      repositoryId: repo.id,
      branch: `${name}-branch`,
      baseBranch: "main",
    });
    await updateRun(db, run.id, { status: "running" });
    const [story] = await upsertStories(db, run.id, [
      { trackerIssueId: `${name}-story`, identifier: `${name.toUpperCase()}-2`, title: "Story" },
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
        agentId,
      })
      .returning();
    const { run: triageRun } = await createTriageRun(db, {
      organizationId: org.id,
      trackerIssueId: `${name}-triage-issue`,
      trackerSessionId: `${name}-triage-session`,
      trigger: "mention",
    });
    return {
      name,
      adminId: admin!.id,
      memberId: member!.id,
      orgId: org.id,
      agentId,
      enrollmentId: created.id,
      connectionId: connection.id,
      repoId: repo.id,
      repoPath,
      ruleId: rule.id,
      hostToolName,
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

  it("aggregates only each organization's own runs in run analytics, and ignores the other's repo", async () => {
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
        expect(all.body.repositories).toEqual([
          expect.objectContaining({
            id: own.repoId,
            organization: { id: own.orgId, name: own.name },
          }),
        ]);
        const repo = await call(runAnalytics.GET, { path: `/api/ui?repository=${own.repoId}` });
        expect(repo).toMatchObject({ status: 200, body: { params: { repositoryId: own.repoId } } });
        // The other's repository as the filter is ignored.
        const theirs = await call(runAnalytics.GET, { path: `/api/ui?repository=${other.repoId}` });
        expect(theirs).toMatchObject({ status: 200, body: { params: { repositoryId: null } } });
        for (const { body } of [active, all, repo, theirs]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }
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

  it("offers only the scope's repositories as Runs filter options, and 404s on the other's", async () => {
    type Options = { repositories: { id: string; organization: { id: string } }[] };
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        for (const organization of [undefined, "all", own.orgId]) {
          const query = organization ? `?organization=${organization}` : "";
          const response = await call(runFilterOptions.GET, { path: `/api/ui${query}` });
          expect(response).toMatchObject({
            status: 200,
            body: {
              repositories: [
                { id: own.repoId, fullPath: own.repoPath, organization: { id: own.orgId } },
              ],
            },
          });
          for (const marker of markers(other)) {
            expect(JSON.stringify(response.body)).not.toContain(marker);
          }
        }
        expect(
          await call(runFilterOptions.GET, { path: `/api/ui?organization=${other.orgId}` }),
        ).toMatchObject({ status: 404 });
      }
    }
    // A member of both gets both organizations' repositories under organization=all.
    const [both] = await db
      .insert(users)
      .values({ id: "filter-options-both", email: "filter-both@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: both!.id, role: "member" },
      { organizationId: b.orgId, userId: both!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: both!.id, organizationId: a.orgId });
    try {
      state.userId = both!.id;
      const all = await call(runFilterOptions.GET, { path: "/api/ui?organization=all" });
      expect(all.status).toBe(200);
      const listed = (all.body as Options).repositories;
      expect(new Map(listed.map((r) => [r.id, r.organization.id]))).toEqual(
        new Map([
          [a.repoId, a.orgId],
          [b.repoId, b.orgId],
        ]),
      );
    } finally {
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, both!.id));
      await db.delete(users).where(eq(users.id, both!.id));
    }
    state.userId = null;
    expect((await call(runFilterOptions.GET)).status).toBe(401);
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
        trackerIssueId: `${name}-all-stopped-issue`,
        trackerIdentifier: `${name.toUpperCase()}-77`,
        trackerTitle: `${name} stopped for all`,
        trackerUrl: null,
        trackerSessionId: `${name}-all-stopped-session`,
        kind: "children",
        repositoryId,
        branch: `${name}-all-stopped`,
        baseBranch: "main",
      });
      await updateRun(db, stopped.id, { status: "stopped" });
      ralph.push(stopped.id);
      const { run: failed } = await createTriageRun(db, {
        organizationId: orgId,
        trackerIssueId: `${name}-all-failed-issue`,
        trackerSessionId: `${name}-all-failed-session`,
        trigger: "mention",
      });
      await db.update(triageRuns).set({ status: "failed" }).where(eq(triageRuns.id, failed.id));
      triage.push(failed.id);
      const ids = [stopped.id, failed.id];
      if (orgId === c.id) {
        const { run: running } = await createTriageRun(db, {
          organizationId: orgId,
          trackerIssueId: "gamma-all-running-issue",
          trackerSessionId: "gamma-all-running-session",
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
          questions: number;
        };
      const [countA, countB] = [await countsOf(a.orgId), await countsOf(b.orgId)];
      expect(counts.body).toEqual({
        needsYou: countA.needsYou + countB.needsYou,
        problems: countA.problems + countB.problems,
        running: countA.running + countB.running,
        questions: countA.questions + countB.questions,
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
        trackerIssueId: `${own.name}-stopped-issue`,
        trackerIdentifier: `${own.name.toUpperCase()}-9`,
        trackerTitle: `${own.name} stopped epic`,
        trackerUrl: null,
        trackerSessionId: `${own.name}-stopped-session`,
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

  it("lists only the active organization's own connections in Settings, to its members", async () => {
    const discord = new Map<string, string>();
    try {
      for (const own of [a, b]) {
        const saved = await saveChatConnection(db, {
          organizationId: own.orgId,
          platform: "discord",
          externalId: `${own.name}-settings-guild`,
          name: `${own.name} settings Discord`,
          credentials: null,
          installedByUserId: null,
        });
        if (saved === "other_organization") throw new Error("setup");
        discord.set(own.orgId, saved.id);
      }
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const { status, body } = await call(connectionList.GET);
          expect(status).toBe(200);
          const ids = (body.connections as { id: string }[]).map((row) => row.id);
          expect(ids).toEqual(expect.arrayContaining([own.connectionId, discord.get(own.orgId)]));
          expect(ids).not.toContain(discord.get(other.orgId));
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
          expect(JSON.stringify(body)).not.toContain(`${other.name} settings Discord`);
        }
      }
    } finally {
      await db.delete(chatConnections).where(inArray(chatConnections.id, [...discord.values()]));
    }
  });

  it("counts only each organization's own agents and failed deliveries in the nav dots, and 404s on the other's", async () => {
    type Indicators = {
      fleet: { offline: number; updateFailed: number };
      settings: { failedDeliveries: number; byConnection: { id: string; failed: number }[] };
    };
    const read = async (organization?: string) =>
      call(navIndicators.GET, {
        path: organization ? `/api/ui?organization=${organization}` : "/api/ui",
      }) as Promise<{ status: number; body: Indicators }>;
    const added: string[] = [];
    const deliveries: string[] = [];
    try {
      for (const own of [a, b]) {
        deliveries.push(
          await recordWebhookEvent(db, {
            organizationId: own.orgId,
            provider: "github",
            source: { scmConnectionId: own.connectionId },
            event: "pull_request.opened",
            rawBody: "{}",
            outcome: "failed",
          }),
        );
      }
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const before = await read();
          expect(before.status).toBe(200);
          expect((await read(own.orgId)).body).toEqual(before.body);
          expect((await read("all")).body).toEqual(before.body);
          const ids = before.body.settings.byConnection.map((c) => c.id);
          expect(ids).toContain(own.connectionId);
          expect(ids).not.toContain(other.connectionId);
          expect(await read(other.orgId)).toMatchObject({ status: 404 });
          // The other organization's offline agent and failed delivery change nothing here.
          const [extra] = await db
            .insert(agents)
            .values({ organizationId: other.orgId, name: `${other.name}-dark`, liveOnline: false })
            .returning();
          added.push(extra!.id);
          deliveries.push(
            await recordWebhookEvent(db, {
              organizationId: other.orgId,
              provider: "github",
              source: { scmConnectionId: other.connectionId },
              event: "pull_request.opened",
              rawBody: "{}",
              outcome: "failed",
            }),
          );
          expect((await read()).body).toEqual(before.body);
        }
      }
    } finally {
      await db.delete(agents).where(inArray(agents.id, added));
      await db.delete(webhookEvents).where(inArray(webhookEvents.id, deliveries));
    }
    state.userId = null;
    expect((await read()).status).toBe(401);
  });

  it("rotates and replaces only its own organization's GitLab bot tokens, as admins", async () => {
    const gitlab = new Map<string, string>();
    try {
      for (const own of [a, b]) {
        const saved = (await upsertScmConnection(db, {
          organizationId: own.orgId,
          provider: "gitlab",
          name: `${own.name} bot @ gitlab.example.com`,
          baseUrl: "https://gitlab.example.com",
          externalId: `${own.name}-bot-user`,
          credentials: { token: `${own.name}-glpat`, webhookSecret: "s" },
        }))!;
        gitlab.set(own.orgId, saved.id);
      }
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        // Refused before GitLab is asked anything: no request leaves the test.
        state.userId = own.adminId;
        const otherId = gitlab.get(other.orgId)!;
        expect(
          await call(gitlabRotate.POST, { method: "POST", params: { id: otherId } }),
        ).toMatchObject({ status: 404 });
        expect(
          await call(gitlabToken.PUT, {
            method: "PUT",
            params: { id: otherId },
            body: { token: "x" },
          }),
        ).toMatchObject({ status: 404 });
        state.userId = own.memberId;
        const ownId = gitlab.get(own.orgId)!;
        expect(
          await call(gitlabRotate.POST, { method: "POST", params: { id: ownId } }),
        ).toMatchObject({ status: 403 });
        expect(
          await call(gitlabToken.PUT, {
            method: "PUT",
            params: { id: ownId },
            body: { token: "x" },
          }),
        ).toMatchObject({ status: 403 });
      }
      for (const own of [a, b]) {
        const [row] = await db
          .select()
          .from(scmConnections)
          .where(eq(scmConnections.id, gitlab.get(own.orgId)!));
        expect(connectionCredentials<{ token: string }>(row!).token).toBe(`${own.name}-glpat`);
      }
    } finally {
      await db.delete(scmConnections).where(inArray(scmConnections.id, [...gitlab.values()]));
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

  it("lists only each organization's own Backlog, counts and Up next, and 404s on the other's", async () => {
    const linear = new Map<string, string>();
    const titles = (body: Record<string, unknown>) =>
      Object.values(body as Record<string, Array<{ title: string; organization: { id: string } }>>)
        .flat()
        .map((row) => row.title);
    try {
      for (const own of [a, b]) {
        const integration = await saveIntegration(db, {
          organizationId: own.orgId,
          provider: "linear",
          externalId: `${own.name}-backlog-workspace`,
          name: `${own.name} workspace`,
          credentials: { accessToken: "t" },
          installedByUserId: null,
        });
        if (integration === "other_organization") throw new Error("setup");
        linear.set(own.orgId, integration.id);
        const workspace = new FakeLinearGateway();
        workspace.teams = [{ id: `${own.name}-team`, key: "ENG", name: `${own.name} team` }];
        workspace.add({
          id: `${own.name}-backlog-issue`,
          identifier: `${own.name.toUpperCase()}-BL1`,
          title: `${own.name} backlog item`,
          teamId: `${own.name}-team`,
        });
        state.linear.set(own.orgId, workspace);
        expect(
          await saveWorkItemMatch(db, {
            organizationId: own.orgId,
            repositoryId: own.repoId,
            userId: null,
            match: {
              tracker: "linear",
              team: "ENG",
              project: null,
              withoutProject: false,
              labels: [],
            },
          }),
        ).not.toBeNull();
        await db
          .update(repositories)
          .set({ codingEnabled: true })
          .where(eq(repositories.id, own.repoId));
      }
      resetBacklogCache();
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          for (const organization of [undefined, "all", own.orgId]) {
            const query = organization ? `?organization=${organization}` : "";
            const listed = await call(backlogList.GET, { path: `/api/ui/backlog${query}` });
            expect(listed.status).toBe(200);
            const groups = listed.body.groups as Record<string, unknown>;
            expect(titles(groups as Record<string, unknown>)).toEqual([`${own.name} backlog item`]);
            const counts = await call(backlogCounts.GET, { path: `/api/ui/backlog${query}` });
            expect(counts).toMatchObject({
              status: 200,
              body: { readyToStart: 1, needsRefining: 0, total: 1 },
            });
            const upNext = await call(backlogUpNext.GET, { path: `/api/ui/backlog${query}` });
            expect(upNext.status).toBe(200);
            expect(titles(upNext.body)).toEqual([`${own.name} backlog item`]);
            const targets = await call(workItemTargets.GET, {
              path: `/api/ui/work-items/targets${query}`,
            });
            expect(targets.status).toBe(200);
            expect(
              (targets.body.targets as Array<{ repository: { id: string } }>).map(
                (target) => target.repository.id,
              ),
            ).toEqual([own.repoId]);
            const searched = await call(searchRoute.GET, {
              path: `/api/ui/search?q=backlog%20item${organization ? `&organization=${organization}` : ""}`,
            });
            expect(searched.status).toBe(200);
            expect(
              (searched.body.groups as Array<{ id: string; results: Array<{ id: string }> }>).find(
                (group) => group.id === "workItem",
              )?.results,
            ).toEqual([
              expect.objectContaining({
                workItem: expect.objectContaining({ title: `${own.name} backlog item` }),
              }),
            ]);
            for (const { body } of [listed, counts, upNext, targets, searched]) {
              for (const marker of markers(other)) {
                expect(JSON.stringify(body)).not.toContain(marker);
              }
            }
          }
          for (const handler of [
            backlogList.GET,
            backlogCounts.GET,
            backlogUpNext.GET,
            workItemTargets.GET,
          ]) {
            expect(
              await call(handler, { path: `/api/ui/backlog?organization=${other.orgId}` }),
            ).toMatchObject({ status: 404 });
          }
          // Opening a work item from search: their own only.
          const ownGroups = (await call(searchRoute.GET, { path: "/api/ui/search?q=backlog" })).body
            .groups as Array<{ id: string; results: Array<{ id: string }> }>;
          const ownId = ownGroups.find((group) => group.id === "workItem")!.results[0]!.id;
          state.userId = other.memberId;
          const theirs = (await call(searchRoute.GET, { path: "/api/ui/search?q=backlog" })).body
            .groups as Array<{ id: string; results: Array<{ id: string }> }>;
          const otherId = theirs.find((group) => group.id === "workItem")!.results[0]!.id;
          state.userId = userId;
          expect(
            await call(searchRecent.POST, { body: { kind: "workItem", id: otherId } }),
          ).toMatchObject({ status: 404 });
          expect(
            await call(searchRecent.POST, { body: { kind: "workItem", id: ownId } }),
          ).toMatchObject({ status: 200 });
          const recent = await call(searchRoute.GET, { path: "/api/ui/search?q=" });
          expect(recent.body).toMatchObject({
            mode: "recent",
            groups: [{ id: "recent", results: [expect.objectContaining({ id: ownId })] }],
          });
        }
      }
      // A member of both gets both organizations' items under organization=all.
      const [both] = await db
        .insert(users)
        .values({ id: "backlog-both", email: "backlog-both@alpha.io" })
        .returning();
      await db.insert(organizationMembers).values([
        { organizationId: a.orgId, userId: both!.id, role: "member" },
        { organizationId: b.orgId, userId: both!.id, role: "member" },
      ]);
      await setActiveOrganization(db, { userId: both!.id, organizationId: a.orgId });
      try {
        state.userId = both!.id;
        const all = await call(backlogList.GET, { path: "/api/ui/backlog?organization=all" });
        const rows = (all.body.groups as { readyToStart: Array<{ organization: { id: string } }> })
          .readyToStart;
        expect(rows.map((row) => row.organization.id).sort()).toEqual([a.orgId, b.orgId].sort());
      } finally {
        await db.delete(organizationMembers).where(eq(organizationMembers.userId, both!.id));
        await db.delete(users).where(eq(users.id, both!.id));
      }
      state.userId = null;
      for (const handler of [
        backlogList.GET,
        backlogCounts.GET,
        backlogUpNext.GET,
        workItemTargets.GET,
      ]) {
        expect((await call(handler)).status).toBe(401);
      }
    } finally {
      state.linear.clear();
      resetBacklogCache();
      for (const own of [a, b]) {
        await db.delete(workItemMatches).where(eq(workItemMatches.repositoryId, own.repoId));
        await db
          .update(repositories)
          .set({ codingEnabled: false })
          .where(eq(repositories.id, own.repoId));
      }
      for (const id of linear.values()) {
        await db.delete(integrationRows).where(eq(integrationRows.id, id));
      }
    }
  });

  it("searches only the scope's own runs, repos, agents and recent items, and 404s on the other's", async () => {
    type Groups = Array<{ id: string; results: Array<{ kind: string; id: string }> }>;
    const ids = (groups: Groups, kind: string) =>
      groups.find((group) => group.id === kind)?.results.map((result) => result.id) ?? [];
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        for (const organization of [undefined, "all", own.orgId]) {
          const scope = organization ? `&organization=${organization}` : "";
          // Their own: by the run's identifier, the repo's path and the agent's name.
          const byIdentifier = await call(searchRoute.GET, {
            path: `/api/ui/search?q=${own.name.toUpperCase()}-1${scope}`,
          });
          expect(byIdentifier).toMatchObject({ status: 200, body: { mode: "results" } });
          const groups = byIdentifier.body.groups as Groups;
          expect(groups[0]).toMatchObject({ id: "run", results: [{ kind: "run", id: own.runId }] });
          const byName = await call(searchRoute.GET, {
            path: `/api/ui/search?q=${own.name}${scope}`,
          });
          expect(ids(byName.body.groups as Groups, "repository")).toEqual([own.repoId]);
          const agents = await call(searchRoute.GET, {
            path: `/api/ui/search?q=${own.name}-agent${scope}`,
          });
          expect(ids(agents.body.groups as Groups, "agent")).toEqual([own.agentId]);
          // The other's: nothing, whatever is typed.
          const theirs = await call(searchRoute.GET, {
            path: `/api/ui/search?q=${other.name}${scope}`,
          });
          expect(theirs.status).toBe(200);
          for (const { body } of [byIdentifier, byName, agents, theirs]) {
            for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
          }
        }
        expect(
          await call(searchRoute.GET, {
            path: `/api/ui/search?q=${own.name}&organization=${other.orgId}`,
          }),
        ).toMatchObject({ status: 404 });

        // Recent items: only their own can be recorded, and only their own are listed.
        for (const [kind, id] of [
          ["run", other.runId],
          ["run", other.triageRunId],
          ["repository", other.repoId],
          ["agent", other.agentId],
          ["settings", "/settings/nope"],
        ] as const) {
          expect(await call(searchRecent.POST, { body: { kind, id } })).toMatchObject({
            status: 404,
          });
        }
        for (const [kind, id] of [
          ["agent", own.agentId],
          ["repository", own.repoId],
          ["run", own.runId],
          ["settings", "/settings/members"],
        ] as const) {
          expect(await call(searchRecent.POST, { body: { kind, id } })).toMatchObject({
            status: 200,
          });
        }
        const recent = await call(searchRoute.GET, { path: "/api/ui/search?q=a" });
        expect(recent).toMatchObject({ status: 200, body: { mode: "recent" } });
        expect(ids(recent.body.groups as Groups, "recent")).toEqual([
          "/settings/members",
          own.runId,
          own.repoId,
          own.agentId,
        ]);
        for (const marker of markers(other)) {
          expect(JSON.stringify(recent.body)).not.toContain(marker);
        }
      }
    }
    // A member of both: either organization's matches under "All organizations", the
    // active one's otherwise, and recent items of the scope only.
    const [both] = await db
      .insert(users)
      .values({ id: "search-both", email: "search-both@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: both!.id, role: "member" },
      { organizationId: b.orgId, userId: both!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: both!.id, organizationId: a.orgId });
    try {
      state.userId = both!.id;
      const all = await call(searchRoute.GET, { path: "/api/ui/search?q=app&organization=all" });
      expect(ids(all.body.groups as Groups, "repository").sort()).toEqual(
        [a.repoId, b.repoId].sort(),
      );
      const active = await call(searchRoute.GET, { path: "/api/ui/search?q=app" });
      expect(ids(active.body.groups as Groups, "repository")).toEqual([a.repoId]);
      expect(
        await call(searchRecent.POST, { body: { kind: "repository", id: b.repoId } }),
      ).toMatchObject({ status: 200 });
      const recentActive = await call(searchRoute.GET, { path: "/api/ui/search" });
      expect(ids(recentActive.body.groups as Groups, "recent")).toEqual([]);
      const recentAll = await call(searchRoute.GET, { path: "/api/ui/search?organization=all" });
      expect(ids(recentAll.body.groups as Groups, "recent")).toEqual([b.repoId]);
    } finally {
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, both!.id));
      await db.delete(users).where(eq(users.id, both!.id));
    }
    state.userId = null;
    expect((await call(searchRoute.GET, { path: "/api/ui/search?q=alpha" })).status).toBe(401);
    expect((await call(searchRecent.POST, { body: { kind: "run", id: a.runId } })).status).toBe(
      401,
    );
  });

  it("opens and acts on each organization's own work items only, 404 on the other's", async () => {
    const linear = new Map<string, string>();
    const workspaces = new Map<string, FakeLinearGateway>();
    const itemId = (tenant: Tenant) => `linear-${tenant.name}-work-item`;
    try {
      for (const own of [a, b]) {
        const integration = await saveIntegration(db, {
          organizationId: own.orgId,
          provider: "linear",
          externalId: `${own.name}-work-item-workspace`,
          name: `${own.name} workspace`,
          credentials: { accessToken: "t" },
          installedByUserId: null,
        });
        if (integration === "other_organization") throw new Error("setup");
        linear.set(own.orgId, integration.id);
        const workspace = new FakeLinearGateway();
        workspace.add({
          id: `${own.name}-work-item`,
          identifier: `${own.name.toUpperCase()}-WI1`,
          title: `${own.name} work item`,
          description: `${own.name} PRD`,
        });
        workspaces.set(own.orgId, workspace);
        state.linear.set(own.orgId, workspace);
        await db
          .update(repositories)
          .set({ codingEnabled: true })
          .where(eq(repositories.id, own.repoId));
      }
      resetBacklogCache();
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.adminId, own.memberId]) {
          state.userId = userId;
          const opened = await call(workItemDetail.GET, {
            params: { id: itemId(own) },
            path: `/api/ui/work-items/${itemId(own)}`,
          });
          expect(opened.status).toBe(200);
          expect(opened.body).toMatchObject({
            title: `${own.name} work item`,
            organization: { id: own.orgId },
          });
          for (const marker of markers(other)) {
            expect(JSON.stringify(opened.body)).not.toContain(marker);
          }
          // Its own item, asked in the other organization: not found.
          expect(
            await call(workItemDetail.GET, {
              params: { id: itemId(own) },
              path: `/api/ui/work-items/${itemId(own)}?organization=${other.orgId}`,
            }),
          ).toMatchObject({ status: 404 });

          const id = itemId(other);
          const path = `/api/ui/work-items/${id}`;
          const attempts = [
            call(workItemDetail.GET, { params: { id }, path }),
            call(workItemPrd.PUT, {
              params: { id },
              path,
              method: "PUT",
              body: { markdown: "Taken over", baseUpdatedAt: "2026-01-01T00:00:01.000Z" },
            }),
            call(workItemStart.POST, { params: { id }, path, method: "POST" }),
            call(workItemTriage.POST, { params: { id }, path, method: "POST" }),
            call(workItemRepository.PUT, {
              params: { id },
              path,
              method: "PUT",
              body: { repositoryId: own.repoId },
            }),
            call(workItemMove.POST, { params: { id }, path, body: { to: "needs_refining" } }),
            call(workItemCancel.POST, { params: { id }, path, method: "POST" }),
            // A new work item for the other organization's repo.
            call(workItemCreate.POST, {
              path: "/api/ui/work-items",
              method: "POST",
              body: { repositoryId: other.repoId, title: "Planted", triageNow: true },
            }),
          ];
          for (const attempt of await Promise.all(attempts)) {
            expect(attempt).toMatchObject({ status: 404 });
          }

          // Review links: members create, list and revoke their own items' links only.
          const ownPath = `/api/ui/work-items/${itemId(own)}/share-links`;
          const created = await call(workItemShareLinks.POST, {
            params: { id: itemId(own) },
            path: ownPath,
            body: {},
          });
          expect(created.status).toBe(201);
          const ownLinkId = (created.body.link as { id: string }).id;
          const listed = await call(workItemShareLinks.GET, {
            params: { id: itemId(own) },
            path: ownPath,
          });
          expect(listed.status).toBe(200);
          expect((listed.body.links as Array<{ id: string }>).map((l) => l.id)).toContain(
            ownLinkId,
          );
          const theirLink = await createWorkItemShareLink(db, {
            organizationId: other.orgId,
            tracker: "linear",
            externalId: `${other.name}-work-item`,
            tokenHash: `isolation-${randomUUID()}`,
            passwordHash: null,
            expiresAt: new Date(Date.now() + 60_000),
            actor: { userId: null, name: "Om" },
            maxActive: 10,
          });
          if (theirLink.status !== "created") throw new Error("setup");
          const shareAttempts = [
            call(workItemShareLinks.GET, { params: { id }, path: `${path}/share-links` }),
            call(workItemShareLinks.POST, {
              params: { id },
              path: `${path}/share-links`,
              body: { password: "" },
            }),
            call(shareLinkRevoke.DELETE, {
              params: { linkId: theirLink.link.id },
              path: `/api/ui/share-links/${theirLink.link.id}`,
              method: "DELETE",
            }),
          ];
          for (const attempt of await Promise.all(shareAttempts)) {
            expect(attempt).toMatchObject({ status: 404 });
          }
          // Not revoked, and no link of the other organization's item was created.
          expect(
            (
              await listActiveWorkItemShareLinks(db, {
                organizationId: other.orgId,
                tracker: "linear",
                externalId: `${other.name}-work-item`,
              })
            ).map((link) => link.id),
          ).toEqual([theirLink.link.id]);
          await db
            .delete(workItemShareLinkRows)
            .where(eq(workItemShareLinkRows.id, theirLink.link.id));
          expect(
            await call(shareLinkRevoke.DELETE, {
              params: { linkId: ownLinkId },
              path: `/api/ui/share-links/${ownLinkId}`,
              method: "DELETE",
            }),
          ).toEqual({ status: 200, body: { ok: true } });

          // Nothing reached the other organization's tracker.
          const theirs = workspaces.get(other.orgId)!;
          expect(theirs.issueUpdates).toEqual([]);
          expect(theirs.stateChanges).toEqual([]);
          expect(theirs.delegations).toEqual([]);
          expect(theirs.labelChanges).toEqual([]);
          expect(theirs.created).toEqual([]);
        }
      }
      state.userId = null;
      expect((await call(workItemDetail.GET, { params: { id: itemId(a) } })).status).toBe(401);
    } finally {
      state.linear.clear();
      resetBacklogCache();
      for (const own of [a, b]) {
        await db
          .update(repositories)
          .set({ codingEnabled: false })
          .where(eq(repositories.id, own.repoId));
      }
      for (const id of linear.values()) {
        await db.delete(integrationRows).where(eq(integrationRows.id, id));
      }
    }
  });

  it("lists each organization's own agents to its members, and none of the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const { status, body } = await call(agentList.GET);
        expect(status).toBe(200);
        // Its own agents (an earlier test enrolled more), none of the other's (the markers).
        expect((body.agents as { id: string }[]).map((h) => h.id)).toContain(own.agentId);
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        // Fleet's scopes: its own organization by ID or all of the user's, never the other's.
        for (const organization of ["all", own.orgId]) {
          const scoped = await call(agentList.GET, {
            path: `/api/ui?organization=${organization}`,
          });
          expect(scoped.status).toBe(200);
          const rows = scoped.body.agents as { id: string; organization: { id: string } }[];
          expect(rows.map((h) => h.id)).toContain(own.agentId);
          for (const row of rows) expect(row.organization.id).toBe(own.orgId);
          for (const marker of markers(other)) {
            expect(JSON.stringify(scoped.body)).not.toContain(marker);
          }
        }
        expect(
          await call(agentList.GET, { path: `/api/ui?organization=${other.orgId}` }),
        ).toMatchObject({ status: 404 });
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
      `omniralph-agent enroll --server https://omniralph.example.com --token ${body.token}`,
    );
    const { agentId } = (await enrollAgent(db, {
      enrollmentToken: body.token as string,
      name: "host",
      version: "1.0.0",
    }))!;
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row).toMatchObject({ organizationId: b.orgId, name: "beta-2" });

    // Only its own organization sees the enrollment and its agent.
    const params = { id: body.id as string };
    expect(await call(enrollment.GET, { params })).toMatchObject({
      status: 200,
      body: { id: body.id, agent: { id: agentId, name: "beta-2" } },
    });
    state.userId = a.adminId;
    expect(await call(enrollment.GET, { params })).toMatchObject({ status: 404 });
  });

  it("404s on the other organization's enrollment", async () => {
    state.userId = a.adminId;
    expect(await call(enrollment.GET, { params: { id: a.enrollmentId } })).toMatchObject({
      status: 200,
      body: { agent: { id: a.agentId } },
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

  it("shows each organization's own agent pages to its admins, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      state.userId = own.adminId;
      const ownParams = { id: own.agentId };
      const detail = await call(agentDetail.GET, { params: ownParams });
      expect(detail).toMatchObject({ status: 200, body: { agent: { id: own.agentId } } });
      const installables = await call(agentInstallables.GET, { params: ownParams });
      expect(installables).toMatchObject({ status: 200, body: { installJobs: [] } });
      expect(detail.body.hostTools).toEqual([
        expect.objectContaining({ name: own.hostToolName, path: `/opt/${own.hostToolName}` }),
      ]);
      for (const { body } of [detail, installables]) {
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
      }

      const otherParams = { id: other.agentId };
      for (const handler of [agentDetail.GET, agentInstallables.GET]) {
        expect(await call(handler, { params: otherParams })).toMatchObject({ status: 404 });
        expect(await call(handler, { params: { id: "not-a-uuid" } })).toMatchObject({
          status: 404,
        });
      }
      // Fleet's agent detail is for every member; the old tabs' parts stay admin-only.
      state.userId = own.memberId;
      expect(await call(agentDetail.GET, { params: ownParams })).toMatchObject({
        status: 200,
        body: { agent: { id: own.agentId, organization: { id: own.orgId, role: "member" } } },
      });
      expect(await call(agentDetail.GET, { params: otherParams })).toMatchObject({ status: 404 });
      expect(await call(agentInstallables.GET, { params: ownParams })).toMatchObject({
        status: 403,
      });
    }
  });

  it("refuses every agent change on the other organization's agent and repositories", async () => {
    state.userId = a.adminId;
    const theirs = { id: b.agentId };
    // Fleet's ⋯ actions check the agent's own organization: not a member there, not found.
    const notFound = [
      await call(agentInstalls.POST, { params: theirs, body: { name: "@omniralph/hello" } }),
      await call(agentRevoke.POST, { method: "POST", params: theirs }),
      await call(agentDetail.DELETE, { method: "DELETE", params: theirs }),
    ];
    for (const response of notFound) expect(response.status).toBe(404);

    const other = (await getAgentOverview(db, b.orgId, b.agentId))!;
    expect(other).toMatchObject({
      revokedAt: null,
      deletedAt: null,
    });
    expect(other.pinnedRepositories).toEqual([]);
    expect(
      (await db.select().from(jobs).where(eq(jobs.organizationId, b.orgId))).map((j) => j.id),
    ).toEqual([b.jobId]);

    // Its own agent still works.
    expect(
      await call(agentInstalls.POST, {
        params: { id: a.agentId },
        body: { name: "@omniralph/hello" },
      }),
    ).toMatchObject({ status: 200 });
  });

  it("shows a member of both organizations either organization's agents without switching", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-admin", email: "both@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "admin" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;

    const { status, body } = await call(agentDetail.GET, { params: { id: b.agentId } });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      agent: { id: b.agentId, organization: { id: b.orgId, role: "member" } },
    });
    const all = await call(agentList.GET, { path: "/api/ui?organization=all" });
    const rows = all.body.agents as { id: string; organization: { id: string; role: string } }[];
    expect(rows.find((h) => h.id === a.agentId)?.organization).toMatchObject({ role: "admin" });
    expect(rows.find((h) => h.id === b.agentId)?.organization).toMatchObject({ role: "member" });
    // Working in Alpha, the active organization's list stays Alpha's.
    const active = await call(agentList.GET);
    expect((active.body.agents as { id: string }[]).map((h) => h.id)).not.toContain(b.agentId);
    expect((await getActiveOrganization(db, user!.id))?.id).toBe(a.orgId);
  });
  it("lists each organization's own repositories on the Repos rail, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        for (const organization of [undefined, "all", own.orgId]) {
          const query = organization ? `?organization=${organization}` : "";
          const { status, body } = await call(repositoryList.GET, { path: `/api/ui${query}` });
          expect(status).toBe(200);
          expect(body.repositories as { id: string; organization: { id: string } }[]).toEqual([
            expect.objectContaining({
              id: own.repoId,
              organization: expect.objectContaining({ id: own.orgId }),
            }),
          ]);
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }
        expect(
          await call(repositoryList.GET, { path: `/api/ui?organization=${other.orgId}` }),
        ).toMatchObject({ status: 404 });
      }
      // The Connect buttons' setup is for admins.
      state.userId = own.memberId;
      expect(await call(repositorySetup.GET)).toMatchObject({ status: 403 });
    }
    // A member of both gets both organizations' repositories under organization=all, each
    // with their role there.
    const [both] = await db
      .insert(users)
      .values({ id: "repos-rail-both", email: "repos-both@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: both!.id, role: "admin" },
      { organizationId: b.orgId, userId: both!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: both!.id, organizationId: a.orgId });
    try {
      state.userId = both!.id;
      const all = await call(repositoryList.GET, { path: "/api/ui?organization=all" });
      expect(all.status).toBe(200);
      const rows = all.body.repositories as {
        id: string;
        organization: { id: string; role: string };
      }[];
      expect(new Map(rows.map((r) => [r.id, r.organization]))).toEqual(
        new Map([
          [a.repoId, expect.objectContaining({ id: a.orgId, role: "admin" })],
          [b.repoId, expect.objectContaining({ id: b.orgId, role: "member" })],
        ]),
      );
    } finally {
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, both!.id));
      await db.delete(users).where(eq(users.id, both!.id));
    }
  });

  it("lists only its own organization's connections' repos to admins, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      state.userId = own.adminId;
      // The picker's list never asks the code host for another organization's connection.
      expect(
        await call(selectable.GET, {
          params: { id: other.connectionId },
          path: "/api/ui?provider=github",
        }),
      ).toMatchObject({ status: 404 });

      state.userId = own.memberId;
      expect(
        await call(selectable.GET, {
          params: { id: own.connectionId },
          path: "/api/ui?provider=github",
        }),
      ).toMatchObject({ status: 403 });
    }
  });

  it("shows each organization's own repository detail, and 404s on the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const userId of [own.adminId, own.memberId]) {
        state.userId = userId;
        const { status, body } = await call(repositoryDetail.GET, { params: { id: own.repoId } });
        expect(status).toBe(200);
        expect(body).toMatchObject({
          repository: {
            id: own.repoId,
            fullPath: own.repoPath,
            organization: { id: own.orgId, role: userId === own.adminId ? "admin" : "member" },
          },
          canEdit: userId === own.adminId,
        });
        // Its own agents (an earlier test enrolled more), none of the other's (the markers).
        expect((body.agents as { pinnable: { id: string }[] }).pinnable.map((h) => h.id)).toContain(
          own.agentId,
        );
        for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        expect(await call(repositoryDetail.GET, { params: { id: other.repoId } })).toMatchObject({
          status: 404,
        });
      }
      expect(await call(repositoryDetail.GET, { params: { id: "not-a-uuid" } })).toMatchObject({
        status: 404,
      });
    }
  });

  it("refuses every repository settings save on the other organization's repository", async () => {
    const cards = (id: string, agentId: string) => [
      call(repositoryReviews.PUT, {
        method: "PUT",
        params: { id },
        body: {
          reviewsEnabled: false,
          triggers: { onOpen: false, onPush: false, drafts: false },
          depth: "deep",
          pathExcludes: [],
          reviewerInstructions: "",
        },
      }),
      call(repositoryAsk.PUT, { method: "PUT", params: { id }, body: { askEnabled: false } }),
      call(repositoryAgents.PUT, {
        method: "PUT",
        params: { id },
        body: { pinnedAgentIds: [agentId] },
      }),
      call(repositoryPlaybooks.PUT, {
        method: "PUT",
        params: { id },
        body: {
          bindings: {
            review: ["builtin:summarize-pr"],
            correlation: "builtin:correlate-findings",
            story: "builtin:implement-story",
            request: "builtin:handle-request",
          },
        },
      }),
    ];
    const codingSave = (id: string) =>
      call(repositoryCoding.PUT, { method: "PUT", params: { id }, body: CODING_CARD });
    const matchCheck = (id: string) =>
      call(repositoryMatchCheck.POST, {
        method: "POST",
        params: { id },
        body: { workItemMatch: { tracker: "linear", team: "ENG" } },
      });
    const trackerOptions = (id: string) =>
      call(repositoryTrackerOptions.GET, { method: "GET", params: { id } });
    state.userId = a.adminId;
    // The card saves serve any of the user's organizations: the other's repo is not found.
    for (const response of await Promise.all([
      ...cards(b.repoId, b.agentId),
      codingSave(b.repoId),
      matchCheck(b.repoId),
      trackerOptions(b.repoId),
    ])) {
      expect(response).toMatchObject({ status: 404, body: { error: expect.any(String) } });
    }
    for (const response of await Promise.all([
      ...cards("not-a-uuid", b.agentId),
      codingSave("not-a-uuid"),
      matchCheck("not-a-uuid"),
      trackerOptions("not-a-uuid"),
    ])) {
      expect(response.status).toBe(404);
    }
    // Pinning the other organization's agent on the admin's own repository is refused.
    const foreignPin = await call(repositoryAgents.PUT, {
      method: "PUT",
      params: { id: a.repoId },
      body: { pinnedAgentIds: [b.agentId] },
    });
    expect(foreignPin).toMatchObject({
      status: 400,
      body: { fieldErrors: { pinnedAgentIds: expect.any(String) } },
    });
    // Members change nothing, in their own organization either.
    state.userId = b.memberId;
    for (const response of await Promise.all([
      ...cards(b.repoId, b.agentId),
      codingSave(b.repoId),
      matchCheck(b.repoId),
      trackerOptions(b.repoId),
    ])) {
      expect(response.status).toBe(403);
    }
    expect(await getRepository(db, b.repoId)).toMatchObject({
      reviewDepth: "standard",
      reviewsEnabled: true,
      askEnabled: true,
      codingEnabled: false,
      historyRewrite: "when-asked",
      reviewPlaybookIds: ["builtin:review-pr"],
    });
    expect(
      await db.select().from(agentRepoPins).where(eq(agentRepoPins.repositoryId, b.repoId)),
    ).toEqual([]);
  });

  it("saves each card of a repo of a non-active organization for its admin, not after they leave", async () => {
    const [both] = await db
      .insert(users)
      .values({ id: "cards-both-admin", email: "cards-both@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: both!.id, role: "member" },
      { organizationId: b.orgId, userId: both!.id, role: "admin" },
    ]);
    await setActiveOrganization(db, { userId: both!.id, organizationId: a.orgId });
    state.userId = both!.id;
    const before = await getRepository(db, b.repoId);
    try {
      const saves = [
        call(repositoryAsk.PUT, {
          method: "PUT",
          params: { id: b.repoId },
          body: { askEnabled: false },
        }),
        call(repositoryAgents.PUT, {
          method: "PUT",
          params: { id: b.repoId },
          body: { pinnedAgentIds: [b.agentId] },
        }),
      ];
      const [ask, agentsSaved] = await Promise.all(saves);
      expect(ask).toMatchObject({ status: 200, body: { ok: true, card: { enabled: false } } });
      expect(agentsSaved).toMatchObject({
        status: 200,
        body: { ok: true, card: { pinned: [{ id: b.agentId }] } },
      });
      const reviews = await call(repositoryReviews.PUT, {
        method: "PUT",
        params: { id: b.repoId },
        body: {
          reviewsEnabled: true,
          triggers: before!.triggers,
          depth: "quick",
          pathExcludes: [],
          reviewerInstructions: "",
        },
      });
      expect(reviews).toMatchObject({ status: 200, body: { card: { depth: "quick" } } });
      const playbooks = await call(repositoryPlaybooks.PUT, {
        method: "PUT",
        params: { id: b.repoId },
        body: {
          bindings: {
            review: ["builtin:summarize-pr"],
            correlation: before!.correlationPlaybookId,
            story: before!.storyPlaybookId,
            request: before!.requestPlaybookId,
          },
        },
      });
      expect(playbooks).toMatchObject({
        status: 200,
        body: { card: { bindings: { review: ["builtin:summarize-pr"] } } },
      });
      expect(
        await call(repositoryCoding.PUT, {
          method: "PUT",
          params: { id: b.repoId },
          body: CODING_CARD,
        }),
      ).toMatchObject({ status: 200, body: { card: { historyRewrite: "always" }, warnings: [] } });
      expect(
        await call(repositoryMatchCheck.POST, {
          method: "POST",
          params: { id: b.repoId },
          body: { workItemMatch: { tracker: "linear", team: "ENG" } },
        }),
      ).toEqual({ status: 200, body: { warnings: [] } });
      // An admin of the active organization only is refused (member of the repo's).
      await db
        .update(organizationMembers)
        .set({ role: "member" })
        .where(
          and(
            eq(organizationMembers.userId, both!.id),
            eq(organizationMembers.organizationId, b.orgId),
          ),
        );
      expect(
        await call(repositoryAsk.PUT, {
          method: "PUT",
          params: { id: b.repoId },
          body: { askEnabled: true },
        }),
      ).toMatchObject({ status: 403 });
      // After leaving, the repo isn't found.
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, both!.id),
            eq(organizationMembers.organizationId, b.orgId),
          ),
        );
      expect(
        await call(repositoryAsk.PUT, {
          method: "PUT",
          params: { id: b.repoId },
          body: { askEnabled: true },
        }),
      ).toMatchObject({ status: 404 });
    } finally {
      // As the other tests expect b's repo.
      await db
        .update(repositories)
        .set({
          askEnabled: before!.askEnabled,
          historyRewrite: before!.historyRewrite,
          reviewDepth: before!.reviewDepth,
          reviewPlaybookIds: before!.reviewPlaybookIds,
        })
        .where(eq(repositories.id, b.repoId));
      await db.delete(agentRepoPins).where(eq(agentRepoPins.repositoryId, b.repoId));
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, both!.id));
      await db.delete(users).where(eq(users.id, both!.id));
    }
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
      expect(response).toMatchObject({ status: 404, body: { error: expect.any(String) } });
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

  it("serves a member of both organizations the other's repo page, rules and webhook without switching", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-repos-page", email: "both-repos-page@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "admin" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;
    const id = b.repoId;
    const setRole = (role: Role) =>
      db
        .update(organizationMembers)
        .set({ role })
        .where(
          and(
            eq(organizationMembers.userId, user!.id),
            eq(organizationMembers.organizationId, b.orgId),
          ),
        );
    try {
      // A member there: the page and rules read-only, whichever organization is active.
      const page = await call(repositoryDetail.GET, { params: { id } });
      expect(page).toMatchObject({
        status: 200,
        body: {
          repository: { id, organization: { id: b.orgId, role: "member" } },
          canEdit: false,
        },
      });
      for (const marker of markers(a)) expect(JSON.stringify(page.body)).not.toContain(marker);
      expect(await call(repositoryRules.GET, { params: { id } })).toMatchObject({
        status: 200,
        body: { repository: { id }, rules: [{ id: b.ruleId }] },
      });
      for (const response of [
        await call(repositoryRules.POST, { params: { id }, body: { text: "Both rule" } }),
        await call(repositoryRule.PATCH, {
          method: "PATCH",
          params: { id, ruleId: b.ruleId },
          body: { enabled: false },
        }),
        await call(repositoryRule.DELETE, { method: "DELETE", params: { id, ruleId: b.ruleId } }),
        await call(repositoryWebhook.POST, { method: "POST", params: { id } }),
      ]) {
        expect(response.status).toBe(403);
      }

      // An admin there edits them without entering it.
      await setRole("admin");
      expect(await call(repositoryDetail.GET, { params: { id } })).toMatchObject({
        body: { repository: { organization: { role: "admin" } }, canEdit: true },
      });
      expect(
        await call(repositoryRules.POST, { params: { id }, body: { text: "Both rule" } }),
      ).toMatchObject({ status: 200, body: { ok: true } });
      const added = (await listRepositoryRules(db, id)).find((r) => r.text === "Both rule")!;
      expect(
        await call(repositoryRule.PATCH, {
          method: "PATCH",
          params: { id, ruleId: added.id },
          body: { text: "Both rule, edited" },
        }),
      ).toMatchObject({ status: 200, body: { ok: true } });
      expect(
        await call(repositoryRule.DELETE, { method: "DELETE", params: { id, ruleId: added.id } }),
      ).toMatchObject({ status: 200, body: { ok: true } });
      // The webhook handler runs in Beta (its repository is a GitHub one, so it has none).
      expect(await call(repositoryWebhook.POST, { method: "POST", params: { id } })).toMatchObject({
        status: 400,
        body: { error: "That GitLab project isn't connected." },
      });

      // Leaving Beta loses its repos.
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, user!.id),
            eq(organizationMembers.organizationId, b.orgId),
          ),
        );
      for (const response of [
        await call(repositoryDetail.GET, { params: { id } }),
        await call(repositoryRules.GET, { params: { id } }),
        await call(repositoryRules.POST, { params: { id }, body: { text: "Both rule" } }),
        await call(repositoryWebhook.POST, { method: "POST", params: { id } }),
      ]) {
        expect(response.status).toBe(404);
      }
    } finally {
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
    }
    expect((await listRepositoryRules(db, id)).map((r) => [r.text, r.enabled])).toEqual([
      ["beta rule", true],
    ]);
  });

  it("refuses every repository and connection change on the other organization's rows", async () => {
    state.userId = a.adminId;
    expect(
      await call(repositoryWebhook.POST, { method: "POST", params: { id: b.repoId } }),
    ).toMatchObject({ status: 404 });
    // The other organization's connection, named as one of the admin's own organization's.
    expect(
      await call(selectable.POST, {
        method: "POST",
        params: { id: b.connectionId },
        body: { provider: "github", ids: [500], organizationId: a.orgId },
      }),
    ).toMatchObject({ status: 400 });
    // An organization the admin isn't a member of isn't found.
    for (const response of [
      await call(scmConnection.DELETE, { method: "DELETE", params: { id: b.connectionId } }),
      await call(repository.DELETE, { method: "DELETE", params: { id: b.repoId } }),
      await call(selectable.POST, {
        method: "POST",
        params: { id: b.connectionId },
        body: { provider: "github", ids: [500], organizationId: b.orgId },
      }),
      await call(selectable.GET, {
        params: { id: b.connectionId },
        path: `/api/ui?${new URLSearchParams({ provider: "github", organization: b.orgId })}`,
      }),
      await call(scmConnectionList.GET, {
        path: `/api/ui?${new URLSearchParams({ organization: b.orgId })}`,
      }),
      await call(repositorySetup.GET, {
        path: `/api/ui?${new URLSearchParams({ organization: b.orgId })}`,
      }),
      await call(gitlabConnections.POST, {
        body: { baseUrl: "https://gitlab.example.com", token: "glpat-x", organizationId: b.orgId },
      }),
    ]) {
      expect(response.status).toBe(404);
    }
    expect(await getRepository(db, b.repoId)).toMatchObject({
      disconnectedAt: null,
      reviewsEnabled: true,
    });
    expect(
      await db.select().from(scmConnections).where(eq(scmConnections.id, b.connectionId)),
    ).toHaveLength(1);
    expect(
      await call(repository.DELETE, { method: "DELETE", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });
    expect(
      await call(scmConnection.DELETE, { method: "DELETE", params: { id: "not-a-uuid" } }),
    ).toMatchObject({ status: 404 });
    expect(
      await call(scmConnection.DELETE, { method: "DELETE", params: { id: randomUUID() } }),
    ).toMatchObject({ status: 404 });

    // Members change nothing, in their own organization either.
    state.userId = a.memberId;
    for (const response of [
      await call(repository.DELETE, { method: "DELETE", params: { id: a.repoId } }),
      await call(repositoryWebhook.POST, { method: "POST", params: { id: a.repoId } }),
      await call(scmConnection.DELETE, { method: "DELETE", params: { id: a.connectionId } }),
      await call(selectable.POST, {
        method: "POST",
        params: { id: a.connectionId },
        body: { provider: "github", ids: [1], organizationId: a.orgId },
      }),
      await call(selectable.GET, {
        params: { id: a.connectionId },
        path: `/api/ui?${new URLSearchParams({ provider: "github", organization: a.orgId })}`,
      }),
      await call(scmConnectionList.GET, {
        path: `/api/ui?${new URLSearchParams({ organization: a.orgId })}`,
      }),
      await call(repositorySetup.GET),
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

  it("lets an admin of another organization list its connections and remove its repos and connections without switching", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-repos-admin", email: "both-repos@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "member" },
      { organizationId: b.orgId, userId: user!.id, role: "admin" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    state.userId = user!.id;
    try {
      const listed = await call(scmConnectionList.GET, {
        path: `/api/ui?${new URLSearchParams({ organization: b.orgId })}`,
      });
      expect(listed.status).toBe(200);
      expect((listed.body.connections as { id: string }[]).map((c) => c.id)).toEqual([
        b.connectionId,
      ]);
      expect(
        await call(repositorySetup.GET, {
          path: `/api/ui?${new URLSearchParams({ organization: b.orgId })}`,
        }),
      ).toMatchObject({ status: 200 });
      // Picking and adding repos, connecting GitLab and loading a repo's tracker options in
      // the other organization get past the access check: what answers is the code host
      // (no GitHub App configured here, GitLab unreachable) or the tracker, not a 403/404.
      expect(
        await call(selectable.GET, {
          params: { id: b.connectionId },
          path: `/api/ui?${new URLSearchParams({ provider: "github", organization: b.orgId })}`,
        }),
      ).toMatchObject({ status: 502, body: { code: "listing_failed" } });
      expect(
        await call(selectable.POST, {
          method: "POST",
          params: { id: b.connectionId },
          body: { provider: "github", ids: [500], organizationId: b.orgId },
        }),
      ).toMatchObject({
        status: 400,
        body: { error: expect.stringContaining("Couldn't list the installation's repositories") },
      });
      const offline = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
      try {
        expect(
          await call(gitlabConnections.POST, {
            body: {
              baseUrl: "https://gitlab.example.com",
              token: "glpat-x",
              organizationId: b.orgId,
            },
          }),
        ).toMatchObject({
          status: 400,
          body: { error: expect.stringContaining("Couldn't reach GitLab") },
        });
      } finally {
        offline.mockRestore();
      }
      expect(await call(repositoryTrackerOptions.GET, { params: { id: b.repoId } })).toMatchObject({
        status: 200,
        body: { status: "disconnected" },
      });
      // A member of the active organization: its connections and setup stay admin-only.
      expect(await call(scmConnectionList.GET)).toMatchObject({ status: 403 });
      expect(await call(repositorySetup.GET)).toMatchObject({ status: 403 });
      expect(
        await call(repository.DELETE, { method: "DELETE", params: { id: a.repoId } }),
      ).toMatchObject({ status: 403 });

      const extra = await connectRepository(db, {
        connectionId: b.connectionId,
        provider: "github",
        externalId: "both-admin-removes",
        fullPath: "beta/removed-by-other-admin",
      });
      expect(
        await call(repository.DELETE, { method: "DELETE", params: { id: extra.id } }),
      ).toMatchObject({ status: 200, body: { ok: true } });
      expect(await getRepository(db, extra.id)).toMatchObject({
        disconnectedAt: expect.any(Date),
      });
      // Removed already: not found.
      expect(
        await call(repository.DELETE, { method: "DELETE", params: { id: extra.id } }),
      ).toMatchObject({ status: 404 });

      // Removing a connection of the other organization, as its admin, without switching.
      const removable = (await upsertScmConnection(db, {
        organizationId: b.orgId,
        provider: "github",
        name: "beta-removable",
        baseUrl: "https://api.github.com",
        externalId: "beta-removable-installation",
        credentials: {},
      }))!;
      const removableRepo = await connectRepository(db, {
        connectionId: removable.id,
        provider: "github",
        externalId: "beta-removable-1",
        fullPath: "beta-removable/app",
      });
      // The active organization's connection stays admin-only.
      expect(
        await call(scmConnection.DELETE, { method: "DELETE", params: { id: a.connectionId } }),
      ).toMatchObject({ status: 403 });
      expect(
        await call(scmConnection.DELETE, { method: "DELETE", params: { id: removable.id } }),
      ).toMatchObject({ status: 200, body: { ok: true } });
      expect(
        await db.select().from(scmConnections).where(eq(scmConnections.id, removable.id)),
      ).toHaveLength(0);
      expect(await getRepository(db, removableRepo.id)).toBeNull();
      expect(
        await db.select().from(scmConnections).where(eq(scmConnections.id, b.connectionId)),
      ).toHaveLength(1);
      expect(
        await db.select().from(scmConnections).where(eq(scmConnections.id, a.connectionId)),
      ).toHaveLength(1);
      // Removed already: not found.
      expect(
        await call(scmConnection.DELETE, { method: "DELETE", params: { id: removable.id } }),
      ).toMatchObject({ status: 404 });
    } finally {
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
    }
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
    // Each epic's story was built in a commit, which the code host has.
    state.scm = new FakeScmAdapter();
    for (const tenant of [a, b]) {
      const sha = tenant.name.padEnd(40, "0");
      await updateStory(db, tenant.storyId, { commitSha: sha });
      state.scm.commitDiffs.set(`${tenant.repoPath}@${sha}`, {
        sha,
        url: `https://github.com/${tenant.repoPath}/commit/${sha}`,
        files: [
          {
            path: `${tenant.name}.ts`,
            previousPath: null,
            status: "added",
            additions: 1,
            deletions: 0,
            patch: `@@ -0,0 +1 @@\n+${tenant.name}`,
            truncated: false,
          },
        ],
        truncated: false,
      });
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
        const session = await call(runSession.GET, { params: { id: own.runId } });
        expect(session).toMatchObject({ status: 200, body: { messages: [] } });
        const diff = await call(runStepDiff.GET, {
          params: { id: own.runId, stepId: own.storyId },
        });
        expect(diff).toMatchObject({ status: 200, body: { files: [{ path: `${own.name}.ts` }] } });
        for (const { body } of [list, detail, triageDetail, transcript, session, diff]) {
          for (const marker of markers(other)) expect(JSON.stringify(body)).not.toContain(marker);
        }

        for (const id of [other.runId, other.triageRunId, "not-a-uuid"]) {
          expect(await call(runDetail.GET, { params: { id } })).toMatchObject({ status: 404 });
          expect(await call(runSession.GET, { params: { id } })).toMatchObject({ status: 404 });
        }
        // The other's story, through their run or through one's own.
        for (const id of [other.runId, own.runId]) {
          expect(
            await call(runStepDiff.GET, { params: { id, stepId: other.storyId } }),
          ).toMatchObject({ status: 404 });
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
    for (const tenant of [a, b]) await updateStory(db, tenant.storyId, { commitSha: null });
    state.scm = null;
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
      const pass = await createReview(db, {
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
      await db.insert(findings).values({
        reviewId: pass.id,
        path: `${tenant.name}.ts`,
        startLine: 1,
        endLine: 1,
        severity: "high",
        category: "bug",
        title: `${tenant.name} finding`,
        body: "Body",
        confidence: 0.9,
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
          `${other.name} finding`,
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
          const ownFindings = await call(runFindings.GET, { params: { id: mine.reviewRunId } });
          expect(ownFindings).toMatchObject({
            status: 200,
            body: { passes: [{ files: [{ findings: [{ title: `${own.name} finding` }] }] }] },
          });
          details.push(ownFindings);
          for (const { body } of [...lists, ...details]) {
            for (const marker of theirMarkers) expect(JSON.stringify(body)).not.toContain(marker);
          }

          // The other's review run and ask, and their attempts through one's own runs.
          for (const id of [theirs.reviewRunId, theirs.askId]) {
            expect(await call(runDetail.GET, { params: { id } })).toMatchObject({ status: 404 });
            expect(await call(runFindings.GET, { params: { id } })).toMatchObject({ status: 404 });
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

  it("shows each member only their own Ask chats and their organization's repos, 404 on anything else", async () => {
    const chats = new Map<string, { id: string }>();
    /** Each chat's card message, by organization. */
    const cards = new Map<string, string>();
    for (const own of [a, b]) {
      const thread = await createWebChatThread(db, {
        organizationId: own.orgId,
        userId: own.memberId,
        repositoryId: own.repoId,
        branch: "main",
        title: `${own.name} chat`,
      });
      await appendWebMessage(db, {
        threadId: thread.id,
        author: "user",
        userId: own.memberId,
        markdown: `${own.name} question`,
      });
      const card = (await appendWebMessage(db, {
        threadId: thread.id,
        author: "om",
        markdown: "**Pick one**",
        card: {
          type: "card",
          title: "Pick one",
          children: [
            {
              type: "actions",
              children: [{ type: "button", id: "pick", label: "This", value: "1" }],
            },
          ],
        },
      }))!;
      cards.set(own.orgId, card.id);
      chats.set(own.orgId, thread);
    }
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const ownChat = chats.get(own.orgId)!;
      const otherChat = chats.get(other.orgId)!;
      state.userId = own.memberId;
      const listed = await call(askChats.GET);
      expect(listed.status).toBe(200);
      expect((listed.body.chats as Array<{ id: string }>).map((c) => c.id)).toEqual([ownChat.id]);
      expect(JSON.stringify(listed.body)).not.toContain(other.name);
      expect(
        (await call(askChats.GET, { path: `/api/ui?organization=${other.orgId}` })).status,
      ).toBe(404);

      const shown = await call(askChat.GET, { params: { id: ownChat.id } });
      expect(shown.status).toBe(200);
      expect(JSON.stringify(shown.body)).not.toContain(other.name);
      expect((await call(askChat.GET, { params: { id: otherChat.id } })).status).toBe(404);
      const before = await db.select().from(chatWebMessages);
      expect(
        (await call(askChatMessages.POST, { params: { id: otherChat.id }, body: { text: "Hi" } }))
          .status,
      ).toBe(404);
      for (const body of [
        { organizationId: other.orgId, repositoryId: null, text: "Hi" },
        { organizationId: other.orgId, repositoryId: other.repoId, text: "Hi" },
        { organizationId: own.orgId, repositoryId: other.repoId, text: "Hi" },
      ]) {
        expect((await call(askChats.POST, { body })).status, JSON.stringify(body)).toBe(404);
      }
      // A card action on the other chat, or on its card through one's own chat.
      const otherCard = { messageId: cards.get(other.orgId)!, actionId: "pick", value: "1" };
      expect(
        (await call(askChatActions.POST, { params: { id: otherChat.id }, body: otherCard })).status,
      ).toBe(404);
      expect(
        (await call(askChatActions.POST, { params: { id: ownChat.id }, body: otherCard })).status,
      ).toBe(404);
      expect(await db.select().from(chatWebMessages)).toHaveLength(before.length);

      const repos = await call(askRepositories.GET);
      expect(repos.status).toBe(200);
      const repoIds = (repos.body.repositories as Array<{ id: string }>).map((r) => r.id);
      expect(repoIds).not.toContain(other.repoId);
      expect(JSON.stringify(repos.body)).not.toContain(other.name);
      expect(
        (await call(askRepositories.GET, { path: `/api/ui?organization=${other.orgId}` })).status,
      ).toBe(404);

      // A chat is private to the member who started it, even within the organization.
      state.userId = own.adminId;
      expect((await call(askChat.GET, { params: { id: ownChat.id } })).status).toBe(404);
      expect(
        (
          await call(askChatActions.POST, {
            params: { id: ownChat.id },
            body: { messageId: cards.get(own.orgId)!, actionId: "pick", value: "1" },
          })
        ).status,
      ).toBe(404);
      expect(
        ((await call(askChats.GET)).body.chats as Array<{ id: string }>).map((c) => c.id),
      ).not.toContain(ownChat.id);
    }
    await db.delete(chatThreads).where(
      inArray(
        chatThreads.id,
        [...chats.values()].map((c) => c.id),
      ),
    );
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

  it("lets a member of both organizations cancel a job of the one that isn't active", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-cancel-member", email: "both-cancel@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "member" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    try {
      state.userId = user!.id;
      // The Runs screen under All organizations opens b's run without switching to b.
      expect(await call(jobCancel.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject(
        {
          status: 200,
          body: { ok: true, warning: CANCEL_REQUESTED_WARNING },
        },
      );
      // Once the user leaves b, its jobs are refused again.
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, user!.id),
            eq(organizationMembers.organizationId, b.orgId),
          ),
        );
      expect(await call(jobCancel.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject(
        { status: 400, body: { error: "That job doesn't exist." } },
      );
    } finally {
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
    }
  });

  it("refuses to rerun the other organization's job, and its own members may rerun it", async () => {
    state.userId = a.adminId;
    expect(await call(jobRerun.POST, { method: "POST", params: { id: b.jobId } })).toMatchObject({
      status: 404,
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

  it("lets a member of both organizations rerun a failed repo sync of the one that isn't active", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-rerun-member", email: "both-rerun@alpha.io" })
      .returning();
    await db.insert(organizationMembers).values([
      { organizationId: a.orgId, userId: user!.id, role: "member" },
      { organizationId: b.orgId, userId: user!.id, role: "member" },
    ]);
    await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId });
    const [sync] = await db
      .insert(jobs)
      .values({
        organizationId: b.orgId,
        type: "repo.sync",
        taskType: "system",
        status: "failed",
        agentId: b.agentId,
        targetAgentId: b.agentId,
        repositoryId: b.repoId,
        payload: { repositoryId: b.repoId },
      })
      .returning();
    try {
      state.userId = user!.id;
      // The Repos rail under All organizations offers Retry on b's repo without switching to b.
      expect(await call(jobRerun.POST, { method: "POST", params: { id: sync!.id } })).toMatchObject(
        { status: 200, body: { ok: true, jobId: expect.any(String) } },
      );
      // A user of a only (a's admin) doesn't reach it.
      state.userId = a.adminId;
      expect(await call(jobRerun.POST, { method: "POST", params: { id: sync!.id } })).toMatchObject(
        { status: 404, body: { error: "That job doesn't exist." } },
      );
      // Once the user leaves b, its jobs are not found again.
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, user!.id),
            eq(organizationMembers.organizationId, b.orgId),
          ),
        );
      state.userId = user!.id;
      expect(await call(jobRerun.POST, { method: "POST", params: { id: sync!.id } })).toMatchObject(
        { status: 404, body: { error: "That job doesn't exist." } },
      );
    } finally {
      await db.delete(jobs).where(eq(jobs.id, sync!.id));
      await db.delete(organizationMembers).where(eq(organizationMembers.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
    }
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

    // A page of the other organization's resource gets the signed path that switches to
    // its organization and comes back to the page.
    const page = `/fleet/${b.agentId}`;
    const enterPath = await createEnterOrganizationPath({
      userId: user!.id,
      organizationId: b.orgId,
      next: page,
    });
    expect(enterPath).toMatch(new RegExp(`^${ENTER_ORGANIZATION_PATH}\\?token=`));
    expect((await getActiveOrganization(db, user!.id))?.id).toBe(a.orgId);
    const response = await enterOrganization(new NextRequest(`http://localhost${enterPath}`));
    expect(response.headers.get("location")).toBe(`http://localhost${page}`);
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(b.orgId);
    expect((await getActiveOrganization(db, user!.id))?.id).toBe(b.orgId);
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
    /** Each tenant's Slack workspace and Discord server, one channel of each with its own playbooks. */
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
          await upsertChatChannelPlaybookSetting(db, {
            organizationId: own.orgId,
            connectionId: saved.id,
            channelId:
              platform === "slack"
                ? `slack:C${own.name.toUpperCase()}`
                : `discord:${saved.externalId}:1`,
            askPlaybookId: "builtin:ask-about-code",
            startWorkPlaybookId: null,
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

    it("lists each organization's own Linear, Slack and Discord connections to its members, and none of the other's", async () => {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.memberId, own.adminId]) {
          state.userId = userId;
          const { status, body } = await call(connectionList.GET);
          expect(status).toBe(200);
          const rows = (body as { connections: { provider: string; id: string; name: string }[] })
            .connections;
          expect(
            rows
              .filter((row) => ["linear", "slack", "discord"].includes(row.provider))
              .map((row) => [row.provider, row.name])
              .sort(),
          ).toEqual([
            ["discord", `${own.name}-discord workspace`],
            ["linear", `${own.name}-linear workspace`],
            ["slack", `${own.name}-slack workspace`],
          ]);
          expect(rows.map((row) => row.id)).toEqual(
            expect.arrayContaining([extra(own).slackId, extra(own).discordId]),
          );
          const json = JSON.stringify(body);
          for (const marker of markersOf(other)) expect(json).not.toContain(marker);
        }
      }
    });

    it("shows each organization's members its own chat playbooks and channel overrides only", async () => {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        for (const userId of [own.memberId, own.adminId]) {
          state.userId = userId;
          const { status, body } = await call(chatPlaybooks.GET);
          expect(status).toBe(200);
          const connections = (body as { connections: { id: string; channels: unknown[] }[] })
            .connections;
          expect(connections.map((c) => [c.id, c.channels.length]).sort()).toEqual(
            [
              [extra(own).slackId, 1],
              [extra(own).discordId, 1],
            ].sort(),
          );
          const json = JSON.stringify(body);
          for (const marker of markersOf(other)) expect(json).not.toContain(marker);
        }
      }
    });

    it("refuses every integration change on the other organization's connections, and to members", async () => {
      const valid = { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" };
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
        await call(channelPlaybooks.PUT, {
          method: "PUT",
          params: otherSlack,
          body: { channel: "C0123ABCD", ...valid },
        }),
      ).toEqual({ status: 400, body: { error: "That chat connection isn't connected." } });
      expect(
        await call(channelPlaybooks.DELETE, {
          method: "DELETE",
          params: otherSlack,
          body: { channelId: "slack:CBETA" },
        }),
      ).toEqual({ status: 400, body: { error: "That channel has no playbook overrides." } });
      // Another organization's id under its own platform's route, and a non-uuid.
      expect(
        await call(slackIntegration.DELETE, { method: "DELETE", params: otherDiscord }),
      ).toMatchObject({ status: 400 });
      expect(
        await call(slackIntegration.DELETE, { method: "DELETE", params: { id: "nope" } }),
      ).toMatchObject({ status: 404 });
      expect(
        await call(channelPlaybooks.PUT, { method: "PUT", params: { id: "nope" }, body: {} }),
      ).toMatchObject({ status: 404 });

      // Members can't change anything.
      state.userId = b.memberId;
      for (const result of [
        await call(linearIntegration.DELETE, { method: "DELETE" }),
        await call(slackIntegration.DELETE, { method: "DELETE", params: otherSlack }),
        await call(discordIntegration.DELETE, { method: "DELETE", params: otherDiscord }),
        await call(chatPlaybooks.PUT, { method: "PUT", body: valid }),
        await call(channelPlaybooks.PUT, {
          method: "PUT",
          params: otherSlack,
          body: { channel: "C0123ABCD", ...valid },
        }),
        await call(channelPlaybooks.DELETE, {
          method: "DELETE",
          params: otherSlack,
          body: { channelId: "slack:CBETA" },
        }),
      ]) {
        expect(result).toMatchObject({ status: 403 });
      }

      expect(await listChatConnections(db, b.orgId)).toHaveLength(2);
      expect(await listChatChannelPlaybookSettings(db, b.orgId)).toHaveLength(2);
      expect(await getIntegration(db, b.orgId, "linear")).not.toBeNull();
    });

    it("changes only the active organization's integrations", async () => {
      state.userId = a.adminId;
      const chosen = {
        ask: "builtin:ask-about-code",
        startWork: "builtin:handle-request",
      };
      expect(await call(chatPlaybooks.PUT, { method: "PUT", body: chosen })).toEqual({
        status: 200,
        body: { ok: true },
      });
      expect(
        await call(channelPlaybooks.PUT, {
          method: "PUT",
          params: { id: extra(a).slackId },
          body: { channel: "C0123ABCD", ask: null, startWork: "builtin:handle-request" },
        }),
      ).toEqual({
        status: 200,
        body: {
          ok: true,
          channel: {
            channelId: "slack:C0123ABCD",
            channel: "C0123ABCD",
            ask: null,
            startWork: "builtin:handle-request",
          },
        },
      });
      expect(
        await call(channelPlaybooks.DELETE, {
          method: "DELETE",
          params: { id: extra(a).slackId },
          body: { channelId: "slack:CALPHA" },
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(
        (await listChatChannelPlaybookSettings(db, a.orgId)).map((t) => t.channelId).sort(),
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
      const { body: listed } = await call(connectionList.GET);
      expect(
        (listed as { connections: { provider: string; id: string }[] }).connections
          .filter((row) => ["linear", "slack", "discord"].includes(row.provider))
          .map((row) => [row.provider, row.id]),
      ).toEqual([["discord", extra(a).discordId]]);

      // The other organization keeps everything.
      expect(await getIntegration(db, b.orgId, "linear")).not.toBeNull();
      expect(await listChatConnections(db, b.orgId)).toHaveLength(2);
      expect(await listChatChannelPlaybookSettings(db, b.orgId)).toHaveLength(2);
    });
  });

  describe("playbooks", () => {
    /** Each tenant's own review playbook, created through the API. */
    const created = new Map<string, string>();
    const own = (tenant: Tenant) => created.get(tenant.name)!;
    const { id: _reviewPrId, ...reviewPr } = getBuiltinPlaybook("builtin:review-pr")!;
    const playbookInput = (tenant: Tenant) => ({
      ...reviewPr,
      name: `${tenant.name}-playbook`,
      systemPrompt: `${tenant.name} prompt`,
    });
    const playbookMarkers = (tenant: Tenant) => [own(tenant), `${tenant.name}-playbook`];

    beforeAll(async () => {
      for (const tenant of [a, b]) {
        state.userId = tenant.adminId;
        const playbook = await call(playbookList.POST, { body: playbookInput(tenant) });
        expect(playbook).toMatchObject({ status: 200, body: { ok: true } });
        created.set(tenant.name, playbook.body.id as string);
      }
    });

    it("lists and shows each organization's own playbooks to its members, and 404s on the other's", async () => {
      for (const [mine, other] of [
        [a, b],
        [b, a],
      ] as const) {
        state.userId = mine.memberId;
        const list = await call(playbookList.GET);
        expect(list.status).toBe(200);
        expect(list.body.playbooks).toContainEqual(
          expect.objectContaining({ id: own(mine), builtin: false, role: "review" }),
        );
        const detail = await call(playbookDetail.GET, { params: { id: own(mine) } });
        expect(detail).toMatchObject({
          status: 200,
          body: { playbook: { name: `${mine.name}-playbook` }, builtin: false },
        });
        // A built-in's "used by" lists only this organization's settings.
        const builtin = await call(playbookDetail.GET, {
          params: { id: encodeURIComponent("builtin:review-pr") },
        });
        expect(builtin.status).toBe(200);

        for (const body of [list.body, detail.body, builtin.body]) {
          const json = JSON.stringify(body);
          for (const marker of [...playbookMarkers(other), ...markers(other)]) {
            expect(json).not.toContain(marker);
          }
        }
        for (const id of [own(other), "not-a-uuid", "builtin:nope"]) {
          expect(await call(playbookDetail.GET, { params: { id } }), id).toMatchObject({
            status: 404,
          });
        }
      }
    });

    it("refuses every change to the other organization's playbooks, and members can't change any", async () => {
      state.userId = a.adminId;
      const theirs = { params: { id: own(b) } };
      for (const response of [
        await call(playbookDetail.PUT, { ...theirs, method: "PUT", body: playbookInput(a) }),
        await call(playbookDetail.DELETE, { ...theirs, method: "DELETE" }),
        await call(playbookClone.POST, { ...theirs, method: "POST" }),
      ]) {
        expect(response).toMatchObject({ status: 404 });
      }

      state.userId = a.memberId;
      const mine = { params: { id: own(a) } };
      for (const response of [
        await call(playbookList.POST, { body: playbookInput(a) }),
        await call(playbookDetail.PUT, { ...mine, method: "PUT", body: playbookInput(a) }),
        await call(playbookDetail.DELETE, { ...mine, method: "DELETE" }),
        await call(playbookClone.POST, { ...mine, method: "POST" }),
      ]) {
        expect(response.status).toBe(403);
      }

      // The other organization keeps its playbook as it was.
      state.userId = b.memberId;
      expect(await call(playbookDetail.GET, theirs)).toMatchObject({
        status: 200,
        body: { playbook: { name: `${b.name}-playbook`, systemPrompt: `${b.name} prompt` } },
      });
    });

    it("creates, changes, clones and deletes only the active organization's playbooks", async () => {
      state.userId = a.adminId;
      const cloned = await call(playbookClone.POST, { params: { id: own(a) }, method: "POST" });
      expect(cloned).toMatchObject({ status: 200, body: { ok: true } });
      const cloneId = cloned.body.id as string;
      expect(
        await call(playbookDetail.PUT, {
          params: { id: cloneId },
          method: "PUT",
          body: { ...playbookInput(a), name: "alpha-renamed" },
        }),
      ).toMatchObject({ status: 200, body: { ok: true, id: cloneId } });
      expect(
        await call(playbookDetail.DELETE, { params: { id: cloneId }, method: "DELETE" }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect((await call(playbookDetail.GET, { params: { id: cloneId } })).status).toBe(404);

      const builtinClone = await call(playbookClone.POST, {
        params: { id: encodeURIComponent("builtin:review-pr") },
        method: "POST",
      });
      expect(builtinClone).toMatchObject({ status: 200, body: { ok: true } });

      state.userId = b.memberId;
      const list = JSON.stringify((await call(playbookList.GET)).body);
      expect(list).not.toContain(builtinClone.body.id as string);
      expect(list).not.toContain(cloneId);
      expect(list).toContain(own(b));
    });

    it("offers each organization only its own agents' models, installables' MCP servers and host tools in the editor", async () => {
      for (const tenant of [a, b]) {
        await db
          .update(agents)
          .set({
            reportedModels: [
              { value: `${tenant.name}-model`, displayName: `${tenant.name}-model` },
            ],
            reportedInstallables: [{ name: `${tenant.name}-tools`, version: "1.0.0" }],
          })
          .where(eq(agents.id, tenant.agentId));
        await db.insert(jobs).values({
          organizationId: tenant.orgId,
          type: "install",
          taskType: "system",
          status: "completed",
          payload: {},
          result: { name: `${tenant.name}-tools`, mcpServers: [`${tenant.name}-server`] },
        });
      }
      for (const [mine, other] of [
        [a, b],
        [b, a],
      ] as const) {
        state.userId = mine.memberId;
        expect((await call(playbookFormOptions.GET)).status).toBe(403);

        state.userId = mine.adminId;
        const options = await call(playbookFormOptions.GET);
        expect(options).toMatchObject({
          status: 200,
          body: {
            models: [{ value: `${mine.name}-model` }],
            mcpServers: [`${mine.name}-tools:${mine.name}-server`],
            hostTools: [mine.hostToolName],
          },
        });
        const json = JSON.stringify(options.body);
        for (const marker of [`${other.name}-model`, `${other.name}-tools`, ...markers(other)]) {
          expect(json).not.toContain(marker);
        }
      }
    });
  });
  describe("agent defaults", () => {
    it("shows each organization's own agent defaults to its admins only", async () => {
      for (const [own, other] of [
        [a, b],
        [b, a],
      ] as const) {
        state.userId = own.memberId;
        expect((await call(agentDefaults.GET)).status).toBe(403);

        state.userId = own.adminId;
        const defaults = await call(agentDefaults.GET);
        expect(defaults).toMatchObject({ status: 200, body: { packageName: expect.any(String) } });

        const json = JSON.stringify(defaults.body);
        for (const marker of markers(other)) expect(json).not.toContain(marker);
      }
    });

    it("refuses every change outside the active organization, and to members", async () => {
      state.userId = a.memberId;
      expect(
        (await call(agentDefaults.PUT, { method: "PUT", body: { version: "2.4.0" } })).status,
      ).toBe(403);
      expect(await getDesiredAgentVersion(db, a.orgId)).not.toBe("2.4.0");
    });

    it("changes only the active organization's agent defaults", async () => {
      state.userId = a.adminId;
      expect(
        await call(agentDefaults.PUT, {
          method: "PUT",
          body: { version: "2.4.0" },
        }),
      ).toEqual({
        status: 200,
        body: { ok: true, versionPolicy: { mode: "pinned", version: "2.4.0", target: "2.4.0" } },
      });

      expect(await getDesiredAgentVersion(db, a.orgId)).toBe("2.4.0");
      expect(await getDesiredAgentVersion(db, b.orgId)).not.toBe("2.4.0");

      state.userId = b.adminId;
      expect((await call(agentDefaults.GET)).body).not.toMatchObject({ desiredVersion: "2.4.0" });
    });
  });
});
