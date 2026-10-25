import "server-only";
import {
  getChatConnection,
  getMembership,
  getOrganization,
  isChatLinkStateUsed,
  linkChatIdentityWithState,
  type ChatPlatform,
  type Database,
} from "@omniralph/db";
import { readLinkState, type ChatLinkState } from "./link";

/**
 * What `/chat/link` shows a signed-in user for a link's state: why it can't
 * be used, or the confirmation (`ready`).
 */
export type ChatLinkCheck =
  | { status: "expired" | "invalid" | "used" | "not_connected" }
  | { status: "not_member"; organizationName: string }
  | {
      status: "ready";
      state: ChatLinkState;
      organizationName: string;
      /** The Slack workspace or Discord server name. */
      connectionName: string;
    };

/**
 * Checks a link for `userId`: the state is ours and current, its workspace or
 * server is still connected to its organization, the user is a member of
 * that organization, and the link wasn't used yet.
 */
export async function checkChatLink(
  db: Database,
  userId: string,
  rawState: string | null | undefined,
  env?: NodeJS.ProcessEnv,
  now?: Date,
): Promise<ChatLinkCheck> {
  const read = await readLinkState(rawState, env, now);
  if (!read.ok) return { status: read.reason };
  const { state } = read;
  if (await isChatLinkStateUsed(db, state.id)) return { status: "used" };
  const organization = await getOrganization(db, state.organizationId);
  if (!organization) return { status: "not_connected" };
  if (!(await getMembership(db, organization.id, userId))) {
    return { status: "not_member", organizationName: organization.name };
  }
  const connection = await getChatConnection(db, organization.id, state.connectionId);
  if (connection?.platform !== state.platform) return { status: "not_connected" };
  return {
    status: "ready",
    state,
    organizationName: organization.name,
    connectionName: connection.name,
  };
}

export type LinkChatAccountResult =
  | { ok: true; platform: ChatPlatform; displayName: string; organizationName: string }
  | { ok: false; check: Exclude<ChatLinkCheck, { status: "ready" }> };

/**
 * Links the link's chat user to `userId` (a manual link, replacing any link
 * to another user and withdrawing an opt-out of automatic linking). The
 * link's state is used up in the same transaction, so a replay fails.
 */
export async function linkChatAccount(
  db: Database,
  userId: string,
  rawState: string | null | undefined,
  env?: NodeJS.ProcessEnv,
  now?: Date,
): Promise<LinkChatAccountResult> {
  const check = await checkChatLink(db, userId, rawState, env, now);
  if (check.status !== "ready") return { ok: false, check };
  const { state } = check;
  const linked = await linkChatIdentityWithState(
    db,
    {
      organizationId: state.organizationId,
      platform: state.platform,
      externalUserId: state.externalUserId,
      userId,
      source: "manual",
      displayName: state.displayName,
    },
    { id: state.id, expiresAt: state.expiresAt },
    now,
  );
  // Used by a concurrent request since the check.
  if (!linked) return { ok: false, check: { status: "used" } };
  return {
    ok: true,
    platform: state.platform,
    displayName: state.displayName,
    organizationName: check.organizationName,
  };
}

/** The message for a link that can't be used. */
export function chatLinkProblem(check: Exclude<ChatLinkCheck, { status: "ready" }>): string {
  switch (check.status) {
    case "expired":
      return "This link has expired. Mention Om again to get a new one.";
    case "invalid":
      return "This link isn't valid. Mention Om again to get a new one.";
    case "used":
      return "This link was used already. Each link works once: mention Om again to get a new one.";
    case "not_connected":
      return "The workspace or server this link came from is no longer connected to Omniralph.";
    case "not_member":
      return `You aren't a member of ${check.organizationName}, so you can't link a chat account to it. Ask one of its admins to invite you, or sign in with the account you use there.`;
  }
}
