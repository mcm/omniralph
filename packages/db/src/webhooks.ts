/**
 * Webhook delivery bookkeeping: a delivery that enqueues work is claimed by
 * its provider delivery ID first, so a redelivery of the same event is a no-op.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import type { ScmProvider } from "./repositories.js";
import { webhookDeliveries } from "./schema.js";

export interface WebhookDeliveryRef {
  provider: ScmProvider;
  deliveryId: string;
}

const deliveryWhere = (ref: WebhookDeliveryRef) =>
  and(eq(webhookDeliveries.provider, ref.provider), eq(webhookDeliveries.deliveryId, ref.deliveryId));

/** Records the delivery; false when it was already recorded (a redelivery). */
export async function claimWebhookDelivery(
  db: Database,
  ref: WebhookDeliveryRef & { repositoryId: string },
): Promise<boolean> {
  const rows = await db
    .insert(webhookDeliveries)
    .values({ provider: ref.provider, deliveryId: ref.deliveryId, repositoryId: ref.repositoryId })
    .onConflictDoNothing()
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return rows.length > 0;
}

/** Links a claimed delivery to the job it enqueued. */
export async function setWebhookDeliveryJob(
  db: Database,
  ref: WebhookDeliveryRef,
  jobId: string,
): Promise<void> {
  await db.update(webhookDeliveries).set({ jobId }).where(deliveryWhere(ref));
}

/** Forgets a claimed delivery whose handling failed, so the code host's redelivery is processed. */
export async function releaseWebhookDelivery(db: Database, ref: WebhookDeliveryRef): Promise<void> {
  await db.delete(webhookDeliveries).where(deliveryWhere(ref));
}
