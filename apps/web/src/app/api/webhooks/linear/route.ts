import { after } from "next/server";
import { getDb } from "@/lib/db";
import { acknowledgeLinearEvent, handleLinearEvent } from "@/lib/linear/events";
import { handleLinearWebhook } from "@/lib/linear/ingest";
import { liveDeferred, liveRoute } from "@/lib/live/request";

/**
 * Linear webhook (agent session events and issue changes): verifies the
 * delivery, acknowledges a new agent session synchronously and hands the
 * event to the ralph orchestrator after responding.
 */
async function post(req: Request): Promise<Response> {
  return handleLinearWebhook(req, {
    db: getDb(),
    secret: process.env.LINEAR_WEBHOOK_SECRET,
    acknowledge: acknowledgeLinearEvent,
    handle: handleLinearEvent,
    defer: (task) => after(liveDeferred(task)),
  });
}

export const POST = liveRoute(post);
