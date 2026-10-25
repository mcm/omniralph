import { after } from "next/server";
import { getChatBot } from "@/lib/chat/bot";
import { handleSlackWebhook } from "@/lib/chat/webhooks";
import { getDb } from "@/lib/db";
import { liveRoute, liveWaitUntil } from "@/lib/live/request";

/**
 * Slack Events API: the Chat SDK Slack adapter verifies the signature and
 * hands mentions and thread replies to the bot after responding.
 */
async function post(req: Request): Promise<Response> {
  return handleSlackWebhook(req, {
    db: getDb(),
    bot: getChatBot(),
    waitUntil: (task) => after(liveWaitUntil(task)),
  });
}

export const POST = liveRoute(post);
