"use client";

import { toast } from "@omniralph/ui";
import { useIsMutating } from "@tanstack/react-query";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api, ApiError } from "@/lib/api/client";
import {
  INBOX_TABS,
  inboxItemActionResultSchema,
  type InboxCountsResponse,
  type InboxFeed,
  type InboxItem,
  type InboxItemActionRequest,
  type InboxItemActionResult,
  type InboxTabParam,
} from "@/lib/api/inbox";
import { inboxKeys } from "@/lib/api/keys";
import { useScopeParam } from "@/screens/scope";
import { ITEM_HANDLED } from "./decisions";

const COUNT_OF: Record<InboxItem["tab"], keyof InboxCountsResponse> = {
  "needs-you": "needsYou",
  problems: "problems",
  running: "running",
};

/**
 * Takes the item out of the scope's cached feeds (of `tabs`) and drops each tab's count it
 * left (the nav count too) by one, before the server answers.
 */
export async function removeFromInbox(
  cache: MutationCache,
  scope: string,
  itemKey: string,
  tabs: readonly InboxTabParam[] = INBOX_TABS,
): Promise<void> {
  const inbox = inboxKeys(cache.keys);
  for (const tab of tabs) {
    let removed = false;
    await cache.set<InboxFeed>(inbox.feed(tab, scope), (feed) => {
      if (!feed?.items.some((entry) => entry.key === itemKey)) return feed;
      removed = true;
      return { ...feed, items: feed.items.filter((entry) => entry.key !== itemKey) };
    });
    if (!removed) continue;
    const count = COUNT_OF[tab];
    await cache.set<InboxCountsResponse>(inbox.counts(scope), (counts) =>
      counts ? { ...counts, [count]: Math.max(0, counts[count] - 1) } : counts,
    );
  }
}

/** The mutation key of the decisions on one item, so every place it shows can disable them. */
export function inboxDecisionKey(itemKey: string) {
  return ["inbox-decision", itemKey] as const;
}

/** Whether a decision on the item is waiting on the server. */
export function useInboxDecisionPending(itemKey: string): boolean {
  return useIsMutating({ mutationKey: inboxDecisionKey(itemKey) }) > 0;
}

/**
 * Decides on an Inbox item (`POST /api/ui/inbox/items/{key}`), for an item of any of the
 * user's organizations. Before the server answers, the item leaves its feed and its tab
 * count (the nav count too) drops by one; the Inbox then selects the next item. A failure
 * puts both back with the server's message; a 404 (someone decided first) says so in an
 * info toast and leaves the item removed. The change event that follows confirms it.
 */
export function useInboxDecision(item: Pick<InboxItem, "key" | "tab">) {
  const scope = useScopeParam();
  return useApiMutation<InboxItemActionResult | null, InboxItemActionRequest>({
    mutationKey: inboxDecisionKey(item.key),
    mutationFn: async (body, { organizationId }) => {
      try {
        return await api.post(
          `/api/ui/inbox/items/${encodeURIComponent(item.key)}`,
          inboxItemActionResultSchema,
          { body, organizationId },
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    optimistic: (_body, cache) => removeFromInbox(cache, scope, item.key, [item.tab]),
    invalidate: (keys) => [keys.inbox.all, keys.runs.all],
    success: null,
    onSuccess: (result) => {
      if (result === null) toast(ITEM_HANDLED, { variant: "info" });
    },
  });
}
