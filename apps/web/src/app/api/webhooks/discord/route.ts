import { after } from "next/server";
import { getChatBot } from "@/lib/chat/bot";
import { handleDiscordWebhook } from "@/lib/chat/webhooks";
import { getDb } from "@/lib/db";

/**
 * Discord interactions and forwarded Gateway events (no Gateway listener runs yet):
 * the Chat SDK Discord adapter verifies them and hands mentions and thread
 * replies to the bot after responding.
 */
export async function POST(req: Request): Promise<Response> {
  return handleDiscordWebhook(req, {
    db: getDb(),
    bot: getChatBot(),
    waitUntil: (task) => after(task),
  });
}
