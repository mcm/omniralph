import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { captureChanges } from "./changes.js";
import {
  clearInboxItemState,
  countInboxItems,
  findInboxItem,
  INBOX_ITEM_STATE_RETENTION_DAYS,
  listInboxItems,
  listRunQuestions,
  loadInboxReferences,
  pruneInboxItemStates,
  setInboxItemState,
  type InboxCandidate,
} from "./inbox.js";
import { connectRepository, upsertScmConnection } from "./repositories.js";
import {
  appSettings,
  findings,
  agents,
  inboxItemStates,
  jobs,
  organizations,
  ralphLanes,
  ralphRuns,
  ralphStories,
  reviewRuns,
  reviews,
  runPermissionRequests,
  triageRuns,
} from "./schema.js";
import { createUser } from "./users.js";

const databaseAvailable = testDatabaseAvailable();

const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const DAY = 24 * 60;
const ONLINE_WINDOW_MS = 60_000;

type RalphRunInsert = typeof ralphRuns.$inferInsert;
type JobInsert = typeof jobs.$inferInsert;

describe.skipIf(!databaseAvailable)("inbox", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let repo: string;
  let alice: string;
  let bob: string;
  const ids: Record<string, string> = {};

  const ralphRun = async (name: string, values: Partial<RalphRunInsert>) => {
    const id = randomUUID();
    ids[name] = id;
    await db.insert(ralphRuns).values({
      id,
      organizationId: acme,
      linearIssueId: `issue-${name}`,
      linearIdentifier: `ENG-${name}`,
      linearTitle: `Epic ${name}`,
      linearAgentSessionId: `session-${name}`,
      kind: "children",
      mode: "epic",
      repositoryId: repo,
      status: "completed",
      createdAt: ago(60),
      updatedAt: ago(30),
      ...values,
    });
    return id;
  };
  const job = async (name: string, values: Partial<JobInsert>) => {
    const id = randomUUID();
    ids[name] = id;
    await db.insert(jobs).values({
      id,
      organizationId: acme,
      type: "ralph.story",
      taskType: "system",
      status: "completed",
      createdAt: ago(40),
      finishedAt: ago(35),
      ...values,
    });
    return id;
  };

  const list = (userId = alice, organizationIds = [acme]) =>
    listInboxItems(db, { organizationIds, userId, onlineWindowMs: ONLINE_WINDOW_MS, now });
  const keysOf = (items: InboxCandidate[]) => items.map((i) => i.key).sort();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a, b] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = a!.id;
    beta = b!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: acme,
        provider: "github",
        name: "app",
        baseUrl: "https://api.github.com",
        externalId: "installation-1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repo = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/web",
      })
    ).id;
    alice = (await createUser(db, { name: "Alice", email: "alice@example.com" })).id;
    bob = (await createUser(db, { name: "Bob", email: "bob@example.com" })).id;

    // ── Needs you ──
    // A waiting epic with a manual story (an item), a pending story (none), an outside
    // blocker and an open preparation question.
    await ralphRun("waiting", {
      status: "waiting",
      waitingOn: {
        blockers: [
          { id: "blocker-2", identifier: "OPS-2", title: "Two" },
          { id: "blocker-1", identifier: "OPS-1", title: "One" },
        ],
        manual: [],
      },
      preparation: {
        request: {
          storyIssueId: "story-manual",
          identifier: "ENG-11",
          title: "Set up DNS",
          commandsHash: "h",
          headSha: null,
          askedAt: ago(20).toISOString(),
        },
        handled: {},
      },
    });
    await db.insert(ralphStories).values([
      {
        runId: ids.waiting!,
        linearIssueId: "story-manual",
        identifier: "ENG-11",
        title: "Set up DNS",
        status: "manual",
        updatedAt: ago(25),
      },
      {
        runId: ids.waiting!,
        linearIssueId: "story-pending",
        identifier: "ENG-12",
        title: "Build",
        status: "pending",
      },
    ]);
    const [manual] = await db
      .select()
      .from(ralphStories)
      .where(eq(ralphStories.linearIssueId, "story-manual"));
    ids.manualStory = manual!.id;
    // A manual story of a running epic (no item; the run is under Running), whose live
    // session asks to use a tool (a question).
    await ralphRun("running", {
      status: "running",
      createdAt: ago(10),
      permission: {
        requestId: "req-1",
        jobId: randomUUID(),
        tool: "Bash",
        detail: "rm -rf build",
        askedAt: ago(5).toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      },
    });
    await db.insert(ralphStories).values({
      runId: ids.running!,
      linearIssueId: "story-run-manual",
      identifier: "ENG-21",
      title: "Manual",
      status: "manual",
    });
    // Blockers ignored ("start anyway"), an answered permission, a preparation being run.
    await ralphRun("startAnyway", {
      status: "waiting",
      ignoreBlockers: true,
      waitingOn: {
        blockers: [{ id: "blocker-3", identifier: "OPS-3", title: "Three" }],
        manual: [],
      },
      permission: {
        requestId: "req-2",
        jobId: randomUUID(),
        tool: "Bash",
        detail: "ls",
        askedAt: ago(5).toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(),
        answer: "allowed",
      },
      preparation: {
        request: {
          storyIssueId: "s",
          identifier: "ENG-31",
          title: "Prep",
          commandsHash: "h",
          headSha: null,
          askedAt: ago(5).toISOString(),
          answer: "run",
          jobId: randomUUID(),
        },
        handled: {},
      },
    });
    // Stopped: recently (an item) and three weeks ago (left out).
    await ralphRun("stopped", { status: "stopped", mode: "request", updatedAt: ago(15) });
    await ralphRun("stoppedOld", {
      status: "stopped",
      createdAt: ago(22 * DAY),
      updatedAt: ago(21 * DAY),
    });
    // Routing found no repo: which one to use?
    await ralphRun("noRepo", {
      status: "waiting",
      repositoryId: null,
      pendingElicitation: { kind: "repository", repositoryIds: [repo] },
      createdAt: ago(12),
    });
    // A merged lane's leftovers.
    await ralphRun("cleanup", { status: "completed" });
    await db.insert(ralphLanes).values({
      runId: ids.cleanup!,
      repositoryId: repo,
      branch: "omniralph/cleanup",
      baseBranch: "main",
      prNumber: 7,
      prClosed: true,
      prMerged: true,
      cleanup: {
        status: "done",
        at: ago(8).toISOString(),
        mergedSha: "abc",
        questions: [{ kind: "stashes", shas: ["s1"], askedAt: ago(8).toISOString() }],
      },
    });
    // PRs: open and ready (an item, with its AI review), a draft, and one with a job running.
    const lane = async (name: string, values: Partial<typeof ralphLanes.$inferInsert>) => {
      await ralphRun(name, { status: "completed" });
      const [row] = await db
        .insert(ralphLanes)
        .values({
          runId: ids[name]!,
          repositoryId: repo,
          branch: `omniralph/${name}`,
          baseBranch: "main",
          ...values,
        })
        .returning();
      ids[`${name}Lane`] = row!.id;
    };
    await lane("prReady", {
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      prReviewState: "approved",
      prStateUpdatedAt: ago(3),
    });
    await lane("prDraft", { prNumber: 43, prDraft: true });
    await lane("prBusy", { prNumber: 44 });
    await job("prBusyJob", {
      ralphRunId: ids.prBusy,
      type: "ralph.describe-pr",
      status: "running",
      finishedAt: null,
    });
    const [older, newer] = await db
      .insert(reviewRuns)
      .values([
        {
          organizationId: acme,
          repositoryId: repo,
          prNumber: 42,
          headSha: "old",
          baseSha: "b",
          trigger: "webhook",
          mode: "full",
          status: "completed",
          createdAt: ago(50),
        },
        {
          organizationId: acme,
          repositoryId: repo,
          prNumber: 42,
          headSha: "new",
          baseSha: "b",
          trigger: "webhook",
          mode: "incremental",
          status: "completed",
          createdAt: ago(20),
        },
      ])
      .returning();
    ids.prReview = newer!.id;
    const [pass] = await db
      .insert(reviews)
      .values({
        reviewRunId: newer!.id,
        repositoryId: repo,
        prNumber: 42,
        headSha: "new",
        baseSha: "b",
        trigger: "webhook",
        status: "completed",
        budget: 1000,
      })
      .returning();
    const [oldPass] = await db
      .insert(reviews)
      .values({
        reviewRunId: older!.id,
        repositoryId: repo,
        prNumber: 42,
        headSha: "old",
        baseSha: "b",
        trigger: "webhook",
        status: "completed",
        budget: 1000,
      })
      .returning();
    const finding = (reviewId: string, severity: "high" | "low", status: "open" | "resolved") => ({
      reviewId,
      path: "a.ts",
      startLine: 1,
      endLine: 1,
      severity,
      category: "bug",
      title: "t",
      body: "b",
      confidence: 0.9,
      status,
    });
    await db
      .insert(findings)
      .values([
        finding(pass!.id, "high", "open"),
        finding(pass!.id, "high", "open"),
        finding(pass!.id, "low", "resolved"),
        finding(oldPass!.id, "low", "open"),
      ]);
    // Triage: a PRD nobody started (an item), one whose run started since, one unchanged,
    // one with open questions (left Needs refining, so not ready).
    const triage = async (
      name: string,
      outcome: string,
      issue = `triage-${name}`,
      openQuestions: string[] = [],
      size?: string,
    ) => {
      const [row] = await db
        .insert(triageRuns)
        .values({
          organizationId: acme,
          linearIssueId: issue,
          linearAgentSessionId: `triage-session-${name}`,
          trigger: "label",
          status: "completed",
          lastResult: {
            summary: "s",
            error: null,
            outcome: { outcome, openQuestions, ...(size ? { size } : {}) },
          },
          createdAt: ago(100),
          updatedAt: ago(90),
        })
        .returning();
      ids[name] = row!.id;
      await job(`${name}Job`, { type: "triage.run", triageRunId: row!.id, finishedAt: ago(90) });
    };
    await triage("prd", "prd", "triage-prd", [], "XL");
    // A ready PRD whose outcome has no size.
    await triage("prdNoSize", "reformat");
    await triage("prdStarted", "reformat", "issue-prdRun");
    await ralphRun("prdRun", { createdAt: ago(80) });
    await triage("unchanged", "unchanged");
    await triage("prdQuestions", "prd", "triage-prdQuestions", ["Which team owns it?"]);

    // ── Problems ──
    await ralphRun("failed", { status: "failed", mode: "request", error: "The agent crashed." });
    await job("failedAttempt1", {
      ralphRunId: ids.failed,
      type: "ralph.request",
      status: "failed",
      createdAt: ago(50),
    });
    await job("failedAttempt2", {
      ralphRunId: ids.failed,
      type: "ralph.request",
      status: "failed",
      createdAt: ago(40),
    });
    await ralphRun("failedOld", {
      status: "failed",
      createdAt: ago(30 * DAY),
      updatedAt: ago(20 * DAY),
    });
    const [failedReview] = await db
      .insert(reviewRuns)
      .values({
        organizationId: acme,
        repositoryId: repo,
        prNumber: 50,
        headSha: "x",
        baseSha: "b",
        trigger: "webhook",
        mode: "full",
        status: "failed",
        error: "Budget exhausted",
        updatedAt: ago(6),
      })
      .returning();
    ids.failedReview = failedReview!.id;
    await job("syncFailed", {
      type: "repo.sync",
      status: "failed",
      error: "git fetch failed",
      repositoryId: repo,
      finishedAt: ago(9),
    });
    await job("syncDone", { type: "repo.sync", status: "completed", repositoryId: repo });
    await job("installOld", {
      type: "install",
      status: "failed",
      createdAt: ago(16 * DAY),
      finishedAt: ago(16 * DAY),
    });
    await job("storyFailed", { type: "ralph.story", status: "failed", ralphRunId: ids.cleanup });
    const agent = async (name: string, values: Partial<typeof agents.$inferInsert>) => {
      const [row] = await db
        .insert(agents)
        .values({ organizationId: acme, name, ...values })
        .returning();
      ids[name] = row!.id;
    };
    await agent("offline", { lastHeartbeatAt: ago(10) });
    await agent("online", { lastHeartbeatAt: new Date(now.getTime() - 5_000) });
    await agent("revoked", { lastHeartbeatAt: ago(10), revokedAt: ago(5) });
    await agent("neverSeen", {});
    await agent("updateError", {
      lastHeartbeatAt: now,
      updateState: {
        state: "idle",
        version: "1.4.0",
        previous: "1.3.0",
        startsSincePending: 0,
        error: "npm install failed",
      },
    });
    await agent("desiredFailed", { lastHeartbeatAt: now, failedVersions: ["2.0.0"] });
    await agent("desiredOk", { lastHeartbeatAt: now, failedVersions: ["1.0.0"] });
    await db
      .insert(appSettings)
      .values({ organizationId: acme, key: "agent.desiredVersion", value: "2.0.0" });
    await db.update(agents).set({ desiredVersion: "2.1.0" }).where(eq(agents.id, ids.desiredOk!));

    // ── Running ──
    const [runningTriage] = await db
      .insert(triageRuns)
      .values({
        organizationId: acme,
        linearIssueId: "triage-running",
        linearAgentSessionId: "triage-running",
        trigger: "mention",
        status: "running",
      })
      .returning();
    ids.runningTriage = runningTriage!.id;
    await job("runningTriageJob", {
      type: "triage.run",
      triageRunId: runningTriage!.id,
      status: "running",
      finishedAt: null,
    });
    await db.insert(runPermissionRequests).values({
      jobId: ids.runningTriageJob!,
      requestId: "perm-1",
      tool: "WebFetch",
      askedAt: ago(2),
      expiresAt: new Date(now.getTime() + 600_000),
    });
    await db.insert(triageRuns).values({
      organizationId: acme,
      linearIssueId: "triage-old",
      linearAgentSessionId: "triage-old",
      trigger: "mention",
      status: "queued",
      createdAt: ago(15 * DAY),
    });

    // ── Another organization ──
    await db.insert(ralphRuns).values({
      organizationId: beta,
      linearIssueId: "beta-issue",
      linearIdentifier: "BETA-1",
      linearAgentSessionId: "beta-session",
      kind: "single",
      status: "failed",
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("derives every item kind, and none for the neighbors", async () => {
    const items = await list();
    // Timestamps in keys are when something happened: stable, but not worth spelling out.
    expect(
      keysOf(items)
        .map((k) => k.replace(/:\d{4}-\d\d-\d\dT[\d:.]+Z$/, ":<at>"))
        .sort(),
    ).toEqual(
      [
        `manual_story:${ids.manualStory}`,
        `blocked:${ids.waiting}:blocker-1,blocker-2`,
        `question:${ids.waiting}:preparation:<at>`,
        `question:${ids.running}:permission:<at>`,
        `question:${ids.noRepo}:repository:<at>`,
        `question:${ids.cleanup}:cleanup:<at>`,
        `question:${ids.runningTriage}:permission:<at>`,
        `stopped:${ids.stopped}:<at>`,
        `prd_ready:${ids.prd}:${ids.prdJob}`,
        `prd_ready:${ids.prdNoSize}:${ids.prdNoSizeJob}`,
        `pr:${ids.prReadyLane}:approved`,
        `failed:${ids.failed}:${ids.failedAttempt2}`,
        `failed:${ids.failedReview}:none`,
        `failed_attempt:${ids.syncFailed}`,
        `agent_offline:${ids.offline}:<at>`,
        `agent_update:${ids.updateError}:1.4.0`,
        `agent_update:${ids.desiredFailed}:2.0.0`,
        `running:${ids.running}`,
        `running:${ids.runningTriage}`,
      ].sort(),
    );
    const byKind = new Map(items.map((i) => [i.facts.kind + ":" + (i.run?.id ?? ""), i]));
    expect(items.every((i) => i.organizationId === acme)).toBe(true);
    const pr = items.find((i) => i.facts.kind === "pr_waiting")!;
    expect(pr).toMatchObject({
      tab: "needs_you",
      run: { id: ids.prReady, kind: "epic" },
      facts: {
        lane: { prNumber: 42, reviewState: "approved", repositoryId: repo },
        review: {
          runId: ids.prReview,
          status: "completed",
          openFindings: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
        },
      },
    });
    expect(byKind.get(`stopped_epic:${ids.stopped}`)?.run).toEqual({
      id: ids.stopped,
      kind: "request",
    });
    expect(byKind.get(`prd_ready:${ids.prd}`)?.facts).toEqual({
      kind: "prd_ready",
      jobId: ids.prdJob,
      outcome: "prd",
      size: "XL",
    });
    expect(byKind.get(`prd_ready:${ids.prdNoSize}`)?.facts).toMatchObject({
      outcome: "reformat",
      size: null,
    });
    const failedRun = items.find((i) => i.key.startsWith(`failed:${ids.failed}`))!;
    expect(failedRun.facts).toEqual({
      kind: "failed_run",
      lastAttemptId: ids.failedAttempt2,
      error: "The agent crashed.",
    });
    const triagePermission = items.find((i) => i.key.startsWith(`question:${ids.runningTriage}`))!;
    expect(triagePermission.run).toEqual({ id: ids.runningTriage, kind: "triage" });
    expect(triagePermission.facts).toMatchObject({
      question: { kind: "permission", tool: "WebFetch" },
    });
    // Newest first.
    const times = items.map((i) => i.since.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("lists one run's open questions with the Inbox's keys and what their answers need", async () => {
    const items = await list();
    const inboxKey = (runId: string) =>
      items.find((i) => i.key.startsWith(`question:${runId}:`))!.key;

    const [repository] = await listRunQuestions(
      db,
      { id: ids.noRepo!, kind: "epic", organizationId: acme },
      now,
    );
    expect(repository).toMatchObject({
      key: inboxKey(ids.noRepo!),
      facts: {
        question: { kind: "repository", subject: { kind: "repository", repositoryIds: [repo] } },
      },
    });
    const references = await loadInboxReferences(db, [repository!]);
    expect(references.repositories.get(repo)).toMatchObject({ id: repo });

    expect(
      await listRunQuestions(db, { id: ids.cleanup!, kind: "epic", organizationId: acme }, now),
    ).toEqual([
      expect.objectContaining({
        key: inboxKey(ids.cleanup!),
        facts: expect.objectContaining({
          question: expect.objectContaining({
            subject: {
              kind: "cleanup",
              laneId: expect.any(String),
              branch: "omniralph/cleanup",
              question: "stashes",
              count: 1,
            },
          }),
        }),
      }),
    ]);

    const [triage] = await listRunQuestions(
      db,
      { id: ids.runningTriage!, kind: "triage", organizationId: acme },
      now,
    );
    expect(triage).toMatchObject({
      key: inboxKey(ids.runningTriage!),
      facts: {
        question: {
          kind: "permission",
          tool: "WebFetch",
          subject: { kind: "permission", stored: true },
        },
      },
    });
    expect(
      await listRunQuestions(db, { id: ids.stopped!, kind: "request", organizationId: acme }, now),
    ).toEqual([]);

    // Without the Inbox's 14-day window: a run waiting on its question for three weeks still asks.
    const old = await ralphRun("oldQuestion", {
      status: "waiting",
      repositoryId: null,
      pendingElicitation: { kind: "repository", repositoryIds: [repo] },
      createdAt: ago(21 * DAY),
      updatedAt: ago(21 * DAY),
    });
    try {
      expect((await list()).some((i) => i.key.startsWith(`question:${old}:`))).toBe(false);
      expect(
        await listRunQuestions(db, { id: old, kind: "epic", organizationId: acme }, now),
      ).toHaveLength(1);
      // Not another organization's run.
      expect(
        await listRunQuestions(db, { id: old, kind: "epic", organizationId: beta }, now),
      ).toEqual([]);
    } finally {
      await db.delete(ralphRuns).where(eq(ralphRuns.id, old));
    }
  });

  it("filters by tab", async () => {
    const running = await listInboxItems(db, {
      organizationIds: [acme],
      userId: alice,
      tab: "running",
      onlineWindowMs: ONLINE_WINDOW_MS,
      now,
    });
    expect(running.map((i) => i.tab)).toEqual(["running", "running"]);
    expect(running.every((i) => i.facts.kind === "run")).toBe(true);
  });

  it("spans only the organizations asked for", async () => {
    expect(await list(alice, [beta])).toEqual([
      expect.objectContaining({ organizationId: beta, tab: "problems" }),
    ]);
    expect(await list(alice, [])).toEqual([]);
    expect((await list(alice, [acme, beta])).length).toBe((await list()).length + 1);
  });

  it("hides Done and snoozed items for that user only, and a new failure shows again", async () => {
    const failedKey = `failed:${ids.failed}:${ids.failedAttempt2}`;
    const prKey = `pr:${ids.prReadyLane}:approved`;
    const syncKey = `failed_attempt:${ids.syncFailed}`;
    await db.insert(inboxItemStates).values([
      { userId: alice, organizationId: acme, itemKey: failedKey, state: "done" },
      {
        userId: alice,
        organizationId: acme,
        itemKey: prKey,
        state: "snoozed",
        snoozedUntil: new Date(now.getTime() + 3_600_000),
      },
      // Snoozed until a time that has passed: shown again.
      {
        userId: alice,
        organizationId: acme,
        itemKey: syncKey,
        state: "snoozed",
        snoozedUntil: ago(1),
      },
    ]);
    const keys = keysOf(await list(alice));
    expect(keys).not.toContain(failedKey);
    expect(keys).not.toContain(prKey);
    expect(keys).toContain(syncKey);
    // Bob still sees them.
    expect(keysOf(await list(bob))).toEqual(expect.arrayContaining([failedKey, prKey, syncKey]));

    // The run fails again: a new key, so it shows up for Alice again.
    await job("failedAttempt3", {
      ralphRunId: ids.failed,
      type: "ralph.request",
      status: "failed",
      createdAt: ago(1),
    });
    expect(keysOf(await list(alice))).toContain(`failed:${ids.failed}:${ids.failedAttempt3}`);
    // A review state change is new too.
    await db
      .update(ralphLanes)
      .set({ prReviewState: "changes_requested" })
      .where(eq(ralphLanes.id, ids.prReadyLane!));
    expect(keysOf(await list(alice))).toContain(`pr:${ids.prReadyLane}:changes_requested`);
  });

  it("counts what the feeds list", async () => {
    const counts = await countInboxItems(db, {
      organizationIds: [acme],
      userId: alice,
      onlineWindowMs: ONLINE_WINDOW_MS,
      now,
    });
    const items = await list(alice);
    expect(counts).toEqual({
      needs_you: items.filter((i) => i.tab === "needs_you").length,
      problems: items.filter((i) => i.tab === "problems").length,
      running: items.filter((i) => i.tab === "running").length,
    });
  });

  it("counts with a fixed number of queries whatever the number of runs", async () => {
    const count = async () => {
      let queries = 0;
      const counted = new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "execute" || prop === "select") {
            return (...args: unknown[]) => {
              queries += 1;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        },
      });
      await countInboxItems(counted, {
        organizationIds: [acme],
        userId: alice,
        onlineWindowMs: ONLINE_WINDOW_MS,
        now,
      });
      return queries;
    };
    const before = await count();
    for (let i = 0; i < 20; i++) {
      await ralphRun(`more${i}`, { status: i % 2 ? "failed" : "stopped", mode: "request" });
    }
    expect(await count()).toBe(before);
  });

  describe("one item and the user's state of it", () => {
    const find = (key: string, organizationIds = [acme]) =>
      findInboxItem(db, { organizationIds, key, onlineWindowMs: ONLINE_WINDOW_MS, now });

    it("finds an item by key whatever the user marked, in the organizations asked for", async () => {
      const items = await list(bob);
      expect(items.length).toBeGreaterThan(3);
      for (const item of items) expect(await find(item.key)).toEqual(item);
      const failedKey = `failed:${ids.failed}:${ids.failedAttempt2}`;
      // Alice marked it Done, and the run failed again since: it is a new key now.
      expect(await find(failedKey)).toBeNull();
      const [first] = items;
      expect(await find(first!.key, [beta])).toBeNull();
      for (const key of ["", "nonsense", "constructor:x", `manual_story:${randomUUID()}`]) {
        expect(await find(key)).toBeNull();
      }
    });

    it("marks Done, snoozes and restores for one user, recording an inbox_state change for them", async () => {
      const [item] = await list(bob);
      const key = { userId: bob, organizationId: acme, key: item!.key };
      const { changes } = await captureChanges(() =>
        setInboxItemState(db, { ...key, state: "done", snoozedUntil: null }),
      );
      expect(changes).toEqual([
        expect.objectContaining({
          resource: "inbox_state",
          ids: [item!.key],
          organizationId: acme,
          userId: bob,
        }),
      ]);
      expect(keysOf(await list(bob))).not.toContain(item!.key);
      expect(keysOf(await list(alice))).toContain(item!.key);
      // Snoozing replaces Done (and ignores a `snoozedUntil` given for Done).
      await setInboxItemState(db, {
        ...key,
        state: "snoozed",
        snoozedUntil: new Date(now.getTime() + 3_600_000),
      });
      const rows = await db
        .select()
        .from(inboxItemStates)
        .where(eq(inboxItemStates.itemKey, item!.key));
      expect(rows).toEqual([expect.objectContaining({ userId: bob, state: "snoozed" })]);
      expect(keysOf(await list(bob))).not.toContain(item!.key);
      expect((await captureChanges(() => clearInboxItemState(db, key))).changes).toEqual([
        expect.objectContaining({ resource: "inbox_state", userId: bob }),
      ]);
      expect(keysOf(await list(bob))).toContain(item!.key);
    });

    it("prunes states not updated for 60 days", async () => {
      await db.delete(inboxItemStates);
      const at = (days: number) => new Date(now.getTime() - days * 86_400_000);
      await db.insert(inboxItemStates).values([
        { userId: alice, organizationId: acme, itemKey: "old:1", state: "done", updatedAt: at(61) },
        {
          userId: bob,
          organizationId: acme,
          itemKey: "old:2",
          state: "snoozed",
          snoozedUntil: at(-1),
          updatedAt: at(60.5),
        },
        { userId: alice, organizationId: acme, itemKey: "new:1", state: "done", updatedAt: at(59) },
      ]);
      expect(INBOX_ITEM_STATE_RETENTION_DAYS).toBe(60);
      expect(await pruneInboxItemStates(db, now)).toBe(2);
      expect((await db.select().from(inboxItemStates)).map((r) => r.itemKey)).toEqual(["new:1"]);
    });
  });
});
