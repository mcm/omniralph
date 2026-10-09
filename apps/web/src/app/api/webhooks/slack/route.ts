import { after } from "next/server";
import { getChatBot } from "@/lib/chat/bot";
import { handleSlackWebhook } from "@/lib/chat/webhooks";
import { getDb } from "@/lib/db";

/**
 * Slack Events API: the Chat SDK Slack adapter verifies the signature and
 * hands mentions and thread replies to the bot after responding.
 */
export async function POST(req: Request): Promise<Response> {
  return handleSlackWebhook(req, {
    db: getDb(),
    bot: getChatBot(),
    waitUntil: (task) => after(task),
  });
}
