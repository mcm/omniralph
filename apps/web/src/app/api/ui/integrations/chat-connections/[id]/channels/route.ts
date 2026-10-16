import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { removeChannelTasksSchema } from "@/lib/api/integrations";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { removeChatChannelTasks, saveChatChannelTasks } from "@/lib/integrations/manage";

type Params = { id: string };

/**
 * Sets a channel's tasks (`ChannelTasksInput`), overriding the organization's. The body is
 * checked in `saveChatChannelTasks`, so the channel and each task get their own field error.
 */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) => saveChatChannelTasks(getDb(), user, requireUuid(params.id), body),
);

/** Removes a channel's task overrides (`{ channelId }`: the Chat SDK channel ID). */
export const DELETE = apiHandler<"admin", typeof removeChannelTasksSchema, undefined, Params>(
  { access: "admin", body: removeChannelTasksSchema },
  async ({ user, params, body }) =>
    removeChatChannelTasks(getDb(), user, requireUuid(params.id), body.channelId),
);
