import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { handleWebhook } from "@/lib/webhooks/ingest";

/** GitLab webhook: verifies the delivery and enqueues a review when a PR/MR trigger fires. */
export async function POST(req: Request): Promise<Response> {
  return handleWebhook("gitlab", req, { db: getDb(), dispatcher: getDispatcher() });
}
