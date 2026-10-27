import { randomBytes } from "node:crypto";
import { createMockAdapter, createMockLogger, createMockState } from "@chat-adapter/tests";
import {
  appendChatMessage,
  chatMessages,
  chatRequestDrafts,
  chatWebMessages,
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createWebChatThread,
  ensureChatThread,
  getChatRequestDraft,
  getRepository,
  integrations,
  organizationMembers,
  organizations,
  ralphRuns,
  saveChatConnection,
  saveIntegration,
  saveWorkItemMatch,
  upsertScmConnection,
  users,
  workItemEvents,
  workItemMatches,
  type ChatConnection,
  type ChatRequestDraft,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import type * as Changes from "@omniralph/db/changes";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import type { ActionEvent, Adapter, CardElement, Logger, Message, Thread } from "chat";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRequestDraftValue, requestDraftAddValue, type RequestDraftView } from "@/lib/api/ask";
import { fakeWorkItemTracker, type FakeWorkItemTracker } from "@/lib/testing/work-item-tracker";
import type * as ChatStart from "@/lib/ralph/chat-start";
import type { RalphDeps } from "@/lib/ralph/run";
import type { ChatConversationContext } from "./bot";
import type { ChatActor } from "./identity";
import type { ChatToolContext } from "./agent/tools";

vi.mock("server-only", () => ({}));
// `askCardAction` throws the API's errors; nothing here signs in.
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
// Called through, so a test can count the change events a click records.
vi.mock("@omniralph/db/changes", async (importOriginal) => {
  const actual = await importOriginal<typeof Changes>();
  return { ...actual, recordChange: vi.fn(actual.recordChange) };
});
// Called through, so a test can see what a click starts (or start it without an agent).
vi.mock("@/lib/ralph/chat-start", async (importOriginal) => {
  const actual = await importOriginal<typeof ChatStart>();
  return { ...actual, startChatRequest: vi.fn(actual.startChatRequest) };
});
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
const { recordChange } = await import("@omniralph/db/changes");
const { startChatRequest } = await import("@/lib/ralph/chat-start");

const {
  ADD_REQUEST_DRAFT_ACTION,
  ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION,
  ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION,
  DISMISS_REQUEST_DRAFT_ACTION,
  NOT_REQUESTER_TEXT,
  REQUEST_DRAFT_TTL_MS,
  START_REQUEST_DRAFT_ACTION,
  requestDraftCard,
  requestDraftView,
} = await import("./request-draft");
const { RUN_ACTIVE_TEXT, handleRequestDraftAction } = await import("./request-draft-actions");
const { chatTools } = await import("./agent/registry");
const { LINK_REQUIRED_RESULT } = await import("./agent/tools");
const { createChatAgentHandler } = await import("./agent/handler");
const { createChatBot } = await import("./bot");
const { handleWebMessage, webCardRef } = await import("./web-adapter");
const { webEventStream } = await import("./web-stream");
const { askCardAction } = await import("@/lib/ask/actions");

const databaseAvailable = testDatabaseAvailable();

const APP_URL = "https://omniralph.example.com";
const ENV = { APP_URL, AUTH_SECRET: "test-auth-secret" } as unknown as NodeJS.ProcessEnv;
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-27T12:00:00Z");

const silent = {
  child: () => silent,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const repository = { id: "repo-1", provider: "github" as const, fullPath: "acme/customer-portal" };

/** A stored draft with `overrides`. */
const draftOf = (overrides: Partial<ChatRequestDraft> = {}) => ({
  id: DRAFT_ID,
  title: "Retry webhooks on 5xx",
  status: "pending" as ChatRequestDraft["status"],
  expiresAt: new Date(NOW.getTime() + REQUEST_DRAFT_TTL_MS),
  triageNow: null,
  error: null,
  ralphRunId: null,
  workItemTracker: null,
  workItemIdentifier: null,
  workItemUrl: null,
  ...overrides,
});

const contextOf = (overrides: { backlog?: boolean; platform?: "web" | "slack" } = {}) => ({
  repository,
  backlog: overrides.backlog ?? true,
  platform: overrides.platform ?? "slack",
  appUrl: APP_URL,
  now: NOW,
});

const labels = (view: RequestDraftView) => view.actions.map((a) => a.label);

describe("requestDraftView", () => {
  it("offers Start request, Add to backlog and Not now while pending", () => {
    const view = requestDraftView(draftOf(), contextOf());
    expect(view).toEqual({
      id: DRAFT_ID,
      status: "pending",
      title: "Retry webhooks on 5xx",
      repository,
      triageChoice: "follow_up",
      question: null,
      actions: [
        { id: START_REQUEST_DRAFT_ACTION, label: "Start request", value: DRAFT_ID, style: "solid" },
        {
          id: ADD_REQUEST_DRAFT_ACTION,
          label: "Add to backlog",
          value: DRAFT_ID,
          style: "outline",
        },
        { id: DISMISS_REQUEST_DRAFT_ACTION, label: "Not now", value: DRAFT_ID, style: "ghost" },
      ],
      outcome: null,
      error: null,
    });
  });

  it("leaves Add to backlog out when the repo has no work item match or its tracker isn't connected", () => {
    expect(labels(requestDraftView(draftOf(), contextOf({ backlog: false })))).toEqual([
      "Start request",
      "Not now",
    ]);
  });

  it("asks about triage inline on the web, after the click elsewhere", () => {
    expect(requestDraftView(draftOf(), contextOf({ platform: "web" })).triageChoice).toBe("inline");
    expect(requestDraftView(draftOf(), contextOf()).triageChoice).toBe("follow_up");
  });

  it("asks Triage it now? on Slack and Discord after Add to backlog", () => {
    const view = requestDraftView(draftOf(), contextOf(), { askTriage: true });
    expect(view).toMatchObject({
      status: "pending",
      triageChoice: "follow_up",
      question: "Triage it now?",
      actions: [
        {
          id: ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION,
          label: "Triage now",
          value: DRAFT_ID,
          style: "solid",
        },
        {
          id: ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION,
          label: "Add without triage",
          value: DRAFT_ID,
          style: "outline",
        },
      ],
      outcome: null,
    });
    // Not once the repo can't take work items, nor for a draft that can't be acted on.
    expect(
      requestDraftView(draftOf(), contextOf({ backlog: false }), { askTriage: true }),
    ).toMatchObject({
      question: null,
      actions: [{ label: "Start request" }, { label: "Not now" }],
    });
    expect(
      requestDraftView(draftOf({ status: "dismissed" }), contextOf(), { askTriage: true }),
    ).toMatchObject({ question: null, actions: [] });
  });

  it("keeps the buttons and shows why the last click didn't go through", () => {
    const view = requestDraftView(
      draftOf({ error: "Coding is off for customer-portal." }),
      contextOf(),
    );
    expect(view.error).toBe("Coding is off for customer-portal.");
    expect(labels(view)).toEqual(["Start request", "Add to backlog", "Not now"]);
  });

  it.each(["starting", "adding"] as const)("shows no buttons and no outcome while %s", (status) => {
    const view = requestDraftView(draftOf({ status, error: "old" }), contextOf());
    expect(view).toMatchObject({ status, actions: [], outcome: null, error: null });
  });

  it("links the run once started", () => {
    const view = requestDraftView(draftOf({ status: "started", ralphRunId: RUN_ID }), contextOf());
    expect(view.actions).toEqual([]);
    expect(view.outcome).toEqual({
      kind: "started",
      text: "Request started",
      run: { id: RUN_ID, url: `${APP_URL}/runs/${RUN_ID}` },
      workItem: null,
    });
  });

  it("shows the work item once added, and that Om triages it when triaged now", () => {
    const added = draftOf({
      status: "added",
      workItemTracker: "linear",
      workItemIdentifier: "ENG-42",
      workItemUrl: "https://linear.app/acme/issue/ENG-42",
    });
    expect(requestDraftView(added, contextOf()).outcome).toEqual({
      kind: "added",
      text: "Added to the backlog",
      run: null,
      workItem: {
        tracker: "linear",
        identifier: "ENG-42",
        url: "https://linear.app/acme/issue/ENG-42",
      },
    });
    expect(requestDraftView({ ...added, triageNow: true }, contextOf()).outcome?.text).toBe(
      "Added to the backlog · Om is triaging it",
    );
  });

  it("says Not now once dismissed", () => {
    const view = requestDraftView(draftOf({ status: "dismissed" }), contextOf());
    expect(view).toMatchObject({ actions: [], outcome: { kind: "dismissed", text: "Not now" } });
  });

  it("says the draft expired, also for a pending draft past its 24 hours", () => {
    for (const draft of [
      draftOf({ status: "expired" }),
      draftOf({ expiresAt: new Date(NOW.getTime() - 1) }),
    ]) {
      expect(requestDraftView(draft, contextOf())).toMatchObject({
        status: "expired",
        actions: [],
        outcome: { kind: "expired", text: "This draft expired" },
      });
    }
  });

  it("sanitizes the model's title", () => {
    const view = requestDraftView(
      draftOf({ title: "Fix it <img src=x onerror=alert(1)>" }),
      contextOf(),
    );
    expect(view.title).not.toContain("<img");
  });
});

describe("request draft button values", () => {
  it("carry the draft's ID, and on the web's Add to backlog the Triage now choice", () => {
    expect(parseRequestDraftValue(DRAFT_ID)).toEqual({ draftId: DRAFT_ID, triageNow: null });
    expect(parseRequestDraftValue(requestDraftAddValue(DRAFT_ID, true))).toEqual({
      draftId: DRAFT_ID,
      triageNow: true,
    });
    expect(parseRequestDraftValue(requestDraftAddValue(DRAFT_ID, false))).toEqual({
      draftId: DRAFT_ID,
      triageNow: false,
    });
    for (const value of ["", "nope", `${DRAFT_ID}:maybe`, `${DRAFT_ID}:triage:x`]) {
      expect(parseRequestDraftValue(value)).toBeNull();
    }
  });
});

describe("requestDraftCard", () => {
  const card = (draft: Partial<ChatRequestDraft>, context = contextOf()) =>
    requestDraftCard(requestDraftView(draftOf(draft), context));

  it("renders a pending draft with its buttons", () => {
    expect(card({})).toMatchSnapshot();
    expect(card({}, contextOf({ backlog: false }))).toMatchSnapshot();
  });

  it("asks Triage it now? with Triage now and Add without triage", () => {
    expect(
      requestDraftCard(requestDraftView(draftOf(), contextOf(), { askTriage: true })),
    ).toMatchSnapshot();
  });

  it("renders a refusal above the buttons", () => {
    expect(card({ error: "Coding is off for customer-portal." })).toMatchSnapshot();
  });

  it("renders each outcome instead of the buttons", () => {
    expect(card({ status: "started", ralphRunId: RUN_ID })).toMatchSnapshot();
    expect(
      card({
        status: "added",
        triageNow: true,
        workItemTracker: "linear",
        workItemIdentifier: "ENG-42",
        workItemUrl: "https://linear.app/acme/issue/ENG-42",
      }),
    ).toMatchSnapshot();
    expect(card({ status: "dismissed" })).toMatchSnapshot();
    expect(card({ status: "expired" })).toMatchSnapshot();
  });

  it("is a request draft's card for the web", () => {
    expect(webCardRef(card({}))).toEqual({ kind: "request_draft", draftId: DRAFT_ID });
    expect(webCardRef(card({}, contextOf({ backlog: false })))).toEqual({
      kind: "request_draft",
      draftId: DRAFT_ID,
    });
    expect(
      webCardRef(requestDraftCard(requestDraftView(draftOf(), contextOf(), { askTriage: true }))),
    ).toEqual({ kind: "request_draft", draftId: DRAFT_ID });
    expect(webCardRef(card({ status: "dismissed" }))).toBeNull();
  });
});

describe.skipIf(!databaseAvailable)("request drafts in chat", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let repoId: string;
  let goneRepoId: string;
  let otherRepoId: string;
  let slack: ChatConnection;
  let slackThread: ChatThread;
  /** The organization's tracker: a fake Linear workspace with team ENG and project Portal. */
  let fake: FakeWorkItemTracker;
  const tracker = async () => fake.tracker;

  const SLACK_THREAD_ID = "slack:C0123ABCD:1700000000.000100";
  const CARD_ID = "card-1";
  const ada: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
  const bob: ChatActor = { kind: "member", userId: "bob", role: "member", name: "Bob" };
  const actors: Record<string, ChatActor> = {
    "U-ADA": ada,
    "U-BOB": bob,
    "U-DOMAIN": { kind: "domain", email: "eve@acme.test" },
  };

  beforeAll(async () => {
    // The web's cards link runs on the deployment's URL.
    vi.stubEnv("APP_URL", APP_URL);
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    await db.insert(users).values([
      { id: "ada", email: "ada@acme.test", name: "Ada" },
      { id: "bob", email: "bob@acme.test", name: "Bob" },
    ]);
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: "ada" },
      { organizationId: orgId, userId: "bob" },
    ]);
    const scmOf = async (organizationId: string, externalId: string) =>
      (await upsertScmConnection(
        db,
        {
          organizationId,
          provider: "github",
          name: externalId,
          baseUrl: "https://api.github.com",
          externalId,
          credentials: {},
        },
        key,
      ))!;
    const scm = await scmOf(orgId, "1");
    const connect = async (connectionId: string, externalId: string, fullPath: string) =>
      (
        await connectRepository(db, {
          connectionId,
          provider: "github",
          externalId,
          fullPath,
        })
      ).id;
    repoId = await connect(scm.id, "1", "acme/customer-portal");
    goneRepoId = await connect(scm.id, "2", "acme/gone");
    await db
      .update((await import("@omniralph/db")).repositories)
      .set({ disconnectedAt: new Date() })
      .where(eq((await import("@omniralph/db")).repositories.id, goneRepoId));
    otherRepoId = await connect((await scmOf(otherOrgId, "9")).id, "9", "other/app");
    const saved = await saveChatConnection(db, {
      organizationId: orgId,
      platform: "slack",
      externalId: "T1",
      name: "Acme",
      credentials: null,
      installedByUserId: null,
    });
    if (saved === "other_organization") throw new Error("taken");
    slack = saved;
    slackThread = (await ensureChatThread(db, {
      connectionId: slack.id,
      externalThreadId: SLACK_THREAD_ID,
      channelId: "slack:C0123ABCD",
      startedByExternalUserId: "U-ADA",
    }))!;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(chatRequestDrafts);
    await db.delete(ralphRuns);
    await db.delete(chatMessages);
    await db.delete(integrations);
    await db.delete(workItemMatches);
    await db.delete(workItemEvents);
    await setCodingEnabled(db, repoId, true);
    fake = fakeWorkItemTracker();
    fake.workspace.projects = [{ id: "project-portal", name: "Portal" }];
    vi.mocked(startChatRequest).mockClear();
    vi.mocked(recordChange).mockClear();
  });

  /** The repo takes work items: a work item match (ENG, Portal, two labels) and Linear connected. */
  async function backlogReady() {
    await saveWorkItemMatch(db, {
      organizationId: orgId,
      repositoryId: repoId,
      userId: null,
      match: {
        tracker: "linear",
        team: "ENG",
        project: "Portal",
        withoutProject: false,
        labels: ["backend", "webhooks"],
      },
    });
    await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "linear-org",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
  }

  /** A tool context in `chatThread` for `actor`; `afterTurn` collects what posts after the text. */
  function toolContext(
    chatThread: ChatThread,
    actor: ChatActor = ada,
    options: { platform?: ChatConnection["platform"]; thread?: Thread } = {},
  ) {
    const posted: unknown[] = [];
    const later: Array<() => Promise<void>> = [];
    const thread =
      options.thread ??
      ({
        id: chatThread.externalThreadId,
        post: vi.fn(async (message: unknown) => {
          posted.push(message);
          return { id: CARD_ID };
        }),
      } as unknown as Thread);
    const context: ChatToolContext = {
      db,
      organizationId: orgId,
      connection: {
        id: chatThread.connectionId,
        organizationId: orgId,
        platform: options.platform ?? "slack",
      },
      actor,
      requesterExternalUserId: "U-ADA",
      thread,
      appUrl: APP_URL,
      chatThread,
      turnMessages: [{ author: "Ada", text: "Why do webhooks get lost?" }],
      ralph: async () => ({}) as unknown as RalphDeps,
      handedOff: vi.fn(),
      afterTurn: (post) => void later.push(post),
    };
    return { context, posted, later };
  }

  async function draftRequest(
    input: Record<string, unknown>,
    context: ChatToolContext,
  ): Promise<Record<string, unknown>> {
    const tool = chatTools.draft_request!;
    return (await tool.execute(
      tool.inputSchema.parse({
        title: "Retry webhooks on 5xx",
        request: "Retry webhook deliveries that fail with a 5xx, three times with backoff.",
        ...input,
      }),
      context,
    )) as Record<string, unknown>;
  }

  /** A pending draft in the Slack thread, its card posted. */
  async function drafted(input: Record<string, unknown> = {}): Promise<string> {
    const { context, later } = toolContext(slackThread);
    const result = await draftRequest({ repository: "acme/customer-portal", ...input }, context);
    expect(result.status).toBe("drafted");
    for (const post of later) await post();
    return (result.draft as { id: string }).id;
  }

  describe("draft_request", () => {
    it("stores a pending draft that expires in 24 hours and posts its card after the turn", async () => {
      const before = Date.now();
      const { context, posted, later } = toolContext(slackThread);
      const result = await draftRequest({ repository: "acme/customer-portal" }, context);

      const draft = (await db.select().from(chatRequestDrafts))[0]!;
      expect(result).toMatchObject({
        status: "drafted",
        draft: {
          id: draft.id,
          repository: "acme/customer-portal",
          title: "Retry webhooks on 5xx",
          expiresAt: draft.expiresAt.toISOString(),
        },
      });
      expect(draft).toMatchObject({
        organizationId: orgId,
        threadId: slackThread.id,
        requestedByUserId: "ada",
        requestedByExternalUserId: "U-ADA",
        repositoryId: repoId,
        status: "pending",
        request: "Retry webhook deliveries that fail with a 5xx, three times with backoff.",
        messageId: null,
      });
      const ttl = draft.expiresAt.getTime() - before;
      expect(ttl).toBeGreaterThanOrEqual(REQUEST_DRAFT_TTL_MS);
      expect(ttl).toBeLessThan(REQUEST_DRAFT_TTL_MS + 60_000);
      expect(context.handedOff).toHaveBeenCalled();

      // Nothing posted until the turn's text is out.
      expect(posted).toEqual([]);
      for (const post of later) await post();
      const card = posted[0] as CardElement;
      expect(card.title).toBe("Retry webhooks on 5xx");
      expect(webCardRef(card)).toEqual({ kind: "request_draft", draftId: draft.id });
      expect((await getChatRequestDraft(db, draft.id))!.messageId).toBe(CARD_ID);
    });

    it("defaults to the web chat's repo", async () => {
      const chat = await createWebChatThread(db, {
        organizationId: orgId,
        userId: "ada",
        repositoryId: repoId,
        branch: "main",
        title: "Webhooks",
      });
      const { context } = toolContext(chat, ada, { platform: "web" });
      const result = await draftRequest({}, context);
      expect(result).toMatchObject({
        status: "drafted",
        draft: { repository: "acme/customer-portal" },
      });
    });

    it("refuses a repo outside the organization, a disconnected one, and no repo at all", async () => {
      for (const repository of ["other/app", otherRepoId, "acme/gone", goneRepoId]) {
        const { context, later } = toolContext(slackThread);
        expect(await draftRequest({ repository }, context)).toMatchObject({
          error: "unknown_repository",
        });
        expect(later).toEqual([]);
      }
      const { context } = toolContext(slackThread);
      expect(await draftRequest({}, context)).toMatchObject({ error: "repository_needed" });
      expect(await db.select().from(chatRequestDrafts)).toEqual([]);
    });

    it("is an action tool: an unlinked or domain user gets LINK_REQUIRED_RESULT", async () => {
      for (const actor of [{ kind: "unlinked" }, actors["U-DOMAIN"]!] as ChatActor[]) {
        const { context } = toolContext(slackThread, actor);
        expect(await draftRequest({ repository: "acme/customer-portal" }, context)).toEqual(
          LINK_REQUIRED_RESULT,
        );
      }
      expect(chatTools.draft_request!.tier).toBe("action");
      expect(await db.select().from(chatRequestDrafts)).toEqual([]);
    });
  });

  describe("clicks on Slack", () => {
    function click(draftId: string, actionId: string, userId: string) {
      const adapter = createMockAdapter("slack");
      const postEphemeral = vi.fn().mockResolvedValue({ id: "e1", threadId: SLACK_THREAD_ID });
      const event = {
        actionId,
        value: draftId,
        adapter,
        messageId: CARD_ID,
        threadId: SLACK_THREAD_ID,
        thread: { id: SLACK_THREAD_ID, postEphemeral } as unknown as Thread,
        user: { userId, userName: userId, fullName: userId, isBot: false, isMe: false },
        raw: {},
        openModal: vi.fn(),
      } as ActionEvent;
      return { event, adapter, postEphemeral };
    }

    const handle = (event: ActionEvent, now?: Date) =>
      handleRequestDraftAction(
        {
          db,
          resolveActor: async (_c, externalUserId) =>
            actors[externalUserId] ?? { kind: "unlinked" },
          ralph: async () => ({ db, organizationId: orgId }) as unknown as RalphDeps,
          tracker,
          env: ENV,
          now: now && (() => now),
          logger: silent,
        },
        event,
        slack,
      );

    /** The cards the click showed, as text. */
    const shown = (adapter: Adapter) =>
      vi.mocked(adapter.editMessage).mock.calls.map(([, messageId, card]) => ({
        messageId,
        text: JSON.stringify(card),
      }));

    const recorded = async () =>
      (
        await db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.threadId, slackThread.id))
          .orderBy(asc(chatMessages.createdAt))
      ).filter((m) => m.role === "assistant");

    /** startChatRequest starting a run of the thread, as it does with an agent. */
    const startsRun = () =>
      vi.mocked(startChatRequest).mockImplementationOnce(async (_deps, input) => {
        const { run } = await createRun(db, {
          origin: "chat",
          organizationId: orgId,
          chatThreadId: input.chatThreadId,
          repositoryId: repoId,
          routedBy: "the chat request",
        });
        const repo = (await getRepository(db, repoId))!;
        return { status: "started", run, repository: repo, followUp: false };
      });

    it("Start request starts the request run with the draft's repo, request and the chat's latest messages", async () => {
      for (const text of ["Hi", "Why do webhooks get lost?", "Can you fix that?"]) {
        await appendChatMessage(db, {
          threadId: slackThread.id,
          role: "user",
          externalUserId: "U-ADA",
          authorName: "Ada",
          content: text,
        });
      }
      const id = await drafted();
      startsRun();
      const { event, adapter } = click(id, START_REQUEST_DRAFT_ACTION, "U-ADA");

      await handle(event);

      expect(startChatRequest).toHaveBeenCalledTimes(1);
      expect(vi.mocked(startChatRequest).mock.calls[0]![1]).toMatchObject({
        chatThreadId: slackThread.id,
        repository: "acme/customer-portal",
        request: "Retry webhook deliveries that fail with a 5xx, three times with backoff.",
        quoted: [
          { author: "Ada", text: "Hi" },
          { author: "Ada", text: "Why do webhooks get lost?" },
          { author: "Ada", text: "Can you fix that?" },
        ],
        author: "Ada",
        codingTaskId: expect.any(String),
      });
      const [run] = await db.select().from(ralphRuns);
      expect(await getChatRequestDraft(db, id)).toMatchObject({
        status: "started",
        ralphRunId: run!.id,
        error: null,
      });
      expect(run).toMatchObject({ chatThreadId: slackThread.id, repositoryId: repoId });
      const [card] = shown(adapter);
      expect(card!.messageId).toBe(CARD_ID);
      expect(card!.text).toContain("Request started");
      expect(card!.text).toContain(`${APP_URL}/runs/${run!.id}`);
      expect(card!.text).not.toContain(START_REQUEST_DRAFT_ACTION);
      expect((await recorded())[0]!.content).toContain(`${APP_URL}/runs/${run!.id}`);

      // A second click starts nothing more.
      const again = click(id, START_REQUEST_DRAFT_ACTION, "U-ADA");
      await handle(again.event);
      expect(startChatRequest).toHaveBeenCalledTimes(1);
      expect(shown(again.adapter)[0]!.text).toContain("Request started");
    });

    it("keeps the draft pending and shows why when coding is off for the repo", async () => {
      const id = await drafted();
      await setCodingEnabled(db, repoId, false);
      const { event, adapter } = click(id, START_REQUEST_DRAFT_ACTION, "U-ADA");

      await handle(event);

      expect(startChatRequest).toHaveBeenCalledTimes(1);
      expect(await getChatRequestDraft(db, id)).toMatchObject({
        status: "pending",
        error: "Coding is off for customer-portal.",
        ralphRunId: null,
      });
      const text = shown(adapter)[0]!.text;
      expect(text).toContain("Coding is off for customer-portal.");
      expect(text).toContain(START_REQUEST_DRAFT_ACTION);
      expect(await db.select().from(ralphRuns)).toEqual([]);
    });

    it("keeps the draft pending and shows why when the thread already has a run", async () => {
      const id = await drafted();
      await createRun(db, {
        origin: "chat",
        organizationId: orgId,
        chatThreadId: slackThread.id,
        repositoryId: repoId,
      });
      const { event, adapter } = click(id, START_REQUEST_DRAFT_ACTION, "U-ADA");

      await handle(event);

      expect(await getChatRequestDraft(db, id)).toMatchObject({
        status: "pending",
        error: RUN_ACTIVE_TEXT,
      });
      expect(shown(adapter)[0]!.text).toContain(RUN_ACTIVE_TEXT);

      // Once it can start, the error is gone.
      await db.delete(ralphRuns);
      startsRun();
      const retry = click(id, START_REQUEST_DRAFT_ACTION, "U-ADA");
      await handle(retry.event);
      expect(await getChatRequestDraft(db, id)).toMatchObject({ status: "started", error: null });
      expect(shown(retry.adapter)[0]!.text).not.toContain(RUN_ACTIVE_TEXT);
    });

    it("Not now dismisses the draft once; a second click changes nothing", async () => {
      const id = await drafted();
      const { event, adapter } = click(id, DISMISS_REQUEST_DRAFT_ACTION, "U-ADA");

      await handle(event);

      expect((await getChatRequestDraft(db, id))!.status).toBe("dismissed");
      expect(shown(adapter)[0]!.text).toContain("Not now");
      expect(shown(adapter)[0]!.text).not.toContain(DISMISS_REQUEST_DRAFT_ACTION);
      expect(await recorded()).toHaveLength(1);

      for (const action of [DISMISS_REQUEST_DRAFT_ACTION, START_REQUEST_DRAFT_ACTION]) {
        const again = click(id, action, "U-ADA");
        await handle(again.event);
        expect(shown(again.adapter)[0]!.text).toContain("Not now");
      }
      expect(startChatRequest).not.toHaveBeenCalled();
      expect((await getChatRequestDraft(db, id))!.status).toBe("dismissed");
      expect(await recorded()).toHaveLength(1);
    });

    it("tells anyone but the member who asked, privately, and changes nothing", async () => {
      const id = await drafted();
      for (const user of ["U-BOB", "U-DOMAIN", "U-NOBODY"]) {
        for (const action of [START_REQUEST_DRAFT_ACTION, DISMISS_REQUEST_DRAFT_ACTION]) {
          const { event, adapter, postEphemeral } = click(id, action, user);
          await handle(event);
          expect(postEphemeral).toHaveBeenCalledWith(
            expect.objectContaining({ userId: user }),
            NOT_REQUESTER_TEXT,
            { fallbackToDM: true },
          );
          expect(adapter.editMessage).not.toHaveBeenCalled();
        }
      }
      expect(startChatRequest).not.toHaveBeenCalled();
      expect((await getChatRequestDraft(db, id))!.status).toBe("pending");
      expect(await recorded()).toHaveLength(0);
    });

    it("says the draft expired after 24 hours, and its buttons do nothing", async () => {
      const id = await drafted();
      const later = new Date((await getChatRequestDraft(db, id))!.expiresAt.getTime() + 1);
      for (const action of [START_REQUEST_DRAFT_ACTION, DISMISS_REQUEST_DRAFT_ACTION]) {
        const { event, adapter } = click(id, action, "U-ADA");
        await handle(event, later);
        expect(shown(adapter)[0]!.text).toContain("This draft expired");
      }
      expect(startChatRequest).not.toHaveBeenCalled();
      expect((await getChatRequestDraft(db, id))!.status).toBe("expired");
      expect(await recorded()).toHaveLength(1);
    });

    it("offers Add to backlog only when the repo has a work item match and its tracker is connected", async () => {
      const { context, posted, later } = toolContext(slackThread);
      await draftRequest({ repository: "acme/customer-portal" }, context);
      for (const post of later) await post();
      expect(JSON.stringify(posted[0])).not.toContain("Add to backlog");

      await saveWorkItemMatch(db, {
        organizationId: orgId,
        repositoryId: repoId,
        userId: null,
        match: { tracker: "linear", team: "ENG", project: null, withoutProject: false, labels: [] },
      });
      const matched = toolContext(slackThread);
      await draftRequest({ repository: "acme/customer-portal" }, matched.context);
      for (const post of matched.later) await post();
      expect(JSON.stringify(matched.posted[0])).not.toContain("Add to backlog");

      await saveIntegration(db, {
        organizationId: orgId,
        provider: "linear",
        externalId: "linear-org",
        name: "Acme",
        credentials: { accessToken: "t" },
        installedByUserId: null,
      });
      const connected = toolContext(slackThread);
      await draftRequest({ repository: "acme/customer-portal" }, connected.context);
      for (const post of connected.later) await post();
      expect(JSON.stringify(connected.posted[0])).toContain("Add to backlog");
    });

    describe("Add to backlog", () => {
      const created = () => fake.workspace.created;
      const issues = () => [...fake.workspace.issues.values()];

      it("asks Triage it now? first, then adds the work item in the match's team, project and labels", async () => {
        await backlogReady();
        const id = await drafted();
        const first = click(id, ADD_REQUEST_DRAFT_ACTION, "U-ADA");

        await handle(first.event);

        expect(created()).toEqual([]);
        expect((await getChatRequestDraft(db, id))!.status).toBe("pending");
        const asked = shown(first.adapter)[0]!.text;
        expect(asked).toContain("Triage it now?");
        expect(asked).toContain(ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION);
        expect(asked).toContain(ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION);
        expect(asked).not.toContain(START_REQUEST_DRAFT_ACTION);

        const choice = click(id, ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION, "U-ADA");
        await handle(choice.event);

        expect(created()).toEqual([
          expect.objectContaining({
            teamId: "team-1",
            projectId: "project-portal",
            labels: ["backend", "webhooks"],
            title: "Retry webhooks on 5xx",
            description: "Retry webhook deliveries that fail with a 5xx, three times with backoff.",
          }),
        ]);
        const [issue] = issues();
        expect(issue!.labels).toEqual(["backend", "webhooks"]);
        expect(await getChatRequestDraft(db, id)).toMatchObject({
          status: "added",
          triageNow: false,
          error: null,
          workItemTracker: "linear",
          workItemExternalId: issue!.id,
          workItemIdentifier: issue!.identifier,
          workItemUrl: issue!.url,
        });
        const [event] = await db
          .select()
          .from(workItemEvents)
          .where(eq(workItemEvents.externalId, issue!.id));
        expect(event).toMatchObject({
          organizationId: orgId,
          kind: "created",
          actorUserId: "ada",
          actorName: "Ada",
          detail: { origin: "ask", repositoryId: repoId, repository: "acme/customer-portal" },
        });
        const text = shown(choice.adapter)[0]!.text;
        expect(text).toContain(`Added to the backlog: ${issue!.identifier}`);
        expect(text).not.toContain("Om is triaging it");
        expect(text).toContain(issue!.url);
        expect((await recorded()).at(-1)!.content).toContain(issue!.identifier);
      });

      it("Triage now starts triage on the new work item", async () => {
        await backlogReady();
        const id = await drafted();
        const { event, adapter } = click(id, ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION, "U-ADA");

        await handle(event);

        const [issue] = issues();
        // The tracker's triage label asks Om to triage it.
        expect(issue!.labels).toEqual(["backend", "webhooks", "coding:triage"]);
        expect(
          (
            await db.select().from(workItemEvents).where(eq(workItemEvents.externalId, issue!.id))
          ).map((e) => e.kind),
        ).toEqual(expect.arrayContaining(["created", "triage_requested"]));
        expect(await getChatRequestDraft(db, id)).toMatchObject({
          status: "added",
          triageNow: true,
        });
        expect(shown(adapter)[0]!.text).toContain(
          `Added to the backlog · Om is triaging it: ${issue!.identifier}`,
        );
      });

      it("adds the work item, not triaging it, when triage can't start", async () => {
        await backlogReady();
        const id = await drafted();
        fake.workspace.failures.set("addIssueLabels", new Error("Linear is down"));
        const { event, adapter } = click(id, ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION, "U-ADA");

        await handle(event);

        expect(issues()).toHaveLength(1);
        expect(await getChatRequestDraft(db, id)).toMatchObject({
          status: "added",
          triageNow: false,
        });
        expect(shown(adapter)[0]!.text).not.toContain("Om is triaging it");
        expect((await recorded()).at(-1)!.content).toContain("Om couldn't start triage");
      });

      it("keeps the draft pending and shows why when the tracker fails, then adds it once", async () => {
        await backlogReady();
        const id = await drafted();
        fake.workspace.failures.set("createIssue", new Error("Linear is down"));
        const failed = click(id, ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION, "U-ADA");

        await handle(failed.event);

        expect(await getChatRequestDraft(db, id)).toMatchObject({
          status: "pending",
          error: "Linear didn't answer. Try again in a moment.",
          workItemIdentifier: null,
        });
        const text = shown(failed.adapter)[0]!.text;
        expect(text).toContain("Linear didn't answer. Try again in a moment.");
        expect(text).toContain(ADD_REQUEST_DRAFT_ACTION);

        fake.workspace.failures.delete("createIssue");
        // Two clicks at once still create one work item.
        await Promise.all([
          handle(click(id, ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION, "U-ADA").event),
          handle(click(id, ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION, "U-ADA").event),
        ]);
        await handle(click(id, ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION, "U-ADA").event);
        expect(issues()).toHaveLength(1);
        expect(await getChatRequestDraft(db, id)).toMatchObject({ status: "added", error: null });
      });

      it("keeps the draft pending and shows why when the repo has no work item match anymore", async () => {
        await backlogReady();
        const id = await drafted();
        await db.delete(workItemMatches);
        const { event, adapter } = click(id, ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION, "U-ADA");

        await handle(event);

        expect(created()).toEqual([]);
        expect(await getChatRequestDraft(db, id)).toMatchObject({
          status: "pending",
          error: "customer-portal doesn't pick up work items yet.",
        });
        const text = shown(adapter)[0]!.text;
        expect(text).toContain("customer-portal doesn't pick up work items yet.");
        // The repo can't take work items now: no Add to backlog.
        expect(text).not.toContain(ADD_REQUEST_DRAFT_ACTION);
      });

      it("lets only the member who asked add it", async () => {
        await backlogReady();
        const id = await drafted();
        for (const action of [ADD_REQUEST_DRAFT_ACTION, ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION]) {
          const { event, postEphemeral } = click(id, action, "U-BOB");
          await handle(event);
          expect(postEphemeral).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "U-BOB" }),
            NOT_REQUESTER_TEXT,
            { fallbackToDM: true },
          );
        }
        expect(created()).toEqual([]);
        expect((await getChatRequestDraft(db, id))!.status).toBe("pending");
      });
    });
  });

  describe("on the web", () => {
    const bot = () =>
      createChatBot({
        db,
        slack: null,
        discord: null,
        state: createMockState(),
        handler: { handle: async () => undefined },
        logger: createMockLogger(),
        env: ENV,
        ralph: async () => ({ db, organizationId: orgId }) as unknown as RalphDeps,
        tracker,
      });

    /** A web chat of Ada's with a drafted request's card posted by the web adapter. */
    async function webDraft(): Promise<{ chat: ChatThread; draftId: string; messageId: string }> {
      const chat = await createWebChatThread(db, {
        organizationId: orgId,
        userId: "ada",
        repositoryId: repoId,
        branch: "main",
        title: "Webhooks",
      });
      const built = bot();
      const thread = {
        id: chat.externalThreadId,
        post: (message: CardElement) =>
          built.adapters.web!.postMessage(chat.externalThreadId, message),
      } as unknown as Thread;
      const { context, later } = toolContext(chat, ada, { platform: "web", thread });
      const result = await draftRequest({}, context);
      for (const post of later) await post();
      const [row] = await db
        .select()
        .from(chatWebMessages)
        .where(eq(chatWebMessages.threadId, chat.id));
      expect(row!.cardRef).toEqual({
        kind: "request_draft",
        draftId: (result.draft as { id: string }).id,
      });
      return { chat, draftId: (result.draft as { id: string }).id, messageId: row!.id };
    }

    /** The `chat` changes recorded for `chat`. */
    const chatChanges = (chat: ChatThread) =>
      vi
        .mocked(recordChange)
        .mock.calls.filter(
          ([, change]) =>
            (change as { resource: string; ids: readonly string[]; userId?: string }).resource ===
              "chat" &&
            (change as { ids: readonly string[] }).ids[0] === chat.id &&
            (change as { userId?: string }).userId === "ada",
        );

    it("publishes the chat's change for every status change of a started request", async () => {
      const { chat, draftId, messageId } = await webDraft();
      vi.mocked(startChatRequest).mockImplementationOnce(async (_deps, input) => {
        const { run } = await createRun(db, {
          origin: "chat",
          organizationId: orgId,
          chatThreadId: input.chatThreadId,
          repositoryId: repoId,
        });
        return {
          status: "started",
          run,
          repository: (await getRepository(db, repoId))!,
          followUp: false,
        };
      });
      vi.mocked(recordChange).mockClear();

      const message = await askCardAction(
        { db, bot: bot(), workItems: { resolve: async () => [] } },
        chat,
        { id: "ada", name: "Ada", email: "ada@acme.test" },
        { messageId, actionId: START_REQUEST_DRAFT_ACTION, value: draftId },
      );

      expect(message.card).toMatchObject({
        kind: "request_draft",
        draft: { status: "started", triageChoice: "inline", outcome: { text: "Request started" } },
      });
      // `starting`, then `started`, then the card's edit.
      expect(chatChanges(chat)).toHaveLength(3);
    });

    it("publishes the chat's change when a refusal puts the draft back, and when it's dismissed", async () => {
      const { chat, draftId, messageId } = await webDraft();
      await setCodingEnabled(db, repoId, false);
      vi.mocked(recordChange).mockClear();
      const click = (actionId: string) =>
        askCardAction(
          { db, bot: bot(), workItems: { resolve: async () => [] } },
          chat,
          { id: "ada", name: "Ada", email: "ada@acme.test" },
          { messageId, actionId, value: draftId },
        );

      const refused = await click(START_REQUEST_DRAFT_ACTION);
      expect(refused.card).toMatchObject({
        kind: "request_draft",
        draft: { status: "pending", error: "Coding is off for customer-portal." },
      });
      // `starting`, back to `pending`, the card's edit.
      expect(chatChanges(chat)).toHaveLength(3);

      vi.mocked(recordChange).mockClear();
      const dismissed = await click(DISMISS_REQUEST_DRAFT_ACTION);
      expect(dismissed.card).toMatchObject({
        kind: "request_draft",
        draft: { status: "dismissed", actions: [], outcome: { text: "Not now" } },
      });
      expect(chatChanges(chat)).toHaveLength(2);
      expect((await getChatRequestDraft(db, draftId))!.status).toBe("dismissed");
    });

    it("Add to backlog sends the Triage now choice and adds the work item at once", async () => {
      await backlogReady();
      const { chat, draftId, messageId } = await webDraft();
      vi.mocked(recordChange).mockClear();
      const add = (value: string | null) =>
        askCardAction(
          { db, bot: bot(), workItems: { resolve: async () => [] } },
          chat,
          { id: "ada", name: "Ada", email: "ada@acme.test" },
          { messageId, actionId: ADD_REQUEST_DRAFT_ACTION, value },
        );

      const message = await add(requestDraftAddValue(draftId, true));

      const [issue] = [...fake.workspace.issues.values()];
      expect(fake.workspace.created).toEqual([
        expect.objectContaining({
          teamId: "team-1",
          projectId: "project-portal",
          labels: ["backend", "webhooks"],
          title: "Retry webhooks on 5xx",
        }),
      ]);
      expect(message.card).toMatchObject({
        kind: "request_draft",
        draft: {
          status: "added",
          triageChoice: "inline",
          question: null,
          actions: [],
          outcome: {
            kind: "added",
            text: "Added to the backlog · Om is triaging it",
            workItem: { tracker: "linear", identifier: issue!.identifier, url: issue!.url },
          },
        },
      });
      // `adding`, then `added`, then the card's edit.
      expect(chatChanges(chat)).toHaveLength(3);

      // A second click adds nothing more: the card has no buttons anymore.
      await expect(add(requestDraftAddValue(draftId, false))).rejects.toMatchObject({
        status: 400,
      });
      expect(fake.workspace.issues.size).toBe(1);
      expect(await getChatRequestDraft(db, draftId)).toMatchObject({
        status: "added",
        triageNow: true,
      });
    });

    it("Add to backlog without triage, as the unchecked box sends it", async () => {
      await backlogReady();
      const { chat, draftId, messageId } = await webDraft();

      const message = await askCardAction(
        { db, bot: bot(), workItems: { resolve: async () => [] } },
        chat,
        { id: "ada", name: "Ada", email: "ada@acme.test" },
        {
          messageId,
          actionId: ADD_REQUEST_DRAFT_ACTION,
          value: requestDraftAddValue(draftId, false),
        },
      );

      expect(message.card).toMatchObject({
        draft: { status: "added", outcome: { text: "Added to the backlog" } },
      });
      const [issue] = [...fake.workspace.issues.values()];
      expect(issue!.labels).toEqual(["backend", "webhooks"]);
    });

    it("ignores another member's click, posting nothing in the chat", async () => {
      const { chat, draftId, messageId } = await webDraft();
      const before = await db
        .select()
        .from(chatWebMessages)
        .where(eq(chatWebMessages.threadId, chat.id));

      const message = await askCardAction(
        { db, bot: bot(), workItems: { resolve: async () => [] } },
        chat,
        { id: "bob", name: "Bob", email: "bob@acme.test" },
        { messageId, actionId: DISMISS_REQUEST_DRAFT_ACTION, value: draftId },
      );

      expect(message.card).toMatchObject({ draft: { status: "pending" } });
      expect((await getChatRequestDraft(db, draftId))!.status).toBe("pending");
      expect(
        await db.select().from(chatWebMessages).where(eq(chatWebMessages.threadId, chat.id)),
      ).toEqual(before);
    });
  });

  describe("cards follow the turn's text", () => {
    type CallOptions = Parameters<MockLanguageModelV2["doGenerate"]>[0];
    type StreamPart =
      Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer P>
        ? P
        : never;
    const INTRO = "I drafted the request from this conversation:";
    const input = {
      repository: "acme/customer-portal",
      title: "Retry webhooks on 5xx",
      request: "Retry failed webhook deliveries.",
    };

    /** A model calling draft_request, then answering INTRO (generated or streamed). */
    function draftingModel() {
      const calls: CallOptions[] = [];
      return new MockLanguageModelV2({
        doGenerate: async (call) => {
          calls.push(call);
          return calls.length === 1
            ? {
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "draft_request",
                    input: JSON.stringify(input),
                  },
                ],
                finishReason: "tool-calls",
                usage: USAGE,
                warnings: [],
              }
            : {
                content: [{ type: "text", text: INTRO }],
                finishReason: "stop",
                usage: USAGE,
                warnings: [],
              };
        },
        doStream: async (call) => {
          calls.push(call);
          const chunks: StreamPart[] =
            calls.length === 1
              ? [
                  { type: "stream-start", warnings: [] },
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "draft_request",
                    input: JSON.stringify(input),
                  },
                  { type: "finish", finishReason: "tool-calls", usage: USAGE },
                ]
              : [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "t1" },
                  { type: "text-delta", id: "t1", delta: INTRO },
                  { type: "text-end", id: "t1" },
                  { type: "finish", finishReason: "stop", usage: USAGE },
                ];
          return { stream: simulateReadableStream({ chunks }) };
        },
      });
    }

    it("on Slack and Discord", async () => {
      const posts: string[] = [];
      const thread = {
        id: SLACK_THREAD_ID,
        async post(message: string | { markdown: string } | CardElement) {
          posts.push(
            typeof message === "string"
              ? message
              : "markdown" in message
                ? message.markdown
                : `card: ${(message as CardElement).title}`,
          );
          return { id: `m${posts.length}` };
        },
        async startTyping() {},
        get state() {
          return Promise.resolve(null);
        },
        async setState() {},
      } as unknown as Thread;
      const message = {
        id: "m0",
        text: "Why do webhooks get lost?",
        author: { userId: "U-ADA", userName: "ada", fullName: "Ada" },
      } as Message;
      // As the bot does before the turn.
      await appendChatMessage(db, {
        threadId: slackThread.id,
        role: "user",
        externalUserId: "U-ADA",
        authorName: "Ada",
        content: message.text,
      });
      const handler = createChatAgentHandler({
        db,
        model: draftingModel(),
        logger: silent,
        env: ENV,
      });

      await handler.handle(thread, message, {
        organizationId: orgId,
        connection: slack,
        chatThread: slackThread,
        skipped: [],
        thread,
        message,
        actor: ada,
        linkUrl: async () => "",
      } satisfies ChatConversationContext);

      expect(posts).toEqual([INTRO, "card: Retry webhooks on 5xx"]);
    });

    it("on the web", async () => {
      const chat = await createWebChatThread(db, {
        organizationId: orgId,
        userId: "ada",
        repositoryId: repoId,
        branch: "main",
        title: "Webhooks",
      });
      const built = createChatBot({
        db,
        slack: null,
        discord: null,
        state: createMockState(),
        handler: createChatAgentHandler({ db, model: draftingModel(), logger: silent, env: ENV }),
        logger: createMockLogger(),
        env: ENV,
      });
      const { body, finished } = webEventStream(async () => {
        await handleWebMessage(
          { db, bot: built },
          { thread: chat, user: { id: "ada", name: "Ada" }, text: "Why do webhooks get lost?" },
        );
      });
      await body.pipeTo(new WritableStream());
      await finished;

      const rows = await db
        .select()
        .from(chatWebMessages)
        .where(eq(chatWebMessages.threadId, chat.id))
        .orderBy(asc(chatWebMessages.createdAt));
      expect(rows.map((r) => [r.author, r.cardRef?.kind ?? r.markdown])).toEqual([
        ["user", "Why do webhooks get lost?"],
        ["om", INTRO],
        ["om", "request_draft"],
      ]);
      const draft = (await db.select().from(chatRequestDrafts))[0]!;
      expect(draft.messageId).toBe(rows[2]!.id);
    });
  });
});
