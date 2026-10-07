import { Gitlab } from "@gitbeaker/rest";
import { isAccessTokenBotUsername, normalizeGitLabUrl, statusOf } from "./setup.js";

/** Bot tokens are rotated to expire this many days after the rotation (UTC). */
export const BOT_TOKEN_LIFETIME_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type GitLabRotation =
  /** The old token is revoked; `token` replaces it. */
  | { status: "rotated"; token: string; expiresAt: string | null }
  /** Not rotated: GitLab rejects the token, or it's a group or project access token. */
  | { status: "skipped"; reason: "token_invalid" | "access_token_bot" }
  /** The instance has no `POST /personal_access_tokens/self/rotate` (404). */
  | { status: "unsupported" };

/** `expires_at` for a rotation at `now`: today (UTC) + {@link BOT_TOKEN_LIFETIME_DAYS}. */
export function rotatedTokenExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + BOT_TOKEN_LIFETIME_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Rotates a GitLab connection's bot token with
 * `POST /personal_access_tokens/self/rotate`. GitLab revokes the old token
 * immediately, so the caller must store the returned token (and serialize
 * rotations of the same connection). Tokens GitLab rejects and group or
 * project access tokens are skipped. Other GitLab errors are thrown.
 */
export async function rotateGitLabToken(options: {
  baseUrl?: string;
  token: string;
  now?: Date;
}): Promise<GitLabRotation> {
  const api = new Gitlab<false>({
    host: normalizeGitLabUrl(options.baseUrl),
    token: options.token,
  });
  let username: string;
  try {
    username = (await api.Users.showCurrentUser()).username;
  } catch (error) {
    if (statusOf(error) === 401) return { status: "skipped", reason: "token_invalid" };
    throw error;
  }
  if (isAccessTokenBotUsername(username)) return { status: "skipped", reason: "access_token_bot" };
  try {
    const rotated = await api.PersonalAccessTokens.rotate("self", {
      expiresAt: rotatedTokenExpiry(options.now),
    });
    return { status: "rotated", token: rotated.token, expiresAt: rotated.expires_at ?? null };
  } catch (error) {
    if (statusOf(error) === 404) return { status: "unsupported" };
    throw error;
  }
}
