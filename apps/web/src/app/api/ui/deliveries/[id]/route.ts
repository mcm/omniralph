import { getWebhookEvent, listWebhookEventReplays } from "@omniralph/db";
import { z } from "zod";
import type { DeliveryDetail } from "@/lib/api/deliveries";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { deliveryDetail } from "@/lib/deliveries/list";

const NOT_FOUND = "That delivery doesn't exist.";

/**
 * A webhook delivery with its stored payload (null when it was too large to keep) and its
 * replays: any member of its organization may read it.
 */
export const GET = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params }): Promise<DeliveryDetail> => {
    if (!z.uuid().safeParse(params.id).success) throw ApiRouteError.notFound(NOT_FOUND);
    const db = getDb();
    const event = await getWebhookEvent(db, params.id);
    const organization = await requireOrganizationAccess(user, event?.organizationId ?? null, {
      notFoundMessage: NOT_FOUND,
    });
    return deliveryDetail(event!, organization, await listWebhookEventReplays(db, event!.id));
  },
);
