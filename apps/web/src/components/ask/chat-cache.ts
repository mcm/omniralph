import type { InfiniteData } from "@tanstack/react-query";
import type { AskChatDetail, AskMessageView } from "@/lib/api/ask";

/**
 * A chat's query data: its pages from `GET /api/ui/ask/chats/{id}`, the latest first
 * (`pages[0]`, with the chat and its activity), then older ones (`before`).
 */
export type AskChatData = InfiniteData<AskChatDetail, string | undefined>;

/** The ID prefix of a member's message shown before the server has stored it. */
export const PENDING_MESSAGE_PREFIX = "pending:";

export const isPendingMessage = (message: Pick<AskMessageView, "id">) =>
  message.id.startsWith(PENDING_MESSAGE_PREFIX);

/** The member's message as it shows the moment they send it. */
export function pendingUserMessage(id: string, text: string, now = new Date()): AskMessageView {
  return {
    id: `${PENDING_MESSAGE_PREFIX}${id}`,
    author: "user",
    markdown: text,
    status: "complete",
    createdAt: now.toISOString(),
    run: null,
    files: [],
    workItems: [],
    card: null,
  };
}

/** Every message of the chat, oldest first, each once. */
export function chatMessages(data: AskChatData): AskMessageView[] {
  const seen = new Set<string>();
  const messages: AskMessageView[] = [];
  for (const page of [...data.pages].reverse()) {
    for (const message of page.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }
  return messages;
}

function mapPages(
  data: AskChatData,
  map: (messages: AskMessageView[], index: number) => AskMessageView[],
): AskChatData {
  return {
    ...data,
    pages: data.pages.map((page, index) => {
      const messages = map(page.messages, index);
      return messages === page.messages ? page : { ...page, messages };
    }),
  };
}

const contains = (data: AskChatData, id: string) =>
  data.pages.some((page) => page.messages.some((message) => message.id === id));

/**
 * `message` stored in the chat: replaces the message with its ID where it is, else is
 * appended (newest). The member's own stored message replaces the pending one it was sent as.
 */
export function withMessage(data: AskChatData, message: AskMessageView): AskChatData {
  if (contains(data, message.id)) {
    return mapPages(data, (messages) =>
      messages.some((m) => m.id === message.id)
        ? messages.map((m) => (m.id === message.id ? message : m))
        : messages,
    );
  }
  let replaced = false;
  const next = mapPages(data, (messages) => {
    if (replaced || message.author !== "user") return messages;
    const index = messages.findIndex((m) => isPendingMessage(m) && m.markdown === message.markdown);
    if (index === -1) return messages;
    replaced = true;
    return messages.map((m, i) => (i === index ? message : m));
  });
  if (replaced) return next;
  return mapPages(data, (messages, index) => (index === 0 ? [...messages, message] : messages));
}

/** A streaming message's text so far (nothing changes when the message isn't there). */
export function withMessageText(data: AskChatData, messageId: string, text: string): AskChatData {
  if (!contains(data, messageId)) return data;
  return mapPages(data, (messages) =>
    messages.some((m) => m.id === messageId)
      ? messages.map((m) => (m.id === messageId ? { ...m, markdown: text } : m))
      : messages,
  );
}

/** The chat without the message (a pending one that never reached the server). */
export function withoutMessage(data: AskChatData, messageId: string): AskChatData {
  if (!contains(data, messageId)) return data;
  return mapPages(data, (messages) => messages.filter((m) => m.id !== messageId));
}

/** What a turn in flight has shown so far, laid over the chat's data while it streams. */
export interface AskTurnOverlay {
  /** The member's message until the server has stored it. */
  pending: AskMessageView | null;
  /** The text each streaming Om message has received so far, by message ID. */
  streamed: ReadonlyMap<string, string>;
  /** Each message the turn's events delivered, as last sent, in order. */
  messages: ReadonlyMap<string, AskMessageView>;
}

/** `data` with each of `messages` it doesn't hold yet appended (newest). */
export function withMissingMessages(
  data: AskChatData,
  messages: Iterable<AskMessageView>,
): AskChatData {
  let next = data;
  for (const message of messages) {
    if (!contains(next, message.id)) next = withMessage(next, message);
  }
  return next;
}

/**
 * The chat's data with a turn in flight laid over it: a refetch while the turn streams
 * (another view's change event, or a new chat's first load) returns the database's copy,
 * flushed at most once a second and maybe from before the turn's messages, so the turn's
 * messages stay, the text already received wins, and the pending message stays.
 */
export function withTurn(data: AskChatData, turn: AskTurnOverlay | null): AskChatData {
  if (!turn) return data;
  let next = withMissingMessages(data, turn.messages.values());
  if (turn.streamed.size > 0) {
    next = mapPages(next, (messages) =>
      messages.some((m) => m.status === "streaming" && turn.streamed.has(m.id))
        ? messages.map((m) =>
            m.status === "streaming" && turn.streamed.has(m.id)
              ? { ...m, markdown: turn.streamed.get(m.id)! }
              : m,
          )
        : messages,
    );
  }
  const pending = turn.pending;
  if (pending && !contains(next, pending.id)) {
    next = mapPages(next, (messages, index) => (index === 0 ? [...messages, pending] : messages));
  }
  return next;
}
