import {
  pruneWebhookDeliveries,
  pruneWebhookEvents,
  WEBHOOK_EVENT_RETENTION_DAYS,
} from "@omniralph/db";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { liveRoute } from "@/lib/live/request";

/**
 * How long `webhook_deliveries` rows are kept. GitHub and GitLab only resend
 * an event for a short while (automatic retries, manual redelivery of recent
 * deliveries), so a week comfortably covers every redelivery.
 */
const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Vercel Cron (`vercel.json`): deletes webhook delivery claims older than their
 * retention, and the delivery log (`webhook_events`) older than
 * `WEBHOOK_EVENT_RETENTION_DAYS`, in batches.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const now = Date.now();
  const pruned = await pruneWebhookDeliveries(
    db,
    new Date(now - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS),
  );
  const prunedEvents = await pruneWebhookEvents(
    db,
    new Date(now - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS),
  );
  return Response.json({ pruned, prunedEvents });
}

export const GET = liveRoute(get);
