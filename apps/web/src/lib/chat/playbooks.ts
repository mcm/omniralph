import "server-only";
import {
  getChatChannelPlaybookSetting,
  getChatPlaybookDefaults,
  type ChatConnection,
  type ChatPlaybooks,
  type Database,
  type ExternalChatConnection,
  type ExternalChatPlatform,
} from "@omniralph/db";
import type { Playbook, PlaybookRole } from "@omniralph/tasks";
import type { PlaybookFilter } from "@/lib/playbooks";

/**
 * The playbooks chat runs: "ask about code" (`ask`, a `chat-ask` playbook) and
 * "start work" (`startWork`, a `request` playbook). An organization chooses
 * them (`chat.playbooks` in `app_settings`) and a channel of one of its chat
 * connections can override either (`chat_channel_task_settings`); unchosen,
 * they're the built-in `builtin:ask-about-code` and `builtin:handle-request`.
 */

export type ChatPlaybookSlot = keyof ChatPlaybooks;

export const CHAT_PLAYBOOK_SLOTS: readonly ChatPlaybookSlot[] = ["ask", "startWork"];

/** The role each chat playbook must have. */
export const CHAT_PLAYBOOK_ROLES: Record<ChatPlaybookSlot, PlaybookRole> = {
  ask: "chat-ask",
  startWork: "request",
};

/**
 * What each chat playbook's picker offers (`listPlaybookChoices`): the
 * organization's playbooks, built-in or its own, of the slot's role.
 */
export const CHAT_PLAYBOOK_FILTERS: Record<ChatPlaybookSlot, PlaybookFilter> = {
  ask: { roles: [CHAT_PLAYBOOK_ROLES.ask] },
  startWork: { roles: [CHAT_PLAYBOOK_ROLES.startWork] },
};

export const CHAT_PLAYBOOK_LABELS: Record<ChatPlaybookSlot, string> = {
  ask: "Ask about code",
  startWork: "Start work",
};

/** Looks a playbook up by ID (e.g. `organizationPlaybooks(…).getPlaybook`). */
export type PlaybookLookup = (id: string) => Playbook | null | Promise<Playbook | null>;

export type ChatPlaybookChoiceResult =
  | { ok: true; playbook: Playbook }
  | { ok: false; reason: "unknown_playbook" | "wrong_role"; error: string };

/**
 * Whether `playbook` (what `playbookId` resolves to, null when nothing) can be
 * the chat playbook `slot` runs: a known playbook of the slot's role
 * (`CHAT_PLAYBOOK_ROLES`).
 */
export function validateChatPlaybookChoice(
  slot: ChatPlaybookSlot,
  playbookId: string,
  playbook: Playbook | null,
): ChatPlaybookChoiceResult {
  if (!playbook) {
    return { ok: false, reason: "unknown_playbook", error: `There's no playbook ${playbookId}.` };
  }
  const role = CHAT_PLAYBOOK_ROLES[slot];
  if (playbook.role !== role) {
    return {
      ok: false,
      reason: "wrong_role",
      error: `${CHAT_PLAYBOOK_LABELS[slot]} needs a ${role} playbook; ${playbook.name} is a ${playbook.role} playbook.`,
    };
  }
  return { ok: true, playbook };
}

/**
 * The playbooks chat runs in a channel of a connection: each from the channel's
 * override when set, else the organization's choice, else the built-in default.
 */
export async function chatPlaybooksFor(
  db: Database,
  connection: Pick<ChatConnection, "id" | "organizationId">,
  channelId: string,
): Promise<ChatPlaybooks> {
  const [defaults, override] = await Promise.all([
    getChatPlaybookDefaults(db, connection.organizationId),
    getChatChannelPlaybookSetting(db, connection.organizationId, connection.id, channelId),
  ]);
  return {
    ask: override?.askPlaybookId ?? defaults.ask,
    startWork: override?.startWorkPlaybookId ?? defaults.startWork,
  };
}

const PLATFORM_CHANNEL_ID: Record<ExternalChatPlatform, RegExp> = {
  slack: /^[CGD][A-Z0-9]{6,40}$/,
  discord: /^\d{1,30}$/,
};

/**
 * The Chat SDK channel ID (`chat_threads.channel_id`) of a channel of a
 * connection, from the ID the platform shows (a Slack channel ID like
 * `C0123ABCD`, or a Discord channel ID): `slack:{channel}` or
 * `discord:{guild}:{channel}`. Null when it isn't one.
 */
export function chatChannelId(
  connection: Pick<ExternalChatConnection, "platform" | "externalId">,
  platformChannelId: string,
): string | null {
  const id = platformChannelId.trim();
  if (!PLATFORM_CHANNEL_ID[connection.platform].test(id)) return null;
  return connection.platform === "slack" ? `slack:${id}` : `discord:${connection.externalId}:${id}`;
}

/** The ID the platform shows for a Chat SDK channel ID (its last part). */
export function platformChannelId(channelId: string): string {
  return channelId.slice(channelId.lastIndexOf(":") + 1);
}
