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
vi.mock("./analytics/analytics-view", () => ({ AnalyticsView: () => null }));
vi.mock("./settings/profiles/profiles-view", () => ({ ProfilesView: () => null }));
vi.mock("./settings/harnesses/harness-settings-view", () => ({ HarnessSettingsView: () => null }));
vi.mock("./settings/integrations/integrations-view", () => ({ IntegrationsView: () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { GET: enterOrganization } = await import("../api/organizations/enter/route");
const { default: AppLayout } = await import("./layout");
const { default: HomePage } = await import("./page");
const { GET: triageRunDetail } = await import("../api/ui/triage/[id]/route");
const { default: AnalyticsPage } = await import("./analytics/page");
const { default: ProfilesPage } = await import("./settings/profiles/page");
const { default: HarnessSettingsPage } = await import("./settings/harnesses/page");
const { default: IntegrationsPage } = await import("./settings/integrations/page");
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

/** Next.js `redirect(path)` throws an error whose digest carries the path. */
const redirectTo = (path: string) => ({ digest: expect.stringContaining(`;${path};`) });

/** A triage run's page asking the API for the run (`next` is the page). */
const openTriageRun = (id: string, next?: string) =>
  triageRunDetail(
    new Request(
      `http://localhost/api/ui/triage/${id}${next ? `?${new URLSearchParams({ next })}` : ""}`,
    ),
    { params: Promise.resolve({ id }) },
  );
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
      analytics: await AnalyticsPage(search()),
      profiles: await ProfilesPage(),
      harnessSettings: await HarnessSettingsPage(),
      integrations: await IntegrationsPage(search()),
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
      expect(pages.analytics!.props.repositories).toMatchObject([{ id: own.repoId }]);
      expect(JSON.stringify(pages.analytics!.props.analytics)).toContain(own.harnessId);
      expect(ids(pages.profiles!.props.profiles)).toEqual(["quick", "standard", "deep"]);
      expect(pages.profiles!.props.choices.harnessCount).toBe(1);
      expect(pages.harnessSettings!.props.desiredVersion).toBe(`1.0.0-${own.name}`);
      expect(pages.integrations!.props.linear).toMatchObject({
        workspaceId: `${own.name}-workspace`,
      });
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

  it("returns 404 on another organization's resource URLs for a non-member", async () => {
    state.userId = a.userId;
    expect((await openTriageRun(b.triageRunId)).status).toBe(404);
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

    // The run's page asks the API, which answers 409 with the signed path that switches to
    // the run's organization and comes back to the page, showing the run.
    const path = `/triage/${b.triageRunId}`;
    expect(await setActiveOrganization(db, { userId: user!.id, organizationId: a.orgId })).toBe(
      true,
    );
    const refused = await openTriageRun(b.triageRunId, path);
    expect(refused.status).toBe(409);
    const enter = ((await refused.json()) as { enterPath: string }).enterPath;
    expect(enter).toMatch(new RegExp(`^${ENTER_ORGANIZATION_PATH}\\?token=`));
    expect((await getActiveOrganization(db, user!.id))?.id).toBe(a.orgId);
    const response = await enterOrganization(new NextRequest(`http://localhost${enter}`));
    expect(response.headers.get("location")).toBe(`http://localhost${path}`);
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(b.orgId);
    expect((await getActiveOrganization(db, user!.id))?.id).toBe(b.orgId);
    const opened = await openTriageRun(b.triageRunId, path);
    expect(opened.status).toBe(200);
    expect(JSON.stringify(await opened.json())).toContain(b.triageJobId);
  });

  it("sends the dashboard to the repositories page", () => {
    expect(() => HomePage()).toThrow(expect.objectContaining(redirectTo("/repositories")));
  });
});
