import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setAllowedTaskTypeDefaults } from "./app-settings.js";
import { ensureChatThread, listThreadRuns, saveChatConnection } from "./chat.js";
import { closeDb, createDb, type Database } from "./client.js";
import {
  listHiddenRefsToDelete,
  listRunHiddenRefs,
  markHiddenRefsDeleted,
  recordHiddenRef,
} from "./hidden-refs.js";
import { insertJob } from "./jobs.js";
import { runMigrations } from "./migrate.js";
import {
  appendGuidance,
  appendProgress,
  createRun,
  getRun,
  getActiveRunByChatThread,
  getActiveRunOfSameOrigin,
  getRunByChatThread,
  getRunByIssue,
  getRunBySession,
  isLinearRun,
  linearSessionOf,
  listActiveRunJobIds,
  runReference,
  listRunsAffectedByIssue,
  listRunsToReconcile,
  getRunDetail,
  listRalphRepositories,
  listRalphRunRepositories,
  listRuns,
  listStories,
  lockRun,
  updateRepositoryRalphSettings,
  updateRun,
  updateStory,
  upsertStories,
  copyLanes,
  ensureLane,
  getLane,
  getLaneByRepository,
  getMainLane,
  insertMessage,
  listLanes,
  listLanesToCleanUp,
  listMessages,
  listOpenPullRequestLanes,
  moveToRepository,
  updateLane,
  updateMessage,
  RUN_DETAIL_MESSAGE_LIMIT,
  type NewChatRalphRunInput,
  type RalphRun,
  type NewLinearRalphRunInput,
} from "./ralph.js";
import {
  connectRepository,
  disconnectRepository,
  getRepository,
  upsertScmConnection,
} from "./repositories.js";
import {
  harnesses,
  hiddenRefs,
  chatConnections,
  DEFAULT_RALPH_SETTINGS,
  jobs,
  ralphMessages,
  ralphRuns,
  organizations,
  repositories,
} from "./schema.js";
import { seedReviewProfiles } from "./settings.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("ralph queries", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;
  let harnessId: string;
  let session = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
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
      key,
    ))!;
    repoA = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/b-api",
      })
    ).id;
    repoB = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/a-web",
      })
    ).id;
    [{ id: harnessId }] = (await db
      .insert(harnesses)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning({ id: harnesses.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
  });

  const runInput = (overrides: Partial<NewLinearRalphRunInput> = {}): NewLinearRalphRunInput => {
    session += 1;
    return {
      organizationId: orgId,
      linearIssueId: `issue-${session}`,
      linearIdentifier: `TOOL-${session}`,
      linearAgentSessionId: `session-${session}`,
      kind: "children",
      repositoryId: repoA,
      branch: `steve/tool-${session}`,
      baseBranch: "main",
      ...overrides,
    };
  };

  it("records hidden refs from story outcomes and selects ended or old ones for deletion", async () => {
    const sha = (n: number) => String(n).repeat(40).slice(0, 40);
    const at = (status: RalphRun["status"]) => async () => {
      const { run } = await createRun(db, runInput());
      return (await updateRun(db, run.id, { status }))!;
    };
    const completed = await at("completed")();
    const ref = `refs/omniralph/runs/${completed.id}`;
    await recordHiddenRef(db, { repositoryId: repoA, runId: completed.id, ref, sha: sha(1) });
    // A later story's push moves it; the same ref in another repository is its own row.
    await recordHiddenRef(db, { repositoryId: repoA, runId: completed.id, ref, sha: sha(2) });
    await recordHiddenRef(db, { repositoryId: repoB, runId: completed.id, ref, sha: sha(3) });
    expect(
      (await listRunHiddenRefs(db, completed.id)).map((r) => [r.repositoryId, r.ref, r.sha]),
    ).toEqual([
      [repoA, ref, sha(2)],
      [repoB, ref, sha(3)],
    ]);

    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const refOf = async (status: RalphRun["status"], createdAt = new Date()) => {
      const run = await at(status)();
      const row = await recordHiddenRef(db, {
        repositoryId: repoA,
        runId: run.id,
        ref: `refs/omniralph/runs/${run.id}`,
        sha: sha(4),
      });
      await db.update(hiddenRefs).set({ createdAt }).where(eq(hiddenRefs.id, row.id));
      return row.id;
    };
    const failed = await refOf("failed");
    const oldStopped = await refOf("stopped", old);
    const oldPending = await refOf("pending", old);
    await refOf("stopped");
    await refOf("waiting");
    await refOf("running", old);
    const selected = (await listHiddenRefsToDelete(db, cutoff)).map((r) => r.hiddenRef.id);
    const completedIds = (await listRunHiddenRefs(db, completed.id)).map((r) => r.id);
    expect(selected.sort()).toEqual([...completedIds, failed, oldStopped, oldPending].sort());
    // A resumed run that pushes its old ref again restarts its age.
    const [pending] = await db.select().from(hiddenRefs).where(eq(hiddenRefs.id, oldPending));
    await recordHiddenRef(db, {
      repositoryId: repoA,
      runId: pending!.runId,
      ref: pending!.ref,
      sha: sha(5),
    });
    expect((await listHiddenRefsToDelete(db, cutoff)).map((r) => r.hiddenRef.id).sort()).toEqual(
      [...completedIds, failed, oldStopped].sort(),
    );
    expect(
      (await listHiddenRefsToDelete(db, cutoff)).find((r) => r.hiddenRef.id === failed)?.run.id,
    ).toBeDefined();

    // Marked deleted per repository: only the listed refs there.
    expect(await markHiddenRefsDeleted(db, repoA, [ref])).toBe(1);
    expect(await markHiddenRefsDeleted(db, repoA, [ref])).toBe(0);
    expect((await listRunHiddenRefs(db, completed.id)).map((r) => r.repositoryId)).toEqual([repoB]);
    expect((await listHiddenRefsToDelete(db, cutoff)).map((r) => r.hiddenRef.id)).not.toContain(
      completedIds[0],
    );
    // Pushed again (a resumed run): live again.
    await recordHiddenRef(db, { repositoryId: repoA, runId: completed.id, ref, sha: sha(5) });
    expect((await listRunHiddenRefs(db, completed.id)).map((r) => r.repositoryId).sort()).toEqual(
      [repoA, repoB].sort(),
    );
  });

  it("adds ralph settings and Linear routing to repositories, with defaults", async () => {
    expect(await getRepository(db, repoA)).toMatchObject({
      ralphEnabled: null,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    // Inheriting: coding is on while the organization allows it (the built-in default), by path.
    expect((await listRalphRepositories(db, orgId)).map((r) => [r.id, r.effective.coding])).toEqual(
      [
        [repoB, true],
        [repoA, true],
      ],
    );
    await setAllowedTaskTypeDefaults(db, orgId, ["query", "review"], null);
    expect(await listRalphRepositories(db, orgId)).toEqual([]);

    const settings = {
      ...DEFAULT_RALPH_SETTINGS,
      verifyCommands: ["pnpm test"],
      epicCompletedState: "In Review",
      openPullRequestEarly: true,
      setupCommand: "pnpm install",
      model: "sonnet",
      manualLabels: ["by hand"],
    };
    for (const id of [repoA, repoB]) {
      expect(
        await updateRepositoryRalphSettings(db, id, {
          ralphEnabled: true,
          linearTeamKeys: ["TOOL"],
          linearProjectNames: ["Omniralph"],
          linearLabels: ["backend"],
          ralphSettings: settings,
        }),
      ).toMatchObject({ ralphEnabled: true, linearTeamKeys: ["TOOL"], ralphSettings: settings });
    }
    // An explicit true wins over the organization's default; by path.
    expect((await listRalphRepositories(db, orgId)).map((r) => r.fullPath)).toEqual([
      "acme/a-web",
      "acme/b-api",
    ]);
    await setAllowedTaskTypeDefaults(db, orgId, null, null);
    // An explicit false wins when the organization allows coding.
    await db.update(repositories).set({ ralphEnabled: false }).where(eq(repositories.id, repoB));
    expect((await listRalphRepositories(db, orgId)).map((r) => r.id)).toEqual([repoA]);
    await db.update(repositories).set({ ralphEnabled: true }).where(eq(repositories.id, repoB));

    await disconnectRepository(db, orgId, repoB);
    expect((await listRalphRepositories(db, orgId)).map((r) => r.id)).toEqual([repoA]);
    expect(
      await updateRepositoryRalphSettings(db, repoB, {
        ralphEnabled: true,
        linearTeamKeys: [],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: DEFAULT_RALPH_SETTINGS,
      }),
    ).toBeNull();
    await connectRepository(db, {
      connectionId: (await getRepository(db, repoB))!.connectionId,
      provider: "github",
      externalId: "2",
      fullPath: "acme/a-web",
    });
  });

  it("creates a run and finds it by id, session or issue", async () => {
    const input = runInput({ kind: "prd", focusStoryId: "story-issue" });
    const { run, created } = await createRun(db, input);
    expect(created).toBe(true);
    const { branch, baseBranch, ...columns } = input;
    expect(run).toMatchObject({
      ...columns,
      status: "pending",
      harnessId: null,
      guidance: [],
      ignoreBlockers: false,
      progress: "",
      waitingOn: null,
      iterations: 0,
    });
    expect(await getRun(db, run.id)).toEqual(run);
    expect(await getRunBySession(db, input.linearAgentSessionId)).toEqual(run);
    expect(await getRunByIssue(db, orgId, input.linearIssueId)).toEqual(run);
    expect(await getRunBySession(db, "unknown")).toBeNull();
    expect(await getRunByIssue(db, orgId, "unknown")).toBeNull();
    // The branches are the main lane's.
    expect(await getMainLane(db, run)).toMatchObject({ repositoryId: repoA, branch, baseBranch });
  });

  it("returns the existing run for the same session, or an unfinished run of the same issue", async () => {
    const input = runInput();
    const first = await createRun(db, input);
    expect(await createRun(db, input)).toEqual({ run: first.run, created: false });

    // A second session on the same issue while the first run is unfinished.
    const other = { ...input, linearAgentSessionId: "session-other" };
    expect(await createRun(db, other)).toEqual({ run: first.run, created: false });

    // Once it finished, the issue can be delegated again; the latest run wins.
    await updateRun(db, first.run.id, { status: "completed" });
    const second = await createRun(db, other);
    expect(second.created).toBe(true);
    expect((await getRunByIssue(db, orgId, input.linearIssueId))?.id).toBe(second.run.id);
    expect((await getRunByIssue(db, orgId, input.linearIssueId, { activeOnly: true }))?.id).toBe(
      second.run.id,
    );
    await updateRun(db, second.run.id, { status: "stopped" });
    expect(await getRunByIssue(db, orgId, input.linearIssueId, { activeOnly: true })).toBeNull();

    // Concurrent creates make one run.
    const racing = runInput();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createRun(db, { ...racing, linearAgentSessionId: `race-${session}-${i}` }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
  });

  describe("chat runs", () => {
    let thread = 0;
    /** A new Slack thread (of a new connection) of the organization. */
    async function newThread(): Promise<{ id: string; connectionId: string }> {
      thread += 1;
      const connection = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "slack",
        externalId: `T${thread}`,
        name: `Acme ${thread}`,
        credentials: null,
        installedByUserId: null,
      });
      if (connection === "other_organization") throw new Error("connected elsewhere");
      const row = await ensureChatThread(db, {
        connectionId: connection.id,
        externalThreadId: `slack:C${thread}:1.${thread}`,
        channelId: `slack:C${thread}`,
        startedByExternalUserId: "U1",
      });
      return { id: row!.id, connectionId: connection.id };
    }
    /** The constraint a failed write violated (null: it worked). */
    const violated = (write: PromiseLike<unknown>) =>
      Promise.resolve(write).then(
        () => null,
        (error: { cause?: { constraint?: string } }) => error.cause?.constraint ?? "unknown",
      );
    const chatInput = (
      chatThreadId: string,
      overrides: Partial<NewChatRalphRunInput> = {},
    ): NewChatRalphRunInput => ({
      origin: "chat",
      organizationId: orgId,
      chatThreadId,
      repositoryId: repoA,
      branch: `omniralph/chat-${chatThreadId.slice(0, 8)}`,
      baseBranch: "main",
      ...overrides,
    });

    it("creates a request-mode run without Linear fields and finds it by thread", async () => {
      const { id: threadId } = await newThread();
      const { run, created } = await createRun(db, chatInput(threadId));
      expect(created).toBe(true);
      expect(run).toMatchObject({
        origin: "chat",
        chatThreadId: threadId,
        mode: "request",
        kind: "single",
        linearIssueId: null,
        linearIdentifier: null,
        linearAgentSessionId: null,
        status: "pending",
      });
      expect(await getMainLane(db, run)).toMatchObject({ repositoryId: repoA, baseBranch: "main" });
      // The thread's coding run, which finds it.
      expect(await listThreadRuns(db, orgId, threadId)).toMatchObject([
        { kind: "coding", ralphRunId: run.id, jobId: null },
      ]);
      expect(await getRunByChatThread(db, threadId)).toEqual(run);
      expect(await getActiveRunByChatThread(db, threadId)).toEqual(run);
      expect(await getActiveRunOfSameOrigin(db, run)).toEqual(run);
      expect(isLinearRun(run)).toBe(false);
      expect(linearSessionOf(run)).toBeNull();
      expect(runReference(run)).toBe(`chat-${run.id.slice(0, 8)}`);

      // A Linear run is one.
      const linear = (await createRun(db, runInput())).run;
      expect(isLinearRun(linear)).toBe(true);
      expect(linearSessionOf(linear)).toBe(linear.linearAgentSessionId);
      expect(runReference(linear)).toBe(linear.linearIdentifier);
      expect(linear.origin).toBe("linear");
      expect(await getActiveRunOfSameOrigin(db, linear)).toEqual(linear);
    });

    it("allows one unfinished run per thread, alongside Linear runs", async () => {
      const { id: threadId } = await newThread();
      const { id: otherThreadId } = await newThread();
      const first = await createRun(db, chatInput(threadId));
      expect(await createRun(db, chatInput(threadId))).toEqual({ run: first.run, created: false });
      // Another thread, and a Linear run, don't collide with it.
      expect((await createRun(db, chatInput(otherThreadId))).created).toBe(true);
      expect((await createRun(db, runInput())).created).toBe(true);
      // The index itself refuses a second unfinished run of the thread.
      expect(
        await violated(
          db.insert(ralphRuns).values({
            organizationId: orgId,
            origin: "chat",
            chatThreadId: threadId,
            kind: "single",
            mode: "request",
            repositoryId: repoA,
          }),
        ),
      ).toBe("ralph_runs_chat_thread_active_uq");

      // Once it finished, the thread can start another; the latest run wins.
      await updateRun(db, first.run.id, { status: "completed" });
      expect(await getActiveRunByChatThread(db, threadId)).toBeNull();
      expect(await getActiveRunOfSameOrigin(db, first.run)).toBeNull();
      const second = await createRun(db, chatInput(threadId));
      expect(second.created).toBe(true);
      expect((await getRunByChatThread(db, threadId))?.id).toBe(second.run.id);
      expect((await getRunByChatThread(db, threadId, { activeOnly: true }))?.id).toBe(
        second.run.id,
      );

      // Concurrent creates make one run.
      const { id: racingThreadId } = await newThread();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => createRun(db, chatInput(racingThreadId))),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    });

    it("keeps one unfinished Linear run per issue", async () => {
      const input = runInput();
      await createRun(db, input);
      expect(
        await violated(
          db.insert(ralphRuns).values({
            organizationId: orgId,
            linearIssueId: input.linearIssueId,
            linearIdentifier: input.linearIdentifier,
            linearAgentSessionId: "session-again",
            kind: "children",
            repositoryId: repoA,
          }),
        ),
      ).toBe("ralph_runs_issue_active_uq");
    });

    it("checks each origin's columns", async () => {
      const { id: threadId } = await newThread();
      const linear = {
        organizationId: orgId,
        linearIssueId: "issue-check",
        linearIdentifier: "TOOL-0",
        linearAgentSessionId: "session-check",
        kind: "children" as const,
        repositoryId: repoA,
      };
      // Linear runs need their issue, identifier and agent session.
      for (const missing of ["linearIssueId", "linearIdentifier", "linearAgentSessionId"]) {
        expect(await violated(db.insert(ralphRuns).values({ ...linear, [missing]: null }))).toBe(
          "ralph_runs_origin_check",
        );
      }
      // `linear` is the default origin.
      const [row] = await db.insert(ralphRuns).values(linear).returning();
      expect(row?.origin).toBe("linear");

      // Chat runs only do what they were asked.
      const chat = {
        organizationId: orgId,
        origin: "chat" as const,
        chatThreadId: threadId,
        kind: "single" as const,
        repositoryId: repoA,
      };
      expect(await violated(db.insert(ralphRuns).values({ ...chat, mode: "epic" }))).toBe(
        "ralph_runs_origin_check",
      );
      await expect(
        db
          .insert(ralphRuns)
          .values({ ...chat, mode: "request" })
          .returning(),
      ).resolves.toHaveLength(1);
    });

    it("keeps a chat run when its thread goes (e.g. the chat connection is removed)", async () => {
      const { id: threadId, connectionId } = await newThread();
      const { run } = await createRun(db, chatInput(threadId));
      await db.delete(chatConnections).where(eq(chatConnections.id, connectionId));
      expect(await getRun(db, run.id)).toMatchObject({ origin: "chat", chatThreadId: null });
      expect(await getActiveRunOfSameOrigin(db, { ...run, chatThreadId: null })).toBeNull();
    });

    it("lists and details a chat run with its thread's platform and channel", async () => {
      const { id: threadId } = await newThread();
      const { run } = await createRun(db, chatInput(threadId));
      const linear = (await createRun(db, runInput())).run;
      const { runs } = await listRuns(db, orgId);
      expect(runs.find((r) => r.id === run.id)).toMatchObject({
        origin: "chat",
        linearIdentifier: null,
        chatThread: {
          id: threadId,
          platform: "slack",
          channelId: expect.stringMatching(/^slack:C/),
        },
      });
      expect(runs.find((r) => r.id === linear.id)).toMatchObject({
        origin: "linear",
        chatThread: null,
      });
      expect((await getRunDetail(db, orgId, run.id))?.chatThread).toMatchObject({
        id: threadId,
        platform: "slack",
      });
      expect((await getRunDetail(db, orgId, linear.id))?.chatThread).toBeNull();
    });
  });

  it("updates a run's status and state", async () => {
    const { run } = await createRun(db, runInput());
    const waitingOn = {
      blockers: [{ id: "x", identifier: "EXT-1", title: "Upstream" }],
      manual: [],
    };
    const updated = await updateRun(db, run.id, {
      status: "waiting",
      waitingOn,
      harnessId,
      ignoreBlockers: true,
      pendingElicitation: { kind: "repository", repositoryIds: ["r"] },
      iterations: 2,
    });
    expect(updated).toMatchObject({
      status: "waiting",
      waitingOn,
      harnessId,
      iterations: 2,
    });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(run.updatedAt.getTime());
    expect(
      await updateRun(db, "00000000-0000-4000-8000-000000000000", { status: "failed" }),
    ).toBeNull();
  });

  it("appends guidance and progress atomically", async () => {
    const { run } = await createRun(db, runInput());
    const at = new Date("2026-10-06T10:00:00Z");
    await Promise.all(["one", "two", "three"].map((text) => appendGuidance(db, run.id, text, at)));
    const guidance = (await getRun(db, run.id))!.guidance;
    expect(guidance.map((g) => g.text).sort()).toEqual(["one", "three", "two"]);
    expect(guidance[0]!.at).toBe(at.toISOString());
    for (let i = 0; i < 12; i++) await appendGuidance(db, run.id, `g${i}`, at);
    expect((await getRun(db, run.id))!.guidance.map((g) => g.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `g${i + 2}`),
    );

    await appendProgress(db, run.id, "## TOOL-1\n- did it");
    await appendProgress(db, run.id, "---\n");
    await appendProgress(db, run.id, "## TOOL-2 'quoted' \\ backslash");
    expect((await getRun(db, run.id))!.progress).toBe(
      "## TOOL-1\n- did it\n---\n## TOOL-2 'quoted' \\ backslash",
    );
  });

  it("upserts stories, keeping their state and refreshing title and order", async () => {
    const { run } = await createRun(db, runInput());
    const stories = await upsertStories(db, run.id, [
      { linearIssueId: "i-1", identifier: "TOOL-1", title: "First" },
      { linearIssueId: "i-2", identifier: "TOOL-2", title: "Second" },
    ]);
    expect(stories.map((s) => [s.identifier, s.position, s.status, s.attempts])).toEqual([
      ["TOOL-1", 0, "pending", 0],
      ["TOOL-2", 1, "pending", 0],
    ]);

    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: run.id,
    });
    expect(job.ralphRunId).toBe(run.id);
    await updateStory(db, stories[0]!.id, {
      status: "completed",
      attempts: 2,
      commitSha: "a".repeat(40),
      lastFeedback: "gates failed",
      lastJobId: job.id,
    });

    const again = await upsertStories(db, run.id, [
      { linearIssueId: "i-3", identifier: "TOOL-3", title: "Third" },
      { linearIssueId: "i-1", identifier: "TOOL-1", title: "First (renamed)" },
      { linearIssueId: "i-2", identifier: "TOOL-2", title: "Second" },
    ]);
    expect(again.map((s) => s.identifier)).toEqual(["TOOL-3", "TOOL-1", "TOOL-2"]);
    expect(again[1]).toMatchObject({
      id: stories[0]!.id,
      title: "First (renamed)",
      status: "completed",
      attempts: 2,
      commitSha: "a".repeat(40),
      lastJobId: job.id,
    });
    expect(await upsertStories(db, run.id, [])).toHaveLength(3);
    expect(await listStories(db, "00000000-0000-4000-8000-000000000000")).toEqual([]);

    // Deleting the job clears the reference; deleting the run removes its stories and unlinks its jobs.
    await db.delete(ralphRuns).where(eq(ralphRuns.id, run.id));
    expect(await listStories(db, run.id)).toEqual([]);
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]!.ralphRunId).toBeNull();
  });

  it("lists a run's queued and running jobs", async () => {
    const { run } = await createRun(db, runInput());
    const job = async (status: "queued" | "running" | "completed") => {
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "ralph.story",
        taskType: "coding",
        pool: "long",
        ralphRunId: run.id,
      });
      await db.update(jobs).set({ status }).where(eq(jobs.id, job.id));
      return job.id;
    };
    const queued = await job("queued");
    const running = await job("running");
    await job("completed");
    await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
    });
    expect(await listActiveRunJobIds(db, run.id)).toEqual([queued, running]);
  });

  it("finds the unfinished runs an issue change may move", async () => {
    const ref = (id: string) => ({ id, identifier: id, title: id });
    const { run: waiting } = await createRun(db, runInput());
    await updateRun(db, waiting.id, {
      status: "waiting",
      waitingOn: { blockers: [ref("ext-1")], manual: [ref("manual-1")] },
    });
    const { run: running } = await createRun(db, runInput());
    await updateRun(db, running.id, {
      status: "running",
      waitingOn: { blockers: [ref("ext-1")], manual: [] },
    });
    await upsertStories(db, running.id, [
      { linearIssueId: "story-1", identifier: "S-1", title: "s" },
    ]);
    const { run: done } = await createRun(db, runInput());
    await upsertStories(db, done.id, [{ linearIssueId: "story-1", identifier: "S-1", title: "s" }]);
    await updateRun(db, done.id, { status: "completed" });

    const ids = async (issue: string) =>
      (await listRunsAffectedByIssue(db, orgId, issue)).map((r) => r.id);
    expect(await ids("ext-1")).toEqual([waiting.id]);
    expect(await ids("manual-1")).toEqual([waiting.id]);
    expect(await ids("story-1")).toEqual([running.id]);
    expect(await ids("other")).toEqual([]);
  });

  it("lists waiting runs and stale runs without an active job to reconcile", async () => {
    const { run: waiting } = await createRun(db, runInput());
    await updateRun(db, waiting.id, { status: "waiting" });
    const { run: stale } = await createRun(db, runInput());
    await updateRun(db, stale.id, { status: "running" });
    const { run: busy } = await createRun(db, runInput());
    await updateRun(db, busy.id, { status: "running" });
    await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: busy.id,
    });
    const { run: finished } = await createRun(db, runInput());
    await updateRun(db, finished.id, { status: "failed" });

    const later = new Date(Date.now() + 60_000);
    const ids = (runs: { id: string }[]) => runs.map((r) => r.id).sort();
    expect(ids(await listRunsToReconcile(db, orgId, later))).toEqual([waiting.id, stale.id].sort());
    expect(ids(await listRunsToReconcile(db, orgId, new Date(0)))).toEqual([waiting.id]);
  });

  it("lockRun serializes changes to a run", async () => {
    const { run } = await createRun(db, runInput());
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const first = lockRun(db, run.id, async (tx, current) => {
      locked();
      order.push(`first saw ${current.iterations}`);
      await held;
      await updateRun(tx, run.id, { iterations: current.iterations + 1 });
      order.push("first done");
      return "first";
    });
    await isLocked;
    const second = lockRun(db, run.id, async (tx, current) => {
      order.push(`second saw ${current.iterations}`);
      await updateRun(tx, run.id, { iterations: current.iterations + 1 });
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(["first saw 0"]);
    release();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(order).toEqual(["first saw 0", "first done", "second saw 1"]);
    expect((await getRun(db, run.id))!.iterations).toBe(2);

    // A throwing callback rolls back.
    await expect(
      lockRun(db, run.id, async (tx) => {
        await updateRun(tx, run.id, { status: "failed" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await getRun(db, run.id))!.status).toBe("pending");

    let called = false;
    expect(
      await lockRun(db, "00000000-0000-4000-8000-000000000000", async () => {
        called = true;
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });

  it("lists runs newest first, paginated and filtered by status and repository", async () => {
    const a1 = (
      await createRun(
        db,
        runInput({ linearTitle: "Epic A", linearUrl: "https://linear.app/acme/issue/A-1" }),
      )
    ).run;
    const a2 = (await createRun(db, runInput())).run;
    const b1 = (await createRun(db, runInput({ repositoryId: repoB }))).run;
    await updateRun(db, a1.id, { status: "completed", harnessId });
    await updateLane(db, (await getMainLane(db, a1))!.id, {
      prNumber: 3,
      prUrl: "https://example.com/3",
    });
    await updateRun(db, b1.id, { status: "waiting" });
    // Distinct creation times for a stable order.
    for (const [i, id] of [a1.id, a2.id, b1.id].entries()) {
      await db
        .update(ralphRuns)
        .set({ createdAt: new Date(Date.UTC(2026, 9, 1 + i)) })
        .where(eq(ralphRuns.id, id));
    }
    const stories = await upsertStories(db, a1.id, [
      { linearIssueId: "x-1", identifier: "X-1", title: "One" },
      { linearIssueId: "x-2", identifier: "X-2", title: "Two" },
      { linearIssueId: "x-3", identifier: "X-3", title: "Three" },
    ]);
    await updateStory(db, stories[0]!.id, { status: "completed" });
    await updateStory(db, stories[1]!.id, { status: "completed" });

    const all = await listRuns(db, orgId);
    expect(all).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(all.runs.map((r) => r.id)).toEqual([b1.id, a2.id, a1.id]);
    expect(all.runs[2]).toMatchObject({
      linearIdentifier: a1.linearIdentifier,
      linearTitle: "Epic A",
      linearUrl: "https://linear.app/acme/issue/A-1",
      status: "completed",
      repository: { id: repoA, provider: "github", fullPath: "acme/b-api" },
      agent: { id: harnessId, name: "coder-1" },
      prNumber: 3,
      stories: { total: 3, completed: 2 },
    });
    expect(all.runs[1]).toMatchObject({ agent: null, stories: { total: 0, completed: 0 } });

    expect((await listRuns(db, orgId, { status: "waiting" })).runs.map((r) => r.id)).toEqual([
      b1.id,
    ]);
    expect(
      (await listRuns(db, orgId, { status: ["pending", "completed"] })).runs.map((r) => r.id),
    ).toEqual([a2.id, a1.id]);
    expect((await listRuns(db, orgId, { repositoryId: repoA })).total).toBe(2);
    expect(
      (await listRuns(db, orgId, { repositoryId: repoA, status: "pending" })).runs.map((r) => r.id),
    ).toEqual([a2.id]);

    const page2 = await listRuns(db, orgId, { page: 2, pageSize: 2 });
    expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page2.runs.map((r) => r.id)).toEqual([a1.id]);
    expect((await listRuns(db, orgId, { page: 9, pageSize: 2 })).runs).toEqual([]);
  });

  it("loads a run's detail: repository, agent, stories in order and jobs newest first", async () => {
    const run = (await createRun(db, runInput({ linearTitle: "Epic" }))).run;
    await updateRun(db, run.id, { harnessId, status: "running" });
    const stories = await upsertStories(db, run.id, [
      { linearIssueId: "d-1", identifier: "D-1", title: "One" },
      { linearIssueId: "d-2", identifier: "D-2", title: "Two" },
    ]);
    const { job: first } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: run.id,
    });
    const { job: second } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.describe-pr",
      taskType: "query",
      pool: "short",
      ralphRunId: run.id,
    });
    await db
      .update(jobs)
      .set({ createdAt: new Date(Date.UTC(2026, 9, 1)), status: "completed", harnessId })
      .where(eq(jobs.id, first.id));
    await updateStory(db, stories[0]!.id, { lastJobId: first.id, commitSha: "c".repeat(40) });
    // Another run's job isn't listed.
    const other = (await createRun(db, runInput())).run;
    await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: other.id,
    });

    const detail = await getRunDetail(db, orgId, run.id);
    expect(detail).toMatchObject({
      run: { id: run.id, status: "running", linearTitle: "Epic" },
      repository: { id: repoA, provider: "github", fullPath: "acme/b-api" },
      agent: { id: harnessId, name: "coder-1" },
    });
    expect(detail!.stories.map((s) => [s.identifier, s.commitSha, s.lastJobId])).toEqual([
      ["D-1", "c".repeat(40), first.id],
      ["D-2", null, null],
    ]);
    expect(detail!.jobs.map((j) => [j.id, j.type, j.status, j.agent?.name ?? null])).toEqual([
      [second.id, "ralph.describe-pr", "queued", null],
      [first.id, "ralph.story", "completed", "coder-1"],
    ]);

    expect(detail!.pendingRequests).toEqual([]);
    expect(detail!.messages).toEqual([]);

    expect(await getRunDetail(db, orgId, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("gives a run's detail its pending requests and its latest live messages", async () => {
    const { run } = await createRun(db, runInput());
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.request",
      taskType: "coding",
      pool: "long",
      ralphRunId: run.id,
    });
    const pending = await insertMessage(db, { runId: run.id, kind: "request", text: "Open a PR" });
    const consumed = await insertMessage(db, { runId: run.id, kind: "request", text: "Done" });
    await updateMessage(db, consumed.id, { consumedAt: new Date() });
    // One more live message than the page shows; the oldest is left out.
    const live: string[] = [];
    for (let i = 0; i <= RUN_DETAIL_MESSAGE_LIMIT; i++) {
      const message = await insertMessage(db, {
        runId: run.id,
        jobId: job.id,
        kind: "request",
        text: `live ${i}`,
        author: "Ada",
      });
      await db
        .update(ralphMessages)
        .set({ createdAt: new Date(Date.UTC(2026, 9, 6, 10, 0, i)) })
        .where(eq(ralphMessages.id, message.id));
      live.push(message.id);
    }
    // Another run's message isn't listed.
    const other = (await createRun(db, runInput())).run;
    await insertMessage(db, { runId: other.id, kind: "request", text: "elsewhere" });

    const detail = (await getRunDetail(db, orgId, run.id))!;
    expect(detail.pendingRequests.map((m) => m.id)).toEqual([pending.id]);
    expect(detail.messages).toHaveLength(RUN_DETAIL_MESSAGE_LIMIT);
    expect(detail.messages.map((m) => m.id)).toEqual(live.slice(1).reverse());
    expect(detail.messages[0]).toMatchObject({
      text: `live ${RUN_DETAIL_MESSAGE_LIMIT}`,
      author: "Ada",
      job: { id: job.id, type: "ralph.request", status: "queued" },
    });
  });

  describe("lanes", () => {
    it("gives a run with a repository its main lane, and other repositories a lane each", async () => {
      const { run } = await createRun(db, runInput({ branch: "eng-1", baseBranch: "develop" }));
      const main = await getMainLane(db, run);
      expect(main).toMatchObject({
        runId: run.id,
        repositoryId: repoA,
        branch: "eng-1",
        baseBranch: "develop",
        prNumber: null,
        prClosed: false,
        reviewRounds: 0,
        handledReviewIds: [],
        ciFixRounds: 0,
        handledCiShas: [],
        stashes: [],
        cleanup: null,
      });

      const web = await ensureLane(db, {
        runId: run.id,
        repositoryId: repoB,
        branch: "eng-1",
        baseBranch: "main",
      });
      // Ensuring it again returns the lane as it is.
      expect(
        await ensureLane(db, { runId: run.id, repositoryId: repoB, branch: "x", baseBranch: "y" }),
      ).toEqual(web);
      expect(await getLaneByRepository(db, run.id, repoB)).toEqual(web);
      expect((await listLanes(db, run.id)).map((l) => l.id)).toEqual([main!.id, web.id]);

      const updated = await updateLane(db, web.id, {
        prNumber: 8,
        prUrl: "https://github.com/acme/a-web/pull/8",
        handledReviewIds: ["r1"],
        stashes: [{ sha: "s".repeat(40), storyId: "ENG-3", at: "2026-10-06T00:00:00.000Z" }],
      });
      expect(updated).toMatchObject({ prNumber: 8, handledReviewIds: ["r1"] });
      expect(await getLane(db, web.id)).toEqual(updated);

      // Stories record their lane (and why one is manual) on every upsert.
      const stories = await upsertStories(db, run.id, [
        { linearIssueId: "l-1", identifier: "L-1", title: "Api", laneId: main!.id },
        { linearIssueId: "l-2", identifier: "L-2", title: "Web", laneId: web.id },
        {
          linearIssueId: "l-3",
          identifier: "L-3",
          title: "Docs",
          elsewhere: "it's in project Docs",
        },
      ]);
      expect(stories.map((s) => [s.identifier, s.laneId, s.elsewhere])).toEqual([
        ["L-1", main!.id, null],
        ["L-2", web.id, null],
        ["L-3", null, "it's in project Docs"],
      ]);

      const detail = await getRunDetail(db, orgId, run.id);
      expect(detail!.lanes.map((l) => [l.repository.fullPath, l.main, l.lane.prNumber])).toEqual([
        ["acme/b-api", true, null],
        ["acme/a-web", false, 8],
      ]);
      expect((await listRuns(db, orgId)).runs[0]).toMatchObject({
        branch: "eng-1",
        baseBranch: "develop",
      });
    });

    it("has no lane without a repository", async () => {
      const { run } = await createRun(db, runInput({ repositoryId: null, status: "waiting" }));
      expect(await getMainLane(db, run)).toBeNull();
      expect(await listLanes(db, run.id)).toEqual([]);
      expect((await listRuns(db, orgId)).runs[0]).toMatchObject({ branch: null, prNumber: null });
    });

    it("copies a run's lanes to another run, except one repository", async () => {
      const previous = (await createRun(db, runInput())).run;
      await updateLane(db, (await getMainLane(db, previous))!.id, { prNumber: 1 });
      await ensureLane(db, {
        runId: previous.id,
        repositoryId: repoB,
        branch: "b",
        baseBranch: "main",
      });
      await updateRun(db, previous.id, { status: "stopped" });

      const next = (await createRun(db, runInput({ repositoryId: null }))).run;
      const copied = await copyLanes(db, previous.id, next.id, { exceptRepositoryId: repoA });
      expect(copied.map((l) => [l.runId, l.repositoryId, l.branch])).toEqual([
        [next.id, repoB, "b"],
      ]);
      expect(await listLanes(db, previous.id)).toHaveLength(2);
    });

    describe("moveToRepository", () => {
      it("drops the old main lane and promotes the epic's lane in the new repository", async () => {
        const { run } = await createRun(db, runInput({ repositoryId: repoB, branch: "eng-1" }));
        const old = (await updateLane(db, (await getMainLane(db, run))!.id, {
          prNumber: 1,
          prUrl: "https://github.com/acme/a-web/pull/1",
          reviewRounds: 2,
        }))!;
        const api = await ensureLane(db, {
          runId: run.id,
          repositoryId: repoA,
          branch: "eng-1",
          baseBranch: "develop",
        });
        const message = await insertMessage(db, { runId: run.id, kind: "request", text: "hi" });
        await db
          .update(ralphMessages)
          .set({ laneId: api.id })
          .where(eq(ralphMessages.id, message.id));
        const [story] = await upsertStories(db, run.id, [
          { linearIssueId: "m-1", identifier: "M-1", title: "Web", laneId: old.id },
        ]);

        const moved = await moveToRepository(db, run.id, repoA, {
          branch: "new",
          baseBranch: "main",
        });
        expect(moved?.left).toEqual(old);
        expect(moved?.lane).toMatchObject({
          id: api.id,
          repositoryId: repoA,
          branch: "eng-1",
          baseBranch: "develop",
          prNumber: null,
          reviewRounds: 0,
        });
        expect((await getRun(db, run.id))?.repositoryId).toBe(repoA);
        expect((await getMainLane(db, (await getRun(db, run.id))!))?.id).toBe(api.id);
        expect((await listLanes(db, run.id)).map((l) => l.id)).toEqual([api.id]);
        // The messages of the promoted lane are the main lane's now; the old lane's story has none.
        expect((await listMessages(db, run.id))[0]?.laneId).toBeNull();
        expect((await listStories(db, run.id)).find((s) => s.id === story!.id)?.laneId).toBeNull();
      });

      it("does nothing for the same repository, and starts clean without one", async () => {
        const { run } = await createRun(db, runInput({ repositoryId: null }));
        const started = await moveToRepository(db, run.id, repoA, {
          branch: "b",
          baseBranch: "main",
        });
        expect(started?.left).toBeNull();
        expect(started?.lane).toMatchObject({
          repositoryId: repoA,
          branch: "b",
          baseBranch: "main",
        });
        expect((await getRun(db, run.id))?.repositoryId).toBe(repoA);

        await updateLane(db, started!.lane.id, { branch: "kept" });
        const same = await moveToRepository(db, run.id, repoA, { branch: "x", baseBranch: "y" });
        expect(same).toMatchObject({ left: null, lane: { id: started!.lane.id, branch: "kept" } });

        expect(
          await moveToRepository(db, "00000000-0000-4000-8000-000000000000", repoA, {
            branch: "b",
            baseBranch: "main",
          }),
        ).toBeNull();
      });
    });
  });

  it("lists the repositories runs can be filtered by: ralph enabled or with runs", async () => {
    const off = {
      ralphEnabled: false,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    };
    await updateRepositoryRalphSettings(db, repoA, off);
    await updateRepositoryRalphSettings(db, repoB, off);
    expect(await listRalphRunRepositories(db, orgId)).toEqual([]);

    await updateRepositoryRalphSettings(db, repoB, { ...off, ralphEnabled: true });
    expect((await listRalphRunRepositories(db, orgId)).map((r) => r.id)).toEqual([repoB]);

    // repoA has a run (its ralph setting was turned off later).
    await createRun(db, runInput({ repositoryId: repoA }));
    expect(await listRalphRunRepositories(db, orgId)).toEqual([
      { id: repoB, provider: "github", fullPath: "acme/a-web" },
      { id: repoA, provider: "github", fullPath: "acme/b-api" },
    ]);
  });

  it("keeps another organization's repositories and runs out of every query", async () => {
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    await seedReviewProfiles(db, other!.id);
    const otherConnection = (await upsertScmConnection(
      db,
      {
        organizationId: other!.id,
        provider: "github",
        name: "other",
        baseUrl: "https://api.github.com",
        externalId: "other-1",
        credentials: {},
      },
      key,
    ))!;
    const otherRepo = (
      await connectRepository(db, {
        connectionId: otherConnection.id,
        provider: "github",
        externalId: "99",
        fullPath: "other/api",
      })
    ).id;
    await updateRepositoryRalphSettings(db, otherRepo, {
      ralphEnabled: true,
      linearTeamKeys: ["TOOL"],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    const otherInput = runInput({ organizationId: other!.id, repositoryId: otherRepo });
    const { run: otherRun } = await createRun(db, otherInput);
    await upsertStories(db, otherRun.id, [
      { linearIssueId: "shared-story", identifier: "S-1", title: "s" },
    ]);
    await updateRun(db, otherRun.id, { status: "waiting" });
    await updateLane(db, (await getMainLane(db, otherRun))!.id, {
      prNumber: 1,
      prUrl: "https://example.com/1",
      prMerged: true,
    });

    expect((await listRalphRepositories(db, orgId)).map((r) => r.id)).not.toContain(otherRepo);
    expect((await listRalphRepositories(db, other!.id)).map((r) => r.id)).toEqual([otherRepo]);
    expect((await listRalphRunRepositories(db, orgId)).map((r) => r.id)).not.toContain(otherRepo);
    expect((await listRuns(db, orgId)).runs.map((r) => r.id)).not.toContain(otherRun.id);
    expect((await listRuns(db, other!.id)).runs.map((r) => r.id)).toEqual([otherRun.id]);
    expect(await getRunDetail(db, orgId, otherRun.id)).toBeNull();
    expect((await getRunDetail(db, other!.id, otherRun.id))?.run.id).toBe(otherRun.id);
    expect(await listRunsAffectedByIssue(db, orgId, "shared-story")).toEqual([]);
    expect(await listRunsToReconcile(db, orgId, new Date())).toEqual([]);
    expect((await listRunsToReconcile(db, other!.id, new Date())).map((r) => r.id)).toEqual([
      otherRun.id,
    ]);
    expect(await listOpenPullRequestLanes(db, orgId)).toEqual([]);
    expect(await listLanesToCleanUp(db, orgId)).toEqual([]);
    expect((await listLanesToCleanUp(db, other!.id)).map((l) => l.run.id)).toEqual([otherRun.id]);

    // The same issue (a workspace that moved) doesn't collide with the other organization's run.
    expect(await getRunByIssue(db, orgId, otherInput.linearIssueId)).toBeNull();
    const mine = await createRun(db, runInput({ linearIssueId: otherInput.linearIssueId }));
    expect(mine).toMatchObject({ created: true, run: { organizationId: orgId } });
    expect((await getRunByIssue(db, orgId, otherInput.linearIssueId))?.id).toBe(mine.run.id);
  });
});
