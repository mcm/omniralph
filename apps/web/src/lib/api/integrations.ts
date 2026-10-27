import { z } from "zod";

/**
 * Chat settings and disconnects (`/api/ui/integrations/**`). OAuth connect/callback stay under
 * `/api/integrations`.
 */

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

/** `GET /api/ui/integrations/chat-tasks` (any member): the playbooks chat runs. */
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

/** `PUT /api/ui/integrations/chat-tasks`: the organization's chat playbooks. */
export interface ChatPlaybooksInput {
  ask: string;
  startWork: string;
}

/**
 * `PUT /api/ui/integrations/chat-connections/[id]/channels`: a channel's playbooks (`channel`:
 * the ID the platform shows, or the channel's name; null keeps the organization's playbook).
 */
export interface ChannelPlaybooksInput {
  channel: string;
  ask: string | null;
  startWork: string | null;
}

/** The answer of a saved channel override: the override as the server stored it. */
export const savedChannelPlaybooksSchema = z.object({
  ok: z.literal(true),
  channel: channelPlaybooksSchema,
});
export type SavedChannelPlaybooks = z.infer<typeof savedChannelPlaybooksSchema>;

/** `DELETE /api/ui/integrations/chat-connections/[id]/channels`: the Chat SDK channel ID. */
export const removeChannelPlaybooksSchema = z.object({ channelId: z.string() });
