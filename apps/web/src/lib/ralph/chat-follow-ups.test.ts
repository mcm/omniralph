import { randomBytes, randomUUID } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  agents,
  completeJob,
  connectRepository,
  closeDb,
  createDb,
  ensureChatThread,
  getJob,
  getMainLane,
  getRun,
  jobs,
  listPendingRequests,
  organizations,
  ralphRuns,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  startJob,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  webhookDeliveries,
  DEFAULT_RALPH_SETTINGS,
  type ChatConnection,
  type ChatThread,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import {
  MAX_JOB_DELIVERIES,
  RalphCleanupPayload,
  type RalphCleanupResult,
  type RalphRequestResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Adapter, Logger, Message, Thread } from "chat";
import { and, eq, inArray } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversationContext } from "@/lib/chat/bot";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import type { LinearGateway } from "@/lib/linear/gateway";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import type { ChatChannel } from "./conversation";
import type { RalphDeps } from "./run";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { handleWebhook } = await import("@/lib/webhooks/ingest");
const { createChatAgentHandler, SESSION_REACTION } = await import("@/lib/chat/agent/handler");
const { onRalphCleanupJobFinished, onRalphJobFinished, onRalphJobStarted } = await import("./jobs");
const { startChatRequest } = await import("./chat-start");
const { sendToChatRun } = await import("./chat-reply");
const { askPermission, readPermission } = await import("./permissions");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const APP_URL = "https://omniralph.example.com";
const THREAD_ID = "discord:G1:CH1:TH1";
const JOB_URL = "https://github.com/acme/app/actions/runs/5/job/1";

/**
 * PR/MR follow-ups of a run from chat (CI fixes, `@bot fix`, cleanup after
 * the merge): they report to the run's thread and never touch Linear.
 */
describe.skipIf(!dockerAvailable)("PR follow-ups of a chat run", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let connection: ChatConnection;
  let chatThread: ChatThread;
  let agentId: string;
  let scm: FakeScmAdapter;
  let dispatcher: VercelQueuesDispatcher;
  let adapter: Adapter;
  let state: ReturnType<typeof createMockState>;
  /** Every Linear gateway call, and every time one was loaded. */
  let linearCalls: string[];
  let linearLoads: number;

  /** A Linear gateway that records (and fails) any call: chat runs must not make one. */
  const strictLinear = () =>
    new Proxy({} as LinearGateway, {
      get: (_target, prop) =>
        prop === "then"
          ? undefined
          : async () => {
              linearCalls.push(String(prop));
              throw new Error(`Linear called: ${String(prop)}`);
            },
    });

  const chat = (): ChatChannel => ({
    db,
    adapters: { discord: adapter },
    state,
    appUrl: APP_URL,
    encryptionKey: key,
  });

  const ralph = (): RalphDeps => ({
    db,
    organizationId: orgId,
    linear: strictLinear(),
    dispatcher,
    adapterFor: () => scm.asAdapter(),
    chat: chat(),
  });

  const webhook = (event: string, body: Record<string, unknown>) =>
    handleWebhook(
      "github",
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": randomUUID(),
        },
        body: JSON.stringify({
          installation: { id: 1 },
          repository: { id: 1, full_name: "acme/app" },
          ...body,
        }),
      }),
      {
        db,
        dispatcher,
        adapterFor: () => scm.asAdapter(),
        handle: "omniralph",
        linear: async () => {
          linearLoads += 1;
          return strictLinear();
        },
        chat: chat(),
      },
    );

  /** The markdown of every message posted to the thread, in order. */
  const posted = () =>
    vi.mocked(adapter.postMessage).mock.calls.map(([, m]) => (m as { markdown: string }).markdown);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
    const scmConnection = (await upsertScmConnection(
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
    repoId = (
      await connectRepository(db, {
        connectionId: scmConnection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/app",
      })
    ).id;
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    const saved = await saveChatConnection(
      db,
      {
        organizationId: orgId,
        platform: "discord",
        externalId: "G1",
        name: "Acme server",
        credentials: null,
        installedByUserId: null,
      },
      key,
    );
    if (saved === "other_organization") throw new Error("taken");
    connection = saved;
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
    await db.delete(webhookDeliveries);
    await db.execute("DELETE FROM chat_threads");
    chatThread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: THREAD_ID,
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D1",
    }))!;
    scm = new FakeScmAdapter();
    dispatcher = new VercelQueuesDispatcher({ db, publisher: new RecordingPublisher() });
    let n = 0;
    adapter = createMockAdapter("discord", {
      postMessage: vi.fn(async (threadId: string) => {
        n += 1;
        return { id: `m-${n}`, threadId, raw: {} };
      }),
    });
    state = createMockState();
    linearCalls = [];
    linearLoads = 0;
  });

  const activeJobs = (runId: string, type: string) =>
    db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.ralphRunId, runId),
          eq(jobs.type, type),
          inArray(jobs.status, ["queued", "running"]),
        ),
      );

  /** Starts the run's one queued job of `type` on the agent. */
  async function start(runId: string, type: string): Promise<Job> {
    const [job, ...more] = await activeJobs(runId, type);
    expect(job, `the run has a queued ${type} job`).toBeDefined();
    expect(more).toEqual([]);
    const started = await startJob(db, {
      organizationId: orgId,
      jobId: job!.id,
      agentId,
      enabledCapabilities: ["ralph"],
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.action).toBe("run");
    if (type !== "ralph.cleanup") {
      expect(await onRalphJobStarted(db, job!, agentId)).toEqual({ skip: false });
    }
    return job!;
  }

  async function finish(job: Job, result: Record<string, unknown>): Promise<void> {
    expect(await completeJob(db, { jobId: job.id, agentId, result })).toEqual({
      status: "completed",
    });
    const done = (await getJob(db, job.id))!;
    if (done.type === "ralph.cleanup") await onRalphCleanupJobFinished(db, done, ralph());
    else await onRalphJobFinished(db, done, ralph());
  }

  const requestResult = (overrides: Partial<RalphRequestResult> = {}): RalphRequestResult => ({
    summary: "Done.",
    error: null,
    sessionId: "claude-1",
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
    durationMs: 5,
    ...overrides,
  });

  /** A chat run in acme/app whose request opened PR #1 (head `head1`) and completed. */
  async function chatRunWithPullRequest(): Promise<RalphRun> {
    const started = await startChatRequest(ralph(), {
      chatThreadId: chatThread.id,
      repository: "acme/app",
      request: "Fix the typo in the README.",
      quoted: [],
      author: "Ada Lovelace",
      announce: async () => undefined,
    });
    if (started.status !== "started") throw new Error(`not started: ${started.status}`);
    await finish(
      await start(started.run.id, "ralph.request"),
      requestResult({
        summary: "Fixed the typo.",
        pullRequest: { action: "open", title: "Fix the README typo", body: "Fixes a typo." },
      }),
    );
    const run = (await getRun(db, started.run.id))!;
    expect(run.status).toBe("completed");
    expect(scm.changeRequests).toHaveLength(1);
    scm.changeRequests[0]!.headSha = "head1";
    vi.mocked(adapter.postMessage).mockClear();
    vi.mocked(adapter.editMessage).mockClear();
    return run;
  }

  it("reports a CI-fix round in the thread", async () => {
    const run = await chatRunWithPullRequest();
    scm.ciStatuses.set("acme/app#1", {
      state: "failed",
      headSha: "head1",
      failedJobs: [{ id: "1", name: "CI / test", url: JOB_URL, noLog: false }],
    });
    scm.ciJobLogs.set("1", "FAIL test/a.test.ts");

    const res = await webhook("workflow_run", {
      action: "completed",
      workflow_run: {
        head_sha: "head1",
        head_branch: "feature",
        conclusion: "failure",
        pull_requests: [{ number: 1 }],
      },
    });
    expect(await res.json()).toEqual({ status: "accepted", event: "ci_failure" });
    expect(await getMainLane(db, run)).toMatchObject({ ciFixRounds: 1, handledCiShas: ["head1"] });
    // New messages, not edits of the finished request's status message far up the thread:
    // the notice, then the fix's request job status.
    expect(posted()).toEqual([
      "CI failed on the pull request (`head1`: `CI / test`). Working on a fix.",
      "⏳ Working on it\nWorking on your request.",
    ]);
    expect(adapter.editMessage).not.toHaveBeenCalled();

    // The fix runs as a request job with its own status message, then answers in the thread.
    await finish(await start(run.id, "ralph.request"), requestResult({ summary: "Fixed CI." }));
    expect((await getRun(db, run.id))?.status).toBe("completed");
    expect(posted()).toHaveLength(3);
    expect(posted()[2]).toContain("Fixed CI.");

    expect(linearCalls).toEqual([]);
    expect(linearLoads).toBe(0);
  });

  it("reports the cleanup after the merge in the thread and takes its answer from a reply", async () => {
    const run = await chatRunWithPullRequest();
    const branch = (await getMainLane(db, run))!.branch;
    const pr = scm.changeRequests[0]!;
    pr.state = "merged";
    pr.headSha = "a".repeat(40);
    pr.mergeSha = "b".repeat(40);

    const res = await webhook("pull_request", {
      action: "closed",
      pull_request: { number: 1, merged: true },
    });
    expect(await res.json()).toEqual({ status: "accepted", event: "merged" });
    await finish(await start(run.id, "ralph.cleanup"), cleanupResult({ unmerged: 1 }));
    const [merged, question] = posted();
    expect(merged).toContain(`The pull request ${pr.url} was merged, so I removed its worktree`);
    expect(question).toContain(`\`${branch}\` has 1 commit that wasn't merged`);
    expect(posted()).toHaveLength(2);

    // A member's plain reply in the thread answers the question, like a reply in Linear.
    const reactions: string[] = [];
    const thread = {
      id: THREAD_ID,
      async post() {
        throw new Error("the agent shouldn't answer");
      },
      adapter: {
        async addReaction(_threadId: string, _messageId: string, emoji: string) {
          reactions.push(emoji);
        },
      },
    } as unknown as Thread;
    const message = {
      id: "msg-1",
      text: "Delete",
      isMention: false,
      author: { userId: "D1", userName: "ada", fullName: "Ada Lovelace" },
    } as Message;
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const context: ChatConversationContext = {
      organizationId: orgId,
      connection,
      chatThread,
      skipped: [],
      thread,
      message,
      actor: { kind: "member", userId: "ada", role: "member", name: "Ada" },
      logger,
      linkUrl: async () => `${APP_URL}/chat/link?state=s`,
    };
    await createChatAgentHandler({ db, model: null, logger, ralph: async () => ralph() }).handle(
      thread,
      message,
      context,
    );
    expect(reactions).toEqual([SESSION_REACTION]);
    const answer = await start(run.id, "ralph.cleanup");
    expect(RalphCleanupPayload.parse(answer.payload).action).toEqual({
      kind: "branch",
      push: false,
    });
    await finish(answer, cleanupResult({ handled: 1 }));
    expect(posted().at(-1)).toBe(
      `Deleted the local branch \`${branch}\` with its 1 unmerged commit.`,
    );

    expect(linearCalls).toEqual([]);
    expect(linearLoads).toBe(0);
  });

  it("passes an @omniralph fix on its PR to the run and says so in the thread", async () => {
    const run = await chatRunWithPullRequest();
    scm.members.add("maintainer");
    const comments: string[] = [];
    Object.assign(scm, {
      postComment: async (_repo: unknown, _number: number, body: string) => {
        comments.push(body);
      },
    });

    const res = await webhook("issue_comment", {
      action: "created",
      issue: { number: 1, pull_request: {} },
      comment: {
        id: 42,
        body: "@omniralph fix rename the heading",
        user: { login: "maintainer", type: "User" },
      },
    });
    expect(await res.json()).toEqual({ status: "accepted", command: "fix" });
    expect(comments).toEqual([
      "On it, @maintainer: I passed this to ralph's run, which will work on it and push the changes here. Follow along in its chat thread.",
    ]);
    expect(posted()).toEqual([
      "`@maintainer` asked for changes on the pull request. Working through it.",
      "⏳ Working on it\nWorking on your request.",
    ]);
    expect(await activeJobs(run.id, "ralph.request")).toHaveLength(1);

    expect(linearCalls).toEqual([]);
    expect(linearLoads).toBe(0);
  });
  it("asks a session's permission question in the thread, takes the answer and a /ship from replies", async () => {
    const started = await startChatRequest(ralph(), {
      chatThreadId: chatThread.id,
      repository: "acme/app",
      request: "Fix the typo in the README.",
      quoted: [],
      author: "Ada Lovelace",
      announce: async () => undefined,
    });
    if (started.status !== "started") throw new Error(`not started: ${started.status}`);
    const job = await start(started.run.id, "ralph.request");
    vi.mocked(adapter.postMessage).mockClear();

    const requestId = randomUUID();
    expect(
      await askPermission({ db, linear: async () => strictLinear(), chat: chat() }, job, {
        requestId,
        tool: "Bash",
        detail: "git commit -m 'Fix the typo'",
        timeoutSeconds: 1800,
      }),
    ).toEqual({ status: "asked" });
    expect(posted().join("\n")).toContain("I need permission to use **Bash**");

    const reply = (text: string) =>
      sendToChatRun(ralph(), { chatThreadId: chatThread.id, text, author: "Ada Lovelace" });
    expect(await reply("Allow")).toMatchObject({ status: "answered" });
    expect(readPermission(await getRun(db, started.run.id), job, requestId)).toMatchObject({
      status: "allowed",
      answeredBy: "Ada Lovelace",
    });
    expect(posted().at(-1)).toContain("Allowed **Bash**");

    // `/ship` waits for the running session instead of going into it.
    expect(await reply("/ship")).toMatchObject({ status: "queued" });
    // (The running job's own request stays pending until that job finishes.)
    expect((await listPendingRequests(db, started.run.id)).at(-1)).toMatchObject({
      text: "Commit the work on the branch, push it, and open the pull/merge request if there isn't one.",
      ship: true,
      jobId: null,
    });
    // The chat assistant's `ship` flag ships without the `/ship` prefix.
    expect(
      await sendToChatRun(ralph(), {
        chatThreadId: chatThread.id,
        text: "Bump the version first.",
        author: "Ada Lovelace",
        ship: true,
      }),
    ).toMatchObject({ status: "queued" });
    expect((await listPendingRequests(db, started.run.id)).at(-1)).toMatchObject({
      text: "Bump the version first.",
      ship: true,
    });
    expect(linearCalls).toEqual([]);
  });
});
