import "server-only";
import {
  listChatIdentities,
  unlinkChatIdentity,
  type ChatPlatform,
  type Database,
} from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import type { ChatAccount, UnlinkChatAccountInput } from "@/lib/api/organization";

const PLATFORMS: readonly string[] = ["slack", "discord"] satisfies ChatPlatform[];

/** Settings › Chat accounts: the user's linked Slack and Discord accounts, in every organization. */
export async function loadChatAccounts(db: Database, userId: string): Promise<ChatAccount[]> {
  const identities = await listChatIdentities(db, userId);
  return identities.map((i) => ({
    organizationId: i.organizationId,
    organizationName: i.organizationName,
    platform: i.platform,
    externalUserId: i.externalUserId,
    displayName: i.displayName,
    source: i.source,
    linkedAt: i.linkedAt.toISOString(),
  }));
}

/**
 * Unlinks one of the user's chat identities. The chat user is not linked automatically by
 * email again; linking it through the bot's link does.
 */
export async function unlinkChatAccount(
  db: Database,
  userId: string,
  input: UnlinkChatAccountInput,
): Promise<ActionResult> {
  if (!PLATFORMS.includes(input.platform)) return { ok: false, error: "Unknown chat platform." };
  const removed = await unlinkChatIdentity(
    db,
    userId,
    input.organizationId,
    input.platform as ChatPlatform,
    input.externalUserId,
  );
  if (!removed) return { ok: false, error: "That chat account isn't linked to you." };
  return { ok: true };
}
