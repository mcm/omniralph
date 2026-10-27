"use client";

import type { InfiniteData } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { connectionKeys, deliveryKeys } from "@/lib/api/keys";
import {
  deliveryDetailSchema,
  type DeliveryDetail,
  type DeliveryList,
  type DeliveryRow,
} from "@/lib/api/deliveries";
import { writeFailedDeliveries } from "../nav-indicators";

/** The outcome filters of a connection's delivery log, by the outcomes each lists. */
export const DELIVERY_FILTERS = {
  all: [],
  failed: ["failed"],
  ignored: ["ignored"],
} as const satisfies Record<string, readonly DeliveryRow["outcome"][]>;
export type DeliveryFilter = keyof typeof DELIVERY_FILTERS;

/** A row of the cached log: a replay the server hasn't answered yet is `replaying`. */
export type ListedDelivery = DeliveryRow & { replaying?: true };

export type CachedDeliveries = InfiniteData<
  Omit<DeliveryList, "deliveries"> & { deliveries: ListedDelivery[] },
  string | null
>;

/** The ID of a replay's row while the server hasn't answered. */
export const replayingId = (originalId: string) => `replaying:${originalId}`;

/** Every cached page of one of the connection's lists, changed by `update` (none: unchanged). */
function updateList(
  cache: MutationCache,
  connectionId: string,
  filter: DeliveryFilter,
  update: (data: CachedDeliveries) => CachedDeliveries,
) {
  return cache.set<CachedDeliveries>(
    deliveryKeys(cache.keys).list(connectionId, filter),
    (previous) => previous && update(previous),
    { exact: true },
  );
}

/** `data` with `row` on top of its first page. */
const withFirst = (data: CachedDeliveries, row: ListedDelivery): CachedDeliveries => ({
  ...data,
  pages: data.pages.map((page, index) =>
    index === 0 ? { ...page, deliveries: [row, ...page.deliveries] } : page,
  ),
});

/** Whether a cached row of the connection's log already replayed `delivery`. */
function replayedInCache(cache: MutationCache, delivery: DeliveryRow): boolean {
  return (Object.keys(DELIVERY_FILTERS) as DeliveryFilter[]).some((filter) =>
    cache
      .get<CachedDeliveries>(deliveryKeys(cache.keys).list(delivery.connection.id, filter))
      ?.pages.some((page) => page.deliveries.some((row) => row.replayOfId === delivery.id)),
  );
}

/** Counts a failure not yet replayed: the Failed count and the dots drop it at once. */
const countsAsUnreplayed = (cache: MutationCache, delivery: DeliveryRow) =>
  delivery.outcome === "failed" && !replayedInCache(cache, delivery);

/**
 * Replays a delivery (`POST /api/ui/deliveries/{id}/replay`, any member). At once, before
 * the server answers: the replay's row goes on top of the connection's log ("Replaying…"),
 * and a failure not yet replayed leaves the connection's "Failed N" count and the Settings
 * and connection dots. The answer (the replay's own delivery) replaces the row and joins the
 * Failed or Ignored list it belongs to; a replay that failed counts as a new failure. A refusal (a payload too large to keep, a
 * removed connection, too many replays, a run still active) toasts the server's message
 * and puts everything back. The log and counts then reconcile in the background (and
 * through the replay's `webhook_event` event).
 */
export function useReplayDelivery() {
  const { id: userId, name } = useCurrentUser();
  return useApiMutation<DeliveryDetail, DeliveryRow>({
    mutationFn: ({ id }) =>
      api.post(`/api/ui/deliveries/${encodeURIComponent(id)}/replay`, deliveryDetailSchema),
    optimistic: async (delivery, cache) => {
      const counted = countsAsUnreplayed(cache, delivery);
      const replaying: ListedDelivery = {
        ...delivery,
        id: replayingId(delivery.id),
        deliveryId: null,
        outcome: "started_run",
        reasonCode: null,
        reason: null,
        run: null,
        replayOfId: delivery.id,
        replayedBy: { id: userId, name: name ?? "You" },
        receivedAt: new Date().toISOString(),
        replaying: true,
      };
      await updateList(cache, delivery.connection.id, "all", (data) => withFirst(data, replaying));
      if (counted) await writeFailedDeliveries(cache, delivery.connection.id, -1);
    },
    applyResult: async (replay, cache, delivery) => {
      const { payload: _payload, replays: _replays, ...row } = replay;
      const connectionId = delivery.connection.id;
      await updateList(cache, connectionId, "all", (data) => ({
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          deliveries: page.deliveries.map((entry) =>
            entry.id === replayingId(delivery.id) ? row : entry,
          ),
        })),
      }));
      for (const filter of ["failed", "ignored"] as const) {
        if ((DELIVERY_FILTERS[filter] as readonly string[]).includes(row.outcome)) {
          await updateList(cache, connectionId, filter, (data) => withFirst(data, row));
        }
      }
      // A replay that failed is a new failure not yet replayed (and puts back the original's).
      if (row.outcome === "failed") {
        await writeFailedDeliveries(cache, connectionId, 1);
      }
    },
    invalidate: (keys, delivery) => [
      deliveryKeys(keys).connection(delivery.connection.id),
      keys.navIndicators.all,
      connectionKeys(keys).list,
    ],
    success: "Replayed",
  });
}
