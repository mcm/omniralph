import { after } from "next/server";
import { getDb } from "@/lib/db";
import { handleLinearEvent } from "@/lib/linear/events";
import { handleLinearWebhook } from "@/lib/linear/ingest";

/**
 * Linear webhook (agent session events and issue changes): verifies the
 * delivery and hands the event to the ralph orchestrator after responding.
 */
export async function POST(req: Request): Promise<Response> {
  return handleLinearWebhook(req, {
    db: getDb(),
    secret: process.env.LINEAR_WEBHOOK_SECRET,
    handle: handleLinearEvent,
    defer: (task) => after(task),
  });
}
