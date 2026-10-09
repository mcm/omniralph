import {
  appendChatMessage,
  chatMessages,
  closeDb,
  createDb,
  ensureChatThread,
  organizations,
  rateLimits,
  runMigrations,
  saveChatConnection,
  type ChatConnection,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { LanguageModel } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { Logger, Message, Thread } from "chat";
import { asc, eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChatConversationContext } from "../bot";
import type { ChatActor } from "../identity";
import { chatAgentConfig, CHAT_AGENT_MAX_STEPS, DEFAULT_CHAT_AGENT_MODEL } from "./config";
import { defineChatTool, LINK_REQUIRED_RESULT, type ChatToolContext } from "./tools";

vi.mock("server-only", () => ({}));

const { createChatAgentHandler, ERROR_REPLY, NOT_CONFIGURED_REPLY, RATE_LIMITED_REPLY } =
  await import("./handler");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const ENV = { APP_URL: "https://omniralph.example.com" } as unknown as NodeJS.ProcessEnv;
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
type LanguageModelV2CallOptions = Parameters<MockLanguageModelV2["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>;

const textResult = (text: string): GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: "stop",
  usage: USAGE,
  warnings: [],
});
const toolCallResult = (toolName: string, input: unknown, id = "call-1"): GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: "tool-calls",
  usage: USAGE,
  warnings: [],
});

/** A model answering with `results` in turn and recording every call's options. */
function scriptedModel(...results: GenerateResult[]) {
  const calls: LanguageModelV2CallOptions[] = [];
  const model = new MockLanguageModelV2({
    doGenerate: async (options) => {
      calls.push(options);
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      return result!;
    },
  });
  return { model, calls };
}

/** The system prompt and the tool results the model saw in a call. */
const systemOf = (call: LanguageModelV2CallOptions) =>
  call.prompt.find((m) => m.role === "system")?.content as string;
const toolResultsOf = (call: LanguageModelV2CallOptions) =>
  call.prompt.flatMap((m) =>
    m.role === "tool" ? m.content.map((p) => ({ name: p.toolName, output: p.output })) : [],
  );

describe("chatAgentConfig", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

  it("is null without AI Gateway credentials", () => {
    expect(chatAgentConfig(env({}))).toBeNull();
    expect(chatAgentConfig(env({ CHAT_AGENT_MODEL: "x/y" }))).toBeNull();
  });

  it("uses an API key or Vercel's OIDC token, with the default model", () => {
    expect(chatAgentConfig(env({ AI_GATEWAY_API_KEY: "k" }))).toEqual({
      model: DEFAULT_CHAT_AGENT_MODEL,
    });
    expect(chatAgentConfig(env({ VERCEL: "1" }))?.model).toBe("anthropic/claude-haiku-5.5");
    expect(chatAgentConfig(env({ VERCEL_OIDC_TOKEN: "t" }))).not.toBeNull();
    expect(
      chatAgentConfig(env({ AI_GATEWAY_API_KEY: "k", CHAT_AGENT_MODEL: "openai/gpt-5" })),
    ).toEqual({ model: "openai/gpt-5" });
  });
});

describe.skipIf(!dockerAvailable)("control-panel agent", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let connection: ChatConnection;
  let chatThread: ChatThread;
  let posts: string[];
  let ephemerals: Array<{ user: string; text: string }>;
  let threadState: Record<string, unknown> | null;
  let logger: Logger & { error: ReturnType<typeof vi.fn> };

  const thread = () =>
    ({
      id: "discord:G1:CH1:TH1",
      async post(message: string | { markdown: string }) {
        posts.push(typeof message === "string" ? message : message.markdown);
        return {};
      },
      async postEphemeral(user: { userId: string }, text: string) {
        ephemerals.push({ user: user.userId, text });
        return {};
      },
      mentionUser: (id: string) => `<@${id}>`,
      async startTyping() {},
      get state() {
        return Promise.resolve(threadState);
      },
      async setState(state: Record<string, unknown>) {
        threadState = { ...threadState, ...state };
      },
    }) as unknown as Thread;

  const message = (text: string, userId = "D1") =>
    ({ text, author: { userId, userName: `user-${userId}`, fullName: "Ada Lovelace" } }) as Message;

  /** Records `text` as the user's message (as the bot does) and runs the agent's turn. */
  async function turn(
    handler: ReturnType<typeof createChatAgentHandler>,
    text: string,
    actor: ChatActor,
    userId = "D1",
  ) {
    await appendChatMessage(db, {
      threadId: chatThread.id,
      role: "user",
      externalUserId: userId,
      authorName: "Ada Lovelace",
      content: text,
    });
    const t = thread();
    const m = message(text, userId);
    const context: ChatConversationContext = {
      organizationId: orgId,
      connection,
      chatThread,
      skipped: [],
      thread: t,
      message: m,
      actor,
      linkUrl: async () => "https://omniralph.example.com/chat/link?state=s",
    };
    await handler.handle(t, m, context);
  }

  const recorded = () =>
    db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, chatThread.id))
      .orderBy(asc(chatMessages.createdAt));

  const member: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
  const domain: ChatActor = { kind: "domain", email: "ada@acme.test" };
  const unlinked: ChatActor = { kind: "unlinked" };

  /** A `read` and an `action` tool that record their calls. */
  const toolCalls: Array<{ name: string; input: unknown; context: ChatToolContext }> = [];
  const tools = {
    list_runs: defineChatTool({
      tier: "read",
      description: "Lists ralph runs.",
      inputSchema: z.object({ status: z.string() }),
      async execute(input, context) {
        toolCalls.push({ name: "list_runs", input, context });
        return { runs: [{ id: "run-1", status: input.status }] };
      },
    }),
    start_run: defineChatTool({
      tier: "action",
      description: "Starts a ralph run.",
      inputSchema: z.object({ issue: z.string() }),
      async execute(input, context) {
        toolCalls.push({ name: "start_run", input, context });
        return { started: true };
      },
    }),
  };

  const build = (
    model: LanguageModel | null,
    extra: Partial<Parameters<typeof createChatAgentHandler>[0]> = {},
  ) => createChatAgentHandler({ db, model, tools, logger, env: ENV, ...extra });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    const saved = await saveChatConnection(db, {
      organizationId: orgId,
      platform: "discord",
      externalId: "G1",
      name: "Acme server",
      credentials: null,
      installedByUserId: null,
    });
    if (saved === "other_organization") throw new Error("taken");
    connection = saved;
  });

  beforeEach(async () => {
    await db.execute("DELETE FROM chat_threads");
    await db.delete(rateLimits);
    chatThread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: "discord:G1:CH1:TH1",
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D1",
    }))!;
    posts = [];
    ephemerals = [];
    threadState = null;
    toolCalls.length = 0;
    logger = {
      child: () => logger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as typeof logger;
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("answers in plain text with the thread's history and a system prompt", async () => {
    for (let i = 0; i < 56; i += 1) {
      await appendChatMessage(db, {
        threadId: chatThread.id,
        role: i % 2 ? "assistant" : "user",
        externalUserId: i % 2 ? null : "D2",
        authorName: i % 2 ? null : "Grace",
        content: `old ${i}`,
      });
    }
    const { model, calls } = scriptedModel(
      textResult("Two runs are active. See [the runs](https://omniralph.example.com/runs)."),
    );
    await turn(build(model), "what ralph runs are active?", member);

    // Links to the control panel stay links (the sanitizer brackets their target).
    expect(posts).toEqual([
      "Two runs are active. See [the runs](<https://omniralph.example.com/runs>).",
    ]);
    expect(calls).toHaveLength(1);
    const system = systemOf(calls[0]!);
    expect(system).toContain('organization "Acme"');
    expect(system).toContain("Ada Lovelace");
    expect(system).toContain("linked member of the organization (role: member)");
    expect(system).toContain("https://omniralph.example.com");
    // The last 50 messages, starting at a user message (old 7, an assistant message, is dropped).
    const prompt = calls[0]!.prompt.filter((m) => m.role !== "system");
    expect(prompt).toHaveLength(49);
    expect(prompt[0]).toMatchObject({ role: "user", content: [{ text: "Grace: old 8" }] });
    expect(prompt.at(-1)).toMatchObject({
      role: "user",
      content: [{ text: "Ada Lovelace: what ralph runs are active?" }],
    });
    expect(calls[0]!.tools?.map((t) => t.name)).toEqual(["list_runs", "start_run"]);
    expect((await recorded()).at(-1)).toMatchObject({ role: "assistant" });
    expect(ephemerals).toEqual([]);
  });

  it("sanitizes the reply: foreign links and mentions are neutralized", async () => {
    const { model } = scriptedModel(textResult("Click [here](https://evil.example/x) @everyone"));
    await turn(build(model), "hi", member);
    expect(posts[0]).not.toContain("](https://evil.example");
    expect(posts[0]).toContain("`@everyone`");
    const last = (await recorded()).at(-1)!;
    expect(JSON.stringify(last.content)).toContain("`@everyone`");
  });

  it("runs a tool round-trip with the connection's organization and records it", async () => {
    const { model, calls } = scriptedModel(
      toolCallResult("list_runs", { status: "running", organizationId: otherOrgId }),
      textResult("run-1 is running."),
    );
    await turn(build(model), "what is running?", member);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe("list_runs");
    expect(toolCalls[0]!.context.organizationId).toBe(orgId);
    expect(toolCalls[0]!.context.db).toBe(db);
    expect(toolCalls[0]!.context.actor).toBe(member);
    expect(toolCalls[0]!.context.thread.id).toBe("discord:G1:CH1:TH1");
    expect(calls).toHaveLength(2);
    expect(toolResultsOf(calls[1]!)).toEqual([
      {
        name: "list_runs",
        output: { type: "json", value: { runs: [{ id: "run-1", status: "running" }] } },
      },
    ]);
    expect(posts).toEqual(["run-1 is running."]);
    const roles = (await recorded()).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    const [, toolCall, toolResult] = await recorded();
    expect(JSON.stringify(toolCall!.content)).toContain('"toolName":"list_runs"');
    expect(JSON.stringify(toolResult!.content)).toContain("run-1");
  });

  it("caps the tool loop at 8 steps", async () => {
    const { model, calls } = scriptedModel(toolCallResult("list_runs", { status: "running" }));
    await turn(build(model), "loop forever", member);
    expect(calls).toHaveLength(CHAT_AGENT_MAX_STEPS);
    expect(posts).toHaveLength(1);
  });

  it("refuses an action tool to a domain user and posts the link", async () => {
    const { model, calls } = scriptedModel(
      toolCallResult("start_run", { issue: "TOOL-1" }),
      textResult("You need to link your account first."),
    );
    await turn(build(model), "start TOOL-1", domain);

    expect(toolCalls).toEqual([]);
    expect(toolResultsOf(calls[1]!)).toEqual([
      { name: "start_run", output: { type: "json", value: LINK_REQUIRED_RESULT } },
    ]);
    expect(systemOf(calls[0]!)).toContain("read-only tools");
    expect(posts).toEqual(["You need to link your account first."]);
    expect(ephemerals).toEqual([
      { user: "D1", text: expect.stringContaining("/chat/link?state=s") },
    ]);
  });

  it("lets a domain user use read tools", async () => {
    const { model } = scriptedModel(
      toolCallResult("list_runs", { status: "running" }),
      textResult("run-1."),
    );
    await turn(build(model), "runs?", domain);
    expect(toolCalls.map((c) => c.name)).toEqual(["list_runs"]);
    expect(ephemerals).toEqual([]);
  });

  it("gives an unlinked user a turn with no tools and the link", async () => {
    const { model, calls } = scriptedModel(textResult("Please link your account first."));
    await turn(build(model), "what is running?", unlinked);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tools ?? []).toEqual([]);
    expect(systemOf(calls[0]!)).toContain("not linked to an Omniralph account");
    expect(posts).toEqual(["Please link your account first."]);
    expect(ephemerals).toEqual([
      { user: "D1", text: expect.stringContaining("/chat/link?state=s") },
    ]);
  });

  it("says once per thread that it isn't configured", async () => {
    const handler = build(null);
    await turn(handler, "hello?", member);
    await turn(handler, "anyone?", member);
    expect(posts).toEqual([NOT_CONFIGURED_REPLY]);
    expect((await recorded()).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("rate-limits turns per chat user and says so once", async () => {
    const { model, calls } = scriptedModel(textResult("ok"));
    const handler = build(model, {
      rateLimits: {
        perChatUser: (org, platform, user) => ({
          key: `test:user:${org}:${platform}:${user}`,
          limit: 1,
          windowSeconds: 60,
        }),
        perOrganization: (org) => ({ key: `test:org:${org}`, limit: 100, windowSeconds: 60 }),
      },
    });
    await turn(handler, "one", member);
    await turn(handler, "two", member);
    await turn(handler, "three", member);
    expect(calls).toHaveLength(1);
    expect(posts).toEqual(["ok", RATE_LIMITED_REPLY]);
    // Another user still gets answers.
    await turn(handler, "four", member, "D2");
    expect(calls).toHaveLength(2);
  });

  it("rate-limits turns per organization", async () => {
    const { model, calls } = scriptedModel(textResult("ok"));
    const handler = build(model, {
      rateLimits: {
        perChatUser: (org, platform, user) => ({
          key: `test:user:${org}:${platform}:${user}`,
          limit: 100,
          windowSeconds: 60,
        }),
        perOrganization: (org) => ({ key: `test:org:${org}`, limit: 1, windowSeconds: 60 }),
      },
    });
    await turn(handler, "one", member, "D1");
    await turn(handler, "two", member, "D2");
    expect(calls).toHaveLength(1);
    expect(posts).toEqual(["ok", RATE_LIMITED_REPLY]);
  });

  it("apologizes for a model error without leaking it and logs it", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        throw new Error("gateway exploded: secret-token-123");
      },
    });
    await turn(build(model), "hi", member);
    expect(posts).toEqual([ERROR_REPLY]);
    expect(posts.join()).not.toContain("secret-token-123");
    expect(logger.error).toHaveBeenCalledWith(
      "Chat agent turn failed",
      expect.objectContaining({ organizationId: orgId }),
    );
  });
});
