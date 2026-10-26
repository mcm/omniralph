"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import {
  inboxCountsSchema,
  inboxFeedSchema,
  type InboxCountsResponse,
  type InboxFeed,
  type InboxTabParam,
} from "@/lib/api/inbox";
import { inboxKeys } from "@/lib/api/keys";
import { useScopeParam } from "../scope";

/**
 * One Inbox tab's items in the user's scope (`GET /api/ui/inbox?tab=&organization=`). A
 * live query: change events refetch it, and it polls only while live updates are down.
 */
export function useInboxFeed(tab: InboxTabParam) {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<InboxFeed>({
    queryKey: inboxKeys(keys).feed(tab, scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/inbox", inboxFeedSchema, {
        params: { tab, organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * Each Inbox tab's count in the user's scope (`GET /api/ui/inbox/counts`): read once in
 * the shell (the nav count) and shared with the Inbox's tabs through the query cache.
 */
export function useInboxCounts() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<InboxCountsResponse>({
    queryKey: inboxKeys(keys).counts(scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/inbox/counts", inboxCountsSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}
