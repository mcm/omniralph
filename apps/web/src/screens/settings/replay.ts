"use client";

import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { connectionKeys } from "@/lib/api/keys";
import { deliveryDetailSchema, type DeliveryDetail } from "@/lib/api/deliveries";
import { writeReplayedDelivery } from "../nav-indicators";

/** The delivery to replay. */
export interface ReplayRequest {
  id: string;
}

/**
 * Replays a delivery (`POST /api/ui/deliveries/{id}/replay`, any member). The answer (the
 * replay's own delivery) is written into the cache at once: when it didn't fail, the
 * Settings and connection dots and the connection's failed count drop the replayed one
 * before any refetch; the delivery log and counts then reconcile in the background.
 */
export function useReplayDelivery() {
  return useApiMutation<DeliveryDetail, ReplayRequest>({
    mutationFn: ({ id }) =>
      api.post(`/api/ui/deliveries/${encodeURIComponent(id)}/replay`, deliveryDetailSchema),
    applyResult: (replay, cache) =>
      writeReplayedDelivery(cache, {
        connectionId: replay.connection.id,
        failed: replay.outcome === "failed",
      }),
    invalidate: (keys) => [keys.deliveries.all, keys.navIndicators.all, connectionKeys(keys).list],
    success: "Replayed",
  });
}
