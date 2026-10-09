import type { DiscordAdapter } from "@chat-adapter/discord";
import { after } from "next/server";
import { getAppUrl } from "@/lib/app-url";
import { getChatBot } from "@/lib/chat/bot";
import { DISCORD_GATEWAY_LISTEN_SECONDS } from "@/lib/chat/discord-gateway";
import { discordOAuthConfig } from "@/lib/chat/discord-oauth";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";

// Must be a literal for Next.js; equals `DISCORD_GATEWAY_MAX_DURATION_SECONDS`
// (checked by the test), which exceeds the listening time (see there).
export const maxDuration = 800;

/**
 * Vercel Cron (`vercel.json`, every 9 minutes): holds the Discord Gateway
 * WebSocket open for `DISCORD_GATEWAY_LISTEN_SECONDS` and forwards every
 * Gateway event to `POST /api/webhooks/discord`, authenticated with the bot
 * token in `x-discord-gateway-token` (checked there and by the adapter).
 * Without this, ordinary thread replies never reach the bot.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  if (!discordOAuthConfig()) return Response.json({ skipped: "not_configured" });
  const bot = getChatBot();
  // Initializing binds the adapter to the bot, which the listener needs.
  await bot.chat.initialize();
  const discord = bot.adapters.discord as DiscordAdapter;
  return discord.startGatewayListener(
    { waitUntil: (task) => after(task) },
    DISCORD_GATEWAY_LISTEN_SECONDS * 1000,
    undefined,
    `${getAppUrl()}/api/webhooks/discord`,
  );
}
