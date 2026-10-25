import "server-only";
import {
  DEFAULT_CHAT_TASKS,
  deleteChatChannelTaskSetting,
  deleteChatConnection,
  deleteIntegration,
  getChatConnection,
  getChatTaskDefaults,
  getIntegration,
  getUserById,
  listChatChannelTaskSettings,
  listChatConnections,
  setChatTaskDefaults,
  upsertChatChannelTaskSetting,
  withSettingsChanges,
  type Database,
} from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import type { IntegrationsSettings } from "@/lib/api/integrations";
import type { OrgUser } from "@/lib/auth/session";
import { discordOAuthConfig, leaveDiscordGuild } from "@/lib/chat/discord-oauth";
import { revokeSlackToken, slackOAuthConfig, type SlackCredentials } from "@/lib/chat/slack-oauth";
import {
  CHAT_TASK_FILTERS,
  CHAT_TASK_ROLES,
  chatChannelId,
  platformChannelId,
  validateChatTaskChoice,
  type ChatTaskRole,
} from "@/lib/chat/tasks";
import { getPlaybookTask, listPlaybookChoices, organizationPlaybooks } from "@/lib/playbooks";
import { linearOAuthConfig, revokeToken, type LinearCredentials } from "@/lib/linear/oauth";
import {
  settingsActor,
  trackedChatTaskDefaults,
  trackedConnection,
} from "@/lib/settings-history/sections";

/** Runs a save of connection `connectionId`, recording what it changed in its history. */
function savingConnection<T>(
  db: Database,
  admin: OrgUser,
  connectionId: string,
  save: (tx: Database) => Promise<T>,
): Promise<T> {
  return withSettingsChanges(
    db,
    settingsActor(admin),
    trackedConnection(admin.organization.id, connectionId),
    save,
  );
}

/**
 * Settings › Integrations: the active organization's Linear workspace, Slack workspaces and
 * Discord servers, whether this server has each app's credentials, and the tasks chat runs.
 * Database and environment only (it is polled): no call to Linear, Slack or Discord.
 */
export async function loadIntegrations(
  db: Database,
  admin: OrgUser,
): Promise<IntegrationsSettings> {
  const organizationId = admin.organization.id;
  const [
    integration,
    chatConnections,
    chatTaskDefaults,
    channelTasks,
    askAboutCodeChoices,
    startWorkChoices,
  ] = await Promise.all([
    getIntegration(db, organizationId, "linear"),
    listChatConnections(db, organizationId),
    getChatTaskDefaults(db, organizationId),
    listChatChannelTaskSettings(db, organizationId),
    listPlaybookChoices(db, organizationId, CHAT_TASK_FILTERS.askAboutCode),
    listPlaybookChoices(db, organizationId, CHAT_TASK_FILTERS.startWork),
  ]);
  // The installer may have left the organization since, so look them up as a user.
  const installers = new Map(
    await Promise.all(
      [...new Set(chatConnections.map((c) => c.installedByUserId))]
        .filter((id): id is string => id !== null)
        .map(async (id) => {
          const user = await getUserById(db, id);
          return [id, user ? (user.name ?? user.email) : null] as const;
        }),
    ),
  );
  const installedBy = (userId: string | null) => (userId && installers.get(userId)) ?? null;

  return {
    linear: integration
      ? {
          name: integration.name,
          workspaceId: integration.externalId,
          connectedAt: integration.updatedAt.toISOString(),
        }
      : null,
    linearConfigured: linearOAuthConfig() !== null,
    slack: chatConnections
      .filter((c) => c.platform === "slack")
      .map((c) => ({
        id: c.id,
        name: c.name,
        workspaceId: c.externalId,
        installedBy: installedBy(c.installedByUserId),
        connectedAt: c.updatedAt.toISOString(),
      })),
    slackConfigured: slackOAuthConfig() !== null,
    discord: chatConnections
      .filter((c) => c.platform === "discord")
      .map((c) => ({
        id: c.id,
        name: c.name,
        serverId: c.externalId,
        installedBy: installedBy(c.installedByUserId),
        connectedAt: c.updatedAt.toISOString(),
      })),
    discordConfigured: discordOAuthConfig() !== null,
    chatTasks: {
      defaults: chatTaskDefaults,
      builtinDefaults: DEFAULT_CHAT_TASKS,
      choices: { askAboutCode: askAboutCodeChoices, startWork: startWorkChoices },
      connections: chatConnections.map((c) => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
        channels: channelTasks
          .filter((t) => t.connectionId === c.id)
          .map((t) => ({
            channelId: t.channelId,
            channel: platformChannelId(t.channelId),
            askAboutCode: t.askAboutCodeTaskId,
            startWork: t.startWorkTaskId,
          })),
      })),
    },
  };
}

/**
 * Disconnects the active organization's Linear workspace: forgets its tokens and revokes them at
 * Linear (best effort). Linear webhooks are ignored from then on.
 */
export async function disconnectLinear(db: Database, admin: OrgUser): Promise<ActionResult> {
  const connected = await getIntegration(db, admin.organization.id, "linear");
  if (!connected) return { ok: false, error: "No Linear workspace is connected." };
  const removed = await savingConnection(db, admin, connected.id, (tx) =>
    deleteIntegration<LinearCredentials>(tx, admin.organization.id, "linear"),
  );
  if (!removed) return { ok: false, error: "No Linear workspace is connected." };
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
  return { ok: true };
}

/**
 * Disconnects one of the active organization's Slack workspaces: forgets its bot token (and its
 * threads) and revokes the token at Slack (best effort). Its events are ignored from then on.
 */
export async function disconnectSlack(
  db: Database,
  admin: OrgUser,
  connectionId: string,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
  const connections = await listChatConnections(db, organizationId);
  const connection = connections.find((c) => c.id === connectionId && c.platform === "slack");
  if (!connection) return { ok: false, error: "That Slack workspace isn't connected." };
  const removed = await savingConnection(db, admin, connection.id, (tx) =>
    deleteChatConnection<SlackCredentials>(tx, organizationId, connection.id),
  );
  if (!removed) return { ok: false, error: "That Slack workspace isn't connected." };
  if (!removed.credentials) return { ok: true };
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
  return { ok: true };
}

/**
 * Disconnects one of the active organization's Discord servers: forgets it (and its threads) and
 * makes the bot leave it (best effort). Its messages are ignored from then on.
 */
export async function disconnectDiscord(
  db: Database,
  admin: OrgUser,
  connectionId: string,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
  const connections = await listChatConnections(db, organizationId);
  const connection = connections.find((c) => c.id === connectionId && c.platform === "discord");
  if (!connection) return { ok: false, error: "That Discord server isn't connected." };
  const removed = await savingConnection(db, admin, connection.id, (tx) =>
    deleteChatConnection(tx, organizationId, connection.id),
  );
  if (!removed) return { ok: false, error: "That Discord server isn't connected." };
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
  return { ok: true };
}

/** A chat task choice per role; null (for a channel) keeps the organization's. */
type ChatTaskInput<T> = Record<ChatTaskRole, T>;

const asObject = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

/**
 * Field errors of the chat task choices that don't pass `validateChatTaskChoice`
 * against the organization's tasks (built-in or its own).
 */
async function chatTaskErrors(
  db: Database,
  organizationId: string,
  input: unknown,
  optional: boolean,
): Promise<Record<string, string>> {
  const definitions = organizationPlaybooks(db, organizationId);
  const choices = asObject(input);
  const errors: Record<string, string> = {};
  for (const role of CHAT_TASK_ROLES) {
    const taskId = choices[role];
    if (taskId === null && optional) continue;
    if (typeof taskId !== "string") {
      errors[role] = "Choose a task.";
      continue;
    }
    const task = await getPlaybookTask(definitions, taskId);
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
export async function saveChatTaskDefaults(
  db: Database,
  admin: OrgUser,
  input: unknown,
): Promise<ActionResult> {
  const invalid = invalidChatTasks(await chatTaskErrors(db, admin.organization.id, input, false));
  if (invalid) return invalid;
  const tasks = input as ChatTaskInput<string>;
  await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedChatTaskDefaults(admin.organization.id),
    (tx) =>
      setChatTaskDefaults(
        tx,
        admin.organization.id,
        { askAboutCode: tasks.askAboutCode, startWork: tasks.startWork },
        admin.id,
      ),
  );
  return { ok: true };
}

/**
 * Sets the tasks a channel of one of the active organization's chat connections runs
 * (`channel`: the ID the platform shows), overriding the organization's; null keeps its
 * choice. Each chosen task must pass `validateChatTaskChoice` among its tasks.
 */
export async function saveChatChannelTasks(
  db: Database,
  admin: OrgUser,
  connectionId: string,
  input: unknown,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
  const connection = await getChatConnection(db, organizationId, connectionId);
  if (!connection) return { ok: false, error: "That chat connection isn't connected." };
  const { channel, ...tasks } = asObject(input);
  const channelId = typeof channel === "string" ? chatChannelId(connection, channel) : null;
  if (!channelId) {
    const error =
      connection.platform === "slack"
        ? "Enter a Slack channel ID, like C0123ABCD (in the channel's details)."
        : "Enter a Discord channel ID, like 123456789012345678 (Copy Channel ID).";
    return { ok: false, error, fieldErrors: { channel: error } };
  }
  const invalid = invalidChatTasks(await chatTaskErrors(db, organizationId, tasks, true));
  if (invalid) return invalid;
  const chosen = tasks as ChatTaskInput<string | null>;
  if (chosen.askAboutCode === null && chosen.startWork === null) {
    return { ok: false, error: "Choose a task for the channel to run." };
  }
  const saved = await savingConnection(db, admin, connection.id, (tx) =>
    upsertChatChannelTaskSetting(tx, {
      organizationId,
      connectionId: connection.id,
      channelId,
      askAboutCodeTaskId: chosen.askAboutCode,
      startWorkTaskId: chosen.startWork,
      updatedBy: admin.id,
    }),
  );
  if (!saved) return { ok: false, error: "That chat connection isn't connected." };
  return { ok: true };
}

/** Removes a channel's task overrides (`channelId`: the Chat SDK channel ID); it runs the organization's again. */
export async function removeChatChannelTasks(
  db: Database,
  admin: OrgUser,
  connectionId: string,
  channelId: string,
): Promise<ActionResult> {
  // A connection of another organization reads as missing: nothing is recorded for it.
  const removed = await savingConnection(db, admin, connectionId, (tx) =>
    deleteChatChannelTaskSetting(tx, admin.organization.id, connectionId, channelId),
  );
  if (!removed) return { ok: false, error: "That channel has no task overrides." };
  return { ok: true };
}
