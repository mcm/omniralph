import { randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  completeJob,
  connectRepository,
  closeDb,
  createDb,
  getJob,
  getLane,
  getMainLane,
  getRun,
  getRunBySession,
  jobs,
  ralphRuns,
  repositories,
  claimJob,
  updateLane,
  upsertScmConnection,
  webhookDeliveries,
  type Database,
  type Job,
  organizations,
  type TrackerRun,
  ralphLanes,
} from "@omniralph/db";
import { teamIs, setRoutingRules } from "@/lib/routing/testing";
import {
  CODING_TASKS_MIN_AGENT_VERSION,
  MAX_JOB_DELIVERIES,
  RalphCleanupPayload,
  type RalphCleanupResult,
  type RalphRequestResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import type { PlaybookCoding } from "@omniralph/tasks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { handleTrackerEvent } from "@/lib/tracker/events";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { linearRun } from "@/lib/testing/linear-run";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { handleWebhook } from "@/lib/webhooks/ingest";
import { cleanupDedupeKey, reconcileCleanup, startCleanup } from "./cleanup";
import { cleanupLabel } from "./display";
import { onRalphCleanupJobFinished, onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { handleReply } from "./reply";
import { startRun, type StartRunDeps } from "./start";
import { bindCodingPlaybook } from "./testing";

vi.mock("server-only", () => ({}));

/** A cleanup job: the `worktree.cleanup` RPC, or a legacy `ralph.cleanup` queued before it. */
const isCleanupJob = (type: string) => type === "worktree.cleanup" || type === "ralph.cleanup";
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

const sha = (n: number) => n.toString(16).padStart(40, "0");
const MINUTE = 60_000;

const EPIC_DESCRIPTION = `Build the thing.

## Quality Gates
- \`pnpm test\`
`;

/** Ported from cyralph's "cleanup after a merge" (`test/engine.test.ts`), for the control panel's side. */
describe.skipIf(!databaseAvailable)("cleanup after a merge", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let agentA: string;
  let tracker: FakeLinearGateway;
  let dispatcher: PostgresDispatcher;
  let scm: FakeScmAdapter;
  let sessionSeq = 0;

  const deps = (): StartRunDeps => ({
    db,
    organizationId: orgId,
    tracker,
    dispatcher,
    adapterFor: () => scm.asAdapter(),
  });

  /** Coding on, with the built-in story playbook, or one with `coding` settings. */
  const ralphOn = async (coding?: PlaybookCoding) => {
    await db
      .update(repositories)
      .set({ storyPlaybookId: "builtin:implement-story" })
      .where(eq(repositories.id, repoId));
    if (coding) await bindCodingPlaybook(db, orgId, repoId, "story", coding);
    return setCodingEnabled(db, repoId);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
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
    otherRepoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    await setRoutingRules(db, orgId, [repoId, teamIs("ENG")]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(agents);
    await db.delete(webhookDeliveries);
    [{ id: agentA }] = (await db
      .insert(agents)
      .values([
        {
          organizationId: orgId,
          name: "agent-a",
          reportedAcceptedTaskTypes: ["query", "review", "coding"],
        },
      ])
      .returning({ id: agents.id })) as [{ id: string }];
    await ralphOn();
    tracker = new FakeLinearGateway();
    scm = new FakeScmAdapter();
    dispatcher = new PostgresDispatcher({ db });
  });

  const activeJobs = (runId: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, runId), inArray(jobs.status, ["queued", "running"])));

  async function start(runId: string, type?: string): Promise<Job> {
    const active = (await activeJobs(runId)).filter((j) => !type || j.type === type);
    const [job, ...more] = active;
    expect(job, "the run has a queued job").toBeDefined();
    expect(more).toEqual([]);
    const started = await claimJob(db, {
      organizationId: orgId,
      agentId: agentA,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      agentVersion: CODING_TASKS_MIN_AGENT_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job!.id);
    if (!isCleanupJob(job!.type)) {
      expect(await onRalphJobStarted(db, job!, agentA)).toEqual({ skip: false });
    }
    return job!;
  }

  async function finish(job: Job, result: Record<string, unknown>): Promise<void> {
    expect(await completeJob(db, { jobId: job.id, agentId: agentA, result })).toEqual({
      status: "completed",
    });
    const done = (await getJob(db, job.id))!;
    if (isCleanupJob(done.type)) await onRalphCleanupJobFinished(db, done, deps());
    else await onRalphJobFinished(db, done, deps());
  }

  const storyResult = (overrides: Partial<RalphStoryResult> = {}): RalphStoryResult => ({
    status: "complete",
    summary: "Did the work.",
    followUps: [],
    feedback: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  const requestResult = (overrides: Partial<RalphRequestResult> = {}): RalphRequestResult => ({
    summary: "Done.",
    error: null,
    sessionId: "claude-req-1",
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  const cleanupResult = (overrides: Partial<RalphCleanupResult> = {}): RalphCleanupResult => ({
    error: null,
    removedWorktree: true,
    hadBranch: true,
    stashed: null,
    unmerged: 0,
    stashes: [],
    handled: 0,
    deletedRefs: [],
    durationMs: 5,
    ...overrides,
  });

  /** A finished epic (ENG-1) whose PR #1 is open at `sha(1)`. */
  async function epicWithPullRequest(): Promise<{
    run: TrackerRun;
    branch: string;
    epicId: string;
  }> {
    sessionSeq += 1;
    const n = sessionSeq;
    const epic = tracker.add({
      identifier: `ENG-${n * 10}`,
      title: "Epic",
      description: EPIC_DESCRIPTION,
    });
    tracker.add({ identifier: `ENG-${n * 10 + 1}`, title: "Alpha", parentId: epic.id });
    const sessionId = `session-${n}`;
    await startRun(
      {
        kind: "issue_delegated",
        sessionId,
        issueId: epic.id,
        creatorName: "Steve",
      },
      deps(),
    );
    const run = linearRun((await getRunBySession(db, sessionId))!);
    await finish(await start(run.id), storyResult({ commitSha: sha(1) }));
    await finish(await start(run.id, "ralph.describe-pr"), {
      outcome: "answered",
      answer: null,
      structured: { title: "Build the epic", body: "Builds it." },
      references: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 10,
    });
    expect((await getRun(db, run.id))?.status).toBe("completed");
    const request = scm.changeRequests.at(-1)!;
    request.headSha = sha(1);
    const lane = (await getMainLane(db, run))!;
    return { run: linearRun((await getRun(db, run.id))!), branch: lane.branch, epicId: epic.id };
  }

  /** Merges the epic's PR/MR on the code host (`mergeSha` is the merge commit). */
  const merge = (n = scm.changeRequests.length) => {
    const request = scm.changeRequests.find((c) => c.number === n)!;
    request.state = "merged";
    request.mergeSha = sha(500 + n);
  };

  const cleanupJobs = async (runId: string) =>
    (await db.select().from(jobs).where(eq(jobs.ralphRunId, runId)))
      .filter((j) => isCleanupJob(j.type))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const actionOf = (job: Job) => RalphCleanupPayload.parse(job.payload).action;

  const issueDone = (issueId: string) =>
    handleTrackerEvent(
      { kind: "issue_state_changed", issueId, stateType: "completed", removed: false },
      { db, organizationId: orgId, workspaceId: "org-1" },
      { tracker, dispatcher, adapterFor: () => scm.asAdapter() },
    );

  const reply = (run: TrackerRun, body: string) =>
    handleReply({ kind: "session_prompted", sessionId: run.trackerSessionId, body }, deps());

  const responses = (run: TrackerRun) => tracker.bodies(run.trackerSessionId, "response");
  const selects = (run: TrackerRun) =>
    tracker.activities.filter(
      (a) => a.sessionId === run.trackerSessionId && a.options?.signal === "select",
    );
  const optionsOf = (a: ReturnType<typeof selects>[number] | undefined) =>
    (a?.options?.signalMetadata?.options as Array<{ value: string }> | undefined)?.map(
      (o) => o.value,
    );
  const bodyOf = (a: ReturnType<typeof selects>[number] | undefined) =>
    a && "body" in a.content ? a.content.body : "";
  const lane = async (run: TrackerRun) => (await getMainLane(db, run))!;

  /** A merged epic whose cleanup job ran with `result`. */
  async function cleanedUp(result: Partial<RalphCleanupResult> = {}) {
    const t = await epicWithPullRequest();
    merge();
    await reconcileCleanup(deps());
    const job = await start(t.run.id, "worktree.cleanup");
    await finish(job, cleanupResult(result));
    return t;
  }

  it("removes the worktree and local branch once the issue is done after its PR merged", async () => {
    const { run, branch, epicId } = await epicWithPullRequest();
    // Done while the PR is still open (e.g. moved by hand): nothing is removed.
    await issueDone(epicId);
    expect(await cleanupJobs(run.id)).toEqual([]);
    expect((await lane(run)).prClosed).toBe(false);

    merge();
    await issueDone(epicId);
    const [job, ...more] = await cleanupJobs(run.id);
    expect(more).toEqual([]);
    // A system RPC on the run's sticky agent, which holds the worktree, one per lane.
    expect(job).toMatchObject({
      type: "worktree.cleanup",
      taskType: "system",
      taskId: null,
      targetAgentId: agentA,
      dedupeKey: cleanupDedupeKey((await lane(run)).id),
    });
    expect(actionOf(job!)).toEqual({ kind: "cleanup", mergedSha: sha(1), stashes: [] });
    expect(RalphCleanupPayload.parse(job!.payload)).toMatchObject({
      branch,
      epic: { identifier: run.trackerIdentifier },
    });
    expect(await lane(run)).toMatchObject({
      prClosed: true,
      prMerged: true,
      mergeSha: sha(501),
      cleanup: { status: "running", jobId: job!.id, mergedSha: sha(1) },
    });
    expect(cleanupLabel((await lane(run)).cleanup)).toBe("Merged: cleaning up");

    await finish(await start(run.id, "worktree.cleanup"), cleanupResult());
    const prUrl = scm.changeRequests[0]!.url;
    expect(responses(run).at(-1)).toBe(
      `The pull request ${prUrl} was merged, so I removed its worktree and the local branch \`${branch}\`.`,
    );
    // The note is the session's last activity and a response, so Linear sees the session complete
    // again instead of waiting on it.
    expect(tracker.activities.at(-1)?.content.type).toBe("response");
    expect((await lane(run)).cleanup).toMatchObject({ status: "done", questions: [] });
    expect((await lane(run)).cleanup?.jobId).toBeUndefined();
    expect(cleanupLabel((await lane(run)).cleanup)).toBe("Merged: cleaned up");

    // Done again (or the cron): nothing more to do.
    await issueDone(epicId);
    expect(await reconcileCleanup(deps())).toEqual({
      checked: 0,
      started: 0,
      expired: 0,
      failed: 0,
    });
    expect(await cleanupJobs(run.id)).toHaveLength(1);
  });

  it("cleans up each lane on the agent that holds its worktree", async () => {
    const { run } = await epicWithPullRequest();
    const [{ id: agentB }] = (await db
      .insert(agents)
      .values({ organizationId: orgId, name: "agent-b", reportedAcceptedTaskTypes: ["coding"] })
      .returning({ id: agents.id })) as [{ id: string }];
    const [other] = await db
      .insert(ralphLanes)
      .values({
        runId: run.id,
        repositoryId: otherRepoId,
        branch: (await lane(run)).branch,
        baseBranch: "main",
        prMerged: true,
        agentId: agentB,
      })
      .returning();
    // The run's (main lane's) agent is agentA: the other lane's worktree is on agentB.
    expect((await getRun(db, run.id))?.agentId).toBe(agentA);
    expect(await startCleanup(deps(), other!.id, sha(9))).toMatchObject({ status: "enqueued" });
    const [job, ...more] = await cleanupJobs(run.id);
    expect(more).toEqual([]);
    expect(job).toMatchObject({
      repositoryId: otherRepoId,
      targetAgentId: agentB,
      dedupeKey: cleanupDedupeKey(other!.id),
    });

    // A lane that never ran a job on an agent has no worktree to clean up, even when the run did.
    await db.delete(jobs);
    await db
      .update(ralphLanes)
      .set({ agentId: null, cleanup: null })
      .where(eq(ralphLanes.id, other!.id));
    expect(await startCleanup(deps(), other!.id, sha(9))).toEqual({ status: "nothing" });
    expect(await cleanupJobs(run.id)).toEqual([]);

    // The lane's agent can't take jobs anymore: no other agent has its worktree, and the
    // reason names the lane's repository.
    await db
      .update(ralphLanes)
      .set({ agentId: agentB, cleanup: null })
      .where(eq(ralphLanes.id, other!.id));
    await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentB));
    expect(await startCleanup(deps(), other!.id, sha(9))).toEqual({ status: "nothing" });
    expect(await cleanupJobs(run.id)).toEqual([]);
    expect((await getLane(db, other!.id))?.cleanup?.error).toBe(
      "the agent that holds the branch in `acme/web` can't take coding jobs anymore",
    );
  });

  it("still applies a ralph.cleanup job queued before cleanups ran as worktree.cleanup", async () => {
    const { run, branch } = await epicWithPullRequest();
    merge();
    await reconcileCleanup(deps());
    const [queued] = await cleanupJobs(run.id);
    await db
      .update(jobs)
      .set({ type: "ralph.cleanup", taskType: "coding" })
      .where(eq(jobs.id, queued!.id));
    const job = await start(run.id, "ralph.cleanup");
    await finish(job, cleanupResult());
    expect(responses(run).at(-1)).toBe(
      `The pull request ${scm.changeRequests.at(-1)!.url} was merged, so I removed its worktree and the local branch \`${branch}\`.`,
    );
    expect((await lane(run)).cleanup).toMatchObject({ status: "done", questions: [] });
  });

  it("links the PR to the epic and resolves the epic once the PR merged", async () => {
    const { run, epicId } = await epicWithPullRequest();
    const pr = scm.changeRequests.at(-1)!;
    expect(tracker.links).toContainEqual({
      issueId: epicId,
      url: pr.url,
      title: `Pull request #${pr.number}`,
    });
    // Still open: the epic is left alone.
    await reconcileCleanup(deps());
    expect(tracker.issues.get(epicId)?.stateType).not.toBe("completed");

    merge(pr.number);
    await reconcileCleanup(deps());
    expect(tracker.issues.get(epicId)?.stateType).toBe("completed");
    expect(tracker.stateChanges.at(-1)).toEqual({ issueId: epicId, target: { type: "completed" } });
    expect((await lane(run)).prMerged).toBe(true);
  });

  it("leaves the epic alone while another lane hasn't opened its PR yet", async () => {
    const { run, epicId } = await epicWithPullRequest();
    await db.insert(ralphLanes).values({
      runId: run.id,
      repositoryId: otherRepoId,
      branch: (await lane(run)).branch,
      baseBranch: "main",
    });
    const changes = tracker.stateChanges.length;
    merge();
    await reconcileCleanup(deps());
    expect((await lane(run)).prMerged).toBe(true);
    expect(tracker.issues.get(epicId)?.stateType).not.toBe("completed");
    expect(tracker.stateChanges).toHaveLength(changes);
  });

  it("leaves a canceled epic alone when its PR merged", async () => {
    const { epicId } = await epicWithPullRequest();
    tracker.issues.get(epicId)!.stateType = "canceled";
    const changes = tracker.stateChanges.length;
    merge();
    await reconcileCleanup(deps());
    expect(tracker.issues.get(epicId)?.stateType).toBe("canceled");
    expect(tracker.stateChanges).toHaveLength(changes);
  });

  it("cleans up when the cron or the merge webhook sees the PR merged", async () => {
    // The cron, as a fallback for a missed webhook.
    const first = await epicWithPullRequest();
    expect(await reconcileCleanup(deps())).toMatchObject({ checked: 1, started: 0 });
    merge();
    expect(await reconcileCleanup(deps())).toMatchObject({ checked: 1, failed: 0 });
    expect(await cleanupJobs(first.run.id)).toHaveLength(1);
    await finish(await start(first.run.id, "worktree.cleanup"), cleanupResult());
    expect(responses(first.run).at(-1)).toContain("was merged, so I removed its worktree");

    // The merge webhook.
    const second = await epicWithPullRequest();
    const number = scm.changeRequests.at(-1)!.number;
    const closed = (merged: boolean, delivery = randomUUID()) =>
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": delivery,
        },
        body: JSON.stringify({
          action: "closed",
          installation: { id: 1 },
          repository: { id: 1, full_name: "acme/api" },
          pull_request: { number, merged },
        }),
      });
    const webhook = (req: Request) =>
      handleWebhook("github", req, {
        db,
        dispatcher,
        adapterFor: () => scm.asAdapter(),
        tracker: async () => tracker,
      });
    // A close event for a PR the code host still has open (e.g. reopened since) does nothing.
    expect(await (await webhook(closed(false))).json()).toEqual({
      status: "accepted",
      event: "closed",
    });
    expect(await cleanupJobs(second.run.id)).toEqual([]);
    expect((await lane(second.run)).prClosed).toBe(false);
    merge(number);
    const delivery = randomUUID();
    expect(await (await webhook(closed(true, delivery))).json()).toEqual({
      status: "accepted",
      event: "merged",
    });
    expect(await cleanupJobs(second.run.id)).toHaveLength(1);
    // A redelivery (or another merge event) of a PR that's known merged does nothing.
    expect(await (await webhook(closed(true, delivery))).json()).toEqual({
      status: "ignored",
      reason: "not_ralph",
    });
    expect(await cleanupJobs(second.run.id)).toHaveLength(1);
  });

  /** The PR/MR's close (or merge) webhook from `provider` (the repository is moved to it). */
  async function closedWebhook(
    provider: "github" | "gitlab",
    number: number,
    merged: boolean,
    delivery = randomUUID(),
  ) {
    const req =
      provider === "github"
        ? new Request("http://localhost/api/webhooks/github", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "pull_request",
              "x-github-delivery": delivery,
            },
            body: JSON.stringify({
              action: "closed",
              installation: { id: 1 },
              repository: { id: 1, full_name: "acme/api" },
              pull_request: { number, merged },
            }),
          })
        : new Request("http://localhost/api/webhooks/gitlab", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-gitlab-event": "Merge Request Hook",
              "x-gitlab-event-uuid": delivery,
              "x-gitlab-token": "secret",
            },
            body: JSON.stringify({
              object_kind: "merge_request",
              project: { id: 1, path_with_namespace: "acme/api" },
              object_attributes: {
                iid: number,
                action: merged ? "merge" : "close",
                state: merged ? "merged" : "closed",
              },
            }),
          });
    const response = await handleWebhook(provider, req, {
      db,
      dispatcher,
      adapterFor: () => scm.asAdapter(),
      tracker: async () => tracker,
    });
    return response.json();
  }

  it.each(["github", "gitlab"] as const)(
    "removes the worktree but keeps the branch once the PR/MR is closed unmerged (%s webhook)",
    async (provider) => {
      await db.update(repositories).set({ provider }).where(eq(repositories.id, repoId));
      try {
        const { run, branch, epicId } = await epicWithPullRequest();
        const request = scm.changeRequests.at(-1)!;
        request.state = "closed";
        const delivery = randomUUID();
        expect(await closedWebhook(provider, request.number, false, delivery)).toEqual({
          status: "accepted",
          event: "closed",
        });
        const [job, ...more] = await cleanupJobs(run.id);
        expect(more).toEqual([]);
        expect(job).toMatchObject({
          type: "worktree.cleanup",
          taskType: "system",
          targetAgentId: agentA,
          dedupeKey: cleanupDedupeKey((await lane(run)).id),
        });
        expect(actionOf(job!)).toEqual({ kind: "cleanup", keepBranch: true, stashes: [] });
        expect(await lane(run)).toMatchObject({
          prClosed: true,
          prMerged: false,
          cleanup: { status: "running", keepBranch: "closed", mergedSha: null, jobId: job!.id },
        });
        expect(cleanupLabel((await lane(run)).cleanup)).toBe("Closed: cleaning up");
        // A redelivery (or another close event) of a PR/MR known closed does nothing.
        expect(await closedWebhook(provider, request.number, false, delivery)).toEqual({
          status: "ignored",
          reason: "not_ralph",
        });

        // Whatever the agent found, nothing is asked: the branch and the stash stay.
        const stash = sha(90);
        await finish(
          await start(run.id, "worktree.cleanup"),
          cleanupResult({
            stashed: stash,
            stashes: [{ sha: stash, label: "omniralph ralph x cleanup", date: "2026-10-11" }],
          }),
        );
        const term = provider === "github" ? "pull request" : "merge request";
        expect(responses(run).at(-1)).toBe(
          `The ${term} ${request.url} was closed without merging, so I removed its worktree. The branch \`${branch}\` stays, here and on origin. Its uncommitted changes are stashed (\`${stash.slice(0, 10)}\`).`,
        );
        expect(selects(run)).toEqual([]);
        expect(await lane(run)).toMatchObject({
          cleanup: { status: "done", keepBranch: "closed", questions: [] },
          stashes: [{ sha: stash, reason: "cleanup" }],
        });
        expect(cleanupLabel((await lane(run)).cleanup)).toBe("Closed: cleaned up (branch kept)");

        // Another close event, the issue moving to done or the cron: nothing more.
        await closedWebhook(provider, request.number, false);
        await issueDone(epicId);
        expect(await reconcileCleanup(deps())).toMatchObject({ started: 0, failed: 0 });
        expect(await cleanupJobs(run.id)).toHaveLength(1);
      } finally {
        await db
          .update(repositories)
          .set({ provider: "github" })
          .where(eq(repositories.id, repoId));
      }
    },
  );

  it("starts the keep-branch cleanup when the cron sees the PR closed, waits for an active job, and retries a failure", async () => {
    const { run } = await epicWithPullRequest();
    // A reply reopens the run: its request job may still use the worktree.
    await reply(run, "Please also update the README");
    scm.changeRequests.at(-1)!.state = "closed";
    await reconcileCleanup(deps());
    expect(await cleanupJobs(run.id)).toEqual([]);
    expect((await lane(run)).cleanup).toMatchObject({ status: "pending", keepBranch: "closed" });
    expect(cleanupLabel((await lane(run)).cleanup)).toBe(
      "Closed: cleanup waits for the run's current job",
    );

    await finish(await start(run.id, "ralph.request"), requestResult());
    expect(await cleanupJobs(run.id)).toHaveLength(1);
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult({ error: "disk full" }));
    expect((await lane(run)).cleanup).toMatchObject({ status: "failed", keepBranch: "closed" });
    await reconcileCleanup(deps());
    const [, again] = await cleanupJobs(run.id);
    expect(actionOf(again!)).toEqual({ kind: "cleanup", keepBranch: true, stashes: [] });
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult());
    expect((await lane(run)).cleanup).toMatchObject({ status: "done", keepBranch: "closed" });
  });

  it("cleans up merged after a closed PR was reopened and merged", async () => {
    const { run } = await epicWithPullRequest();
    scm.changeRequests.at(-1)!.state = "closed";
    await reconcileCleanup(deps());
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult());
    expect((await lane(run)).cleanup).toMatchObject({ status: "done", keepBranch: "closed" });

    // Reopened (followed up again) and merged: the merge cleanup deletes the branch.
    await updateLane(db, (await lane(run)).id, { prClosed: false, prMerged: false });
    merge();
    await reconcileCleanup(deps());
    const [, merged] = await cleanupJobs(run.id);
    expect(actionOf(merged!)).toEqual({ kind: "cleanup", mergedSha: sha(1), stashes: [] });
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult());
    expect((await lane(run)).cleanup).toMatchObject({ status: "done", mergedSha: sha(1) });
    expect((await lane(run)).cleanup?.keepBranch).toBeUndefined();
  });

  it("keeps the worktree when the repository opted out, whether the PR merged or closed", async () => {
    await ralphOn({ cleanupMergedWorktrees: false });
    const closed = await epicWithPullRequest();
    scm.changeRequests.at(-1)!.state = "closed";
    await reconcileCleanup(deps());
    await closedWebhook("github", scm.changeRequests.at(-1)!.number, false);
    expect(await cleanupJobs(closed.run.id)).toEqual([]);
    expect(await lane(closed.run)).toMatchObject({
      prClosed: true,
      prMerged: false,
      cleanup: null,
    });

    const off = await epicWithPullRequest();
    merge();
    await issueDone(off.epicId);
    await reconcileCleanup(deps());
    expect(await cleanupJobs(off.run.id)).toEqual([]);
    expect(await lane(off.run)).toMatchObject({ prMerged: true, cleanup: null });
  });

  it("stashes a dirty worktree, removes it, and asks about the stash: no answer keeps it, Push stores it on origin", async () => {
    const stash = sha(77);
    const { run, branch } = await cleanedUp({
      stashed: stash,
      stashes: [{ sha: stash, label: "omniralph ralph x cleanup", date: "2026-10-06T10:00:00Z" }],
    });
    expect(
      responses(run).some(
        (b) =>
          b.includes(`removed its worktree and the local branch \`${branch}\``) &&
          b.includes("uncommitted changes are stashed (`0000000000`)"),
      ),
    ).toBe(true);
    const ask = selects(run).at(-1);
    expect(bodyOf(ask)).toContain(
      `1 stashed change from ${run.trackerIdentifier} was never applied`,
    );
    const stashBranch = `ralph/stash/${run.trackerIdentifier.toLowerCase()}`;
    expect(bodyOf(ask)).toContain(`\`${stashBranch}\``);
    expect(optionsOf(ask)).toEqual(["Push to a branch on origin", "Drop"]);
    expect((await lane(run)).cleanup?.questions).toMatchObject([
      { kind: "stashes", shas: [stash] },
    ]);
    expect((await lane(run)).stashes).toMatchObject([{ sha: stash, reason: "cleanup" }]);
    expect(cleanupLabel((await lane(run)).cleanup)).toBe(
      "Merged: cleaned up, waiting for an answer",
    );

    // No answer: nothing happens, however long it takes.
    await reconcileCleanup(deps(), new Date(Date.now() + 365 * 24 * 60 * MINUTE));
    expect(await cleanupJobs(run.id)).toHaveLength(1);
    // A reply that isn't an answer is handled as usual (a request) and leaves the question open.
    const handled = await reply(
      run,
      "Please push the stash to the branch and also update the docs",
    );
    expect(handled?.kind).not.toBe("cleanup_answer");
    await finish(await start(run.id, "ralph.request"), requestResult());
    expect((await lane(run)).cleanup?.questions).toHaveLength(1);

    expect(await reply(run, "Push to a branch on origin")).toEqual({ kind: "cleanup_answer" });
    const answer = (await cleanupJobs(run.id)).at(-1)!;
    expect(actionOf(answer)).toEqual({ kind: "stashes", push: true, shas: [stash] });
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult({ handled: 1 }));
    expect(responses(run).at(-1)).toBe(
      `Pushed 1 stashed change to \`${stashBranch}\` on origin (one commit each) and dropped it here.`,
    );
    expect((await lane(run)).cleanup?.questions).toEqual([]);
    expect((await lane(run)).stashes).toEqual([]);
  });

  it("drops leftover stashes of the epic when told to", async () => {
    const stash = sha(78);
    const blocked = sha(79);
    const { run } = await cleanedUp({
      stashed: stash,
      stashes: [
        { sha: stash, label: "omniralph ralph x cleanup", date: "2026-10-06T10:00:00Z" },
        { sha: blocked, label: "omniralph ralph x ENG-11 blocked", date: "2026-10-05T10:00:00Z" },
      ],
    });
    expect(bodyOf(selects(run).at(-1))).toContain(
      `2 stashed changes from ${run.trackerIdentifier} were never applied`,
    );

    await reply(run, "drop");
    const answer = (await cleanupJobs(run.id)).at(-1)!;
    expect(actionOf(answer)).toEqual({ kind: "stashes", push: false, shas: [stash, blocked] });
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult({ handled: 2 }));
    expect(responses(run).at(-1)).toBe(`Dropped 2 stashed changes from ${run.trackerIdentifier}.`);
  });

  it("removes the worktree of a branch with unmerged commits, keeps the branch, and pushes it when told to", async () => {
    const { run, branch } = await cleanedUp({ unmerged: 1 });
    expect(
      responses(run).some((b) =>
        b.includes(`removed its worktree, but kept the local branch \`${branch}\``),
      ),
    ).toBe(true);
    const ask = selects(run).at(-1);
    expect(bodyOf(ask)).toContain(`\`${branch}\` has 1 commit that wasn't merged`);
    expect(optionsOf(ask)).toEqual(["Push to origin", "Delete"]);

    await reply(run, "Push to origin");
    expect(actionOf((await cleanupJobs(run.id)).at(-1)!)).toEqual({ kind: "branch", push: true });
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult());
    expect(responses(run).at(-1)).toBe(
      `Pushed \`${branch}\` to origin and deleted the local branch.`,
    );
    expect((await lane(run)).cleanup?.questions).toEqual([]);
  });

  it("deletes the kept branch when told to, or once nobody answers in time", async () => {
    const told = await cleanedUp({ unmerged: 1 });
    await reply(told.run, "Delete");
    expect(actionOf((await cleanupJobs(told.run.id)).at(-1)!)).toEqual({
      kind: "branch",
      push: false,
    });
    await finish(await start(told.run.id, "worktree.cleanup"), cleanupResult());
    expect(responses(told.run).at(-1)).toBe(
      `Deleted the local branch \`${told.branch}\` with its 1 unmerged commit.`,
    );

    const quiet = await cleanedUp({ unmerged: 2 });
    await reconcileCleanup(deps(), new Date(Date.now() + 59 * MINUTE));
    expect(await cleanupJobs(quiet.run.id)).toHaveLength(1);
    expect(await reconcileCleanup(deps(), new Date(Date.now() + 61 * MINUTE))).toMatchObject({
      expired: 1,
    });
    expect(actionOf((await cleanupJobs(quiet.run.id)).at(-1)!)).toEqual({
      kind: "branch",
      push: false,
    });
    await finish(await start(quiet.run.id, "worktree.cleanup"), cleanupResult());
    expect((await lane(quiet.run)).cleanup?.questions).toEqual([]);
    expect(responses(quiet.run).at(-1)).toBe(
      `Nobody answered within 60 minutes, so I deleted the local branch \`${quiet.branch}\` with its 2 unmerged commits.`,
    );

    await ralphOn({ unmergedBranchTimeoutMinutes: 5 });
    const custom = await cleanedUp({ unmerged: 1 });
    expect(bodyOf(selects(custom.run).at(-1))).toContain("within 5 minutes");
    await reconcileCleanup(deps(), new Date(Date.now() + 4 * MINUTE));
    expect(await cleanupJobs(custom.run.id)).toHaveLength(1);
    await reconcileCleanup(deps(), new Date(Date.now() + 6 * MINUTE));
    await finish(await start(custom.run.id, "worktree.cleanup"), cleanupResult());
    expect(responses(custom.run).at(-1)).toContain("Nobody answered within 5 minutes");
  });

  it("keeps pending cleanup questions across a restart and still answers them", async () => {
    const stash = sha(80);
    const { run, branch } = await cleanedUp({
      stashed: stash,
      unmerged: 1,
      stashes: [{ sha: stash, label: "omniralph ralph x cleanup", date: "2026-10-06T10:00:00Z" }],
    });
    expect((await lane(run)).cleanup?.questions.map((q) => q.kind)).toEqual(["stashes", "branch"]);

    // A new process (and Linear client) reads the questions back from the database.
    tracker = new FakeLinearGateway();
    dispatcher = new PostgresDispatcher({ db });
    // "Push" alone is ambiguous with both questions open; the option values aren't.
    expect(await reply(run, "Drop")).toEqual({ kind: "cleanup_answer" });
    expect(actionOf((await cleanupJobs(run.id)).at(-1)!)).toMatchObject({ kind: "stashes" });
    // While an answer is carried out, another one for the same branch waits.
    expect(await reply(run, "Push to origin")).toEqual({ kind: "cleanup_answer" });
    expect(tracker.bodies(run.trackerSessionId, "response").at(-1)).toContain(
      "still carrying out the previous answer",
    );
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult({ handled: 1 }));
    expect((await lane(run)).cleanup?.questions.map((q) => q.kind)).toEqual(["branch"]);

    await reply(run, "Push to origin");
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult());
    expect(responses(run).at(-1)).toBe(
      `Pushed \`${branch}\` to origin and deleted the local branch.`,
    );
    expect((await lane(run)).cleanup?.questions).toEqual([]);
  });

  it("says when an answer couldn't be carried out, and takes it again", async () => {
    const { run } = await cleanedUp({ unmerged: 1 });
    await reply(run, "Push to origin");
    await finish(
      await start(run.id, "worktree.cleanup"),
      cleanupResult({ error: "git push failed: rejected" }),
    );
    expect(responses(run).at(-1)).toBe(
      "I couldn't do that (Push to origin): git push failed: rejected\n\nAnswer again to retry.",
    );
    expect((await lane(run)).cleanup?.questions).toHaveLength(1);

    await reply(run, "2");
    expect(actionOf((await cleanupJobs(run.id)).at(-1)!)).toEqual({ kind: "branch", push: false });
  });

  it("waits for the run's active job, and retries a cleanup that failed", async () => {
    const { run } = await epicWithPullRequest();
    // A reply reopens the run: its request job may still use the worktree.
    await reply(run, "Please also update the README");
    merge();
    await reconcileCleanup(deps());
    expect(await cleanupJobs(run.id)).toEqual([]);
    expect((await lane(run)).cleanup).toMatchObject({ status: "pending", mergedSha: sha(1) });
    expect(cleanupLabel((await lane(run)).cleanup)).toBe(
      "Merged: cleanup waits for the run's current job",
    );

    await finish(await start(run.id, "ralph.request"), requestResult());
    expect((await getRun(db, run.id))?.status).toBe("completed");
    expect(await cleanupJobs(run.id)).toHaveLength(1);

    // The agent failed to clean up: the cron starts it again.
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult({ error: "disk full" }));
    expect((await lane(run)).cleanup).toMatchObject({ status: "failed", error: "disk full" });
    await reconcileCleanup(deps());
    expect(await cleanupJobs(run.id)).toHaveLength(2);
    await finish(await start(run.id, "worktree.cleanup"), cleanupResult());
    expect((await lane(run)).cleanup).toMatchObject({ status: "done" });
  });
});
