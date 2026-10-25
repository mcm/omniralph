import { apiHandler } from "@/lib/api/handler";
import type { LiveToken } from "@/lib/api/live";
import { getAblyConfig } from "@/lib/ably/token";
import { getDb } from "@/lib/db";
import { signLiveToken } from "@/lib/live/token";

/**
 * The browser's subscribe-only Ably token for live change events (any signed-in user):
 * its organizations' change channels and its own user channel, valid an hour.
 * `{ token: null }` when Ably is off (the client then polls).
 */
export const GET = apiHandler({ access: "signed-in" }, async ({ user }) => {
  const token = await signLiveToken(getDb(), getAblyConfig(), { userId: user.id });
  return (token ?? { token: null }) satisfies LiveToken;
});
