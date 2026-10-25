import type { NextRequest } from "next/server";
import { discordCallback } from "@/lib/chat/discord-install";
import { liveRoute } from "@/lib/live/request";

/** Discord's OAuth redirect: stores the server the bot was added to as a chat connection. */
async function get(request: NextRequest) {
  return discordCallback(request);
}

export const GET = liveRoute(get);
