import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createTriageRun,
  disconnectRepository,
  organizationMembers,
  organizations,
  pruneWebhookEvents,
  recordWebhookEvent,
  repositories,
  reviewRuns,
  saveIntegration,
  setTriageRunStatus,
  updateRun,
  upsertScmConnection,
  users,
  webhookDeliveries,
  webhookEvents,
  type Database,
  type ScmConnection,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliveryDetailSchema, type DeliveryDetail } from "@/lib/api/deliveries";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import type { HandledTrackerEvent, TrackerEventContext } from "@/lib/tracker/events";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type { IssueSummary } from "@omniralph/tracker";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { handleWebhook, webhookHeaderEvent } from "@/lib/webhooks/ingest";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  linear: undefined as unknown as FakeLinearGateway,
  scm: undefined as unknown as FakeScmAdapter,
  handled: [] as HandledTrackerEvent[],
  handle: async (_event: HandledTrackerEvent, _context: TrackerEventContext): Promise<void> => {},
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/dispatch", async () => {
  const { PostgresDispatcher: Dispatcher } = await import("@/lib/dispatch/dispatcher");
  return { getDispatcher: () => new Dispatcher({ db: state.db }) };
});
vi.mock("@/lib/scm/adapters", () => ({ scmAdapterFor: () => state.scm.asAdapter() }));
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLinearGateway: async () => state.linear,
}));
vi.mock("@/lib/tracker/events", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  handleTrackerEvent: async (event: HandledTrackerEvent, context: TrackerEventContext) => {
    state.handled.push(event);
    await state.handle(event, context);
  },
}));

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const replayRoute = await import("./[id]/replay/route");
const detailRoute = await import("./[id]/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = {
  id: "member-1",
  role: "member",
  name: "Mia Member",
  email: null,
  image: null,
};

async function replay(id: string, user: TestUser | null = member) {
  state.user = user;
  const response = await replayRoute.POST(
    new Request(`http://localhost/api/ui/deliveries/${id}/replay`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as DeliveryDetail & { error?: string },
  };
}

async function detail(id: string) {
  state.user = member;
  const response = await detailRoute.GET(new Request(`http://localhost/api/ui/deliveries/${id}`), {
    params: Promise.resolve({ id }),
  });
  return (await response.json()) as DeliveryDetail;
}

const issue = (id: string, identifier: string): IssueSummary => ({
  id,
  identifier,
  title: `Work on ${identifier}`,
  description: "",
  url: `https://linear.app/acme/issue/${identifier}`,
  branchName: identifier.toLowerCase(),
  teamId: "team-1",
  teamKey: "ENG",
  stateType: "started",
  stateName: "In Progress",
  labels: [],
  priority: 0,
});

describe("webhookHeaderEvent", () => {
  it("recovers the event header from the logged event name", () => {
    expect(webhookHeaderEvent("github", "pull_request.opened", { action: "opened" })).toBe(
      "pull_request",
    );
    expect(webhookHeaderEvent("github", "workflow_run", {})).toBe("workflow_run");
    expect(
      webhookHeaderEvent("gitlab", "Merge Request Hook.update", {
        object_attributes: { action: "update" },
      }),
    ).toBe("Merge Request Hook");
    expect(webhookHeaderEvent("gitlab", "Pipeline Hook", { object_attributes: {} })).toBe(
      "Pipeline Hook",
    );
    expect(webhookHeaderEvent("github", "unknown.opened", { action: "opened" })).toBeNull();
    // CI deliveries name how the run went too.
    expect(
      webhookHeaderEvent("github", "workflow_run.completed.failure", {
        action: "completed",
        workflow_run: { conclusion: "failure" },
      }),
    ).toBe("workflow_run");
    expect(
      webhookHeaderEvent("gitlab", "Pipeline Hook.failed", {
        object_kind: "pipeline",
        object_attributes: { status: "failed" },
      }),
    ).toBe("Pipeline Hook");
  });
});

describe.skipIf(!databaseAvailable)("POST /api/ui/deliveries/{id}/replay", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let other: string;
  let github: ScmConnection;
  let repoId: string;
  let oldRepoId: string;
  let integrationId: string;
  let otherConnection: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, otherOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    acme = acmeOrg!.id;
    other = otherOrg!.id;
    state.orgId = acme;
    await db.insert(users).values([
      { id: member.id, name: member.name, email: "mia@acme.io" },
      { id: "member-2", name: "Max Member", email: "max@acme.io" },
    ]);
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: member.id, role: "member" },
      { organizationId: acme, userId: "member-2", role: "member" },
    ]);
    github = (await upsertScmConnection(db, {
      organizationId: acme,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "1",
      credentials: {},
    }))!;
    repoId = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    oldRepoId = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/old",
      })
    ).id;
    otherConnection = (await upsertScmConnection(db, {
      organizationId: other,
      provider: "github",
      name: "other",
      baseUrl: "https://api.github.com",
      externalId: "9",
      credentials: {},
    }))!.id;
    const integration = await saveIntegration(db, {
      organizationId: acme,
      provider: "linear",
      externalId: "workspace-1",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
    integrationId = integration.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.scm = new FakeScmAdapter("github");
    state.linear = new FakeLinearGateway();
    state.handled = [];
    state.handle = async () => {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A live GitHub delivery, as the webhook route handles it. */
  async function sendGitHub(body: object, delivery = randomUUID()) {
    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": delivery,
      },
      body: JSON.stringify({
        installation: { id: 1 },
        repository: { id: 1, full_name: "acme/api" },
        ...body,
      }),
    });
    const response = await handleWebhook("github", req, {
      db,
      dispatcher: new PostgresDispatcher({ db }),
      adapterFor: () => state.scm.asAdapter(),
    });
    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.deliveryId, delivery));
    return { response: (await response.json()) as Record<string, unknown>, event: row! };
  }

  const opened = (number: number) => ({
    action: "opened",
    pull_request: {
      number,
      state: "open",
      draft: false,
      title: "Add login",
      body: "Please review",
      user: { login: "octocat", type: "User" },
      head: { sha: randomBytes(20).toString("hex") },
      base: { sha: "b".repeat(40) },
      requested_reviewers: [],
      requested_teams: [],
    },
  });

  const setOnOpen = (onOpen: boolean) =>
    db
      .update(repositories)
      .set({ triggers: { onOpen, onPush: true, drafts: false } })
      .where(eq(repositories.id, repoId));

  /** A stored Linear delivery of an agent-session event. */
  const linearDelivery = (
    action: "created" | "prompted",
    sessionId: string,
    issueId: string,
    identifier: string,
    extra: object = {},
  ) =>
    recordWebhookEvent(db, {
      organizationId: acme,
      provider: "linear",
      source: { integrationId },
      deliveryId: randomUUID(),
      event: `AgentSessionEvent.${action}`,
      rawBody: JSON.stringify({
        type: "AgentSessionEvent",
        action,
        organizationId: "workspace-1",
        webhookTimestamp: Date.now(),
        agentSession: { id: sessionId, issue: { id: issueId, identifier } },
        ...extra,
      }),
      outcome: "updated_run",
    });

  const ralphRun = (issueId: string, identifier: string, sessionId: string) =>
    createRun(db, {
      organizationId: acme,
      trackerIssueId: issueId,
      trackerIdentifier: identifier,
      trackerSessionId: sessionId,
      kind: "children",
      repositoryId: null,
    });

  it("replays a delivery ignored as trigger_disabled into a review once the trigger is on", async () => {
    await setOnOpen(false);
    const original = await sendGitHub(opened(7));
    expect(original.response).toEqual({ status: "ignored", reason: "trigger_disabled" });
    expect(original.event).toMatchObject({ outcome: "ignored", reasonCode: "trigger_disabled" });

    await setOnOpen(true);
    const { result, changes } = await captureChanges(() => replay(original.event.id));
    expect(result.status).toBe(200);
    expect(deliveryDetailSchema.parse(result.body)).toEqual(result.body);
    const [run] = await db.select().from(reviewRuns).where(eq(reviewRuns.prNumber, 7));
    expect(result.body).toMatchObject({
      provider: "github",
      connection: { kind: "scm", id: github.id },
      repository: { id: repoId, fullPath: "acme/api" },
      deliveryId: original.event.deliveryId,
      event: "pull_request.opened",
      outcome: "started_run",
      run: { id: run!.id, kind: "review" },
      replayOfId: original.event.id,
      replayedBy: { id: member.id, name: "Mia Member" },
      payload: original.event.payload,
      replays: [],
    });
    expect(result.body.id).not.toBe(original.event.id);
    // The replay claims no delivery ID: the original was never claimed either.
    expect(
      await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.deliveryId, original.event.deliveryId!)),
    ).toEqual([]);

    // One change names both rows.
    expect(changes).toContainEqual(
      expect.objectContaining({
        resource: "webhook_event",
        ids: [result.body.id, original.event.id, github.id],
        organizationId: acme,
      }),
    );

    // The original lists its replays, newest first; it stays as it was.
    const again = await replay(original.event.id);
    expect(again.status).toBe(200);
    const shown = await detail(original.event.id);
    expect(shown).toMatchObject({ outcome: "ignored", reasonCode: "trigger_disabled" });
    expect(shown.replays.map((r) => r.id)).toEqual([again.body.id, result.body.id]);
    expect(shown.replays[1]).toMatchObject({
      replayOfId: original.event.id,
      outcome: "started_run",
    });
  });

  it("replays a claimed delivery past the claim, to the review it already started", async () => {
    await setOnOpen(true);
    const original = await sendGitHub(opened(8));
    expect(original.response).toMatchObject({ status: "enqueued" });
    expect(original.event.runId).toEqual(expect.any(String));
    // A claim would answer a duplicate without a run; the review of this head links its run.
    const { status, body } = await replay(original.event.id);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      outcome: "duplicate",
      run: { id: original.event.runId, kind: "review" },
    });
  });

  it("refuses a truncated payload and a removed repo with 400, and a pruned delivery with 404", async () => {
    const truncated = await recordWebhookEvent(db, {
      organizationId: acme,
      provider: "github",
      source: { scmConnectionId: github.id },
      repositoryId: repoId,
      event: "pull_request.opened",
      rawBody: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
      outcome: "ignored",
    });
    expect(await replay(truncated)).toMatchObject({
      status: 400,
      body: { error: "This delivery was too large to keep, so it can't be replayed." },
    });

    const stored = (repositoryId: string | null) =>
      recordWebhookEvent(db, {
        organizationId: acme,
        provider: "github",
        source: { scmConnectionId: github.id },
        repositoryId,
        event: "pull_request.opened",
        rawBody: JSON.stringify(opened(9)),
        outcome: "ignored",
      });
    const disconnected = await stored(oldRepoId);
    await disconnectRepository(db, acme, oldRepoId);
    const repoless = await stored(null);
    for (const id of [disconnected, repoless]) {
      expect(await replay(id)).toMatchObject({
        status: 400,
        body: {
          error: "The connection this delivery came through was removed, so it can't be replayed.",
        },
      });
    }

    const old = await stored(repoId);
    await db
      .update(webhookEvents)
      .set({ receivedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) })
      .where(eq(webhookEvents.id, old));
    await pruneWebhookEvents(db, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));
    expect((await replay(old)).status).toBe(404);
    expect((await replay(randomUUID())).status).toBe(404);
    expect((await replay("not-a-uuid")).status).toBe(404);
    // Nothing was recorded for the refusals.
    expect(
      await db.select().from(webhookEvents).where(eq(webhookEvents.replayOfId, truncated)),
    ).toEqual([]);
  });

  it("replays a Linear agent-session event of a finished run in a new agent session", async () => {
    state.linear.issues.set("issue-1", issue("issue-1", "ENG-1"));
    const { run: finished } = await ralphRun("issue-1", "ENG-1", "s-old");
    await updateRun(db, finished.id, { status: "completed" });
    const original = await linearDelivery("created", "s-old", "issue-1", "ENG-1", {
      agentSession: {
        id: "s-old",
        issue: { id: "issue-1", identifier: "ENG-1" },
        comment: { body: "@omniralph build it" },
      },
    });
    let started = "";
    state.handle = async (event) => {
      if (event.kind !== "issue_mentioned") return;
      started = (await ralphRun(event.issueId, "ENG-1", event.sessionId)).run.id;
    };

    const { status, body } = await replay(original);
    expect(status).toBe(200);
    expect(state.linear.sessionsCreated).toEqual([{ issueId: "issue-1", sessionId: "session-1" }]);
    expect(state.handled).toEqual([
      expect.objectContaining({
        kind: "issue_mentioned",
        sessionId: "session-1",
        issueId: "issue-1",
        commentBody: "@omniralph build it",
      }),
    ]);
    expect(body).toMatchObject({
      provider: "linear",
      connection: { kind: "linear", id: integrationId },
      event: "AgentSessionEvent.created",
      outcome: "started_run",
      run: { id: started, kind: "epic" },
      replayOfId: original,
      replayedBy: { id: member.id },
    });
  });

  it("moves a reply to a finished triage run into a new agent session", async () => {
    state.linear.issues.set("issue-3", issue("issue-3", "ENG-3"));
    const { run: triage } = await createTriageRun(db, {
      organizationId: acme,
      trackerIssueId: "issue-3",
      trackerSessionId: "s-triage",
      trigger: "mention",
    });
    await setTriageRunStatus(db, triage.id, "completed");
    const original = await linearDelivery("prompted", "s-triage", "issue-3", "ENG-3", {
      agentActivity: { content: { body: "Split it in two" }, user: { name: "Ann" } },
    });
    expect((await replay(original)).status).toBe(200);
    expect(state.handled).toEqual([
      expect.objectContaining({
        kind: "issue_mentioned",
        sessionId: "session-1",
        issueId: "issue-3",
        commentBody: "Split it in two",
        creatorName: "Ann",
      }),
    ]);
  });

  it("refuses to replay an agent-session event while its run is active", async () => {
    await ralphRun("issue-2", "ENG-2", "s-active");
    const original = await linearDelivery("prompted", "s-active", "issue-2", "ENG-2", {
      agentActivity: { content: { body: "continue" } },
    });
    expect(await replay(original)).toMatchObject({
      status: 409,
      body: { error: "Om is still working on ENG-2." },
    });
    expect(state.linear.sessionsCreated).toEqual([]);
    expect(state.handled).toEqual([]);
    expect(
      await db.select().from(webhookEvents).where(eq(webhookEvents.replayOfId, original)),
    ).toEqual([]);
  });

  it("limits replays to 10 a minute per user", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:00:05Z"));
    const truncated = await recordWebhookEvent(db, {
      organizationId: acme,
      provider: "github",
      source: { scmConnectionId: github.id },
      repositoryId: repoId,
      event: "pull_request.opened",
      rawBody: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
      outcome: "ignored",
    });
    const max: TestUser = { ...member, id: "member-2", name: "Max Member" };
    for (let i = 0; i < 10; i++) expect((await replay(truncated, max)).status).toBe(400);
    expect(await replay(truncated, max)).toMatchObject({
      status: 429,
      body: { error: expect.stringContaining("That's a lot of replays in a minute.") },
    });
    // Another user's limit is their own.
    expect((await replay(truncated, member)).status).toBe(400);
  });

  it("doesn't replay another organization's deliveries, and requires a signed-in user", async () => {
    const foreign = await recordWebhookEvent(db, {
      organizationId: other,
      provider: "github",
      source: { scmConnectionId: otherConnection },
      event: "pull_request.opened",
      rawBody: JSON.stringify(opened(1)),
      outcome: "ignored",
    });
    expect((await replay(foreign)).status).toBe(404);
    expect((await replay(foreign, null)).status).toBe(401);
  });
});
