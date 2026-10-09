"use server";

import type { ActionResult } from "@/lib/action-result";
import { runSignedInAction } from "@/lib/auth/admin-action";
import { chatLinkProblem, linkChatAccount } from "@/lib/chat/link-account";
import { getDb } from "@/lib/db";

/** Links the chat user of a link's `state` to the signed-in user (a member of its organization). */
export async function linkChatAccountAction(state: string): Promise<ActionResult> {
  return runSignedInAction(async (user) => {
    const result = await linkChatAccount(getDb(), user.id, state);
    if (!result.ok) return { ok: false, error: chatLinkProblem(result.check) };
  });
}
