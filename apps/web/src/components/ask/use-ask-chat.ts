"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import {
  askCardActionResponseSchema,
  askChatDetailSchema,
  type AskCardActionRequest,
  type AskCardActionResponse,
} from "@/lib/api/ask";
import { api } from "@/lib/api/client";
import { askKeys } from "@/lib/api/keys";
import type { AskCardClick } from "./card-actions";
import { chatMessages, withMessage, withTurn, type AskChatData } from "./chat-cache";
import { askTurn, useAskTurn } from "./chat-memory";
import { runAskTurn, type AskSendResult } from "./turn";

/** A chat's API path. */
export const askChatPath = (chatId: string) => `/api/ui/ask/chats/${encodeURIComponent(chatId)}`;

export type { AskSendResult } from "./turn";

/** What a card's buttons need from the chat: whether its click is in flight, and its error. */
export interface AskCardActionState {
  pending: boolean;
  actionError: string | null;
}

/**
 * A chat (`GET /api/ui/ask/chats/{id}`, the latest messages first, older pages with
 * `before`), with sending and card actions. A live query: a `chat` event naming it (on
 * the viewer's own channel) and the run events of its asks in flight (`activity.runIds`,
 * through `meta.liveRunIds`) refetch it; it polls only as the live layer's fallback.
 *
 * Sending (`POST .../messages`) writes the turn's events into the query's cache as they
 * arrive: the member's message at once, Om's text as it streams, then the stored message.
 * The turn lives in memory (`chat-memory.ts`), so it keeps running when the view unmounts.
 * Card clicks (`POST .../actions`) put the returned message in the cache (`applyResult`)
 * before the change event reconciles it.
 */
export function useAskChat(chatId: string) {
  const client = useQueryClient();
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  const queryKey = React.useMemo(() => askKeys(keys).chat(chatId), [keys, chatId]);
  const path = askChatPath(chatId);
  const turn = useAskTurn(chatId);

  const select = React.useCallback((data: AskChatData) => withTurn(data, turn), [turn]);
  // The asks in flight of the data on screen: their run events refresh the chat.
  const cached = client.getQueryData<AskChatData>(queryKey);
  const liveRunIds = cached?.pages[0]?.activity?.runIds ?? [];

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      api.get(path, askChatDetailSchema, {
        params: { before: pageParam },
        organizationId: organization.id,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    select,
    meta: { liveRunIds },
  });

  /** Sends `text` as the member's next message; resolves when the turn is over. */
  const send = React.useCallback(
    async (text: string): Promise<AskSendResult> => {
      const trimmed = text.trim();
      if (!trimmed || askTurn(chatId)) return "failed";
      return runAskTurn({
        client,
        chatKey: askKeys(keys).chat,
        chatId,
        path: `${path}/messages`,
        body: { text: trimmed },
        text: trimmed,
        organizationId: organization.id,
      });
    },
    [chatId, client, keys, organization.id, path],
  );

  const action = useApiMutation<AskCardActionResponse, AskCardActionRequest>({
    mutationFn: (body, { organizationId }) =>
      api.post(`${path}/actions`, askCardActionResponseSchema, { organizationId, body }),
    applyResult: ({ message }, cache) =>
      cache.set<AskChatData>(queryKey, (data) => (data ? withMessage(data, message) : data), {
        exact: true,
      }),
    // The card already shows the outcome; the chat's change event reconciles it.
    invalidate: () => [],
    success: null,
  });

  const act = React.useCallback(
    (messageId: string, click: AskCardClick) =>
      action.mutate({ messageId, actionId: click.actionId, value: click.value }),
    [action],
  );

  const actionState = (messageId: string): AskCardActionState => {
    const mine = action.variables?.messageId === messageId;
    return {
      pending: mine && action.isPending,
      actionError: mine && action.isError ? action.error.message : null,
    };
  };

  const data = query.data;
  return {
    query,
    chat: data?.pages[0]?.chat ?? null,
    messages: data ? chatMessages(data) : [],
    activity: data?.pages[0]?.activity ?? null,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => void query.fetchNextPage(),
    send,
    /** A turn is in flight (Send is disabled). */
    streaming: turn !== null,
    /** What Om is doing in the turn in flight. */
    status: turn?.status ?? null,
    act,
    actionState,
  };
}
