import "server-only";
import {
  appendWebMessage,
  deleteWebMessage,
  ensureWebChatConnection,
  getChatThread,
  getWebMessage,
  listWebMessages,
  updateWebMessage,
  webChatChannelId,
  webChatExternalThreadId,
  type ChatConnection,
  type ChatThread,
  type ChatWebCardRef,
  type ChatWebMessage,
  type Database,
} from "@omniralph/db";
import { recordChange } from "@omniralph/db/changes";
import {
  cardChildToFallbackText,
  isCardElement,
  markdownToPlainText,
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type Author,
  type CardChild,
  type CardElement,
  type Chat,
  type ChatInstance,
  type EphemeralMessage,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type RawMessage,
  type StreamChunk,
  type ThreadInfo,
} from "chat";
import { LINEAR_ISSUE_ACTIONS } from "./linear-issue";
import { REQUEST_DRAFT_ACTIONS } from "./request-draft";
import { sendWebEvent } from "./web-stream";

/**
 * The web as a Chat SDK platform (Ask): its "platform" is Omniralph's own database. A web
 * chat is a `chat_threads` row of the organization's hidden `web` connection
 * (`ensureWebChatConnection`), and what the web shows is `chat_web_messages`, as Slack's
 * own message store is what Slack shows; `chat_messages` stays the model's history, written
 * by the handler exactly as for Slack. Messages arrive through `/api/ui/ask` and
 * {@link handleWebMessage}, never a webhook.
 *
 * Every write publishes a `chat` change event (IDs only) on the chat owner's own channel
 * once committed: a web chat is private to the member who started it.
 */

export const WEB_ADAPTER_NAME = "web";

/** The status line while Om works on a reply, before it uses a tool. */
export const WEB_THINKING_STATUS = "Thinking";

/** The author of Om's messages in a web chat. */
export const WEB_BOT_USER_ID = "omniralph";

/** Where a web chat's Chat SDK thread ID points. */
export interface WebThreadRef {
  organizationId: string;
  /** The `chat_threads` row's ID. */
  threadId: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WEB_THREAD_ID = new RegExp(`^web:(${UUID}):(${UUID})$`, "i");

/** A web chat's Chat SDK thread ID: `web:{organizationId}:{threadId}`. */
export function encodeWebThreadId(ref: WebThreadRef): string {
  return webChatExternalThreadId(ref.organizationId, ref.threadId);
}

/** The organization and chat of a `web:{organizationId}:{threadId}` thread ID, or null. */
export function decodeWebThreadId(threadId: string): WebThreadRef | null {
  const match = WEB_THREAD_ID.exec(threadId);
  return match ? { organizationId: match[1]!, threadId: match[2]! } : null;
}

/** Every button of a card, in sections too. */
function cardButtons(children: readonly CardChild[]): Array<{ id: string; value?: string }> {
  return children.flatMap((child) => {
    if (child.type === "section") return cardButtons(child.children);
    if (child.type !== "actions") return [];
    return child.children.flatMap((element) =>
      element.type === "button" ? [{ id: element.id, value: element.value }] : [],
    );
  });
}

/**
 * The draft a card acts on, from its buttons' actions: a request draft's card
 * (`REQUEST_DRAFT_ACTIONS`) or a Linear issue draft's (`LINEAR_ISSUE_ACTIONS`), the draft's ID
 * as their value; null for any other card.
 */
export function webCardRef(card: CardElement): ChatWebCardRef | null {
  for (const button of cardButtons(card.children)) {
    if (!button.value) continue;
    if (REQUEST_DRAFT_ACTIONS.includes(button.id)) {
      return { kind: "request_draft", draftId: button.value };
    }
    if (LINEAR_ISSUE_ACTIONS.includes(button.id)) {
      return { kind: "linear_issue_draft", draftId: button.value };
    }
  }
  return null;
}

/** A card's text for a reader without cards (and the model's history). */
function cardText(card: CardElement): string {
  return [
    card.title && `**${card.title}**`,
    card.subtitle,
    ...card.children.map((child) => cardChildToFallbackText(child)),
  ]
    .filter((part): part is string => !!part)
    .join("\n");
}

/** What a posted message stores: its Markdown, and its card if it is one. */
export function webMessageContent(message: AdapterPostableMessage): {
  markdown: string;
  card: CardElement | null;
} {
  if (typeof message === "string") return { markdown: message, card: null };
  if (isCardElement(message)) return { markdown: cardText(message), card: message };
  if ("card" in message) {
    return { markdown: message.fallbackText ?? cardText(message.card), card: message.card };
  }
  if ("markdown" in message) return { markdown: message.markdown, card: null };
  if ("ast" in message) return { markdown: stringifyMarkdown(message.ast), card: null };
  return { markdown: message.raw, card: null };
}

/**
 * Records a `chat` change of a web chat for its owner's own channel (never the
 * organization's), published once the write that caused it has committed.
 */
export function recordWebChatChange(
  db: unknown,
  thread: Pick<ChatThread, "id" | "organizationId" | "startedByUserId">,
): void {
  if (!thread.startedByUserId) return;
  recordChange(db, {
    resource: "chat",
    ids: [thread.id],
    organizationId: thread.organizationId,
    userId: thread.startedByUserId,
  });
}

/** How often at most a streaming message's text is written to the database. */
export const WEB_STREAM_FLUSH_MS = 1000;

/** A stored web message as the open request's `message` event carries it. */
export function webMessageView(row: ChatWebMessage) {
  return {
    id: row.id,
    author: row.author,
    markdown: row.markdown,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A stored web message as a Chat SDK message (`author`: the member who wrote it, else Om). */
export function webMessage(
  row: ChatWebMessage,
  author?: Pick<Author, "fullName" | "userName" | "email">,
): Message<ChatWebMessage> {
  const om = row.author === "om";
  const userId = om ? WEB_BOT_USER_ID : (row.userId ?? "unknown");
  return new Message<ChatWebMessage>({
    id: row.id,
    threadId: encodeWebThreadId({ organizationId: row.organizationId, threadId: row.threadId }),
    text: markdownToPlainText(row.markdown),
    formatted: parseMarkdown(row.markdown),
    raw: row,
    author: {
      userId,
      userName: author?.userName ?? (om ? "Om" : userId),
      fullName: author?.fullName ?? (om ? "Om" : userId),
      ...(author?.email ? { email: author.email } : {}),
      isBot: om,
      isMe: om,
    },
    metadata: {
      dateSent: row.createdAt,
      edited: row.updatedAt.getTime() > row.createdAt.getTime() && om,
    },
    attachments: [],
    // A web chat only has the member and Om: everything they write is for Om.
    isMention: !om,
  });
}

export interface WebAdapterDeps {
  db: Database;
}

export type WebAdapter = Adapter<WebThreadRef, ChatWebMessage>;

/** The Chat SDK adapter of web chats, over `chat_threads` and `chat_web_messages`. */
export function createWebAdapter(deps: WebAdapterDeps): WebAdapter {
  const { db } = deps;

  const decode = (threadId: string): WebThreadRef => {
    const ref = decodeWebThreadId(threadId);
    if (!ref) throw new Error(`Not a web chat thread ID: ${threadId}`);
    return ref;
  };

  /** The web chat a thread ID names, in its own organization; throws when there is none. */
  const loadThread = async (threadId: string): Promise<ChatThread> => {
    const ref = decode(threadId);
    const thread = await getChatThread(db, ref.threadId);
    if (!thread || thread.platform !== "web" || thread.organizationId !== ref.organizationId) {
      throw new Error(`No web chat ${threadId}`);
    }
    return thread;
  };

  /** A message of the thread, or a thrown error (a message of another chat is no message). */
  const loadMessage = async (thread: ChatThread, messageId: string): Promise<ChatWebMessage> => {
    const row = await getWebMessage(db, messageId);
    if (!row || row.threadId !== thread.id) throw new Error(`No message ${messageId} in the chat`);
    return row;
  };

  const raw = (threadId: string, row: ChatWebMessage): RawMessage<ChatWebMessage> => ({
    id: row.id,
    threadId,
    raw: row,
  });

  async function postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ChatWebMessage>> {
    const thread = await loadThread(threadId);
    const { markdown, card } = webMessageContent(message);
    const row = await appendWebMessage(db, {
      threadId: thread.id,
      author: "om",
      markdown,
      card,
      cardRef: card && webCardRef(card),
    });
    if (!row) throw new Error(`No web chat ${threadId}`);
    recordWebChatChange(db, thread);
    sendWebEvent("message", { message: webMessageView(row) });
    return raw(threadId, row);
  }

  /**
   * Om's reply as it is written: a `streaming` row (published and sent in full), each
   * chunk sent to the open request as a `delta`, the row's text written at most once a
   * second (unpublished) and at the end. The final edit (`editMessage`) completes it.
   */
  async function stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<ChatWebMessage>> {
    const thread = await loadThread(threadId);
    const row = await appendWebMessage(db, {
      threadId: thread.id,
      author: "om",
      markdown: "",
      status: "streaming",
    });
    if (!row) throw new Error(`No web chat ${threadId}`);
    recordWebChatChange(db, thread);
    sendWebEvent("message", { message: webMessageView(row) });

    let text = "";
    let written = "";
    let lastWrite = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let writing: Promise<unknown> = Promise.resolve();
    const write = () => {
      timer = null;
      lastWrite = Date.now();
      if (text === written) return;
      const markdown = text;
      written = markdown;
      writing = writing.then(() =>
        updateWebMessage(db, row.id, { markdown }).catch(() => undefined),
      );
    };
    try {
      for await (const chunk of textStream) {
        const delta =
          typeof chunk === "string" ? chunk : chunk.type === "markdown_text" ? chunk.text : "";
        if (!delta) continue;
        text += delta;
        sendWebEvent("delta", { messageId: row.id, text: delta });
        if (timer) continue;
        const wait = WEB_STREAM_FLUSH_MS - (Date.now() - lastWrite);
        if (wait <= 0) write();
        else timer = setTimeout(write, wait);
      }
    } finally {
      if (timer) clearTimeout(timer);
      write();
      await writing;
    }
    return raw(threadId, { ...row, markdown: text });
  }

  return {
    name: WEB_ADAPTER_NAME,
    userName: WEB_BOT_USER_ID,
    botUserId: WEB_BOT_USER_ID,
    lockScope: "thread",

    async initialize(_chat: ChatInstance) {},

    encodeThreadId: encodeWebThreadId,
    decodeThreadId: decode,

    channelIdFromThreadId(threadId) {
      return webChatChannelId(decode(threadId).organizationId);
    },

    isDM() {
      return false;
    },

    // Web messages arrive through `/api/ui/ask` (`handleWebMessage`), never a webhook.
    async handleWebhook() {
      return new Response("Not found", { status: 404 });
    },

    postMessage,
    stream,

    async editMessage(threadId, messageId, message) {
      const thread = await loadThread(threadId);
      const existing = await loadMessage(thread, messageId);
      const { markdown, card } = webMessageContent(message);
      const row = await updateWebMessage(db, existing.id, {
        markdown,
        status: "complete",
        card,
        // A card's later state (created, cancelled) keeps the draft it was for.
        cardRef: card ? (webCardRef(card) ?? existing.cardRef) : null,
      });
      if (!row) throw new Error(`No message ${messageId} in the chat`);
      recordWebChatChange(db, thread);
      sendWebEvent("message", { message: webMessageView(row) });
      return raw(threadId, row);
    },

    async deleteMessage(threadId, messageId) {
      const thread = await loadThread(threadId);
      const existing = await loadMessage(thread, messageId);
      if (await deleteWebMessage(db, existing.id)) recordWebChatChange(db, thread);
    },

    // Only the member who started a chat sees it: an ephemeral message is an ordinary one.
    async postEphemeral(threadId, _userId, message): Promise<EphemeralMessage<ChatWebMessage>> {
      return { ...(await postMessage(threadId, message)), usedFallback: false };
    },

    async fetchMessages(
      threadId,
      options: FetchOptions = {},
    ): Promise<FetchResult<ChatWebMessage>> {
      const thread = await loadThread(threadId);
      const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
      if (options.direction === "forward") {
        // Oldest first: the whole chat, then the page after the cursor (a message ID).
        const { messages: all } = await listWebMessages(db, thread.id, { limit: 10_000 });
        const start = options.cursor ? all.findIndex((m) => m.id === options.cursor) + 1 : 0;
        const page = start > 0 || !options.cursor ? all.slice(start, start + limit) : [];
        const last = page.at(-1);
        return {
          messages: page.map((row) => webMessage(row)),
          nextCursor: last && start + limit < all.length ? last.id : undefined,
        };
      }
      const { messages, nextBefore } = await listWebMessages(db, thread.id, {
        before: options.cursor ?? null,
        limit,
      });
      return {
        messages: messages.map((row) => webMessage(row)),
        nextCursor: nextBefore ?? undefined,
      };
    },

    async fetchMessage(threadId, messageId) {
      const thread = await loadThread(threadId);
      const row = await getWebMessage(db, messageId);
      return row && row.threadId === thread.id ? webMessage(row) : null;
    },

    async fetchThread(threadId): Promise<ThreadInfo> {
      const thread = await loadThread(threadId);
      return {
        id: threadId,
        channelId: thread.channelId,
        channelName: thread.title ?? undefined,
        isDM: false,
        metadata: {
          title: thread.title,
          repositoryId: thread.repositoryId,
          branch: thread.branch,
        },
      };
    },

    parseMessage(row) {
      return webMessage(row);
    },

    renderFormatted(content: FormattedContent) {
      return stringifyMarkdown(content);
    },

    // The web shows what Om is doing as a status line in the reply's stream.
    async startTyping(_threadId, status) {
      sendWebEvent("status", { text: status || WEB_THINKING_STATUS });
    },

    async addReaction() {},
    async removeReaction() {},
  };
}

/**
 * The organization's `web` connection a web chat thread ID resolves to: the chat must be a
 * web chat of the organization the ID names, on that organization's connection. Null for
 * anything else (an unknown chat, or an ID naming another organization than the chat's).
 */
export async function webChatConnection(
  db: Database,
  threadId: string,
): Promise<ChatConnection | null> {
  const ref = decodeWebThreadId(threadId);
  if (!ref) return null;
  const thread = await getChatThread(db, ref.threadId);
  if (
    !thread ||
    thread.platform !== "web" ||
    thread.organizationId !== ref.organizationId ||
    thread.externalThreadId !== threadId
  ) {
    return null;
  }
  const connection = await ensureWebChatConnection(db, ref.organizationId);
  return connection.id === thread.connectionId ? connection : null;
}

export interface WebMessageAuthor {
  /** The member's Omniralph user ID (their external user ID on the `web` platform). */
  id: string;
  name: string | null;
  email?: string | null;
}

export interface HandleWebMessageDeps {
  db: Database;
  bot: { chat: Pick<Chat, "processMessage">; adapters: { web?: Adapter } };
}

/**
 * A member's message in their web chat: stores it (`chat_web_messages`, publishing the
 * chat's change), then hands it to the bot as Slack's webhook does, so the same handler,
 * tools, rate limits and history apply, and waits for the turn's work. Returns the stored row.
 * The caller checked that `user` started the chat and is a member of its organization.
 */
export async function handleWebMessage(
  deps: HandleWebMessageDeps,
  input: { thread: ChatThread; user: WebMessageAuthor; text: string },
): Promise<ChatWebMessage> {
  const { db, bot } = deps;
  const { thread, user, text } = input;
  const adapter = bot.adapters.web;
  if (!adapter) throw new Error("The chat bot has no web adapter");
  if (thread.platform !== "web" || thread.startedByUserId !== user.id) {
    throw new Error(`${user.id} can't write in chat ${thread.id}`);
  }
  const row = await appendWebMessage(db, {
    threadId: thread.id,
    author: "user",
    userId: user.id,
    markdown: text,
  });
  if (!row) throw new Error(`No web chat ${thread.id}`);
  recordWebChatChange(db, thread);
  sendWebEvent("message", { message: webMessageView(row) });

  const name = user.name || user.email || user.id;
  const message = webMessage(row, {
    fullName: name,
    userName: name,
    email: user.email ?? undefined,
  });
  const work: Promise<unknown>[] = [];
  await bot.chat.processMessage(adapter, thread.externalThreadId, message, {
    waitUntil: (task) => void work.push(task),
  });
  while (work.length > 0) await Promise.all(work.splice(0));
  return row;
}
