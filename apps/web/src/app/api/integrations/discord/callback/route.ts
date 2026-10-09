import type { NextRequest } from "next/server";
import { discordCallback } from "@/lib/chat/discord-install";

/** Discord's OAuth redirect: stores the server the bot was added to as a chat connection. */
export async function GET(request: NextRequest) {
  return discordCallback(request);
}
