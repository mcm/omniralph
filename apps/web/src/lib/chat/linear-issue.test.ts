import { createMockAdapter } from "@chat-adapter/tests";
import {
  appendChatMessage,
  chatLinearDelegations,
  chatLinearIssueDrafts,
  chatMessages,
  closeDb,
  createDb,
  ensureChatThread,
  getChatLinearIssueDraft,
  listChatMessages,
  organizations,
  runMigrations,
  saveChatConnection,
  users,
  type ChatConnection,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { ActionEvent, Adapter, CardElement, Thread } from "chat";
import { asc, eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectedLinearGateway } from "@/lib/linear/client";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import type { RalphDeps } from "@/lib/ralph/run";
import type { ChatActor } from "./identity";
import type { ChatToolContext } from "./agent/tools";
import { threadAttachments, type FetchAttachment, type ThreadAttachment } from "./attachments";

vi.mock("server-only", () => ({}));

const { chatTools } = await import("./agent/registry");
const {
  CANCEL_LINEAR_ISSUE_ACTION,
  CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION,
  CREATE_LINEAR_ISSUE_ACTION,
  DELEGATION_FAILED_REPLY,
  LINEAR_ISSUE_DRAFT_TTL_MS,
  LINEAR_NOT_CONNECTED_REPLY,
  NOT_REQUESTER_REPLY,
  handleLinearIssueAction,
} = await import("./linear-issue");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const THREAD_ID = "discord:G1:CH1:TH1";
const CARD_ID = "card-1";
const ada: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
const bob: ChatActor = { kind: "member", userId: "bob", role: "member", name: "Bob" };
/** Chat user → actor. */
const actors: Record<string, ChatActor> = {
  "D-ADA": ada,
  "D-BOB": bob,
  "D-DOMAIN": { kind: "domain", email: "eve@acme.test" },
};

type Result = Record<string, unknown>;

/** The text of a card, children included. */
function cardText(card: CardElement): string {
  return JSON.stringify(card);
}

describe.skipIf(!dockerAvailable)("Linear issues drafted in chat", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let connection: ChatConnection;
  let otherConnection: ChatConnection;
  let chatThread: ChatThread;
  let linear: FakeLinearGateway;
  let gateway: LinearGateway;
  let thread: Thread;

  async function connect(organizationId: string, externalId: string): Promise<ChatConnection> {
    const saved = await saveChatConnection(db, {
      organizationId,
      platform: "discord",
      externalId,
      name: `Server ${externalId}`,
      credentials: null,
      installedByUserId: null,
    });
    if (saved === "other_organization") throw new Error("taken");
    return saved;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    orgId = org!.id;
    await db.insert(users).values([
      { id: "ada", email: "ada@acme.test", name: "Ada" },
      { id: "bob", email: "bob@acme.test", name: "Bob" },
    ]);
    connection = await connect(orgId, "G1");
    otherConnection = await connect(other!.id, "G2");
    chatThread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: THREAD_ID,
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D-ADA",
    }))!;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(chatLinearIssueDrafts);
    await db.delete(chatLinearDelegations);
    await db.delete(chatMessages);
    attachments = undefined;
    linear = new FakeLinearGateway();
    linear.teams = [
      { id: "team-1", key: "ENG", name: "Engineering" },
      { id: "team-2", key: "DES", name: "Design" },
    ];
    gateway = linear;
    thread = {
      id: THREAD_ID,
      post: vi.fn(async () => ({ id: CARD_ID })),
    } as unknown as Thread;
  });

  let attachments: Map<string, ThreadAttachment> | undefined;
  const context = (actor: ChatActor = ada, externalUserId = "D-ADA"): ChatToolContext => ({
    db,
    organizationId: orgId,
    connection: { id: chatThread.connectionId, organizationId: orgId },
    actor,
    requesterExternalUserId: externalUserId,
    thread,
    appUrl: "https://omniralph.example.com",
    chatThread,
    turnMessages: [{ author: "Ada", text: "file an issue for the login bug" }],
    ralph: async () => ({ linear: gateway }) as unknown as RalphDeps,
    handedOff: () => undefined,
    attachments,
  });

  async function draft(input: Record<string, unknown> = {}, actor?: ChatActor): Promise<Result> {
    const tool = chatTools.draft_linear_issue!;
    return (await tool.execute(
      tool.inputSchema.parse({
        team: "eng",
        title: "Login fails with SSO",
        description: "Users signing in with SSO get a 500.\n\n- [ ] SSO login works",
        labels: ["bug"],
        priority: 2,
        ...input,
      }),
      context(actor),
    )) as Result;
  }

  /** A click on the draft's card. */
  function click(
    draftId: string,
    actionId: string,
    externalUserId: string,
    overrides: Partial<ActionEvent> = {},
  ) {
    const adapter = createMockAdapter("discord");
    const postEphemeral = vi.fn().mockResolvedValue({ id: "e1", threadId: THREAD_ID });
    const event = {
      actionId,
      value: draftId,
      adapter,
      messageId: CARD_ID,
      threadId: THREAD_ID,
      thread: { id: THREAD_ID, postEphemeral } as unknown as Thread,
      user: {
        userId: externalUserId,
        userName: externalUserId,
        fullName: externalUserId,
        isBot: false,
        isMe: false,
      },
      raw: {},
      openModal: vi.fn(),
      ...overrides,
    } as ActionEvent;
    return { event, adapter, postEphemeral };
  }

  async function handle(
    event: ActionEvent,
    options: { now?: Date; via?: ChatConnection; fetchAttachment?: FetchAttachment } = {},
  ): Promise<void> {
    await handleLinearIssueAction(
      {
        db,
        fetchAttachment: options.fetchAttachment,
        resolveActor: async (_c, externalUserId) => actors[externalUserId] ?? { kind: "unlinked" },
        linear: async () => gateway,
        now: () => options.now ?? new Date(),
        logger: { warn: vi.fn(), error: vi.fn() } as never,
      },
      event,
      options.via ?? connection,
    );
  }

  const edited = (adapter: Adapter) =>
    vi.mocked(adapter.editMessage).mock.calls.map(([threadId, messageId, card]) => ({
      threadId,
      messageId,
      text: cardText(card as CardElement),
    }));

  const recorded = () =>
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, chatThread.id))
      .orderBy(asc(chatMessages.createdAt));

  async function drafted(): Promise<string> {
    const result = await draft();
    expect(result.status).toBe("drafted");
    return (result.draft as { id: string }).id;
  }

  it("validates the team and posts a preview card without creating anything", async () => {
    const result = await draft();

    expect(result).toMatchObject({ status: "drafted", draft: { team: "ENG" } });
    expect(linear.issues.size).toBe(0);
    expect(thread.post).toHaveBeenCalledOnce();
    const card = vi.mocked(thread.post).mock.calls[0]![0] as CardElement;
    const text = cardText(card);
    expect(card.title).toContain("Login fails with SSO");
    expect(text).toContain("Users signing in with SSO get a 500.");
    expect(text).toContain("ENG");
    expect(text).toContain("High");
    expect(text).toContain(CREATE_LINEAR_ISSUE_ACTION);
    expect(text).toContain(CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION);
    expect(text).toContain("Create and delegate");
    expect(text).toContain(CANCEL_LINEAR_ISSUE_ACTION);

    const id = (result.draft as { id: string }).id;
    const row = await getChatLinearIssueDraft(db, id);
    expect(row).toMatchObject({
      status: "pending",
      threadId: chatThread.id,
      requestedByUserId: "ada",
      requestedByExternalUserId: "D-ADA",
      teamId: "team-1",
      labels: ["bug"],
      priority: 2,
      externalMessageId: CARD_ID,
    });
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThanOrEqual(
      LINEAR_ISSUE_DRAFT_TTL_MS - 60_000,
    );
  });

  it("answers an unknown team with the workspace's teams, posting nothing", async () => {
    const result = await draft({ team: "Marketing" });

    expect(result).toMatchObject({
      error: "unknown_team",
      teams: [
        { key: "ENG", name: "Engineering" },
        { key: "DES", name: "Design" },
      ],
    });
    expect(result.message).toContain("ENG (Engineering)");
    expect(thread.post).not.toHaveBeenCalled();
    expect(await db.select().from(chatLinearIssueDrafts)).toHaveLength(0);
  });

  it("matches a team by name too", async () => {
    expect(await draft({ team: "design" })).toMatchObject({ draft: { team: "DES" } });
  });

  it("returns an error the agent explains when the organization has no Linear integration", async () => {
    gateway = disconnectedLinearGateway();

    const result = await draft();

    expect(result.error).toBe("linear_not_connected");
    expect(result.message).toContain("Settings › Integrations");
    expect(thread.post).not.toHaveBeenCalled();
    expect(await db.select().from(chatLinearIssueDrafts)).toHaveLength(0);
  });

  it("is an action tool: a domain user can't draft", async () => {
    expect(chatTools.draft_linear_issue!.tier).toBe("action");
    expect(await draft({}, { kind: "domain", email: "eve@acme.test" })).toMatchObject({
      error: "link_required",
    });
  });

  it("creates the issue on the requester's Create click, shows its link and records it", async () => {
    const id = await drafted();
    const { event, adapter } = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");

    await handle(event);

    const [issue] = [...linear.issues.values()];
    expect(issue).toMatchObject({
      teamId: "team-1",
      title: "Login fails with SSO",
      description: "Users signing in with SSO get a 500.\n\n- [ ] SSO login works",
      labels: ["bug"],
      priority: 2,
    });
    const [edit] = edited(adapter);
    expect(edit).toMatchObject({ threadId: THREAD_ID, messageId: CARD_ID });
    expect(edit!.text).toContain(issue!.identifier);
    expect(edit!.text).toContain(issue!.url);
    expect(edit!.text).not.toContain(CREATE_LINEAR_ISSUE_ACTION);
    expect(await getChatLinearIssueDraft(db, id)).toMatchObject({
      status: "created",
      linearIssueId: issue!.id,
      linearIssueIdentifier: issue!.identifier,
      linearIssueUrl: issue!.url,
    });
    const messages = await recorded();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant" });
    expect(messages[0]!.content).toContain(issue!.identifier);
    expect(messages[0]!.content).toContain(issue!.url);

    // A second click creates nothing more.
    const again = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");
    await handle(again.event);
    expect(linear.issues.size).toBe(1);
    expect(edited(again.adapter)[0]!.text).toContain(issue!.identifier);
  });

  it("ignores a click by another member, and by an unlinked user", async () => {
    const id = await drafted();
    for (const user of ["D-BOB", "D-DOMAIN", "D-NOBODY"]) {
      const { event, adapter, postEphemeral } = click(id, CREATE_LINEAR_ISSUE_ACTION, user);

      await handle(event);

      expect(postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user }),
        NOT_REQUESTER_REPLY,
        expect.anything(),
      );
      expect(adapter.editMessage).not.toHaveBeenCalled();
    }
    const cancel = click(id, CANCEL_LINEAR_ISSUE_ACTION, "D-BOB");
    await handle(cancel.event);

    expect(linear.issues.size).toBe(0);
    expect((await getChatLinearIssueDraft(db, id))!.status).toBe("pending");
    expect(await recorded()).toHaveLength(0);
  });

  it("cancels on the requester's Cancel click", async () => {
    const id = await drafted();
    const { event, adapter } = click(id, CANCEL_LINEAR_ISSUE_ACTION, "D-ADA");

    await handle(event);

    expect(edited(adapter)[0]!.text).toContain("Cancelled");
    expect((await getChatLinearIssueDraft(db, id))!.status).toBe("cancelled");
    expect((await recorded())[0]!.content).toContain("Cancelled");

    const create = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");
    await handle(create.event);
    expect(linear.issues.size).toBe(0);
    expect(edited(create.adapter)[0]!.text).toContain("Cancelled");
  });

  it("expires a draft after 24 hours", async () => {
    const id = await drafted();
    const row = (await getChatLinearIssueDraft(db, id))!;
    const later = new Date(row.expiresAt.getTime() + 1);

    const { event, adapter } = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");

    await handle(event, { now: later });

    expect(linear.issues.size).toBe(0);
    expect(edited(adapter)[0]!.text).toContain("Expired");
    expect((await getChatLinearIssueDraft(db, id))!.status).toBe("expired");
    expect((await recorded())[0]!.content).toContain("expired");
  });

  it("keeps the draft when Linear isn't connected anymore, and tells the requester", async () => {
    const id = await drafted();
    gateway = disconnectedLinearGateway();
    const { event, adapter, postEphemeral } = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");

    await handle(event);

    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "D-ADA" }),
      LINEAR_NOT_CONNECTED_REPLY,
      expect.anything(),
    );
    expect(adapter.editMessage).not.toHaveBeenCalled();
    expect((await getChatLinearIssueDraft(db, id))!.status).toBe("pending");
  });

  it("puts the draft back when Linear fails, so Create can be clicked again", async () => {
    const id = await drafted();
    linear.failures.set("createIssue", new Error("Linear is down"));
    const first = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");

    await handle(first.event);

    expect(first.postEphemeral).toHaveBeenCalledOnce();
    expect((await getChatLinearIssueDraft(db, id))!.status).toBe("pending");

    linear.failures.delete("createIssue");
    const second = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");
    await handle(second.event);
    expect(linear.issues.size).toBe(1);
  });

  it("ignores clicks received by another connection or in another thread", async () => {
    const id = await drafted();

    await handle(click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA").event, { via: otherConnection });
    await handle(
      click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA", { threadId: "discord:G1:CH1:OTHER" }).event,
    );
    await handle(click("not-a-draft", CREATE_LINEAR_ISSUE_ACTION, "D-ADA").event);

    expect(linear.issues.size).toBe(0);
    expect((await getChatLinearIssueDraft(db, id))!.status).toBe("pending");
  });
  /** Records the delegations stored when `delegateIssue` is called (to check they come first). */
  describe("screenshots", () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const SHOT = "https://cdn.discordapp.com/attachments/1/2/login-error.png";
    const LOG = "https://cdn.discordapp.com/attachments/1/3/app.log";
    const fetchFile: FetchAttachment = async (meta) => {
      if (meta.url === SHOT) return PNG;
      if (meta.url === LOG) return Buffer.from("boom");
      throw new Error("404");
    };

    /** Ada's message with a screenshot and a log, as the bot records it; returns their refs. */
    async function attach(): Promise<{ shot: string; log: string }> {
      await appendChatMessage(db, {
        threadId: chatThread.id,
        role: "user",
        externalUserId: "D-ADA",
        authorName: "Ada",
        content: "login is broken, see screenshot",
        attachments: [
          {
            type: "image",
            name: "login-error.png",
            mimeType: "image/png",
            size: PNG.length,
            url: SHOT,
            fetchMetadata: null,
          },
          {
            type: "file",
            name: "app.log",
            mimeType: "text/plain",
            size: 4,
            url: LOG,
            fetchMetadata: null,
          },
        ],
      });
      attachments = await threadAttachments(
        await listChatMessages(db, chatThread.id, 50),
        fetchFile,
      );
      const [shot, log] = [...attachments.keys()];
      return { shot: shot!, log: log! };
    }

    it("lists the screenshots on the card and embeds them in the issue on Create", async () => {
      const { shot } = await attach();
      const result = await draft({ attachments: [shot] });
      expect(result).toMatchObject({
        status: "drafted",
        draft: { screenshots: ["login-error.png"] },
      });
      const card = cardText(vi.mocked(thread.post).mock.calls[0]![0] as CardElement);
      expect(card).toContain("Screenshots");
      expect(card).toContain("login-error.png");
      // Nothing is uploaded before Create.
      expect(linear.uploaded).toEqual([]);

      const id = (result.draft as { id: string }).id;
      const { event, adapter } = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");
      await handle(event, { fetchAttachment: fetchFile });

      expect(linear.uploaded).toEqual([
        {
          filename: "login-error.png",
          contentType: "image/png",
          size: PNG.length,
          assetUrl: "https://uploads.linear.app/fake/1/login-error.png",
        },
      ]);
      const [issue] = [...linear.issues.values()];
      expect(issue!.description).toBe(
        "Users signing in with SSO get a 500.\n\n- [ ] SSO login works\n\n## Screenshots\n\n![login-error.png](https://uploads.linear.app/fake/1/login-error.png)",
      );
      expect(edited(adapter)[0]!.text).not.toContain("Couldn't attach");
    });

    it("creates the issue without a screenshot that can't be fetched anymore, and says so", async () => {
      const { shot } = await attach();
      const result = await draft({ attachments: [shot] });
      const id = (result.draft as { id: string }).id;
      const { event, adapter } = click(id, CREATE_LINEAR_ISSUE_ACTION, "D-ADA");
      await handle(event, {
        fetchAttachment: async () => {
          throw new Error("expired");
        },
      });
      const [issue] = [...linear.issues.values()];
      expect(issue!.description).not.toContain("Screenshots");
      expect(edited(adapter)[0]!.text).toContain("Couldn't attach: login-error.png");
    });

    it("refuses refs that aren't images of the thread, listing the ones there are", async () => {
      const { shot, log } = await attach();
      for (const ref of [log, "deadbeef-9"]) {
        const result = await draft({ attachments: [ref] });
        expect(result).toMatchObject({ error: "unknown_attachment" });
        expect(result.message).toContain(`${shot} (login-error.png)`);
      }
      expect(thread.post).not.toHaveBeenCalled();
    });
  });

  function watchDelegations(): Array<{ issueId: string; rows: string[] }> {
    const seen: Array<{ issueId: string; rows: string[] }> = [];
    const delegateIssue = linear.delegateIssue.bind(linear);
    linear.delegateIssue = async (issueId: string, delegateId: string) => {
      const rows = await db.select().from(chatLinearDelegations);
      seen.push({ issueId, rows: rows.map((r) => `${r.threadId}:${r.linearIssueId}`) });
      return delegateIssue(issueId, delegateId);
    };
    return seen;
  }

  it("creates and delegates the issue to the app user on Create and delegate", async () => {
    linear.viewer = { id: "omniralph-app", name: "Omniralph" };
    const seen = watchDelegations();
    const id = await drafted();
    const { event, adapter, postEphemeral } = click(
      id,
      CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION,
      "D-ADA",
    );

    await handle(event);

    const [issue] = [...linear.issues.values()];
    expect(issue).toMatchObject({ title: "Login fails with SSO" });
    expect(linear.delegations).toEqual([{ issueId: issue!.id, delegateId: "omniralph-app" }]);
    // The delegation row is written before Linear is asked to delegate.
    expect(seen).toEqual([{ issueId: issue!.id, rows: [`${chatThread.id}:${issue!.id}`] }]);
    const [row] = await db.select().from(chatLinearDelegations);
    expect(row).toMatchObject({ organizationId: orgId, threadId: chatThread.id });
    expect(postEphemeral).not.toHaveBeenCalled();
    const [edit] = edited(adapter);
    expect(edit!.text).toContain(issue!.url);
    expect(edit!.text).toContain("Delegated to ralph");
    expect((await recorded())[0]!.content).toContain("delegated it to ralph");
  });

  it("keeps the created issue and tells the requester when delegating fails", async () => {
    linear.failures.set("delegateIssue", new Error("Linear is down"));
    const id = await drafted();
    const { event, adapter, postEphemeral } = click(
      id,
      CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION,
      "D-ADA",
    );

    await handle(event);

    expect(linear.issues.size).toBe(1);
    expect(linear.delegations).toEqual([]);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "D-ADA" }),
      DELEGATION_FAILED_REPLY,
      expect.anything(),
    );
    const [edit] = edited(adapter);
    expect(edit!.text).toContain("Created");
    expect(edit!.text).not.toContain("Delegated to ralph");
    expect((await getChatLinearIssueDraft(db, id))!.status).toBe("created");
  });

  describe("delegate_linear_issue", () => {
    async function delegate(issue: string, actor?: ChatActor): Promise<Result> {
      const tool = chatTools.delegate_linear_issue!;
      return (await tool.execute(tool.inputSchema.parse({ issue }), context(actor))) as Result;
    }

    it("records the delegation for the thread, then delegates the issue to the app user", async () => {
      linear.viewer = { id: "omniralph-app", name: "Omniralph" };
      const seen = watchDelegations();
      const issue = linear.add({ identifier: "ENG-7", title: "Dark mode" });

      const result = await delegate("ENG-7");

      expect(result).toMatchObject({
        status: "delegated",
        issue: { identifier: "ENG-7", title: "Dark mode", url: issue.url },
      });
      expect(linear.delegations).toEqual([{ issueId: issue.id, delegateId: "omniralph-app" }]);
      expect(seen).toEqual([{ issueId: issue.id, rows: [`${chatThread.id}:${issue.id}`] }]);
    });

    it("explains an unknown issue without delegating anything", async () => {
      const result = await delegate("ENG-404");

      expect(result.error).toBe("unknown_issue");
      expect(linear.delegations).toEqual([]);
      expect(await db.select().from(chatLinearDelegations)).toHaveLength(0);
    });

    it("explains a Linear failure, and a missing Linear integration", async () => {
      linear.add({ identifier: "ENG-8", title: "Search" });
      linear.failures.set("delegateIssue", new Error("Linear is down"));
      expect(await delegate("ENG-8")).toMatchObject({ error: "linear_error" });

      gateway = disconnectedLinearGateway();
      expect(await delegate("ENG-8")).toMatchObject({ error: "linear_not_connected" });
    });

    it("is an action tool: a domain user can't delegate", async () => {
      linear.add({ identifier: "ENG-9", title: "Export" });
      expect(chatTools.delegate_linear_issue!.tier).toBe("action");
      expect(await delegate("ENG-9", { kind: "domain", email: "eve@acme.test" })).toMatchObject({
        error: "link_required",
      });
      expect(linear.delegations).toEqual([]);
    });
  });
});
