import type { NextRequest } from "next/server";
import { slackCallback } from "@/lib/chat/slack-install";
import { liveRoute } from "@/lib/live/request";

/** Slack's OAuth redirect: stores the workspace's bot token as a chat connection. */
async function get(request: NextRequest) {
  return slackCallback(request);
}

export const GET = liveRoute(get);
