"use client";

import { toast } from "@omniralph/ui";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { MUTATION_FAILED } from "@/components/use-api-mutation";
import type { AskChat } from "@/lib/api/ask";
import { ApiError } from "@/lib/api/client";
import { streamAskTurn, type AskTurnEvent } from "@/lib/ask/stream-client";
import {
  pendingUserMessage,
  withMessage,
  withMessageText,
  withMissingMessages,
  withoutMessage,
  type AskChatData,
} from "./chat-cache";
import { askTurn, setAskTurn } from "./chat-memory";

let pendingSeq = 0;

/** How a send ended: `sent` once the server stored the message, else `failed` (nothing sent). */
export type AskSendResult = "sent" | "failed";

export interface AskTurnOptions {
  client: QueryClient;
  /** A chat's query key (`askKeys(keys).chat(id)`). */
  chatKey: (chatId: string) => QueryKey;
  /** The chat the message goes to; null for a new chat, known from its `chat` event. */
  chatId: string | null;
  /** `POST /api/ui/ask/chats` (a new chat) or `.../chats/{id}/messages`. */
  path: string;
  body: unknown;
  /** The member's message as sent (shown at once). */
  text: string;
  organizationId: string;
  /**
   * A new chat's `chat` event: its cache is seeded and its turn started before this runs,
   * so a view switching to the chat shows the member's message and streams the reply.
   */
  onChat?: (chat: AskChat) => void;
}

/**
 * Sends an Ask turn and writes its events into the chat's query cache as they arrive: the
 * member's message at once, Om's text as it streams, then the stored messages. The turn
 * lives in memory (`chat-memory.ts`), so it runs to its end whatever view is showing. A
 * new chat's turn starts on its `chat` event (the first). Resolves when the turn is over.
 */
export async function runAskTurn({
  client,
  chatKey,
  chatId: initialChatId,
  path,
  body,
  text,
  organizationId,
  onChat,
}: AskTurnOptions): Promise<AskSendResult> {
  let chatId = initialChatId;
  const pending = pendingUserMessage(String(++pendingSeq), text);
  const write = (id: string, update: (data: AskChatData) => AskChatData) =>
    client.setQueryData<AskChatData>(chatKey(id), (data) => (data ? update(data) : data));

  const begin = (id: string) => {
    chatId = id;
    setAskTurn(id, { pending, streamed: new Map(), messages: new Map(), status: null });
    write(id, (data) => withMessage(data, pending));
  };

  const apply = (id: string, event: AskTurnEvent) => {
    switch (event.event) {
      case "chat":
        return;
      case "message": {
        const { message } = event;
        write(id, (data) => withMessage(data, message));
        setAskTurn(id, (current) => {
          const streamed = new Map(current.streamed);
          if (message.status === "streaming") streamed.set(message.id, message.markdown);
          else streamed.delete(message.id);
          return {
            ...current,
            pending: message.author === "user" ? null : current.pending,
            streamed,
            messages: new Map(current.messages).set(message.id, message),
          };
        });
        return;
      }
      case "delta": {
        const streamedText = (askTurn(id)?.streamed.get(event.messageId) ?? "") + event.text;
        write(id, (data) => withMessageText(data, event.messageId, streamedText));
        setAskTurn(id, (state) => ({
          ...state,
          streamed: new Map(state.streamed).set(event.messageId, streamedText),
        }));
        return;
      }
      case "status":
        setAskTurn(id, (state) => ({ ...state, status: event.text }));
        return;
      case "error":
        toast(event.message, { variant: "danger" });
        return;
      case "done":
        return;
    }
  };

  if (chatId) begin(chatId);
  try {
    await streamAskTurn({
      path,
      body,
      organizationId,
      onEvent: (event) => {
        if (event.event === "chat" && chatId === null) {
          const { chat } = event;
          client.setQueryData<AskChatData>(chatKey(chat.id), (data) =>
            data
              ? data
              : {
                  pages: [{ chat, messages: [], activity: null, nextBefore: null }],
                  pageParams: [undefined],
                },
          );
          begin(chat.id);
          onChat?.(chat);
          return;
        }
        if (chatId !== null) apply(chatId, event);
        else if (event.event === "error") toast(event.message, { variant: "danger" });
      },
    });
  } catch (error) {
    toast(error instanceof ApiError ? error.message : MUTATION_FAILED, { variant: "danger" });
  }
  if (chatId === null) return "failed";
  const id = chatId;
  const ended = askTurn(id);
  const stored = ended !== null && ended.pending === null;
  if (!stored) write(id, (data) => withoutMessage(data, pending.id));
  // A load during the turn may predate its messages: keep them when the overlay goes.
  else write(id, (data) => withMissingMessages(data, ended.messages.values()));
  setAskTurn(id, null);
  // A stream cut short left a message unfinished: the stored copy is the truth.
  if (stored && ended && ended.streamed.size > 0) {
    void client.invalidateQueries({ queryKey: chatKey(id), exact: true });
  }
  return stored ? "sent" : "failed";
}
