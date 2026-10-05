import { pruneWebhookDeliveries } from "@omniralph/db";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";

/**
 * How long `webhook_deliveries` rows are kept. GitHub and GitLab only resend
 * an event for a short while (automatic retries, manual redelivery of recent
 * deliveries), so a week comfortably covers every redelivery.
 */
const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;

/** Vercel Cron (`vercel.json`): deletes webhook deliveries older than the retention. */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const before = new Date(Date.now() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const pruned = await pruneWebhookDeliveries(getDb(), before);
  return Response.json({ pruned });
}
