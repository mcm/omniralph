import "server-only";
import { listOrganizationsForUser, type Database } from "@omniralph/db";
import type { AblyToken } from "@omniralph/shared";
import { signAblyJwt, type AblyConfig } from "@/lib/ably/token";
import { orgChangesChannel, userChangesChannel } from "./events";

/** Lifetime of a browser's live token, in seconds. */
export const LIVE_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * A browser's Ably token for live change events: client ID = the user, `subscribe`
 * only, on exactly the change channels of the user's organizations (read now, so a
 * removed membership is missing from the next token) and their own user channel.
 * Agents' wake channels are never granted. Null when Ably is off.
 */
export async function signLiveToken(
  db: Database,
  config: AblyConfig | null,
  input: { userId: string; now?: number },
): Promise<AblyToken | null> {
  if (!config) return null;
  const organizations = await listOrganizationsForUser(db, input.userId);
  const capability: Record<string, string[]> = {
    [userChangesChannel(input.userId)]: ["subscribe"],
  };
  for (const { id } of organizations) capability[orgChangesChannel(id)] = ["subscribe"];
  return signAblyJwt(config, {
    clientId: input.userId,
    capability,
    ttlSeconds: LIVE_TOKEN_TTL_SECONDS,
    now: input.now,
  });
}
