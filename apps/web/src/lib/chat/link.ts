import "server-only";
import type { ChatPlatform } from "@omniralph/db";
import { errors, jwtVerify, SignJWT } from "jose";
import { getAppUrl } from "@/lib/app-url";
import { stateKey } from "@/lib/auth/signed-state";
import { CHAT_LINK_PATH } from "./link-paths";

/**
 * Links that let a chat user link their identity to their Omniralph
 * membership: the bot posts `/chat/link?state=…` to the chat user, who opens
 * it signed in. The state is signed (so the chat user and organization come
 * from the bot, never from the browser) and expires after
 * {@link CHAT_LINK_TTL_SECONDS}. Whoever opens it links the chat user to
 * their own account, after a confirmation naming the chat user.
 */
export const CHAT_LINK_TTL_SECONDS = 15 * 60;

const PURPOSE = "chat-link";
const AUDIENCE = `omniralph:${PURPOSE}`;
const PLATFORMS: readonly ChatPlatform[] = ["slack", "discord"];

export interface ChatLinkState {
  organizationId: string;
  /** The connection the chat user wrote through. */
  connectionId: string;
  platform: ChatPlatform;
  externalUserId: string;
  displayName: string;
}

/** `${APP_URL}/chat/link?state=…` for the chat user, valid for 15 minutes. */
export async function createLinkUrl(
  input: ChatLinkState,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const state = await new SignJWT({
    org: input.organizationId,
    conn: input.connectionId,
    platform: input.platform,
    name: input.displayName,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.externalUserId)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + CHAT_LINK_TTL_SECONDS)
    .sign(stateKey(PURPOSE, env));
  const url = new URL(`${getAppUrl(env)}${CHAT_LINK_PATH}`);
  url.searchParams.set("state", state);
  return url.toString();
}

export type ReadLinkStateResult =
  { ok: true; state: ChatLinkState } | { ok: false; reason: "expired" | "invalid" };

/** The chat user and organization of a link's `state`, or why it can't be used. */
export async function readLinkState(
  state: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<ReadLinkStateResult> {
  if (!state) return { ok: false, reason: "invalid" };
  try {
    const { payload } = await jwtVerify(state, stateKey(PURPOSE, env), {
      algorithms: ["HS256"],
      audience: AUDIENCE,
      currentDate: now,
      requiredClaims: ["exp", "sub"],
    });
    const { org, conn, platform, name, sub } = payload;
    if (
      typeof org !== "string" ||
      typeof conn !== "string" ||
      typeof name !== "string" ||
      typeof sub !== "string" ||
      !PLATFORMS.includes(platform as ChatPlatform)
    ) {
      return { ok: false, reason: "invalid" };
    }
    return {
      ok: true,
      state: {
        organizationId: org,
        connectionId: conn,
        platform: platform as ChatPlatform,
        externalUserId: sub,
        displayName: name,
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof errors.JWTExpired ? "expired" : "invalid" };
  }
}
