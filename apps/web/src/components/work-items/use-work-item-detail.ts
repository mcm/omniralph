"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { backlogKeys } from "@/lib/api/keys";
import { api } from "@/lib/api/client";
import { workItemDetailSchema, type WorkItemDetail } from "@/lib/api/work-items";

/** The detail's path: `GET /api/ui/work-items/{id}`. */
export const workItemDetailPath = (workItemId: string) =>
  `/api/ui/work-items/${encodeURIComponent(workItemId)}`;

/** A cached work item detail, and not one of its parts (share links) under the same key. */
export function isWorkItemDetail(data: unknown): data is WorkItemDetail {
  return (
    typeof data === "object" &&
    data !== null &&
    "description" in data &&
    "actions" in data &&
    "route" in data
  );
}

/**
 * A work item's detail (`GET /api/ui/work-items/{id}`), of any of the user's organizations.
 * A live query: a `work_item` change event naming the item refetches it, and it polls only
 * while live updates are down.
 */
export function useWorkItemDetail(workItemId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<WorkItemDetail>({
    queryKey: backlogKeys(keys).detail(workItemId),
    queryFn: ({ signal }) =>
      api.get(workItemDetailPath(workItemId), workItemDetailSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}
