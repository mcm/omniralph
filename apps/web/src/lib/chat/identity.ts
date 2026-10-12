import "server-only";
import {
  emailDomain,
  getChatConnectionWithCredentials,
  getChatIdentity,
  getChatUserProfile,
  getMemberByEmail,
  getMembership,
  getUserById,
  hasChatIdentityOptOut,
  linkChatIdentity,
  listOrganizationDomains,
  saveChatUserProfile,
  type ChatConnection,
  type ChatPlatform,
  type Database,
  type OrganizationRole,
} from "@omniralph/db";
import type { SlackCredentials } from "./slack-oauth";

/**
 * Who wrote a chat message, as far as the organization of the connection that
 * received it is concerned:
 * - `member`: linked to a current member (may use `read` and `action` tools);
 * - `domain`: an unlinked Slack user whose email domain is one of the
 *   organization's email domains (`read` tools only);
 * - `unlinked`: anyone else (gets a link prompt).
 */
export type ChatActor = ChatMemberActor | { kind: "domain"; email: string } | { kind: "unlinked" };

export interface ChatMemberActor {
  kind: "member";
  userId: string;
  role: OrganizationRole;
  name: string | null;
  /** Set when this resolution linked the chat user by email (tell them once). */
  autoLinked?: { email: string };
}

/** Slack profiles (emails) are fetched again after an hour. */
export const CHAT_PROFILE_TTL_MS = 60 * 60 * 1000;
export const SLACK_USERS_INFO_URL = "https://slack.com/api/users.info";

export interface ChatIdentityDeps {
  db: Database;
  /** Slack `users.info` goes through it (tests fake it). */
  fetch?: typeof fetch;
  /** `ENCRYPTION_KEY` override for Slack credentials (tests). */
  encryptionKey?: string | Buffer;
  now?: () => Date;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

export interface ResolveChatActorInput {
  organizationId: string;
  /** The connection that received the message. */
  connection: ChatConnection;
  platform: ChatPlatform;
  externalUserId: string;
}

/**
 * Resolves a chat user to a {@link ChatActor} in the organization. A linked
 * user who is no longer a member counts as unlinked. An unlinked Slack user
 * whose profile email (cached for an hour) is the sign-in email of a member is
 * linked to that member automatically, unless they unlinked before. Discord
 * never exposes emails, so Discord users need an explicit link.
 */
export async function resolveChatActor(
  deps: ChatIdentityDeps,
  input: ResolveChatActorInput,
): Promise<ChatActor> {
  const { db } = deps;
  const { organizationId, connection, platform, externalUserId } = input;
  // The connection decides the organization; a mismatch is a caller bug, not access.
  if (connection.organizationId !== organizationId || connection.platform !== platform) {
    return { kind: "unlinked" };
  }

  const identity = await getChatIdentity(db, organizationId, platform, externalUserId);
  if (identity) {
    const member = await memberActor(db, organizationId, identity.userId);
    if (member) return member;
  }
  if (platform !== "slack") return { kind: "unlinked" };

  const profile = await slackProfile(deps, connection, externalUserId);
  if (!profile?.email) return { kind: "unlinked" };
  const email = profile.email;

  if (!(await hasChatIdentityOptOut(db, organizationId, platform, externalUserId))) {
    const member = await getMemberByEmail(db, organizationId, email);
    if (member) {
      await linkChatIdentity(db, {
        organizationId,
        platform,
        externalUserId,
        userId: member.userId,
        source: "email",
        displayName: profile.displayName,
      });
      return {
        kind: "member",
        userId: member.userId,
        role: member.role,
        name: member.name,
        autoLinked: { email },
      };
    }
  }

  const domains = await listOrganizationDomains(db, organizationId);
  if (domains.length > 0 && domains.includes(emailDomain(email))) return { kind: "domain", email };
  return { kind: "unlinked" };
}

/**
 * The organization member a chat user is linked to, or null (no identity
 * lookup on the platform, no auto-linking): who a wake-up acts for.
 */
export async function linkedMemberActor(
  db: Database,
  organizationId: string,
  platform: ChatPlatform,
  externalUserId: string,
): Promise<ChatMemberActor | null> {
  const identity = await getChatIdentity(db, organizationId, platform, externalUserId);
  return identity ? memberActor(db, organizationId, identity.userId) : null;
}

async function memberActor(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<ChatMemberActor | null> {
  const membership = await getMembership(db, organizationId, userId);
  if (!membership) return null;
  const user = await getUserById(db, userId);
  return { kind: "member", userId, role: membership.role, name: user?.name ?? null };
}

/**
 * The Slack user's cached profile, fetched from `users.info` (and cached)
 * when missing or older than an hour; null when Slack can't be asked.
 */
async function slackProfile(
  deps: ChatIdentityDeps,
  connection: ChatConnection,
  externalUserId: string,
): Promise<{ email: string | null; displayName: string } | null> {
  const now = deps.now?.() ?? new Date();
  const cached = await getChatUserProfile(deps.db, connection.id, externalUserId);
  if (cached && now.getTime() - cached.fetchedAt.getTime() < CHAT_PROFILE_TTL_MS) return cached;

  const withCredentials = await getChatConnectionWithCredentials<SlackCredentials>(
    deps.db,
    "slack",
    connection.externalId,
    deps.encryptionKey,
  );
  if (withCredentials?.id !== connection.id || !withCredentials.credentials) return null;
  try {
    const fetched = await fetchSlackUser(
      withCredentials.credentials.botToken,
      externalUserId,
      deps.fetch,
    );
    return await saveChatUserProfile(
      deps.db,
      { connectionId: connection.id, externalUserId, ...fetched },
      now,
    );
  } catch (error) {
    deps.logger?.warn("Fetching the Slack user failed", {
      userId: externalUserId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

interface SlackUsersInfo {
  ok: boolean;
  error?: string;
  user?: {
    name?: string;
    real_name?: string;
    is_bot?: boolean;
    deleted?: boolean;
    profile?: { email?: string; display_name?: string; real_name?: string };
  };
}

/**
 * A Slack user's email and display name from `users.info` (scopes
 * `users:read`, `users:read.email`). Bots, deleted users and restricted
 * profiles have no email.
 */
export async function fetchSlackUser(
  botToken: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ email: string | null; displayName: string }> {
  const res = await fetchImpl(SLACK_USERS_INFO_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ user: userId }),
  });
  if (!res.ok) throw new Error(`Slack users.info failed with HTTP ${res.status}`);
  const body = (await res.json()) as SlackUsersInfo;
  if (!body.ok || !body.user)
    throw new Error(`Slack users.info failed: ${body.error ?? "no user"}`);
  const { user } = body;
  const email = !user.is_bot && !user.deleted ? user.profile?.email?.trim() || null : null;
  const displayName =
    user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || userId;
  return { email, displayName };
}
