import "server-only";
import {
  getChatConnection,
  getMembership,
  getOrganization,
  linkChatIdentity,
  type ChatPlatform,
  type Database,
} from "@omniralph/db";
import { readLinkState, type ChatLinkState } from "./link";

/**
 * What `/chat/link` shows a signed-in user for a link's state: why it can't
 * be used, or the confirmation (`ready`).
 */
export type ChatLinkCheck =
  | { status: "expired" | "invalid" | "not_connected" }
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
 * server is still connected to its organization, and the user is a member of
 * that organization.
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
 * to another user and withdrawing an opt-out of automatic linking).
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
  await linkChatIdentity(db, {
    organizationId: state.organizationId,
    platform: state.platform,
    externalUserId: state.externalUserId,
    userId,
    source: "manual",
    displayName: state.displayName,
  });
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
      return "This link has expired. Mention the bot again to get a new one.";
    case "invalid":
      return "This link isn't valid. Mention the bot again to get a new one.";
    case "not_connected":
      return "The workspace or server this link came from is no longer connected to Omniralph.";
    case "not_member":
      return `You aren't a member of ${check.organizationName}, so you can't link a chat account to it. Ask one of its admins to invite you, or sign in with the account you use there.`;
  }
}
