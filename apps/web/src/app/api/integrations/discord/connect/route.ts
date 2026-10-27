import type { NextRequest } from "next/server";
import { discordConnect } from "@/lib/chat/discord-install";

/** Settings › Connections › Add connection › Discord › Connect: redirects an admin to Discord's add-bot screen. */
export async function GET(request: NextRequest) {
  return discordConnect(request);
}
