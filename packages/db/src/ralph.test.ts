import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { insertJob } from "./jobs.js";
import { runMigrations } from "./migrate.js";
import {
  appendGuidance,
  appendProgress,
  createRun,
  getRun,
  getRunByIssue,
  getRunBySession,
  listActiveRunJobIds,
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
  type NewRalphRunInput,
} from "./ralph.js";
import {
  connectRepository,
  disconnectRepository,
  getRepository,
  upsertScmConnection,
} from "./repositories.js";
import { agents, DEFAULT_RALPH_SETTINGS, jobs, ralphRuns } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("ralph queries", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let repoA: string;
  let repoB: string;
  let agentId: string;
  let session = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const connection = await upsertScmConnection(
      db,
      {
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      key,
    );
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
    [{ id: agentId }] = (await db
      .insert(agents)
      .values({ name: "coder-1" })
      .returning({ id: agents.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
  });

  const runInput = (overrides: Partial<NewRalphRunInput> = {}): NewRalphRunInput => {
    session += 1;
    return {
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

  it("adds ralph settings and Linear routing to repositories, with defaults", async () => {
    expect(await getRepository(db, repoA)).toMatchObject({
      ralphEnabled: false,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    expect(await listRalphRepositories(db)).toEqual([]);

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
    // By path.
    expect((await listRalphRepositories(db)).map((r) => r.fullPath)).toEqual([
      "acme/a-web",
      "acme/b-api",
    ]);

    await disconnectRepository(db, repoB);
    expect((await listRalphRepositories(db)).map((r) => r.id)).toEqual([repoA]);
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
    expect(run).toMatchObject({
      ...input,
      status: "pending",
      agentId: null,
      guidance: [],
      ignoreBlockers: false,
      progress: "",
      waitingOn: null,
      iterations: 0,
    });
    expect(await getRun(db, run.id)).toEqual(run);
    expect(await getRunBySession(db, input.linearAgentSessionId)).toEqual(run);
    expect(await getRunByIssue(db, input.linearIssueId)).toEqual(run);
    expect(await getRunBySession(db, "unknown")).toBeNull();
    expect(await getRunByIssue(db, "unknown")).toBeNull();
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
    expect((await getRunByIssue(db, input.linearIssueId))?.id).toBe(second.run.id);
    expect((await getRunByIssue(db, input.linearIssueId, { activeOnly: true }))?.id).toBe(
      second.run.id,
    );
    await updateRun(db, second.run.id, { status: "stopped" });
    expect(await getRunByIssue(db, input.linearIssueId, { activeOnly: true })).toBeNull();

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

  it("updates a run's status and state", async () => {
    const { run } = await createRun(db, runInput());
    const waitingOn = {
      blockers: [{ id: "x", identifier: "EXT-1", title: "Upstream" }],
      manual: [],
    };
    const updated = await updateRun(db, run.id, {
      status: "waiting",
      waitingOn,
      agentId,
      prNumber: 7,
      prUrl: "https://github.com/acme/b-api/pull/7",
      ignoreBlockers: true,
      pendingElicitation: { kind: "repository", repositoryIds: ["r"] },
      iterations: 2,
    });
    expect(updated).toMatchObject({
      status: "waiting",
      waitingOn,
      agentId,
      prNumber: 7,
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
      capability: "ralph",
      type: "ralph.story",
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
        capability: "ralph",
        type: "ralph.story",
        ralphRunId: run.id,
      });
      await db.update(jobs).set({ status }).where(eq(jobs.id, job.id));
      return job.id;
    };
    const queued = await job("queued");
    const running = await job("running");
    await job("completed");
    await insertJob(db, { capability: "ralph", type: "ralph.story" });
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
      (await listRunsAffectedByIssue(db, issue)).map((r) => r.id);
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
    await insertJob(db, { capability: "ralph", type: "ralph.story", ralphRunId: busy.id });
    const { run: finished } = await createRun(db, runInput());
    await updateRun(db, finished.id, { status: "failed" });

    const later = new Date(Date.now() + 60_000);
    const ids = (runs: { id: string }[]) => runs.map((r) => r.id).sort();
    expect(ids(await listRunsToReconcile(db, later))).toEqual([waiting.id, stale.id].sort());
    expect(ids(await listRunsToReconcile(db, new Date(0)))).toEqual([waiting.id]);
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
    await updateRun(db, a1.id, {
      status: "completed",
      agentId,
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

    const all = await listRuns(db);
    expect(all).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(all.runs.map((r) => r.id)).toEqual([b1.id, a2.id, a1.id]);
    expect(all.runs[2]).toMatchObject({
      linearIdentifier: a1.linearIdentifier,
      linearTitle: "Epic A",
      linearUrl: "https://linear.app/acme/issue/A-1",
      status: "completed",
      repository: { id: repoA, provider: "github", fullPath: "acme/b-api" },
      agent: { id: agentId, name: "coder-1" },
      prNumber: 3,
      stories: { total: 3, completed: 2 },
    });
    expect(all.runs[1]).toMatchObject({ agent: null, stories: { total: 0, completed: 0 } });

    expect((await listRuns(db, { status: "waiting" })).runs.map((r) => r.id)).toEqual([b1.id]);
    expect(
      (await listRuns(db, { status: ["pending", "completed"] })).runs.map((r) => r.id),
    ).toEqual([a2.id, a1.id]);
    expect((await listRuns(db, { repositoryId: repoA })).total).toBe(2);
    expect(
      (await listRuns(db, { repositoryId: repoA, status: "pending" })).runs.map((r) => r.id),
    ).toEqual([a2.id]);

    const page2 = await listRuns(db, { page: 2, pageSize: 2 });
    expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page2.runs.map((r) => r.id)).toEqual([a1.id]);
    expect((await listRuns(db, { page: 9, pageSize: 2 })).runs).toEqual([]);
  });

  it("loads a run's detail: repository, agent, stories in order and jobs newest first", async () => {
    const run = (await createRun(db, runInput({ linearTitle: "Epic" }))).run;
    await updateRun(db, run.id, { agentId, status: "running" });
    const stories = await upsertStories(db, run.id, [
      { linearIssueId: "d-1", identifier: "D-1", title: "One" },
      { linearIssueId: "d-2", identifier: "D-2", title: "Two" },
    ]);
    const { job: first } = await insertJob(db, {
      capability: "ralph",
      type: "ralph.story",
      ralphRunId: run.id,
    });
    const { job: second } = await insertJob(db, {
      capability: "ralph",
      type: "ralph.describe-pr",
      ralphRunId: run.id,
    });
    await db
      .update(jobs)
      .set({ createdAt: new Date(Date.UTC(2026, 9, 1)), status: "completed", agentId })
      .where(eq(jobs.id, first.id));
    await updateStory(db, stories[0]!.id, { lastJobId: first.id, commitSha: "c".repeat(40) });
    // Another run's job isn't listed.
    const other = (await createRun(db, runInput())).run;
    await insertJob(db, { capability: "ralph", type: "ralph.story", ralphRunId: other.id });

    const detail = await getRunDetail(db, run.id);
    expect(detail).toMatchObject({
      run: { id: run.id, status: "running", linearTitle: "Epic" },
      repository: { id: repoA, provider: "github", fullPath: "acme/b-api" },
      agent: { id: agentId, name: "coder-1" },
    });
    expect(detail!.stories.map((s) => [s.identifier, s.commitSha, s.lastJobId])).toEqual([
      ["D-1", "c".repeat(40), first.id],
      ["D-2", null, null],
    ]);
    expect(detail!.jobs.map((j) => [j.id, j.type, j.status, j.agent?.name ?? null])).toEqual([
      [second.id, "ralph.describe-pr", "queued", null],
      [first.id, "ralph.story", "completed", "coder-1"],
    ]);

    expect(await getRunDetail(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
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
    expect(await listRalphRunRepositories(db)).toEqual([]);

    await updateRepositoryRalphSettings(db, repoB, { ...off, ralphEnabled: true });
    expect((await listRalphRunRepositories(db)).map((r) => r.id)).toEqual([repoB]);

    // repoA has a run (its ralph setting was turned off later).
    await createRun(db, runInput({ repositoryId: repoA }));
    expect(await listRalphRunRepositories(db)).toEqual([
      { id: repoB, provider: "github", fullPath: "acme/a-web" },
      { id: repoA, provider: "github", fullPath: "acme/b-api" },
    ]);
  });
});
