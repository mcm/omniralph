/**
 * The webhook delivery log on the wire: the list's query and cursor, and its rows.
 */
import type { WebhookEventCursor, WebhookEventDetail, WebhookEventSummary } from "@omniralph/db";
import { z } from "zod";
import {
  DELIVERY_LIST_DEFAULT_LIMIT,
  DELIVERY_LIST_MAX_LIMIT,
  DELIVERY_OUTCOMES,
  type DeliveryDetail,
  type DeliveryRow,
} from "@/lib/api/deliveries";
import type { ScopedOrganization } from "@/lib/api/scope";

/** `{receivedAt, id}` of the last row, as an opaque base64url string. */
export function encodeDeliveryCursor(cursor: WebhookEventCursor): string {
  return Buffer.from(JSON.stringify([cursor.receivedAt, cursor.id])).toString("base64url");
}

const cursorShape = z.tuple([z.iso.datetime(), z.uuid()]);

/** The cursor `encodeDeliveryCursor` wrote, or null when `value` isn't one. */
export function decodeDeliveryCursor(value: string): WebhookEventCursor | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? { receivedAt: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

const limitError = { error: "The limit must be a number from 1 to 100." };

/** The list's query: `outcome` repeats, every value must be known. */
export const deliveryListQuerySchema = z.object({
  outcome: z.array(z.enum(DELIVERY_OUTCOMES, { error: "Unknown outcome." })).default([]),
  cursor: z
    .string()
    .transform((value, ctx) => {
      const cursor = decodeDeliveryCursor(value);
      if (!cursor) ctx.addIssue({ code: "custom", message: "The cursor is invalid." });
      return cursor ?? z.NEVER;
    })
    .optional(),
  limit: z.coerce
    .number(limitError)
    .int(limitError)
    .min(1, limitError)
    .max(DELIVERY_LIST_MAX_LIMIT, limitError)
    .default(DELIVERY_LIST_DEFAULT_LIMIT),
});

/** The search params as `deliveryListQuerySchema` reads them (`outcome` as a list). */
export function deliveryListSearch(params: URLSearchParams): Record<string, unknown> {
  return { ...Object.fromEntries(params), outcome: params.getAll("outcome") };
}

/** A delivery's row on the wire. */
export function deliveryRow(
  event: WebhookEventSummary,
  organization: ScopedOrganization,
): DeliveryRow {
  return {
    id: event.id,
    provider: event.provider,
    connection: event.scmConnectionId
      ? { kind: "scm", id: event.scmConnectionId }
      : { kind: "linear", id: event.integrationId! },
    organization: { id: organization.id, name: organization.name, role: organization.role },
    repository: event.repository,
    deliveryId: event.deliveryId,
    event: event.event,
    outcome: event.outcome,
    reasonCode: event.reasonCode,
    reason: event.reason,
    run: event.run,
    replayOfId: event.replayOfId,
    payloadTruncated: event.payloadTruncated,
    receivedAt: event.receivedAt,
  };
}

/** A delivery's detail on the wire, with its replays. */
export function deliveryDetail(
  event: WebhookEventDetail,
  organization: ScopedOrganization,
  replays: readonly WebhookEventSummary[],
): DeliveryDetail {
  return {
    ...deliveryRow(event, organization),
    replays: replays.map((replay) => deliveryRow(replay, organization)),
    payload: event.payload,
    replayedBy: event.replayedBy && {
      id: event.replayedBy.id,
      name: event.replayedBy.name ?? "Someone",
    },
  };
}
