import type { WebhookEventOutcome } from "@omniralph/db";
import { z } from "zod";
import { RUN_KINDS, organizationRefSchema, repositoryRefSchema } from "./runs";
import { isoDate } from "./schemas";

/**
 * Wire formats of the webhook delivery log: `GET /api/ui/connections/{scm|linear}/{id}/deliveries`,
 * `GET /api/ui/deliveries/{id}` and `POST /api/ui/deliveries/{id}/replay` (the replay's detail).
 */

/** Client-safe copy of `webhook_event_outcome`. */
export const DELIVERY_OUTCOMES = [
  "started_run",
  "updated_run",
  "ignored",
  "failed",
  "duplicate",
] as const satisfies readonly WebhookEventOutcome[];

/** The connection kinds a delivery log belongs to: a code-host connection or a Linear integration. */
export const DELIVERY_CONNECTION_KINDS = ["scm", "linear"] as const;

/** Default and largest page of a connection's deliveries. */
export const DELIVERY_LIST_DEFAULT_LIMIT = 50;
export const DELIVERY_LIST_MAX_LIMIT = 100;

/** A delivery in the log: what came in and what it did. */
export const deliveryRowSchema = z.object({
  id: z.string(),
  provider: z.enum(["github", "gitlab", "linear"]),
  connection: z.object({ kind: z.enum(DELIVERY_CONNECTION_KINDS), id: z.string() }),
  organization: organizationRefSchema,
  repository: repositoryRefSchema.nullable(),
  /** The provider's delivery ID, when it sent one. */
  deliveryId: z.string().nullable(),
  /** The event and its action, e.g. `pull_request.synchronize` (the provider's own names). */
  event: z.string(),
  outcome: z.enum(DELIVERY_OUTCOMES),
  /** Why it was ignored or failed: a code for filtering and a sentence to show. */
  reasonCode: z.string().nullable(),
  reason: z.string().nullable(),
  /** The run it started or updated. */
  run: z.object({ id: z.string(), kind: z.enum(RUN_KINDS) }).nullable(),
  /** The delivery this one replayed. */
  replayOfId: z.string().nullable(),
  /** The body was too large to keep, so the detail has no payload (and it can't be replayed). */
  payloadTruncated: z.boolean(),
  receivedAt: isoDate,
});
export type DeliveryRow = z.infer<typeof deliveryRowSchema>;

export const deliveryListSchema = z.object({
  deliveries: z.array(deliveryRowSchema),
  nextCursor: z.string().nullable(),
});
export type DeliveryList = z.infer<typeof deliveryListSchema>;

/** A delivery with its stored payload, who replayed it, and its own replays (newest first). */
export const deliveryDetailSchema = deliveryRowSchema.extend({
  payload: z.unknown(),
  replayedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  replays: z.array(deliveryRowSchema),
});
export type DeliveryDetail = z.infer<typeof deliveryDetailSchema>;
