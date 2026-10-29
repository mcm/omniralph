import { fieldErrors } from "@omniralph/shared";
import { getWebhookEventSourceOrganizationId, listWebhookEvents } from "@omniralph/db";
import { z } from "zod";
import { DELIVERY_CONNECTION_KINDS, type DeliveryList } from "@/lib/api/deliveries";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import {
  deliveryListQuerySchema,
  deliveryListSearch,
  deliveryRow,
  encodeDeliveryCursor,
} from "@/lib/deliveries/list";

type Params = { kind: string; id: string };

const NOT_FOUND = "That connection doesn't exist.";

/**
 * A page of the webhook deliveries a connection received (`scm`: a GitHub or GitLab
 * connection, `linear`: a Linear integration), newest first, optionally only some
 * outcomes (`outcome` repeats) and only those not replayed (`unreplayed=true`). Any member of the connection's organization may read it.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params, request }): Promise<DeliveryList> => {
    const kind = z.enum(DELIVERY_CONNECTION_KINDS).safeParse(params.kind);
    if (!kind.success || !z.uuid().safeParse(params.id).success) {
      throw ApiRouteError.notFound(NOT_FOUND);
    }
    const parsed = deliveryListQuerySchema.safeParse(
      deliveryListSearch(new URL(request.url).searchParams),
    );
    if (!parsed.success) {
      const errors = fieldErrors(parsed.error);
      throw new ApiRouteError(
        400,
        Object.values(errors)[0] ?? "The request is invalid.",
        "invalid_request",
        errors,
      );
    }
    const db = getDb();
    const source =
      kind.data === "scm" ? { scmConnectionId: params.id } : { integrationId: params.id };
    const organization = await requireOrganizationAccess(
      user,
      await getWebhookEventSourceOrganizationId(db, source),
      { notFoundMessage: NOT_FOUND },
    );
    const page = await listWebhookEvents(db, {
      source,
      outcomes: parsed.data.outcome,
      unreplayed: parsed.data.unreplayed,
      cursor: parsed.data.cursor,
      limit: parsed.data.limit,
    });
    return {
      deliveries: page.events.map((event) => deliveryRow(event, organization)),
      nextCursor: page.next && encodeDeliveryCursor(page.next),
    };
  },
);
