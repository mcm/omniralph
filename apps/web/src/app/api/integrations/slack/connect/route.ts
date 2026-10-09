import type { NextRequest } from "next/server";
import { slackConnect } from "@/lib/chat/slack-install";

/** Settings › Integrations › Connect Slack: redirects an admin to Slack's install screen. */
export async function GET(request: NextRequest) {
  return slackConnect(request);
}
