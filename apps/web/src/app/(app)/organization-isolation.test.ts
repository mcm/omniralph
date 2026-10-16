// Every list and detail loader of the control panel, against two organizations with data
// in every tenant table: a member of one never gets a row of the other, gets a 404 on the
// other's resource URLs, and opening a resource of another of their own organizations
// switches to it.
import { randomBytes } from "node:crypto";
import {
  addMember,
  addOrganizationDomain,
  closeDb,
  connectRepository,
  createHarnessEnrollment,
  createCustomRule,
  createDb,
  createInvitation,
  createOrganization,
  createReview,
  createRun,
  createTriageRun,
  enrollHarness,
  ensureLane,
  findings,
  getActiveOrganization,
  getJob,
  insertJob,
  insertMessage,
  organizationMembers,
  saveIntegration,
  setActiveOrganization,
  setDesiredHarnessVersion,
  claimJob,
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
import type { JSX } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { assertRole, type Role } from "@/lib/auth/roles";
import { ENTER_ORGANIZATION_PATH, ORGANIZATION_COOKIE } from "@/lib/auth/routes";

vi.mock("server-only", () => ({}));
vi.stubEnv("AUTH_SECRET", "organization-isolation-test-secret");
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  cookies: new Map<string, string>(),
}));
// This browser's cookies.
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
    getCurrentUser: async () => (state.userId === null ? null : { id: state.userId }),
    requireUser: async (role: Role = "member") => current(role),
    requirePageUser: async (role: Role = "member") => current(role),
  };
});
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
vi.mock("@/lib/scm/github-app", () => ({
  getGitHubAppAuth: () => ({}),
  getGitHubInstallUrl: async () => null,
  GITHUB_INSTALL_PATH: "/repositories/github/install",
}));
// Views are client components; the tests read the props the pages pass them.
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("./repositories/[id]/settings/repository-settings-view", () => ({
  RepositorySettingsView: () => null,
}));
vi.mock("./repositories/[id]/rules/rules-view", () => ({ RulesView: () => null }));
vi.mock("./reviews/reviews-view", () => ({ ReviewsView: () => null }));
vi.mock("./reviews/[id]/review-detail-view", () => ({ ReviewDetailView: () => null }));
vi.mock("./triage/triage-runs-view", () => ({ TriageRunsView: () => null }));
vi.mock("./triage/[id]/triage-run-detail-view", () => ({ TriageRunDetailView: () => null }));
vi.mock("./jobs/jobs-view", () => ({ JobsView: () => null }));
vi.mock("./analytics/analytics-view", () => ({ AnalyticsView: () => null }));
vi.mock("./settings/profiles/profiles-view", () => ({ ProfilesView: () => null }));
vi.mock("./settings/harnesses/harness-settings-view", () => ({ HarnessSettingsView: () => null }));
vi.mock("./settings/integrations/integrations-view", () => ({ IntegrationsView: () => null }));
vi.mock("./settings/organization/organization-settings-view", () => ({
  OrganizationSettingsView: () => null,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { GET: enterOrganization } = await import("../api/organizations/enter/route");
const { default: AppLayout } = await import("./layout");
const { default: HomePage } = await import("./page");
const { default: RepositorySettingsPage } = await import("./repositories/[id]/settings/page");
const { default: RepositoryRulesPage } = await import("./repositories/[id]/rules/page");
const { default: RepositoryReviewsPage } = await import("./repositories/[id]/reviews/page");
const { default: ReviewsPage } = await import("./reviews/page");
const { default: ReviewPage } = await import("./reviews/[id]/page");
const { default: TriageRunsPage } = await import("./triage/page");
const { default: TriageRunPage } = await import("./triage/[id]/page");
const { default: JobsPage } = await import("./jobs/page");
const { default: AnalyticsPage } = await import("./analytics/page");
const { default: ProfilesPage } = await import("./settings/profiles/page");
const { default: HarnessSettingsPage } = await import("./settings/harnesses/page");
const { default: IntegrationsPage } = await import("./settings/integrations/page");
const { default: OrganizationSettingsPage } = await import("./settings/organization/page");
const { cancelJob } = await import("./jobs/actions");
const { createEnterOrganizationPath } = await import("@/lib/organizations/enter");

const databaseAvailable = testDatabaseAvailable();

/** One organization's rows; every name, path and text contains `name`. */
interface Tenant {
  name: string;
  userId: string;
  orgId: string;
  connectionId: string;
  repoId: string;
  ruleId: string;
  reviewId: string;
  findingId: string;
  harnessId: string;
  jobId: string;
  runId: string;
  laneId: string;
  storyId: string;
  messageId: string;
  triageRunId: string;
  triageJobId: string;
  invitationId: string;
}

/** Next.js `notFound()` throws an error whose digest marks a 404. */
const notFound = { digest: expect.stringContaining("404") };
/** Next.js `redirect(path)` throws an error whose digest carries the path. */
const redirectTo = (path: string) => ({ digest: expect.stringContaining(`;${path};`) });
/** Where `page` redirects (`NEXT_REDIRECT;<type>;<url>;<status>;`). */
const redirectLocation = (page: Promise<unknown>) =>
  page.then(
    () => expect.unreachable("expected a redirect"),
    (error: { digest?: string }) => error.digest?.split(";")[2],
  );

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const search = (query: Record<string, string> = {}) => ({ searchParams: Promise.resolve(query) });

describe.skipIf(!databaseAvailable)("organization isolation of every page", () => {
  let testDb: TestDatabase;
  let db: Database;
  let a: Tenant;
  let b: Tenant;

  async function tenant(name: string, installationId: string): Promise<Tenant> {
    const [user] = await db
      .insert(users)
      .values({ id: `${name}-admin`, email: `admin@${name}.io`, name: `${name} admin` })
      .returning();
    // Also seeds the organization's review profiles.
    const org = await createOrganization(db, { name, createdBy: user!.id });
    expect(await addOrganizationDomain(db, org.id, `${name}.io`)).toBe("added");
    const invitation = await createInvitation(db, {
      organizationId: org.id,
      email: `invitee@${name}.io`,
      role: "member",
      invitedBy: user!.id,
    });
    if (invitation.status !== "created") throw new Error(invitation.status);

    const connection = (await upsertScmConnection(db, {
      organizationId: org.id,
      provider: "github",
      name: `${name}-installation`,
      baseUrl: "https://api.github.com",
      externalId: installationId,
      credentials: {},
    }))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "500",
      fullPath: `${name}/app`,
    });
    const rule = await createCustomRule(db, {
      repositoryId: repo.id,
      text: `${name} rule`,
      createdBy: user!.id,
    });
    const review = await createReview(db, {
      repositoryId: repo.id,
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
      trigger: "webhook",
      profileId: "standard",
      model: null,
      budget: 1,
    });
    const [finding] = await db
      .insert(findings)
      .values({
        reviewId: review.id,
        path: `${name}.ts`,
        startLine: 1,
        endLine: 1,
        severity: "medium",
        category: "bug",
        title: `${name} finding`,
        body: "x",
        confidence: 0.9,
      })
      .returning();

    expect(
      await saveIntegration(db, {
        organizationId: org.id,
        provider: "linear",
        externalId: `${name}-workspace`,
        name: `${name} workspace`,
        credentials: { accessToken: `lin_${name}` },
        installedByUserId: user!.id,
      }),
    ).not.toBe("other_organization");

    const enrollment = await createHarnessEnrollment(db, {
      organizationId: org.id,
      name: `${name}-agent`,
      createdBy: user!.id,
    });
    // A second, unused enrollment stays pending.
    await createHarnessEnrollment(db, { organizationId: org.id, name: `${name}-pending` });
    const { harnessId } = (await enrollHarness(db, {
      enrollmentToken: enrollment.token,
      name: `${name}-agent`,
      version: "1.0.0",
    }))!;
    await setDesiredHarnessVersion(db, org.id, `1.0.0-${name}`, user!.id);

    const { run } = await createRun(db, {
      organizationId: org.id,
      linearIssueId: `${name}-issue`,
      linearIdentifier: `${name.toUpperCase()}-1`,
      linearTitle: `${name} epic`,
      linearUrl: `https://linear.app/${name}/issue/1`,
      linearAgentSessionId: `${name}-session`,
      kind: "children",
      repositoryId: repo.id,
      branch: `${name}-branch`,
      baseBranch: "main",
    });
    const lane = await ensureLane(db, {
      runId: run.id,
      repositoryId: repo.id,
      branch: `${name}-lane`,
      baseBranch: "main",
    });
    const [story] = await upsertStories(db, run.id, [
      {
        linearIssueId: `${name}-story`,
        identifier: `${name}-2`,
        title: `${name} story`,
        laneId: lane.id,
      },
    ]);
    const { job } = await insertJob(db, {
      organizationId: org.id,
      type: "review.run",
      taskType: "review",
      pool: "short",
      payload: { note: `${name} job` },
      repositoryId: repo.id,
    });
    expect(
      await claimJob(db, {
        harnessId,
        organizationId: org.id,
        acceptedTaskTypes: ["query", "review"],
        pools: ["short"],
        harnessVersion: null,
        maxDeliveries: 5,
      }),
    ).toMatchObject({
      claim: { action: "run", job: { id: job.id } },
    });
    await insertJob(db, {
      organizationId: org.id,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      payload: { note: `${name} ralph job` },
      repositoryId: repo.id,
      ralphRunId: run.id,
    });
    const { run: triageRun } = await createTriageRun(db, {
      organizationId: org.id,
      linearIssueId: `${name}-triage-issue`,
      linearAgentSessionId: `${name}-triage-session`,
      trigger: "mention",
    });
    const { job: triageJob } = await insertJob(db, {
      organizationId: org.id,
      type: "triage.run",
      taskType: "query",
      pool: "short",
      payload: {
        trigger: {
          kind: "linear.triage",
          context: { triageRunId: triageRun.id, issue: { identifier: `${name.toUpperCase()}-9` } },
        },
      },
    });
    const message = await insertMessage(db, {
      runId: run.id,
      kind: "guidance",
      text: `${name} guidance`,
    });

    return {
      name,
      userId: user!.id,
      orgId: org.id,
      connectionId: connection.id,
      repoId: repo.id,
      ruleId: rule.id,
      reviewId: review.id,
      findingId: finding!.id,
      harnessId,
      jobId: job.id,
      runId: run.id,
      laneId: lane.id,
      storyId: story!.id,
      messageId: message.id,
      triageRunId: triageRun.id,
      triageJobId: triageJob.id,
      invitationId: invitation.invitation.id,
    };
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

  /** What a member of `own` gets from every list and detail loader, by page. */
  async function loadEveryPage(own: Tenant): Promise<Record<string, JSX.Element>> {
    state.userId = own.userId;
    const pages: Record<string, JSX.Element> = {
      layout: await AppLayout({ children: null }),
      repositorySettings: await RepositorySettingsPage(params(own.repoId)),
      repositoryRules: await RepositoryRulesPage(params(own.repoId)),
      repositoryReviews: await RepositoryReviewsPage({ ...params(own.repoId), ...search() }),
      reviews: await ReviewsPage(search()),
      review: await ReviewPage(params(own.reviewId)),
      triageRuns: await TriageRunsPage(search()),
      triageRun: await TriageRunPage(params(own.triageRunId)),
      jobs: await JobsPage(search()),
      analytics: await AnalyticsPage(search()),
      profiles: await ProfilesPage(),
      harnessSettings: await HarnessSettingsPage(),
      integrations: await IntegrationsPage(search()),
      organization: await OrganizationSettingsPage(),
    };
    return pages;
  }

  /** IDs and names of `tenant`'s rows: none of them may show up in the other's pages. */
  const markers = (tenant: Tenant) =>
    Object.values(tenant).filter((value) => value !== tenant.userId);

  it("shows each organization its own rows on every page, and none of the other's", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const pages = await loadEveryPage(own);
      for (const [page, element] of Object.entries(pages)) {
        const props = JSON.stringify(element.props);
        for (const marker of markers(other)) {
          expect(props, `${page} of ${own.name} shows ${other.name}'s ${marker}`).not.toContain(
            marker,
          );
        }
      }

      // Every loader found the organization's own rows (the check above isn't vacuous).
      const ids = <T extends { id: string }>(rows: T[]) => rows.map((row) => row.id);
      expect(pages.layout!.props.organizations).toEqual([{ id: own.orgId, name: own.name }]);
      expect(pages.repositorySettings!.props.repository.id).toBe(own.repoId);
      expect(ids(pages.repositorySettings!.props.harnesses)).toEqual([own.harnessId]);
      expect(ids(pages.repositoryRules!.props.rules)).toEqual([own.ruleId]);
      expect(ids(pages.repositoryReviews!.props.reviews)).toEqual([own.reviewId]);
      expect(ids(pages.reviews!.props.reviews)).toEqual([own.reviewId]);
      expect(pages.review!.props.review.id).toBe(own.reviewId);
      expect(JSON.stringify(pages.review!.props.review)).toContain(own.findingId);
      expect(ids(pages.triageRuns!.props.runs)).toEqual([own.triageRunId]);
      expect(pages.triageRun!.props.run.id).toBe(own.triageRunId);
      expect(ids(pages.triageRun!.props.run.jobs)).toEqual([own.triageJobId]);
      expect(ids(pages.jobs!.props.jobs)).toHaveLength(3);
      expect(ids(pages.jobs!.props.jobs)).toContain(own.jobId);
      expect(pages.jobs!.props.jobs).toContainEqual(
        expect.objectContaining({
          id: own.triageJobId,
          triageRun: { id: own.triageRunId, label: `${own.name.toUpperCase()}-9` },
        }),
      );
      expect(pages.analytics!.props.repositories).toMatchObject([{ id: own.repoId }]);
      expect(JSON.stringify(pages.analytics!.props.analytics)).toContain(own.harnessId);
      expect(ids(pages.profiles!.props.profiles)).toEqual(["quick", "standard", "deep"]);
      expect(pages.profiles!.props.choices.harnessCount).toBe(1);
      expect(pages.harnessSettings!.props.desiredVersion).toBe(`1.0.0-${own.name}`);
      expect(pages.integrations!.props.linear).toMatchObject({
        workspaceId: `${own.name}-workspace`,
      });
      expect(pages.organization!.props.organization.name).toBe(own.name);
      expect(ids(pages.organization!.props.members)).toEqual([own.userId]);
      expect(ids(pages.organization!.props.invitations)).toEqual([own.invitationId]);
      expect(pages.organization!.props.domains).toEqual([`${own.name}.io`]);
    }
  });

  it("counts only the organization's own reviews, findings, jobs and ralph runs in analytics", async () => {
    state.userId = a.userId;
    const { analytics, ralph } = (await AnalyticsPage(search())).props;
    expect(JSON.stringify(analytics)).toContain(`"reviews":1`);
    expect(analytics.jobsByHarness).toMatchObject([{ agent: { id: a.harnessId }, total: 1 }]);
    expect(JSON.stringify(ralph)).not.toContain(b.runId);
    // Another organization's repository as the filter is ignored.
    const filtered = (await AnalyticsPage(search({ repo: b.repoId }))).props;
    expect(filtered.params.repositoryId).toBeNull();
  });

  it("ignores another organization's repository in list filters", async () => {
    state.userId = a.userId;
    expect((await ReviewsPage(search({ repository: b.repoId }))).props.reviews).not.toContainEqual(
      expect.objectContaining({ id: b.reviewId }),
    );
    expect((await JobsPage(search({ status: "running" }))).props.jobs).toMatchObject([
      { id: a.jobId },
    ]);
  });

  it("returns 404 on another organization's resource URLs for a non-member", async () => {
    state.userId = a.userId;
    await expect(RepositorySettingsPage(params(b.repoId))).rejects.toMatchObject(notFound);
    await expect(RepositoryRulesPage(params(b.repoId))).rejects.toMatchObject(notFound);
    await expect(RepositoryReviewsPage({ ...params(b.repoId), ...search() })).rejects.toMatchObject(
      notFound,
    );
    await expect(ReviewPage(params(b.reviewId))).rejects.toMatchObject(notFound);
    await expect(TriageRunPage(params(b.triageRunId))).rejects.toMatchObject(notFound);
    // Nothing switched, nor can it be.
    expect((await getActiveOrganization(db, a.userId))?.id).toBe(a.orgId);
    const enter = async (url: string) =>
      (await enterOrganization(new NextRequest(`http://localhost${url}`))).status;
    // Unsigned (a link from another site), signed for someone else, or signed for a.
    const unsigned = new URLSearchParams({ organization: b.orgId, next: "/" });
    expect(await enter(`${ENTER_ORGANIZATION_PATH}?${unsigned}`)).toBe(404);
    for (const userId of [b.userId, a.userId]) {
      const signed = await createEnterOrganizationPath({
        userId,
        organizationId: b.orgId,
        next: "/",
      });
      expect(await enter(signed)).toBe(404);
    }
    expect((await getActiveOrganization(db, a.userId))?.id).toBe(a.orgId);
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBeUndefined();
  });

  it("switches to the resource's organization when the user is a member of it", async () => {
    const [user] = await db
      .insert(users)
      .values({ id: "both-admin", email: "both@alpha.io" })
      .returning();
    expect(await addMember(db, { organizationId: a.orgId, userId: user!.id, role: "admin" })).toBe(
      "added",
    );
    // Beta's email domains don't match; members from before a domain change stay members.
    await db
      .insert(organizationMembers)
      .values({ organizationId: b.orgId, userId: user!.id, role: "admin" });
    state.userId = user!.id;

    const resources: [string, () => Promise<JSX.Element>, string][] = [
      [`/reviews/${b.reviewId}`, () => ReviewPage(params(b.reviewId)), b.reviewId],
      [`/triage/${b.triageRunId}`, () => TriageRunPage(params(b.triageRunId)), b.triageRunId],
      [
        `/repositories/${b.repoId}/settings`,
        () => RepositorySettingsPage(params(b.repoId)),
        b.repoId,
      ],
      [`/repositories/${b.repoId}/rules`, () => RepositoryRulesPage(params(b.repoId)), b.repoId],
      [
        `/repositories/${b.repoId}/reviews?status=queued`,
        () => RepositoryReviewsPage({ ...params(b.repoId), ...search({ status: "queued" }) }),
        b.repoId,
      ],
    ];
    for (const [path, open, id] of resources) {
      expect(await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId })).toBe(
        true,
      );
      // The page sends the browser to switch to the resource's organization (pages can't
      // set cookies), which then reloads the page, showing the resource.
      const enter = await redirectLocation(open());
      expect(enter, path).toMatch(new RegExp(`^${ENTER_ORGANIZATION_PATH}\\?token=`));
      expect((await getActiveOrganization(db, user!.id))?.id).toBe(a.orgId);
      const response = await enterOrganization(new NextRequest(`http://localhost${enter}`));
      expect(response.headers.get("location"), path).toBe(`http://localhost${path}`);
      expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(b.orgId);
      expect((await getActiveOrganization(db, user!.id))?.id).toBe(b.orgId);
      expect(JSON.stringify((await open()).props), path).toContain(id);
    }
  });

  it("refuses to cancel another organization's job", async () => {
    state.userId = a.userId;
    expect(await cancelJob(b.jobId)).toEqual({ ok: false, error: "That job doesn't exist." });
    expect(await getJob(db, b.jobId)).toMatchObject({ status: "running", cancelRequested: false });
  });

  it("sends the dashboard to the repositories page", () => {
    expect(() => HomePage()).toThrow(expect.objectContaining(redirectTo("/repositories")));
  });
});
