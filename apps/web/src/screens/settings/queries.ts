"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { connectionListSchema, type ConnectionList } from "@/lib/api/connections";
import { connectionKeys } from "@/lib/api/keys";

/**
 * The active organization's connections (`GET /api/ui/connections`), for Settings' nav and
 * connection pages. A live query: `connection` change events (a connection added, renamed
 * or removed) refetch it.
 */
export function useConnections() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<ConnectionList>({
    queryKey: connectionKeys(keys).list,
    queryFn: ({ signal }) =>
      api.get("/api/ui/connections", connectionListSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}
