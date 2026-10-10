import { randomBytes } from "node:crypto";
import {
  agents,
  connectRepository,
  closeDb,
  createDb,
  createRun,
  ensureChatThread,
  ensureLane,
  getJob,
  getMainLane,
  getRun,
  insertJob,
  insertMessage,
  integrations,
  jobs,
  listStories,
  ralphMessages,
  ralphRuns,
  runMigrations,
  RUN_DETAIL_MESSAGE_LIMIT,
  saveChatConnection,
  saveIntegration,
  updateLane,
  updateMessage,
  updateRepositoryRalphSettings,
  updateRun,
  updateStory,
  upsertScmConnection,
  upsertStories,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  organizations,
  seedReviewProfiles,
  type LinearRun,
  type NewLinearRalphRunInput,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import type { ReactElement } from "react";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import {
  runSourceLabel,
  type RalphRunDetailView,
  type RalphRunListParams,
  type RalphRunRow,
} from "@/lib/ralph/display";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  /** The user's active organization. */
  orgId: "",
  linear: undefined as unknown as LinearGateway,
  dispatcher: undefined as unknown,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
const withOrganization = (user: TestUser | null) =>
  user && { ...user, organization: { id: state.orgId, name: "Acme" } };
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(withOrganization(state.user), role),
  requirePageUser: async (role: Role = "member") => assertRole(withOrganization(state.user), role),
}));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => state.dispatcher }));
vi.mock("@/lib/linear/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLinearGatewayOrDisconnected: async () => state.linear,
}));
// The pages only load data: their client views are stubs here.
vi.mock("./ralph-runs-view", () => ({ RalphRunsView: () => null }));
vi.mock("./[id]/ralph-run-detail-view", () => ({ RalphRunDetailView: () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { stopRalphRun } = await import("./actions");
const { default: RalphRunsPage } = await import("./page");
const { default: RalphRunPage } = await import("./[id]/page");
const { disconnectedLinearGateway } = await import("@/lib/linear/client");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const admin: TestUser = {
  id: "admin-1",
  role: "admin",
  name: "Ada Admin",
  email: null,
  image: null,
};
const member: TestUser = { id: "member-1", role: "member", name: null, email: null, image: null };

interface ListProps {
  runs: RalphRunRow[];
  repositories: { id: string; fullPath: string }[];
  params: RalphRunListParams;
  total: number;
  pageSize: number;
  linearConnected: boolean;
}

async function listPage(searchParams: Record<string, string> = {}): Promise<ListProps> {
  const element = (await RalphRunsPage({
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement<ListProps>;
  return element.props;
}

async function detailPage(
  id: string,
): Promise<{ run: RalphRunDetailView; linearConnected: boolean }> {
  const element = (await RalphRunPage({ params: Promise.resolve({ id }) })) as ReactElement<{
    run: RalphRunDetailView;
    linearConnected: boolean;
  }>;
  return element.props;
}

describe.skipIf(!dockerAvailable)("Ralph runs pages", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;
  let agentId: string;
  let linear: FakeLinearGateway;
  let session = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
    state.db = db;
    const github = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "1",
      credentials: {},
    }))!;
    const gitlab = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    repoA = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    repoB = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    await updateRepositoryRalphSettings(db, repoA, {
      ralphEnabled: true,
      linearTeamKeys: ["ENG"],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    [{ id: agentId }] = (await db
      .insert(agents)
      .values({ organizationId: orgId, name: "agent-a", enabledCapabilities: ["ralph"] })
      .returning({ id: agents.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(integrations);
    state.user = admin;
    state.orgId = orgId;
    linear = new FakeLinearGateway();
    state.linear = linear;
    state.dispatcher = new PostgresDispatcher({ db });
  });

  async function newRun(overrides: Partial<NewLinearRalphRunInput> = {}) {
    session += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: `issue-${session}`,
      linearIdentifier: `ENG-${session}`,
      linearTitle: `Epic ${session}`,
      linearUrl: `https://linear.app/acme/issue/ENG-${session}/epic`,
      linearAgentSessionId: `session-${session}`,
      kind: "children",
      repositoryId: repoA,
      branch: `eng-${session}`,
      baseBranch: "main",
      ...overrides,
    });
    return linearRun(run);
  }

  async function connectLinear() {
    await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "org-1",
      name: "Acme",
      credentials: { accessToken: "lin_x" },
      installedByUserId: null,
    });
  }

  it("lists runs newest first with their row facts, filtered by status and repository", async () => {
    const first = await newRun();
    const second = await newRun({ repositoryId: repoB });
    await updateRun(db, first.id, { status: "completed", agentId });
    await updateLane(db, (await getMainLane(db, first))!.id, {
      prNumber: 7,
      prUrl: "https://github.com/acme/api/pull/7",
    });
    await updateRun(db, second.id, { status: "waiting" });
    await updateLane(db, (await getMainLane(db, second))!.id, {
      prNumber: 3,
      prUrl: "https://gl/mr/3",
    });
    for (const [i, id] of [first.id, second.id].entries()) {
      await db
        .update(ralphRuns)
        .set({ createdAt: new Date(Date.UTC(2026, 9, 1 + i)) })
        .where(eq(ralphRuns.id, id));
    }
    const stories = await upsertStories(db, first.id, [
      { linearIssueId: "s-1", identifier: "ENG-11", title: "One" },
      { linearIssueId: "s-2", identifier: "ENG-12", title: "Two" },
    ]);
    await updateStory(db, stories[0]!.id, { status: "completed" });

    const all = await listPage();
    expect(all.total).toBe(2);
    expect(all.linearConnected).toBe(false);
    expect(all.params).toEqual({ status: null, repositoryId: null, page: 1 });
    expect(all.repositories.map((r) => r.fullPath)).toEqual(["acme/api", "acme/web"]);
    expect(all.runs.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(all.runs[1]).toMatchObject({
      linearIdentifier: first.linearIdentifier,
      linearTitle: first.linearTitle,
      linearUrl: first.linearUrl,
      repository: { id: repoA, provider: "github", fullPath: "acme/api" },
      status: "completed",
      stories: { total: 2, completed: 1 },
      branch: `eng-${session - 1}`,
      pullRequest: { number: 7, url: "https://github.com/acme/api/pull/7", label: "#7" },
      agent: { id: agentId, name: "agent-a" },
    });
    expect(typeof all.runs[1]!.updatedAt).toBe("string");
    expect(all.runs[0]).toMatchObject({ pullRequest: { label: "!3" }, agent: null });

    expect((await listPage({ status: "waiting" })).runs.map((r) => r.id)).toEqual([second.id]);
    expect((await listPage({ repository: repoA })).runs.map((r) => r.id)).toEqual([first.id]);
    expect((await listPage({ repository: repoA, status: "waiting" })).total).toBe(0);
    // Unknown filter values are ignored.
    const ignored = await listPage({ status: "bogus", repository: "not-a-uuid", page: "x" });
    expect(ignored.params).toEqual({ status: null, repositoryId: null, page: 1 });
    expect(ignored.total).toBe(2);
    // Past the last page.
    const past = await listPage({ page: "3" });
    expect(past).toMatchObject({ total: 2, runs: [], params: { page: 3 } });

    await connectLinear();
    expect((await listPage()).linearConnected).toBe(true);
  });

  it("shows a chat run with its platform and channel instead of a Linear issue", async () => {
    const connection = await saveChatConnection(db, {
      organizationId: orgId,
      platform: "slack",
      externalId: "T1",
      name: "Acme",
      credentials: null,
      installedByUserId: null,
    });
    if (connection === "other_organization") throw new Error("connected elsewhere");
    const thread = await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: "slack:C0123:1.1",
      channelId: "slack:C0123",
      startedByExternalUserId: "U1",
    });
    const { run } = await createRun(db, {
      origin: "chat",
      organizationId: orgId,
      chatThreadId: thread!.id,
      repositoryId: repoA,
      branch: "omniralph/readme-typo",
      baseBranch: "main",
    });

    const [row] = (await listPage()).runs;
    expect(row).toMatchObject({
      id: run.id,
      origin: "chat",
      linearIdentifier: null,
      chatThread: { platform: "slack", channelId: "slack:C0123" },
    });
    expect(runSourceLabel(row!)).toBe("Slack C0123");
    const { run: view } = await detailPage(run.id);
    expect(view).toMatchObject({
      origin: "chat",
      linearIdentifier: null,
      chatThread: { platform: "slack", channelId: "slack:C0123" },
      branch: "omniralph/readme-typo",
    });
  });

  it("is empty with no runs, and tells whether Linear is connected", async () => {
    expect(await listPage()).toMatchObject({ runs: [], total: 0, linearConnected: false });
  });

  it("loads a run's detail: header, stories, guidance, progress and jobs", async () => {
    const run = await newRun();
    const [s1, s2] = await upsertStories(db, run.id, [
      { linearIssueId: "d-1", identifier: "ENG-21", title: "First" },
      { linearIssueId: "d-2", identifier: "ENG-22", title: "Second" },
    ]);
    const { job } = await insertJob(db, {
      organizationId: orgId,
      capability: "ralph",
      type: "ralph.story",
      ralphRunId: run.id,
    });
    await db
      .update(jobs)
      .set({ status: "completed", agentId, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await updateStory(db, s1!.id, {
      status: "completed",
      attempts: 2,
      commitSha: "a".repeat(40),
      lastJobId: job.id,
    });
    await updateStory(db, s2!.id, {
      status: "blocked",
      attempts: 1,
      lastFeedback: "Gates failed.",
    });
    await updateRun(db, run.id, {
      status: "waiting",
      agentId,
      waitingOn: {
        blockers: [{ id: "x", identifier: "OPS-1", title: "Provision DB" }],
        manual: [],
      },
      guidance: [{ text: "Use pnpm.", at: "2026-10-06T01:00:00.000Z" }],
      progress: "## Progress\n- did ENG-21",
    });
    await connectLinear();

    const { run: view, linearConnected } = await detailPage(run.id);
    expect(linearConnected).toBe(true);
    expect(view).toMatchObject({
      id: run.id,
      linearIdentifier: run.linearIdentifier,
      linearTitle: run.linearTitle,
      linearUrl: run.linearUrl,
      status: "waiting",
      repository: { id: repoA, fullPath: "acme/api" },
      branch: `eng-${session}`,
      baseBranch: "main",
      agent: { id: agentId, name: "agent-a" },
      pullRequest: null,
      waitingOn: { blockers: [{ identifier: "OPS-1", title: "Provision DB" }], manual: [] },
      guidance: [{ text: "Use pnpm.", at: "2026-10-06T01:00:00.000Z" }],
      progress: "## Progress\n- did ENG-21",
      storyCounts: { total: 2, completed: 1 },
    });
    expect(view.stories).toEqual([
      {
        id: s1!.id,
        identifier: "ENG-21",
        title: "First",
        status: "completed",
        attempts: 2,
        lastFeedback: null,
        commitSha: "a".repeat(40),
        lastJobId: job.id,
        laneId: null,
        elsewhere: null,
      },
      {
        id: s2!.id,
        identifier: "ENG-22",
        title: "Second",
        status: "blocked",
        attempts: 1,
        lastFeedback: "Gates failed.",
        commitSha: null,
        lastJobId: null,
        laneId: null,
        elsewhere: null,
      },
    ]);
    expect(view.jobs).toMatchObject([
      { id: job.id, type: "ralph.story", status: "completed", agent: { name: "agent-a" } },
    ]);

    // One section per lane: the main lane first, each with its branch, PR/MR and stories.
    const main = (await getMainLane(db, run))!;
    const web = await ensureLane(db, {
      runId: run.id,
      repositoryId: repoB,
      branch: main.branch,
      baseBranch: "develop",
    });
    await updateLane(db, web.id, {
      prNumber: 8,
      prUrl: "https://gitlab.com/acme/web/-/merge_requests/8",
    });
    await upsertStories(db, run.id, [
      { linearIssueId: "d-1", identifier: "ENG-21", title: "First", laneId: main.id },
      { linearIssueId: "d-2", identifier: "ENG-22", title: "Second", laneId: web.id },
      {
        linearIssueId: "d-3",
        identifier: "ENG-23",
        title: "Docs",
        elsewhere: "it's in project Docs",
      },
    ]);
    const laned = (await detailPage(run.id)).run;
    expect(laned.lanes).toEqual([
      {
        id: main.id,
        repository: { id: repoA, provider: "github", fullPath: "acme/api" },
        main: true,
        branch: main.branch,
        baseBranch: "main",
        pullRequest: null,
        cleanup: null,
        reviewRounds: { done: 0, max: 3 },
        ciFixRounds: { done: 0, max: 3 },
      },
      {
        id: web.id,
        repository: { id: repoB, provider: "gitlab", fullPath: "acme/web" },
        main: false,
        branch: main.branch,
        baseBranch: "develop",
        pullRequest: {
          number: 8,
          url: "https://gitlab.com/acme/web/-/merge_requests/8",
          label: "!8",
        },
        cleanup: null,
        reviewRounds: { done: 0, max: 3 },
        ciFixRounds: { done: 0, max: 3 },
      },
    ]);
    expect(laned.stories.map((s) => [s.identifier, s.laneId, s.elsewhere])).toEqual([
      ["ENG-21", main.id, null],
      ["ENG-22", web.id, null],
      ["ENG-23", null, "it's in project Docs"],
    ]);

    // waiting_on is only shown while waiting.
    await updateRun(db, run.id, { status: "running" });
    expect((await detailPage(run.id)).run.waitingOn).toBeNull();

    await expect(detailPage("00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(detailPage("nope")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows each lane's review/CI rounds, the pending requests and the live messages", async () => {
    // acme/web turned CI fixes off and allows 5 review rounds.
    await updateRepositoryRalphSettings(db, repoB, {
      ralphEnabled: true,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: { ...DEFAULT_RALPH_SETTINGS, maxReviewRounds: 5, respondToCiFailures: false },
    });
    const run = await newRun();
    const main = (await getMainLane(db, run))!;
    await updateLane(db, main.id, { reviewRounds: 2, ciFixRounds: 3 });
    const web = await ensureLane(db, {
      runId: run.id,
      repositoryId: repoB,
      branch: main.branch,
      baseBranch: "main",
    });
    await updateLane(db, web.id, { reviewRounds: 1, ciFixRounds: 1 });

    // Pending: no job, not consumed (lane null: the main lane's). Consumed ones aren't listed.
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute));
    const ask = await insertMessage(db, {
      runId: run.id,
      kind: "request",
      text: "Open the PR",
      author: "Ada",
    });
    const fix = await insertMessage(db, {
      runId: run.id,
      laneId: web.id,
      kind: "request",
      text: "Fix the CI",
    });
    const done = await insertMessage(db, { runId: run.id, kind: "request", text: "Done already" });
    await updateMessage(db, done.id, { consumedAt: new Date() });

    // Live messages: delivered, rejected (kept as guidance), still waiting.
    const { job: story } = await insertJob(db, {
      organizationId: orgId,
      capability: "ralph",
      type: "ralph.story",
      ralphRunId: run.id,
    });
    await db.update(jobs).set({ status: "running", agentId }).where(eq(jobs.id, story.id));
    const live = async (
      minute: number,
      text: string,
      update: Parameters<typeof updateMessage>[2],
    ) => {
      const message = await insertMessage(db, {
        runId: run.id,
        jobId: story.id,
        kind: "guidance",
        text,
        author: "Bob",
      });
      await db
        .update(ralphMessages)
        .set({ createdAt: at(minute) })
        .where(eq(ralphMessages.id, message.id));
      if (Object.keys(update).length > 0) await updateMessage(db, message.id, update);
      return message;
    };
    const delivered = await live(1, "Use pnpm", { deliveredAt: at(2), consumedAt: at(2) });
    const rejected = await live(3, "Skip the docs", { consumedAt: at(4) });
    const waiting = await live(5, "Also add a test", {});

    const view = (await detailPage(run.id)).run;
    expect(view.lanes.map((l) => [l.repository.fullPath, l.reviewRounds, l.ciFixRounds])).toEqual([
      ["acme/api", { done: 2, max: 3 }, { done: 3, max: 3 }],
      ["acme/web", { done: 1, max: 5 }, { done: 1, max: null }],
    ]);
    expect(view.pendingRequests).toEqual([
      {
        id: ask.id,
        laneId: null,
        text: "Open the PR",
        author: "Ada",
        createdAt: ask.createdAt.toISOString(),
      },
      {
        id: fix.id,
        laneId: web.id,
        text: "Fix the CI",
        author: null,
        createdAt: fix.createdAt.toISOString(),
      },
    ]);
    expect(view.messageLimit).toBe(RUN_DETAIL_MESSAGE_LIMIT);
    const job = { id: story.id, type: "ralph.story", status: "running" };
    expect(view.messages).toEqual([
      {
        id: waiting.id,
        kind: "guidance",
        text: "Also add a test",
        author: "Bob",
        job,
        state: "waiting",
        createdAt: at(5).toISOString(),
        deliveredAt: null,
        consumedAt: null,
      },
      {
        id: rejected.id,
        kind: "guidance",
        text: "Skip the docs",
        author: "Bob",
        job,
        state: "guidance",
        createdAt: at(3).toISOString(),
        deliveredAt: null,
        consumedAt: at(4).toISOString(),
      },
      {
        id: delivered.id,
        kind: "guidance",
        text: "Use pnpm",
        author: "Bob",
        job,
        state: "delivered",
        createdAt: at(1).toISOString(),
        deliveredAt: at(2).toISOString(),
        consumedAt: at(2).toISOString(),
      },
    ]);

    // A run without requests or messages.
    const empty = (await detailPage((await newRun()).id)).run;
    expect(empty).toMatchObject({ pendingRequests: [], messages: [] });
  });

  async function runningRun(): Promise<{ run: LinearRun; jobId: string }> {
    const run = await newRun();
    const [story] = await upsertStories(db, run.id, [
      { linearIssueId: "r-1", identifier: "ENG-31", title: "Story" },
    ]);
    const { job } = await insertJob(db, {
      organizationId: orgId,
      capability: "ralph",
      type: "ralph.story",
      ralphRunId: run.id,
    });
    await updateStory(db, story!.id, { status: "running", lastJobId: job.id });
    await updateRun(db, run.id, { status: "running" });
    return { run: linearRun((await getRun(db, run.id))!), jobId: job.id };
  }

  it("stops a run like the Linear stop reply: job canceled, session told who stopped it", async () => {
    const { run, jobId } = await runningRun();
    expect(await stopRalphRun(run.id)).toEqual({ ok: true });

    expect((await getRun(db, run.id))!.status).toBe("stopped");
    expect((await getJob(db, jobId))!.status).toBe("canceled");
    expect((await listStories(db, run.id)).map((s) => s.status)).toEqual(["pending"]);
    const [response] = linear.bodies(run.linearAgentSessionId, "response");
    expect(response).toContain("Stopped (requested by Ada Admin).");
    expect(response).toContain("I canceled the job that was running.");
    expect(linear.plan(run.linearAgentSessionId)).toBeDefined();

    expect(await stopRalphRun(run.id)).toEqual({
      ok: false,
      error: "This run is already stopped.",
    });
  });

  it("only lets admins stop a run", async () => {
    const { run, jobId } = await runningRun();
    state.user = member;
    const result = await stopRalphRun(run.id);
    expect(result.ok).toBe(false);
    state.user = null;
    expect((await stopRalphRun(run.id)).ok).toBe(false);

    expect((await getRun(db, run.id))!.status).toBe("running");
    expect((await getJob(db, jobId))!.status).toBe("queued");
    expect(linear.bodies(run.linearAgentSessionId, "response")).toEqual([]);
  });

  it("stops a run while Linear isn't connected, and rejects unknown or finished runs", async () => {
    const { run } = await runningRun();
    state.linear = disconnectedLinearGateway();
    expect(await stopRalphRun(run.id)).toEqual({ ok: true });
    expect((await getRun(db, run.id))!.status).toBe("stopped");

    const done = await newRun();
    await updateRun(db, done.id, { status: "completed" });
    expect(await stopRalphRun(done.id)).toEqual({
      ok: false,
      error: "This run is already over (completed).",
    });
    expect(await stopRalphRun("00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      error: "That run doesn't exist.",
    });
    expect(await stopRalphRun("nope")).toEqual({ ok: false, error: "That run doesn't exist." });
  });

  it("keeps another organization's runs out: not listed, 404 and can't be stopped", async () => {
    // Another organization with its own repository, Linear workspace and run.
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    await seedReviewProfiles(db, other!.id);
    const connection = (await upsertScmConnection(db, {
      organizationId: other!.id,
      provider: "github",
      name: "other",
      baseUrl: "https://api.github.com",
      externalId: "other-1",
      credentials: {},
    }))!;
    const otherRepo = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "99",
        fullPath: "other/api",
      })
    ).id;
    await updateRepositoryRalphSettings(db, otherRepo, {
      ralphEnabled: true,
      linearTeamKeys: ["ENG"],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    await saveIntegration(db, {
      organizationId: other!.id,
      provider: "linear",
      externalId: "org-2",
      name: "Other",
      credentials: { accessToken: "lin_other" },
      installedByUserId: null,
    });
    const theirs = await newRun({ organizationId: other!.id, repositoryId: otherRepo });
    await updateRun(db, theirs.id, { status: "running" });
    const ours = await newRun();

    const list = await listPage();
    expect(list.runs.map((r) => r.id)).toEqual([ours.id]);
    expect(list.repositories.map((r) => r.fullPath)).not.toContain("other/api");
    // Their workspace isn't ours.
    expect(list.linearConnected).toBe(false);
    expect(await listPage({ repository: otherRepo })).toMatchObject({ total: 0, runs: [] });
    await expect(detailPage(theirs.id)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await stopRalphRun(theirs.id)).toEqual({
      ok: false,
      error: "That run doesn't exist.",
    });
    expect((await getRun(db, theirs.id))!.status).toBe("running");

    // Their members see it.
    state.orgId = other!.id;
    expect((await listPage()).runs.map((r) => r.id)).toEqual([theirs.id]);
    expect((await listPage()).linearConnected).toBe(true);
    expect((await detailPage(theirs.id)).run).toMatchObject({ id: theirs.id });
    await expect(detailPage(ours.id)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
