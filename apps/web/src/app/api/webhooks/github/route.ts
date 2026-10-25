import { after } from "next/server";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { handleWebhook } from "@/lib/webhooks/ingest";
import { liveDeferred, liveRoute } from "@/lib/live/request";

/**
 * GitHub webhook: verifies the delivery and enqueues a review when a PR/MR trigger
 * fires, or runs a `@bot` command from a comment (after responding).
 */
async function post(req: Request): Promise<Response> {
  return handleWebhook("github", req, {
    db: getDb(),
    dispatcher: getDispatcher(),
    defer: (task) => after(liveDeferred(task)),
  });
}

export const POST = liveRoute(post);
