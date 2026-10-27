"use client";

import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import {
  askChatListSchema,
  askRepositoryListSchema,
  type AskChat,
  type AskChatList,
  type AskRepositoryList,
} from "@/lib/api/ask";
import { api } from "@/lib/api/client";
import { askKeys } from "@/lib/api/keys";
import type { QueryKeys } from "@/lib/api/keys";
import { useScopeParam } from "@/screens/scope";

/** The chats list's query data: its pages, newest activity first. */
export type AskChatListData = InfiniteData<AskChatList, string | null>;

/**
 * The viewer's own web chats in their organization scope (`GET /api/ui/ask/chats`), newest
 * activity first, a page at a time (the next with `nextCursor`). A live query: a `chat`
 * change event on the viewer's own channel refetches every loaded page, so a chat that gets
 * a message moves to the top and one started in another tab appears; it polls only as the
 * live layer's fallback.
 */
export function useAskChats() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useInfiniteQuery({
    queryKey: askKeys(keys).chats(scope),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }): Promise<AskChatList> =>
      api.get("/api/ui/ask/chats", askChatListSchema, {
        params: { organization: scope, cursor: pageParam },
        organizationId: organization.id,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** The repos a new chat can pick in the viewer's scope (`GET /api/ui/ask/repositories`). */
export function useAskRepositories() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<AskRepositoryList>({
    queryKey: askKeys(keys).repositories(scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/ask/repositories", askRepositoryListSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}

/** `data` with `chat` at the top of its first page (and nowhere else). */
export function withChatOnTop(data: AskChatListData, chat: AskChat): AskChatListData {
  return {
    ...data,
    pages: data.pages.map((page, index) => {
      const chats = page.chats.filter((other) => other.id !== chat.id);
      return { ...page, chats: index === 0 ? [chat, ...chats] : chats };
    }),
  };
}

/**
 * Puts a chat the viewer just started at the top of every loaded chats list, before its
 * change event refetches them.
 */
export function addChatToLists(client: QueryClient, keys: QueryKeys, chat: AskChat): void {
  client.setQueriesData<AskChatListData>({ queryKey: askKeys(keys).chatLists }, (data) =>
    data?.pages?.length ? withChatOnTop(data, chat) : data,
  );
}
