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

/**
 * `indicators` with `delta` more (or, negative, fewer) of `connectionId`'s failed deliveries
 * not yet replayed: the Settings dot's count and the connection's entry, which leaves at zero.
 */
export function withFailedDeliveries(
  indicators: NavIndicators,
  connectionId: string,
  delta: number,
): NavIndicators {
  const { byConnection } = indicators.settings;
  const entry = byConnection.find((c) => c.id === connectionId);
  const failed = Math.max(0, (entry?.failed ?? 0) + delta);
  const change = failed - (entry?.failed ?? 0);
  if (change === 0) return indicators;
  const rest = entry ? byConnection : [...byConnection, { id: connectionId, failed }];
  return {
    ...indicators,
    settings: {
      failedDeliveries: Math.max(0, indicators.settings.failedDeliveries + change),
      byConnection: rest.flatMap((c) =>
        c.id !== connectionId ? [c] : failed > 0 ? [{ ...c, failed }] : [],
      ),
    },
  };
}

/**
 * Writes `delta` more (or fewer) of `connectionId`'s failed deliveries not yet replayed into
 * the cache: the Settings and connection dots (every scope's nav indicators) and the
 * connection's "Failed N" count. A replay lowers it at once, and raises it back when the
 * replay failed again (a new unreplayed failure).
 */
export async function writeFailedDeliveries(
  cache: MutationCache,
  connectionId: string,
  delta: number,
): Promise<void> {
  await cache.set<NavIndicators>(cache.keys.navIndicators.all, (previous) =>
    previous ? withFailedDeliveries(previous, connectionId, delta) : previous,
  );
  await cache.set<ConnectionList>(connectionKeys(cache.keys).list, (previous) =>
    previous
      ? {
          ...previous,
          connections: previous.connections.map((connection) =>
            connection.id === connectionId
              ? {
                  ...connection,
                  failedDeliveries: Math.max(0, connection.failedDeliveries + delta),
                }
              : connection,
          ),
        }
      : previous,
  );
}
