"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import type { MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type { ConnectionList } from "@/lib/api/connections";
import { connectionKeys, navIndicatorsKey } from "@/lib/api/keys";
import { navIndicatorsSchema, type NavIndicators } from "@/lib/api/nav-indicators";
import { useScopeParam } from "./scope";

/**
 * What the Fleet and Settings nav dots count (`GET /api/ui/nav-indicators`), in the user's
 * scope: read once in the shell and shared with Settings' section nav through the cache. A
 * live query: `agent` events (the liveness cron, a heartbeat bringing an agent back, an
 * update failing), `webhook_event` events (a delivery recorded or replayed) and `connection`
 * events refetch it.
 */
export function useNavIndicators() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<NavIndicators>({
    queryKey: navIndicatorsKey(keys, scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/nav-indicators", navIndicatorsSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}

/** `indicators` with one of `connectionId`'s failed deliveries replayed successfully. */
export function withoutFailedDelivery(
  indicators: NavIndicators,
  connectionId: string,
): NavIndicators {
  const entry = indicators.settings.byConnection.find((c) => c.id === connectionId);
  if (!entry) return indicators;
  return {
    ...indicators,
    settings: {
      failedDeliveries: Math.max(0, indicators.settings.failedDeliveries - 1),
      byConnection: indicators.settings.byConnection.flatMap((c) =>
        c.id !== connectionId ? [c] : c.failed > 1 ? [{ ...c, failed: c.failed - 1 }] : [],
      ),
    },
  };
}

/**
 * Writes a successful replay of one of `connectionId`'s failed deliveries into the cache:
 * the Settings and connection dots (every scope's nav indicators) and the connection's
 * "Failed N" count drop it at once. A replay that failed again is a new unreplayed failure,
 * so nothing changes then.
 */
export async function writeReplayedDelivery(
  cache: MutationCache,
  { connectionId, failed }: { connectionId: string; failed: boolean },
): Promise<void> {
  if (failed) return;
  await cache.set<NavIndicators>(cache.keys.navIndicators.all, (previous) =>
    previous ? withoutFailedDelivery(previous, connectionId) : previous,
  );
  await cache.set<ConnectionList>(connectionKeys(cache.keys).list, (previous) =>
    previous
      ? {
          ...previous,
          connections: previous.connections.map((connection) =>
            connection.id === connectionId
              ? { ...connection, failedDeliveries: Math.max(0, connection.failedDeliveries - 1) }
              : connection,
          ),
        }
      : previous,
  );
}
