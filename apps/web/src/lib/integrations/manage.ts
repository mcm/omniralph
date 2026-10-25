import "server-only";
import {
  DEFAULT_CHAT_PLAYBOOKS,
  deleteChatChannelPlaybookSetting,
  deleteChatConnection,
  deleteIntegration,
  getChatConnection,
  getChatPlaybookDefaults,
  getIntegration,
  getUserById,
  listChatChannelPlaybookSettings,
  listChatConnections,
  setChatPlaybookDefaults,
  upsertChatChannelPlaybookSetting,
  withSettingsChanges,
  type Database,
} from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import type { IntegrationsSettings } from "@/lib/api/integrations";
import type { OrgUser } from "@/lib/auth/session";
import { discordOAuthConfig, leaveDiscordGuild } from "@/lib/chat/discord-oauth";
import { revokeSlackToken, slackOAuthConfig, type SlackCredentials } from "@/lib/chat/slack-oauth";
import {
  CHAT_PLAYBOOK_FILTERS,
  CHAT_PLAYBOOK_SLOTS,
  chatChannelId,
  platformChannelId,
  validateChatPlaybookChoice,
  type ChatPlaybookSlot,
} from "@/lib/chat/playbooks";
import { getPlaybook, listPlaybookChoices } from "@/lib/playbooks";
import { linearOAuthConfig, revokeToken, type LinearCredentials } from "@/lib/linear/oauth";
import {
  settingsActor,
  trackedChatPlaybookDefaults,
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
 * Discord servers, whether this server has each app's credentials, and the playbooks chat runs.
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
    chatPlaybookDefaults,
    channelPlaybooks,
    askChoices,
    startWorkChoices,
  ] = await Promise.all([
    getIntegration(db, organizationId, "linear"),
    listChatConnections(db, organizationId),
    getChatPlaybookDefaults(db, organizationId),
    listChatChannelPlaybookSettings(db, organizationId),
    listPlaybookChoices(db, organizationId, CHAT_PLAYBOOK_FILTERS.ask),
    listPlaybookChoices(db, organizationId, CHAT_PLAYBOOK_FILTERS.startWork),
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
    chatPlaybooks: {
      defaults: chatPlaybookDefaults,
      builtinDefaults: DEFAULT_CHAT_PLAYBOOKS,
      choices: { ask: askChoices, startWork: startWorkChoices },
      connections: chatConnections.map((c) => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
        channels: channelPlaybooks
          .filter((t) => t.connectionId === c.id)
          .map((t) => ({
            channelId: t.channelId,
            channel: platformChannelId(t.channelId),
            ask: t.askPlaybookId,
            startWork: t.startWorkPlaybookId,
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

/** A chat playbook choice per slot; null (for a channel) keeps the organization's. */
type ChatPlaybookInput<T> = Record<ChatPlaybookSlot, T>;

const asObject = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

/**
 * Field errors of the chat playbook choices that don't pass
 * `validateChatPlaybookChoice` against the organization's playbooks (built-in
 * or its own): each must be a playbook of its slot's role.
 */
async function chatPlaybookErrors(
  db: Database,
  organizationId: string,
  input: unknown,
  optional: boolean,
): Promise<Record<string, string>> {
  const choices = asObject(input);
  const errors: Record<string, string> = {};
  for (const slot of CHAT_PLAYBOOK_SLOTS) {
    const id = choices[slot];
    if (id === null && optional) continue;
    if (typeof id !== "string") {
      errors[slot] = "Choose a playbook.";
      continue;
    }
    const resolved = await getPlaybook(db, organizationId, id);
    const result = validateChatPlaybookChoice(slot, id, resolved?.playbook ?? null);
    if (!result.ok) errors[slot] = result.error;
  }
  return errors;
}

function invalidChatPlaybooks(fieldErrors: Record<string, string>): ActionResult | null {
  const first = Object.values(fieldErrors)[0];
  return first === undefined ? null : { ok: false, error: first, fieldErrors };
}

/**
 * Sets the playbooks chat's "ask about code" (`ask`) and "start work" (`startWork`) run for the
 * active organization (unless a channel overrides them); each must pass
 * `validateChatPlaybookChoice` among its playbooks.
 */
export async function saveChatPlaybookDefaults(
  db: Database,
  admin: OrgUser,
  input: unknown,
): Promise<ActionResult> {
  const invalid = invalidChatPlaybooks(
    await chatPlaybookErrors(db, admin.organization.id, input, false),
  );
  if (invalid) return invalid;
  const playbooks = input as ChatPlaybookInput<string>;
  await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedChatPlaybookDefaults(admin.organization.id),
    (tx) =>
      setChatPlaybookDefaults(
        tx,
        admin.organization.id,
        { ask: playbooks.ask, startWork: playbooks.startWork },
        admin.id,
      ),
  );
  return { ok: true };
}

/**
 * Sets the playbooks a channel of one of the active organization's chat connections runs
 * (`channel`: the ID the platform shows), overriding the organization's; null keeps its
 * choice. Each chosen playbook must pass `validateChatPlaybookChoice` among its playbooks.
 */
export async function saveChatChannelPlaybooks(
  db: Database,
  admin: OrgUser,
  connectionId: string,
  input: unknown,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
  const connection = await getChatConnection(db, organizationId, connectionId);
  if (!connection) return { ok: false, error: "That chat connection isn't connected." };
  const { channel, ...playbooks } = asObject(input);
  const channelId = typeof channel === "string" ? chatChannelId(connection, channel) : null;
  if (!channelId) {
    const error =
      connection.platform === "slack"
        ? "Enter a Slack channel ID, like C0123ABCD (in the channel's details)."
        : "Enter a Discord channel ID, like 123456789012345678 (Copy Channel ID).";
    return { ok: false, error, fieldErrors: { channel: error } };
  }
  const invalid = invalidChatPlaybooks(
    await chatPlaybookErrors(db, organizationId, playbooks, true),
  );
  if (invalid) return invalid;
  const chosen = playbooks as ChatPlaybookInput<string | null>;
  if (chosen.ask === null && chosen.startWork === null) {
    return { ok: false, error: "Choose a playbook for the channel to run." };
  }
  const saved = await savingConnection(db, admin, connection.id, (tx) =>
    upsertChatChannelPlaybookSetting(tx, {
      organizationId,
      connectionId: connection.id,
      channelId,
      askPlaybookId: chosen.ask,
      startWorkPlaybookId: chosen.startWork,
      updatedBy: admin.id,
    }),
  );
  if (!saved) return { ok: false, error: "That chat connection isn't connected." };
  return { ok: true };
}

/**
 * Removes a channel's playbook overrides (`channelId`: the Chat SDK channel ID); it runs the
 * organization's again.
 */
export async function removeChatChannelPlaybooks(
  db: Database,
  admin: OrgUser,
  connectionId: string,
  channelId: string,
): Promise<ActionResult> {
  // A connection of another organization reads as missing: nothing is recorded for it.
  const removed = await savingConnection(db, admin, connectionId, (tx) =>
    deleteChatChannelPlaybookSetting(tx, admin.organization.id, connectionId, channelId),
  );
  if (!removed) return { ok: false, error: "That channel has no playbook overrides." };
  return { ok: true };
}
