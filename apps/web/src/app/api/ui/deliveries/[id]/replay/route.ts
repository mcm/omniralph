import { getWebhookEvent, listWebhookEventReplays } from "@omniralph/db";
import { z } from "zod";
import type { DeliveryDetail } from "@/lib/api/deliveries";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { deliveryDetail } from "@/lib/deliveries/list";
import { hitReplayLimit, replayDelivery } from "@/lib/deliveries/replay";

const NOT_FOUND = "That delivery doesn't exist.";

/**
 * Replays a stored delivery with today's settings, through the same processing as a live
 * delivery (no signature check or delivery-ID claim), and answers the replay's delivery
 * (`replayOfId`, `replayedBy`, the run it started). Any member of the delivery's
 * organization may; 10 a minute per user (429). 404 once it's pruned, 400 when its payload
 * wasn't kept or its connection or repo is gone, 409 while a Linear agent session's run is
 * still active.
 */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params }): Promise<DeliveryDetail> => {
    if (!z.uuid().safeParse(params.id).success) throw ApiRouteError.notFound(NOT_FOUND);
    const db = getDb();
    const event = await getWebhookEvent(db, params.id);
    const organization = await requireOrganizationAccess(user, event?.organizationId ?? null, {
      notFoundMessage: NOT_FOUND,
    });
    await hitReplayLimit(db, user.id);
    const replayId = await replayDelivery({ db, dispatcher: getDispatcher() }, event!, user.id);
    const replay = await getWebhookEvent(db, replayId);
    if (!replay) throw ApiRouteError.notFound(NOT_FOUND);
    return deliveryDetail(replay, organization, await listWebhookEventReplays(db, replay.id));
  },
);
