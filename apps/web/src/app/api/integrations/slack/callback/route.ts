import type { NextRequest } from "next/server";
import { slackCallback } from "@/lib/chat/slack-install";

/** Slack's OAuth redirect: stores the workspace's bot token as a chat connection. */
export async function GET(request: NextRequest) {
  return slackCallback(request);
}
