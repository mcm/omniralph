import { randomBytes } from "node:crypto";
import {
  harnesses,
  appendChatMessage,
  closeDb,
  connectRepository,
  createDb,
  createReview,
  createRun,
  ensureChatThread,
  findings,
  getMainLane,
  insertJob,
  organizations,
  repositories,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  updateLane,
  upsertScmConnection,
  upsertStories,
  type Database,
  type RalphRunStatus,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV2 } from "ai/test";
import type { Message, Thread } from "chat";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatConversationContext } from "../bot";
import type { ChatActor } from "../identity";
import type { ChatToolContext } from "./tools";

vi.mock("server-only", () => ({}));

const { CHAT_TOOL_RESULT_LIMIT, readTools } = await import("./read-tools");
const { chatTools } = await import("./registry");
const { createChatAgentHandler } = await import("./handler");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const APP_URL = "https://omniralph.example.com";
const member: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
const domain: ChatActor = { kind: "domain", email: "ada@acme.test" };

interface SeededOrg {
  id: string;
  repositoryId: string;
  fullPath: string;
  activeRunId: string;
  doneRunId: string;
  reviewId: string;
  jobId: string;
  harnessId: string;
}

/** A tool's result as a loose record. */
type Result = Record<string, unknown> & { [key: string]: unknown };

describe.skipIf(!dockerAvailable)("control-panel agent read tools", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let acme: SeededOrg;
  let other: SeededOrg;
  let crowdedOrgId: string;

  const context = (organizationId: string, actor: ChatActor = member): ChatToolContext => ({
    db,
    organizationId,
    connection: { id: "00000000-0000-4000-8000-000000000000", organizationId },
    actor,
    requesterExternalUserId: "U-ADA",
    thread: {} as Thread,
    appUrl: APP_URL,
    chatThread: {} as ChatToolContext["chatThread"],
    turnMessages: [],
    ralph: () => Promise.reject(new Error("no ralph in read tools")),
    handedOff: () => undefined,
  });

  async function call(name: string, input: unknown, organizationId: string): Promise<Result> {
    const tool = readTools[name]!;
    return (await tool.execute(tool.inputSchema.parse(input), context(organizationId))) as Result;
  }

  /** An organization with a ralph-enabled repository, an active and a finished run of `ENG-1`, a review, a job and an agent. */
  async function seedOrg(name: string, slug: string): Promise<SeededOrg> {
    const [org] = await db.insert(organizations).values({ name }).returning();
    const id = org!.id;
    await seedReviewProfiles(db, id);
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: id,
        provider: "github",
        name: slug,
        baseUrl: "https://api.github.com",
        externalId: `conn-${slug}`,
        credentials: {},
      },
      key,
    ))!;
    const fullPath = `${slug}/api`;
    const repository = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: `repo-${slug}`,
      fullPath,
    });
    await db
      .update(repositories)
      .set({ ralphEnabled: true })
      .where(eq(repositories.id, repository.id));
    const [agent] = await db
      .insert(harnesses)
      .values({
        organizationId: id,
        name: `${slug}-agent`,
        reportedVersion: "1.2.3",
        lastHeartbeatAt: new Date(),
      })
      .returning();

    const run = async (n: number, status: RalphRunStatus) =>
      (
        await createRun(db, {
          organizationId: id,
          linearIssueId: `${slug}-issue-${n}`,
          linearIdentifier: n === 1 ? "ENG-1" : `ENG-${n}`,
          linearTitle: `${name} epic ${n}`,
          linearAgentSessionId: `${slug}-session-${n}`,
          kind: "children",
          repositoryId: repository.id,
          branch: `${slug}/eng-${n}`,
          baseBranch: "main",
          status,
        })
      ).run;
    // The finished run is older: `ENG-1` names the active one.
    const doneRun = await run(2, "completed");
    const activeRun = await run(1, "running");
    await upsertStories(db, activeRun.id, [
      { linearIssueId: `${slug}-s1`, identifier: "ENG-11", title: `${name} story one` },
      { linearIssueId: `${slug}-s2`, identifier: "ENG-12", title: `${name} story two` },
    ]);
    const lane = (await getMainLane(db, activeRun))!;
    await updateLane(db, lane.id, {
      prNumber: 7,
      prUrl: `https://github.com/${fullPath}/pull/7`,
    });

    const review = await createReview(db, {
      repositoryId: repository.id,
      prNumber: 7,
      prTitle: `${name} PR`,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook",
      profileId: "standard",
      model: "test-model",
      budget: 1000,
    });
    await db.insert(findings).values({
      reviewId: review.id,
      path: "src/index.ts",
      startLine: 3,
      endLine: 5,
      severity: "high",
      category: "bug",
      title: `${name} finding`,
      body: "Body",
      confidence: 0.9,
    });
    const { job } = await insertJob(db, {
      organizationId: id,
      type: "review.task",
      taskType: "review",
      pool: "short",
      repositoryId: repository.id,
      payload: { prNumber: 7 },
    });
    return {
      id,
      repositoryId: repository.id,
      fullPath,
      activeRunId: activeRun.id,
      doneRunId: doneRun.id,
      reviewId: review.id,
      jobId: job.id,
      harnessId: agent!.id,
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    acme = await seedOrg("Acme", "acme");
    other = await seedOrg("Other", "other");

    // An organization with more of everything than a tool returns.
    const [crowded] = await db.insert(organizations).values({ name: "Crowded" }).returning();
    crowdedOrgId = crowded!.id;
    for (let n = 1; n <= CHAT_TOOL_RESULT_LIMIT + 3; n += 1) {
      await createRun(db, {
        organizationId: crowdedOrgId,
        linearIssueId: `crowded-issue-${n}`,
        linearIdentifier: `BIG-${n}`,
        linearAgentSessionId: `crowded-session-${n}`,
        kind: "single",
        repositoryId: null,
        status: "pending",
      });
      await insertJob(db, {
        organizationId: crowdedOrgId,
        type: "ralph.story",
        taskType: "coding",
        pool: "long",
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("registers the read tools as `read` and the ralph and Linear tools as `action`", () => {
    expect(Object.keys(chatTools)).toEqual([
      "list_ralph_runs",
      "get_ralph_run",
      "list_reviews",
      "get_review",
      "list_jobs",
      "list_harnesses",
      "list_repositories",
      "ask_about_code",
      "start_work",
      "send_to_session",
      "send_ralph_guidance",
      "draft_linear_issue",
      "delegate_linear_issue",
    ]);
    expect(Object.values(readTools).every((t) => t.tier === "read")).toBe(true);
    expect(chatTools.start_work?.tier).toBe("action");
    expect(chatTools.start_ralph_request).toBeUndefined();
    expect(chatTools.send_to_session?.tier).toBe("action");
    expect(chatTools.draft_linear_issue?.tier).toBe("action");
    expect(chatTools.delegate_linear_issue?.tier).toBe("action");
  });

  it("list_ralph_runs returns only the organization's runs, filtered, with URLs", async () => {
    for (const [org, foreign] of [
      [acme, other],
      [other, acme],
    ] as const) {
      const all = await call("list_ralph_runs", {}, org.id);
      const runs = all.runs as Array<Result>;
      expect(runs.map((r) => r.id)).toEqual([org.activeRunId, org.doneRunId]);
      expect(runs[0]).toMatchObject({
        url: `${APP_URL}/ralph/${org.activeRunId}`,
        linearIssue: "ENG-1",
        status: "running",
        repository: org.fullPath,
        stories: { total: 2, completed: 0 },
        pullRequest: { number: 7, label: "#7" },
      });
      expect(all).toMatchObject({ shown: 2, total: 2, more: false });
      expect(all).not.toHaveProperty("note");

      const active = await call("list_ralph_runs", { status: "active" }, org.id);
      expect((active.runs as Result[]).map((r) => r.id)).toEqual([org.activeRunId]);
      const done = await call(
        "list_ralph_runs",
        { status: "completed", repository: org.fullPath.toUpperCase() },
        org.id,
      );
      expect((done.runs as Result[]).map((r) => r.id)).toEqual([org.doneRunId]);
      // Another organization's repository is unknown, by path or by id.
      for (const repository of [foreign.fullPath, foreign.repositoryId]) {
        expect(await call("list_ralph_runs", { repository }, org.id)).toMatchObject({
          error: "unknown_repository",
        });
      }
    }
  });

  it("get_ralph_run finds the organization's run by id or Linear identifier only", async () => {
    const byIdentifier = await call("get_ralph_run", { run: "eng-1" }, acme.id);
    expect(byIdentifier).toMatchObject({
      id: acme.activeRunId,
      url: `${APP_URL}/ralph/${acme.activeRunId}`,
      title: "Acme epic 1",
      status: "running",
      pullRequest: { number: 7, url: "https://github.com/acme/api/pull/7" },
      lanes: [{ repository: "acme/api", main: true, pullRequest: { number: 7 } }],
      storyCounts: { total: 2, completed: 0 },
      stories: [
        { identifier: "ENG-11", title: "Acme story one", status: "pending" },
        { identifier: "ENG-12", title: "Acme story two", status: "pending" },
      ],
    });
    expect(await call("get_ralph_run", { run: acme.doneRunId }, acme.id)).toMatchObject({
      id: acme.doneRunId,
      status: "completed",
    });
    expect(await call("get_ralph_run", { run: other.activeRunId }, acme.id)).toMatchObject({
      error: "not_found",
    });
    expect(await call("get_ralph_run", { run: "ENG-1" }, other.id)).toMatchObject({
      id: other.activeRunId,
      title: "Other epic 1",
    });
  });

  it("list_reviews and get_review return only the organization's reviews", async () => {
    const list = await call("list_reviews", {}, acme.id);
    expect(list.reviews).toEqual([
      expect.objectContaining({
        id: acme.reviewId,
        url: `${APP_URL}/reviews/${acme.reviewId}`,
        repository: "acme/api",
        prNumber: 7,
        prUrl: "https://github.com/acme/api/pull/7",
        findingCounts: expect.objectContaining({ high: 1 }),
      }),
    ]);
    expect(list).toMatchObject({ total: 1, more: false });
    const byPr = await call("list_reviews", { repository: "acme/api", prNumber: 7 }, acme.id);
    expect((byPr.reviews as Result[]).map((r) => r.id)).toEqual([acme.reviewId]);
    const otherPr = await call("list_reviews", { prNumber: 8 }, acme.id);
    expect(otherPr.reviews).toEqual([]);
    expect(await call("list_reviews", { repository: "other/api" }, acme.id)).toMatchObject({
      error: "unknown_repository",
    });

    expect(await call("get_review", { review: acme.reviewId }, acme.id)).toMatchObject({
      id: acme.reviewId,
      url: `${APP_URL}/reviews/${acme.reviewId}`,
      prTitle: "Acme PR",
      findingCount: 1,
      findings: [{ path: "src/index.ts", lines: "3-5", severity: "high", title: "Acme finding" }],
    });
    expect(await call("get_review", { review: other.reviewId }, acme.id)).toMatchObject({
      error: "not_found",
    });
    expect(await call("get_review", { review: "not-an-id" }, acme.id)).toMatchObject({
      error: "not_found",
    });
  });

  it("list_jobs returns only the organization's jobs, filtered by status and type", async () => {
    const list = await call("list_jobs", {}, acme.id);
    expect(list.jobs).toEqual([
      expect.objectContaining({
        id: acme.jobId,
        url: `${APP_URL}/jobs#job-${acme.jobId}`,
        type: "review.task",
        status: "queued",
        target: { label: "acme/api#7", url: "https://github.com/acme/api/pull/7" },
        harness: null,
      }),
    ]);
    expect(list).toMatchObject({ shown: 1, more: false });
    const queuedReviews = await call(
      "list_jobs",
      { status: "queued", type: "review.task" },
      acme.id,
    );
    expect((queuedReviews.jobs as Result[]).map((j) => j.id)).toEqual([acme.jobId]);
    expect((await call("list_jobs", { status: "running" }, acme.id)).jobs).toEqual([]);
    expect((await call("list_jobs", { type: "ralph.story" }, acme.id)).jobs).toEqual([]);
  });

  it("list_harnesses returns only the organization's harnesses", async () => {
    const list = await call("list_harnesses", {}, acme.id);
    expect(list.harnesses).toEqual([
      expect.objectContaining({
        id: acme.harnessId,
        url: `${APP_URL}/harnesses/${acme.harnessId}`,
        name: "acme-agent",
        status: "online",
        version: "1.2.3",
        lastHeartbeatAt: expect.any(String),
      }),
    ]);
    expect(list).toMatchObject({ shown: 1, total: 1, more: false });
  });

  it("list_repositories returns only the organization's repositories", async () => {
    const list = await call("list_repositories", {}, other.id);
    expect(list.repositories).toEqual([
      expect.objectContaining({
        id: other.repositoryId,
        url: `${APP_URL}/repositories/${other.repositoryId}/settings`,
        fullPath: "other/api",
        webUrl: "https://github.com/other/api",
        reviewsEnabled: true,
        ralphEnabled: true,
        reviewProfile: expect.any(String),
      }),
    ]);
    expect(list).toMatchObject({ shown: 1, total: 1, more: false });
  });

  it(`caps lists at ${CHAT_TOOL_RESULT_LIMIT} items and says when more exist`, async () => {
    const runs = await call("list_ralph_runs", {}, crowdedOrgId);
    expect(runs.runs).toHaveLength(CHAT_TOOL_RESULT_LIMIT);
    expect(runs).toMatchObject({
      shown: CHAT_TOOL_RESULT_LIMIT,
      total: CHAT_TOOL_RESULT_LIMIT + 3,
      more: true,
      note: expect.stringContaining(`${APP_URL}/ralph`),
    });
    const jobs = await call("list_jobs", { type: "ralph.story" }, crowdedOrgId);
    expect(jobs.jobs).toHaveLength(CHAT_TOOL_RESULT_LIMIT);
    expect(jobs).toMatchObject({ more: true, note: expect.stringContaining(`${APP_URL}/jobs`) });
    expect(jobs).not.toHaveProperty("total");
  });

  it('answers "which runs are active?" through list_ralph_runs', async () => {
    const saved = await saveChatConnection(db, {
      organizationId: acme.id,
      platform: "slack",
      externalId: "T-ACME",
      name: "Acme workspace",
      credentials: null,
      installedByUserId: null,
    });
    if (saved === "other_organization") throw new Error("taken");
    const chatThread = (await ensureChatThread(db, {
      connectionId: saved.id,
      externalThreadId: "slack:C1:1.0",
      channelId: "slack:C1",
      startedByExternalUserId: "U1",
    }))!;
    const text = "which runs are active?";
    await appendChatMessage(db, {
      threadId: chatThread.id,
      role: "user",
      externalUserId: "U1",
      authorName: "Ada",
      content: text,
    });

    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    const calls: Parameters<MockLanguageModelV2["doGenerate"]>[0][] = [];
    const model = new MockLanguageModelV2({
      doGenerate: async (options) => {
        calls.push(options);
        if (calls.length === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "list_ralph_runs",
                // An organization in the model's input is ignored.
                input: JSON.stringify({ status: "active", organizationId: other.id }),
              },
            ],
            finishReason: "tool-calls",
            usage,
            warnings: [],
          };
        }
        const toolOutput = JSON.stringify(
          options.prompt.flatMap((m) => (m.role === "tool" ? m.content : [])),
        );
        const url = toolOutput.match(/https:\/\/omniralph\.example\.com\/ralph\/[0-9a-f-]+/)![0];
        return {
          content: [{ type: "text", text: `One run is active: [ENG-1](${url}).` }],
          finishReason: "stop",
          usage,
          warnings: [],
        };
      },
    });

    const posts: string[] = [];
    const thread = {
      id: "slack:C1:1.0",
      async post(message: string | { markdown: string }) {
        posts.push(typeof message === "string" ? message : message.markdown);
        return {};
      },
      async postEphemeral() {
        return {};
      },
      mentionUser: (id: string) => `<@${id}>`,
      async startTyping() {},
      state: Promise.resolve(null),
      async setState() {},
    } as unknown as Thread;
    const message = { text, author: { userId: "U1", userName: "ada", fullName: "Ada" } } as Message;
    const conversation: ChatConversationContext = {
      organizationId: acme.id,
      connection: saved,
      chatThread,
      skipped: [],
      thread,
      message,
      actor: domain,
      linkUrl: async () => `${APP_URL}/chat/link?state=s`,
    };
    await createChatAgentHandler({
      db,
      model,
      env: { APP_URL } as unknown as NodeJS.ProcessEnv,
    }).handle(thread, message, conversation);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.tools?.map((t) => t.name)).toContain("list_ralph_runs");
    const toolOutput = JSON.stringify(
      calls[1]!.prompt.flatMap((m) => (m.role === "tool" ? m.content : [])),
    );
    expect(toolOutput).toContain(acme.activeRunId);
    expect(toolOutput).not.toContain(acme.doneRunId);
    expect(toolOutput).not.toContain(other.activeRunId);
    expect(posts).toEqual([`One run is active: [ENG-1](<${APP_URL}/ralph/${acme.activeRunId}>).`]);
  });
});
