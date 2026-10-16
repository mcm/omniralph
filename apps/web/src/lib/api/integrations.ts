import { z } from "zod";
import { isoDate } from "./schemas";

/** Settings › Integrations (`/api/ui/integrations/**`). OAuth connect/callback stay under `/api/integrations`. */

const roleTasks = <T extends z.ZodType>(task: T) =>
  z.object({ askAboutCode: task, startWork: task });

/** A task a chat setting can pick (built-in or the organization's own). */
export const taskChoiceSchema = z.object({ id: z.string(), name: z.string(), builtin: z.boolean() });
export type TaskChoice = z.infer<typeof taskChoiceSchema>;

export const channelTasksSchema = z.object({
  /** The Chat SDK channel ID (`slack:C…`, `discord:{guild}:{channel}`). */
  channelId: z.string(),
  /** The ID the platform shows. */
  channel: z.string(),
  /** Null keeps the organization's task. */
  askAboutCode: z.string().nullable(),
  startWork: z.string().nullable(),
});
export type ChannelTasks = z.infer<typeof channelTasksSchema>;

export const chatTasksSettingsSchema = z.object({
  /** The organization's tasks (the built-in ones unless chosen). */
  defaults: roleTasks(z.string()),
  /** The built-in tasks the organization runs until it chooses others (`DEFAULT_CHAT_TASKS`). */
  builtinDefaults: roleTasks(z.string()),
  /** The tasks each can run (the organization's passing `CHAT_TASK_FILTERS`). */
  choices: roleTasks(z.array(taskChoiceSchema)),
  connections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      platform: z.enum(["slack", "discord"]),
      channels: z.array(channelTasksSchema),
    }),
  ),
});
export type ChatTasksSettings = z.infer<typeof chatTasksSettingsSchema>;

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
  chatTasks: chatTasksSettingsSchema,
});
export type IntegrationsSettings = z.infer<typeof integrationsSettingsSchema>;

/**
 * `PUT /api/ui/integrations/chat-connections/[id]/channels`: a channel's tasks (`channel`:
 * the ID the platform shows; null keeps the organization's task).
 */
export interface ChannelTasksInput {
  channel: string;
  askAboutCode: string | null;
  startWork: string | null;
}

/** `DELETE /api/ui/integrations/chat-connections/[id]/channels`: the Chat SDK channel ID. */
export const removeChannelTasksSchema = z.object({ channelId: z.string() });
