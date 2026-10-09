"use server";

import { unlinkChatIdentity, type ChatPlatform } from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runSignedInAction } from "@/lib/auth/admin-action";
import { CHAT_ACCOUNTS_PATH } from "@/lib/chat/link-paths";
import { getDb } from "@/lib/db";

const PLATFORMS: readonly string[] = ["slack", "discord"] satisfies ChatPlatform[];

/**
 * Unlinks one of the signed-in user's chat identities. The chat user is not
 * linked automatically by email again; linking it through the bot's link does.
 */
export async function unlinkChatAccount(input: {
  organizationId: string;
  platform: string;
  externalUserId: string;
}): Promise<ActionResult> {
  return runSignedInAction(async (user) => {
    if (!PLATFORMS.includes(input.platform)) return { ok: false, error: "Unknown chat platform." };
    const removed = await unlinkChatIdentity(
      getDb(),
      user.id,
      input.organizationId,
      input.platform as ChatPlatform,
      input.externalUserId,
    );
    if (!removed) return { ok: false, error: "That chat account isn't linked to you." };
    revalidatePath(CHAT_ACCOUNTS_PATH);
  });
}
