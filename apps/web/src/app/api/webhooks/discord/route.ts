import { after } from "next/server";
import { getChatBot } from "@/lib/chat/bot";
import { handleDiscordWebhook } from "@/lib/chat/webhooks";
import { getDb } from "@/lib/db";

/**
 * Discord interactions and Gateway events forwarded by the Gateway listener:
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
