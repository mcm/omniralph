"use server";

import {
  deleteChatChannelTaskSetting,
  deleteChatConnection,
  deleteIntegration,
  getChatConnection,
  listChatConnections,
  setChatTaskDefaults,
  upsertChatChannelTaskSetting,
} from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { discordOAuthConfig, leaveDiscordGuild } from "@/lib/chat/discord-oauth";
import { revokeSlackToken, type SlackCredentials } from "@/lib/chat/slack-oauth";
import {
  CHAT_TASK_ROLES,
  chatChannelId,
  validateChatTaskChoice,
  type ChatTaskRole,
} from "@/lib/chat/tasks";
import { getDb } from "@/lib/db";
import { organizationDefinitions } from "@/lib/definitions";
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

/**
 * Disconnects one of the active organization's Discord servers: forgets it (and its threads) and
 * makes the bot leave it (best effort). Its messages are ignored from then on.
 */
export async function disconnectDiscord(connectionId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    const organizationId = admin.organization.id;
    const connections = await listChatConnections(db, organizationId);
    const connection = connections.find((c) => c.id === connectionId && c.platform === "discord");
    if (!connection) return { ok: false, error: "That Discord server isn't connected." };
    const removed = await deleteChatConnection(db, organizationId, connection.id);
    if (!removed) return { ok: false, error: "That Discord server isn't connected." };
    revalidatePath("/settings/integrations");
    const warning = {
      ok: true,
      warning: `Disconnected ${removed.name}, but the bot couldn't leave the server. Remove it in Discord's server settings if it's still there.`,
    } as const;
    const config = discordOAuthConfig();
    if (!config) return warning;
    try {
      await leaveDiscordGuild(config, removed.externalId);
    } catch (error) {
      console.error("Leaving the Discord server failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return warning;
    }
  });
}

/** A chat task choice per role; null (for a channel) keeps the organization's. */
type ChatTaskInput<T> = Record<ChatTaskRole, T>;

/**
 * Field errors of the chat task choices that don't pass `validateChatTaskChoice`
 * against the organization's tasks (built-in or its own).
 */
async function chatTaskErrors(
  organizationId: string,
  input: unknown,
  optional: boolean,
): Promise<Record<string, string>> {
  const definitions = organizationDefinitions(getDb(), organizationId);
  const choices = (typeof input === "object" && input !== null ? input : {}) as Partial<
    ChatTaskInput<unknown>
  >;
  const errors: Record<string, string> = {};
  for (const role of CHAT_TASK_ROLES) {
    const taskId = choices[role];
    if (taskId === null && optional) continue;
    if (typeof taskId !== "string") {
      errors[role] = "Choose a task.";
      continue;
    }
    const task = await definitions.getTask(taskId);
    const result = validateChatTaskChoice(role, taskId, () => task);
    if (!result.ok) errors[role] = result.error;
  }
  return errors;
}

function invalidChatTasks(fieldErrors: Record<string, string>): ActionResult | null {
  const first = Object.values(fieldErrors)[0];
  return first === undefined ? null : { ok: false, error: first, fieldErrors };
}

/**
 * Sets the tasks chat's "ask about code" and "start work" run for the active organization
 * (unless a channel overrides them); each must pass `validateChatTaskChoice` among its tasks.
 */
export async function saveChatTaskDefaults(input: ChatTaskInput<string>): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const invalid = invalidChatTasks(await chatTaskErrors(admin.organization.id, input, false));
    if (invalid) return invalid;
    await setChatTaskDefaults(
      getDb(),
      admin.organization.id,
      { askAboutCode: input.askAboutCode, startWork: input.startWork },
      admin.id,
    );
    revalidatePath("/settings/integrations");
  });
}

/**
 * Sets the tasks a channel of one of the active organization's chat connections runs
 * (`channel`: the ID the platform shows), overriding the organization's; null keeps its
 * choice. Each chosen task must pass `validateChatTaskChoice` among its tasks.
 */
export async function saveChatChannelTasks(
  connectionId: string,
  channel: string,
  input: ChatTaskInput<string | null>,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    const organizationId = admin.organization.id;
    const connection =
      typeof connectionId === "string"
        ? await getChatConnection(db, organizationId, connectionId)
        : null;
    if (!connection) return { ok: false, error: "That chat connection isn't connected." };
    const channelId = typeof channel === "string" ? chatChannelId(connection, channel) : null;
    if (!channelId) {
      const error =
        connection.platform === "slack"
          ? "Enter a Slack channel ID, like C0123ABCD (in the channel's details)."
          : "Enter a Discord channel ID, like 123456789012345678 (Copy Channel ID).";
      return { ok: false, error, fieldErrors: { channel: error } };
    }
    const invalid = invalidChatTasks(await chatTaskErrors(organizationId, input, true));
    if (invalid) return invalid;
    if (input.askAboutCode === null && input.startWork === null) {
      return { ok: false, error: "Choose a task for the channel to run." };
    }
    const saved = await upsertChatChannelTaskSetting(db, {
      organizationId,
      connectionId: connection.id,
      channelId,
      askAboutCodeTaskId: input.askAboutCode,
      startWorkTaskId: input.startWork,
      updatedBy: admin.id,
    });
    if (!saved) return { ok: false, error: "That chat connection isn't connected." };
    revalidatePath("/settings/integrations");
  });
}

/** Removes a channel's task overrides (`channelId`: the Chat SDK channel ID); it runs the organization's again. */
export async function removeChatChannelTasks(
  connectionId: string,
  channelId: string,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const removed =
      typeof connectionId === "string" &&
      typeof channelId === "string" &&
      (await deleteChatChannelTaskSetting(getDb(), admin.organization.id, connectionId, channelId));
    if (!removed) return { ok: false, error: "That channel has no task overrides." };
    revalidatePath("/settings/integrations");
  });
}
