import { z } from "zod";
import { isoDate } from "./schemas";

/** Settings › Integrations (`/api/ui/integrations/**`). OAuth connect/callback stay under `/api/integrations`. */

const slotPlaybooks = <T extends z.ZodType>(playbook: T) =>
  z.object({ ask: playbook, startWork: playbook });

/** A playbook a chat setting can pick (built-in or the organization's own). */
export const chatPlaybookChoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  builtin: z.boolean(),
});
export type ChatPlaybookChoice = z.infer<typeof chatPlaybookChoiceSchema>;

export const channelPlaybooksSchema = z.object({
  /** The Chat SDK channel ID (`slack:C…`, `discord:{guild}:{channel}`). */
  channelId: z.string(),
  /** The ID the platform shows. */
  channel: z.string(),
  /** Null keeps the organization's playbook. */
  ask: z.string().nullable(),
  startWork: z.string().nullable(),
});
export type ChannelPlaybooks = z.infer<typeof channelPlaybooksSchema>;

export const chatPlaybooksSettingsSchema = z.object({
  /** The organization's playbooks (the built-in ones unless chosen). */
  defaults: slotPlaybooks(z.string()),
  /** The built-in playbooks the organization runs until it chooses others (`DEFAULT_CHAT_PLAYBOOKS`). */
  builtinDefaults: slotPlaybooks(z.string()),
  /** The playbooks each can run (`chat-ask` and `request` playbooks, `CHAT_PLAYBOOK_FILTERS`). */
  choices: slotPlaybooks(z.array(chatPlaybookChoiceSchema)),
  connections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      platform: z.enum(["slack", "discord"]),
      channels: z.array(channelPlaybooksSchema),
    }),
  ),
});
export type ChatPlaybooksSettings = z.infer<typeof chatPlaybooksSettingsSchema>;

const chatConnectionSchema = z.object({
  /** The chat connection's ID. */
  id: z.string(),
  name: z.string(),
  /** Name or email of the admin who installed it, null when unknown. */
  installedBy: z.string().nullable(),
  connectedAt: isoDate,
});

export const slackWorkspaceSchema = chatConnectionSchema.extend({
  /** Slack team ID (or enterprise ID for an org-wide install). */
  workspaceId: z.string(),
});
export type SlackWorkspace = z.infer<typeof slackWorkspaceSchema>;

export const discordServerSchema = chatConnectionSchema.extend({
  /** Discord guild ID. */
  serverId: z.string(),
});
export type DiscordServer = z.infer<typeof discordServerSchema>;

export const linearConnectionSchema = z.object({
  name: z.string(),
  workspaceId: z.string(),
  connectedAt: isoDate,
});
export type LinearConnection = z.infer<typeof linearConnectionSchema>;

/** `GET /api/ui/integrations` (admins): what is connected and whether this server can use it. */
export const integrationsSettingsSchema = z.object({
  linear: linearConnectionSchema.nullable(),
  linearConfigured: z.boolean(),
  slack: z.array(slackWorkspaceSchema),
  slackConfigured: z.boolean(),
  discord: z.array(discordServerSchema),
  discordConfigured: z.boolean(),
  chatPlaybooks: chatPlaybooksSettingsSchema,
});
export type IntegrationsSettings = z.infer<typeof integrationsSettingsSchema>;

/** `PUT /api/ui/integrations/chat-tasks`: the organization's chat playbooks. */
export interface ChatPlaybooksInput {
  ask: string;
  startWork: string;
}

/**
 * `PUT /api/ui/integrations/chat-connections/[id]/channels`: a channel's playbooks (`channel`:
 * the ID the platform shows; null keeps the organization's playbook).
 */
export interface ChannelPlaybooksInput {
  channel: string;
  ask: string | null;
  startWork: string | null;
}

/** `DELETE /api/ui/integrations/chat-connections/[id]/channels`: the Chat SDK channel ID. */
export const removeChannelPlaybooksSchema = z.object({ channelId: z.string() });
