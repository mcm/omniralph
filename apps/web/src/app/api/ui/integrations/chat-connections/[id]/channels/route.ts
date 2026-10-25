import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { removeChannelPlaybooksSchema } from "@/lib/api/integrations";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { removeChatChannelPlaybooks, saveChatChannelPlaybooks } from "@/lib/integrations/manage";

type Params = { id: string };

/**
 * Sets a channel's playbooks (`ChannelPlaybooksInput`), overriding the organization's. The body
 * is checked in `saveChatChannelPlaybooks`, so the channel and each playbook get their own field
 * error.
 */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) =>
    saveChatChannelPlaybooks(getDb(), user, requireUuid(params.id), body),
);

/** Removes a channel's playbook overrides (`{ channelId }`: the Chat SDK channel ID). */
export const DELETE = apiHandler<"admin", typeof removeChannelPlaybooksSchema, undefined, Params>(
  { access: "admin", body: removeChannelPlaybooksSchema },
  async ({ user, params, body }) =>
    removeChatChannelPlaybooks(getDb(), user, requireUuid(params.id), body.channelId),
);
