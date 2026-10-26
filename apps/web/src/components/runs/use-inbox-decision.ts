"use client";

import { toast } from "@omniralph/ui";
import { useIsMutating } from "@tanstack/react-query";
import { useApiMutation } from "@/components/use-api-mutation";
import { api, ApiError } from "@/lib/api/client";
import {
  inboxItemActionResultSchema,
  type InboxCountsResponse,
  type InboxFeed,
  type InboxItem,
  type InboxItemActionRequest,
  type InboxItemActionResult,
} from "@/lib/api/inbox";
import { inboxKeys } from "@/lib/api/keys";
import { useScopeParam } from "@/screens/scope";
import { ITEM_HANDLED } from "./decisions";

const COUNT_OF: Record<InboxItem["tab"], keyof InboxCountsResponse> = {
  "needs-you": "needsYou",
  problems: "problems",
  running: "running",
};

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
    optimistic: async (_body, cache) => {
      const inbox = inboxKeys(cache.keys);
      let removed = false;
      await cache.set<InboxFeed>(inbox.feed(item.tab, scope), (feed) => {
        if (!feed?.items.some((entry) => entry.key === item.key)) return feed;
        removed = true;
        return { ...feed, items: feed.items.filter((entry) => entry.key !== item.key) };
      });
      if (!removed) return;
      const count = COUNT_OF[item.tab];
      await cache.set<InboxCountsResponse>(inbox.counts(scope), (counts) =>
        counts ? { ...counts, [count]: Math.max(0, counts[count] - 1) } : counts,
      );
    },
    invalidate: (keys) => [keys.inbox.all, keys.runs.all],
    success: null,
    onSuccess: (result) => {
      if (result === null) toast(ITEM_HANDLED, { variant: "info" });
    },
  });
}
