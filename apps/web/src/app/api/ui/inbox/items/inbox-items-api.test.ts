import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  getRun,
  harnesses,
  inboxItemStates,
  insertJob,
  jobs,
  listStories,
  organizationMembers,
  organizations,
  ralphRuns,
  updateRepositoryRalphSettings,
  updateRun,
  updateStory,
  upsertScmConnection,
  upsertStories,
  users,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type NewLinearRalphRunInput,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { REPO_SYNC_JOB_TYPE } from "@omniralph/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inboxFeedSchema,
  inboxItemActionResultSchema,
  type InboxFeed,
  type InboxItemActionResult,
} from "@/lib/api/inbox";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import type { ChangeMessage } from "@/lib/live/publisher";
import { withLiveChanges } from "@/lib/live/request";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  linear: undefined as unknown as LinearGateway,
  dispatcher: undefined as unknown,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => state.dispatcher }));
vi.mock("@/lib/linear/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLinearGatewayOrDisconnected: async () => state.linear,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const itemRoute = await import("@/app/api/ui/inbox/items/[key]/route");
const feedRoute = await import("@/app/api/ui/inbox/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = {
  id: "items-mo",
  role: "member",
  name: "Mo Member",
  email: null,
  image: null,
};
const other: TestUser = { id: "items-ola", role: "member", name: "Ola", email: null, image: null };

/** `POST /api/ui/inbox/items/{key}` (the key percent-encoded, as a client sends it). */
async function act(
  key: string,
  body: unknown,
): Promise<{ status: number; body: InboxItemActionResult & { error?: string } }> {
  const response = await itemRoute.POST(
    new Request(`http://localhost/api/ui/inbox/items/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key: encodeURIComponent(key) }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as InboxItemActionResult & { error?: string },
  };
}

async function feed(tab = "needs-you"): Promise<InboxFeed> {
  const response = await feedRoute.GET(
    new Request(`http://localhost/api/ui/inbox?tab=${tab}&organization=all`),
    { params: Promise.resolve({}) },
  );
  expect(response.status).toBe(200);
  return inboxFeedSchema.parse(await response.json());
}

const keys = async (tab?: string) => (await feed(tab)).items.map((i) => i.key);

/** Runs `fn` as a request whose change events a fake publisher receives. */
async function published(fn: () => Promise<unknown>): Promise<ChangeMessage[]> {
  const messages: ChangeMessage[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  await withLiveChanges(fn, {
    publisher: { publish: async (batch) => void messages.push(...batch) },
    schedule: (task) => scheduled.push(task),
  });
  for (const task of scheduled) await task();
  return messages;
}

describe.skipIf(!databaseAvailable)("POST /api/ui/inbox/items/{key}", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let agentId: string;
  let linear: FakeLinearGateway;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await db.insert(users).values([{ id: member.id }, { id: other.id }]);
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: member.id, role: "member" },
      { organizationId: orgId, userId: other.id, role: "member" },
    ]);
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    [{ id: agentId }] = (await db
      .insert(harnesses)
      .values({ organizationId: orgId, name: "agent-a", acceptedTaskTypes: ["coding"] })
      .returning({ id: harnesses.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(inboxItemStates);
    state.user = member;
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
      linearAgentSessionId: `items-session-${session}`,
      kind: "children",
      repositoryId: repoId,
      branch: `eng-${session}`,
      baseBranch: "main",
      ...overrides,
    });
    return linearRun(run);
  }

  /** An epic waiting on its manual story ENG-51; ENG-52 waits for it. */
  async function manualStoryEpic() {
    const epic = linear.add({ identifier: "ENG-50", title: "Epic", description: "Build it." });
    const manual = linear.add({
      identifier: "ENG-51",
      title: "Point DNS at the new host",
      parentId: epic.id,
      labels: ["manual"],
      subIssueSortOrder: 0,
    });
    const next = linear.add({
      identifier: "ENG-52",
      title: "Use the new host",
      parentId: epic.id,
      subIssueSortOrder: 1,
    });
    await linear.createBlocksRelation(manual.id, next.id);
    const run = await newRun({
      linearIssueId: epic.id,
      linearIdentifier: "ENG-50",
      linearUrl: "https://linear.app/acme/issue/ENG-50/epic",
    });
    const [manualRow, nextRow] = await upsertStories(db, run.id, [
      { linearIssueId: manual.id, identifier: "ENG-51", title: "Point DNS at the new host" },
      { linearIssueId: next.id, identifier: "ENG-52", title: "Use the new host" },
    ]);
    await updateStory(db, manualRow!.id, { status: "manual" });
    await updateRun(db, run.id, {
      status: "waiting",
      waitingOn: {
        blockers: [],
        manual: [{ id: manual.id, identifier: "ENG-51", title: "Point DNS at the new host" }],
      },
    });
    return { run, manual, manualRow: manualRow!, nextRow: nextRow! };
  }

  /** A stopped epic with one open story. */
  async function stoppedEpic() {
    const epic = linear.add({ identifier: "ENG-60", title: "Epic", description: "Build it." });
    const open = linear.add({ identifier: "ENG-61", title: "Open", parentId: epic.id });
    const run = await newRun({
      linearIssueId: epic.id,
      linearIdentifier: "ENG-60",
      linearUrl: "https://linear.app/acme/issue/ENG-60/epic",
    });
    await upsertStories(db, run.id, [
      { linearIssueId: open.id, identifier: "ENG-61", title: "Open" },
    ]);
    await updateRun(db, run.id, { status: "stopped" });
    const current = (await getRun(db, run.id))!;
    return { run, key: `stopped:${run.id}:${await updatedAtKey(run.id)}`, current };
  }

  /** A run's `updated_at` as the Inbox writes it in keys. */
  async function updatedAtKey(runId: string): Promise<string> {
    const result = await db.execute<{ at: string }>(
      sql`select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
        from ralph_runs where id = ${runId}`,
    );
    return result.rows[0]!.at;
  }

  /** The run's change went on the organization's channel, and nothing on a user's. */
  function expectRunChange(messages: ChangeMessage[], runId: string) {
    expect(messages).toContainEqual({
      channel: `org:${orgId}:changes`,
      event: expect.objectContaining({ resource: "run", organizationId: orgId, runId }),
    });
    expect(messages.some((m) => m.channel.startsWith("user:"))).toBe(false);
  }

  const queuedJobs = (runId: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, runId), eq(jobs.status, "queued")));

  describe("a manual story", () => {
    it("Done completes its work item through the tracker and the run goes on with the next story", async () => {
      const { run, manual, manualRow, nextRow } = await manualStoryEpic();
      const key = `manual_story:${manualRow.id}`;
      expect(await keys()).toContain(key);

      let result!: Awaited<ReturnType<typeof act>>;
      const messages = await published(async () => {
        result = await act(key, { action: "done" });
      });
      expect(result.status).toBe(200);
      expect(inboxItemActionResultSchema.parse(result.body)).toEqual({
        key,
        action: "done",
        state: null,
        snoozedUntil: null,
        runId: run.id,
        warning: null,
      });
      // Through the work item tracker (Linear's done state), not a stored Done.
      expect(linear.stateChanges).toContainEqual(expect.objectContaining({ issueId: manual.id }));
      expect((await linear.getIssue(manual.id))!.stateType).toBe("completed");
      expect(await db.select().from(inboxItemStates)).toEqual([]);
      const stories = await listStories(db, run.id);
      expect(stories.find((s) => s.id === manualRow.id)).toMatchObject({ status: "completed" });
      const [job, ...more] = await queuedJobs(run.id);
      expect(more).toEqual([]);
      expect(job).toMatchObject({ type: "ralph.story", ralphStoryId: nextRow.id });
      expect(await getRun(db, run.id)).toMatchObject({ status: "running", waitingOn: null });
      expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
        "**ENG-51** was marked done from Omniralph by Mo Member.",
      );
      // The run's changes go on the organization's channel; nothing on the user's.
      expect(messages.map((m) => m.channel)).toContain(`org:${orgId}:changes`);
      expect(messages).toContainEqual({
        channel: `org:${orgId}:changes`,
        event: expect.objectContaining({ resource: "run", organizationId: orgId }),
      });
      expect(messages.some((m) => m.channel.startsWith("user:"))).toBe(false);
      // The item is gone, and acting on it again finds nothing.
      expect(await keys()).not.toContain(key);
      expect(await act(key, { action: "done" })).toMatchObject({
        status: 404,
        body: { error: "This item was already handled." },
      });
    });

    it("Skip cancels its work item through the tracker and the story becomes canceled", async () => {
      const { run, manual, manualRow, nextRow } = await manualStoryEpic();
      const key = `manual_story:${manualRow.id}`;
      let result!: Awaited<ReturnType<typeof act>>;
      const messages = await published(async () => {
        result = await act(key, { action: "skip" });
      });
      expect(result).toMatchObject({
        status: 200,
        body: { action: "skip", runId: run.id },
      });
      expectRunChange(messages, run.id);
      expect((await linear.getIssue(manual.id))!.stateType).toBe("canceled");
      const stories = await listStories(db, run.id);
      expect(stories.find((s) => s.id === manualRow.id)).toMatchObject({ status: "canceled" });
      expect(await queuedJobs(run.id)).toEqual([
        expect.objectContaining({ type: "ralph.story", ralphStoryId: nextRow.id }),
      ]);
      expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
        "**ENG-51** was skipped from Omniralph by Mo Member: it's done without work.",
      );
    });

    it("answers 502 and changes nothing when the tracker fails", async () => {
      const { run, manualRow } = await manualStoryEpic();
      linear.failures.set("setIssueState", new Error("Linear is down"));
      const result = await act(`manual_story:${manualRow.id}`, { action: "done" });
      expect(result.status).toBe(502);
      expect(result.body.error).toContain("Couldn't complete ENG-51 in Linear");
      expect(await getRun(db, run.id)).toMatchObject({ status: "waiting" });
      expect(await queuedJobs(run.id)).toEqual([]);
    });
  });

  it("refuses Skip and other actions an item doesn't offer", async () => {
    const { key } = await stoppedEpic();
    expect(await act(key, { action: "skip" })).toMatchObject({
      status: 400,
      body: { error: "Only a manual story can be skipped." },
    });
    expect(await act(key, { action: "start_anyway" })).toMatchObject({
      status: 400,
      body: { error: "Only an epic waiting on blockers can be started anyway." },
    });
    expect(await act(key, { action: "retry" })).toMatchObject({ status: 400 });
    expect(await act(key, { action: "answer" })).toMatchObject({
      status: 400,
      body: { error: "Unknown action." },
    });
  });

  describe("Done, Snooze and Restore on other items", () => {
    it("record the user's own state only, on the user's channel", async () => {
      const { run, key } = await stoppedEpic();
      let result!: Awaited<ReturnType<typeof act>>;
      const messages = await published(async () => {
        result = await act(key, { action: "done" });
      });
      expect(result).toMatchObject({ status: 200, body: { key, state: "done", runId: null } });
      expect(messages).toEqual([
        {
          channel: `user:${member.id}:changes`,
          event: expect.objectContaining({ resource: "inbox_state", ids: [key] }),
        },
      ]);
      // The run is untouched; the item is hidden for Mo only.
      expect(await getRun(db, run.id)).toMatchObject({ status: "stopped" });
      expect(await keys()).not.toContain(key);
      state.user = other;
      expect(await keys()).toContain(key);
      state.user = member;

      // Restore brings it back, on the user's channel too.
      const restored = await published(async () => {
        result = await act(key, { action: "restore" });
      });
      expect(result).toMatchObject({ status: 200, body: { state: null } });
      expect(restored).toEqual([
        {
          channel: `user:${member.id}:changes`,
          event: expect.objectContaining({ resource: "inbox_state", ids: [key] }),
        },
      ]);
      expect(await keys()).toContain(key);
      expect(await db.select().from(inboxItemStates)).toEqual([]);
    });

    it("snoozes until a time 5 minutes to 30 days ahead", async () => {
      const { key } = await stoppedEpic();
      const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
      for (const until of [ahead(60_000), ahead(31 * 86_400_000), "tomorrow"]) {
        expect((await act(key, { action: "snooze", until })).status).toBe(400);
      }
      expect(await act(key, { action: "snooze" })).toMatchObject({
        status: 400,
        body: { error: "Snooze for 5 minutes to 30 days." },
      });
      const until = ahead(2 * 3_600_000);
      let result!: Awaited<ReturnType<typeof act>>;
      const messages = await published(async () => {
        result = await act(key, { action: "snooze", until });
      });
      expect(result).toMatchObject({
        status: 200,
        body: { key, state: "snoozed", snoozedUntil: until },
      });
      expect(messages.map((m) => [m.channel, m.event.resource])).toEqual([
        [`user:${member.id}:changes`, "inbox_state"],
      ]);
      expect(await keys()).not.toContain(key);
      // A snooze that ended shows the item again.
      await db
        .update(inboxItemStates)
        .set({ snoozedUntil: new Date(Date.now() - 1000) })
        .where(eq(inboxItemStates.itemKey, key));
      expect(await keys()).toContain(key);
      // Done after a snooze replaces it.
      expect(await act(key, { action: "done" })).toMatchObject({ body: { state: "done" } });
      expect(await db.select().from(inboxItemStates)).toEqual([
        expect.objectContaining({ itemKey: key, state: "done", snoozedUntil: null }),
      ]);
    });
  });

  it("Start anyway ignores the epic's outside blockers, as the reply does, and the run goes on", async () => {
    const epic = linear.add({ identifier: "ENG-70", title: "Epic", description: "Build it." });
    const story = linear.add({ identifier: "ENG-71", title: "Story", parentId: epic.id });
    const outside = linear.add({ identifier: "OPS-2", title: "Outside" });
    await linear.createBlocksRelation(outside.id, epic.id);
    const run = await newRun({
      linearIssueId: epic.id,
      linearIdentifier: "ENG-70",
      linearUrl: "https://linear.app/acme/issue/ENG-70/epic",
    });
    const [storyRow] = await upsertStories(db, run.id, [
      { linearIssueId: story.id, identifier: "ENG-71", title: "Story" },
    ]);
    await updateRun(db, run.id, {
      status: "waiting",
      waitingOn: {
        blockers: [{ id: outside.id, identifier: "OPS-2", title: "Outside" }],
        manual: [],
      },
    });
    const key = `blocked:${run.id}:${outside.id}`;
    expect(await keys()).toContain(key);

    let result!: Awaited<ReturnType<typeof act>>;
    const messages = await published(async () => {
      result = await act(key, { action: "start_anyway" });
    });
    expect(result).toMatchObject({ status: 200, body: { action: "start_anyway", runId: run.id } });
    expect(await getRun(db, run.id)).toMatchObject({
      ignoreBlockers: true,
      waitingOn: null,
      status: "running",
    });
    expect(await queuedJobs(run.id)).toEqual([
      expect.objectContaining({ type: "ralph.story", ralphStoryId: storyRow!.id }),
    ]);
    expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
      "Started anyway from Omniralph by Mo Member: OK, I'll ignore the open blockers and start anyway.",
    );
    expect(messages).toContainEqual({
      channel: `org:${orgId}:changes`,
      event: expect.objectContaining({ resource: "run" }),
    });
    expect(await act(key, { action: "start_anyway" })).toMatchObject({ status: 404 });
  });

  it("Resume retries a stopped epic", async () => {
    const { run, key } = await stoppedEpic();
    let result!: Awaited<ReturnType<typeof act>>;
    const messages = await published(async () => {
      result = await act(key, { action: "resume" });
    });
    expect(result).toMatchObject({
      status: 200,
      body: { action: "resume", runId: run.id },
    });
    expectRunChange(messages, run.id);
    expect(await getRun(db, run.id)).toMatchObject({ status: "running" });
    expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
      "Retried from Omniralph by Mo Member.",
    );
    expect(await act(key, { action: "resume" })).toMatchObject({
      status: 404,
      body: { error: "This item was already handled." },
    });
  });

  it("Retry retries a failed run", async () => {
    const { run } = await stoppedEpic();
    await updateRun(db, run.id, { status: "failed", error: "Out of attempts." });
    const [key] = (await feed("problems")).items
      .filter((i) => i.kind === "failed_run")
      .map((i) => i.key);
    expect(key).toBe(`failed:${run.id}:none`);
    let result!: Awaited<ReturnType<typeof act>>;
    const messages = await published(async () => {
      result = await act(key!, { action: "retry" });
    });
    expect(result).toMatchObject({
      status: 200,
      body: { runId: run.id },
    });
    expectRunChange(messages, run.id);
    expect(await getRun(db, run.id)).toMatchObject({ status: "running" });
  });

  it("Retry reruns a failed system attempt", async () => {
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: REPO_SYNC_JOB_TYPE,
      taskType: "system",
      payload: { repositoryId: repoId },
      repositoryId: repoId,
      targetHarnessId: agentId,
    });
    await db
      .update(jobs)
      .set({ status: "failed", finishedAt: new Date(), error: "git fetch failed" })
      .where(eq(jobs.id, job.id));
    const key = `failed_attempt:${job.id}`;
    expect(await keys("problems")).toContain(key);
    expect(await act(key, { action: "retry" })).toMatchObject({ status: 200 });
    const rerun = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, REPO_SYNC_JOB_TYPE), eq(jobs.status, "queued")));
    expect(rerun).toEqual([expect.objectContaining({ targetHarnessId: agentId })]);
  });

  it("answers 404 for a key that derives no item", async () => {
    for (const key of ["manual_story:00000000-0000-0000-0000-000000000000", "nonsense", "x:y"]) {
      expect(await act(key, { action: "done" })).toMatchObject({
        status: 404,
        body: { error: "This item was already handled." },
      });
    }
  });

  it("answers 401 when signed out", async () => {
    const { key } = await stoppedEpic();
    state.user = null;
    expect((await act(key, { action: "done" })).status).toBe(401);
  });
});
