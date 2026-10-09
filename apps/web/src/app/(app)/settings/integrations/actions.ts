"use server";

import { deleteChatConnection, deleteIntegration, listChatConnections } from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { revokeSlackToken, type SlackCredentials } from "@/lib/chat/slack-oauth";
import { getDb } from "@/lib/db";
import { revokeToken, type LinearCredentials } from "@/lib/linear/oauth";

/**
 * Disconnects the active organization's Linear workspace: forgets its tokens and revokes them at
 * Linear (best effort). Linear webhooks are ignored from then on.
 */
export async function disconnectLinear(): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const removed = await deleteIntegration<LinearCredentials>(
      getDb(),
      admin.organization.id,
      "linear",
    );
    if (!removed) return { ok: false, error: "No Linear workspace is connected." };
    revalidatePath("/settings/integrations");
    try {
      await revokeToken(removed.credentials.accessToken);
    } catch (error) {
      console.error("Revoking the Linear token failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: true,
        warning: `Disconnected ${removed.name}, but Linear didn't confirm revoking the token. Remove the app in Linear's settings if it's still listed.`,
      };
    }
  });
}

/**
 * Disconnects one of the active organization's Slack workspaces: forgets its bot token (and its
 * threads) and revokes the token at Slack (best effort). Its events are ignored from then on.
 */
export async function disconnectSlack(connectionId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    const organizationId = admin.organization.id;
    const connections = await listChatConnections(db, organizationId);
    const connection = connections.find((c) => c.id === connectionId && c.platform === "slack");
    if (!connection) return { ok: false, error: "That Slack workspace isn't connected." };
    const removed = await deleteChatConnection<SlackCredentials>(db, organizationId, connection.id);
    if (!removed) return { ok: false, error: "That Slack workspace isn't connected." };
    revalidatePath("/settings/integrations");
    if (!removed.credentials) return;
    try {
      await revokeSlackToken(removed.credentials.botToken);
    } catch (error) {
      console.error("Revoking the Slack token failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: true,
        warning: `Disconnected ${removed.name}, but Slack didn't confirm revoking the token. Remove the app in Slack's settings if it's still installed.`,
      };
    }
  });
}
