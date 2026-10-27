import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { loadChatPlaybookSettings, saveChatPlaybookDefaults } from "@/lib/integrations/manage";

/**
 * The playbooks chat runs (`ChatPlaybooksSettings`): the organization's choice, the playbooks
 * each can run and every chat connection's channel overrides. Any member reads them
 * (Advanced › Chat channel overrides); there are no secrets in them.
 */
export const GET = apiHandler({ access: "member" }, async ({ user }) =>
  loadChatPlaybookSettings(getDb(), user.organization.id),
);

/**
 * Sets the organization's chat playbooks (`ChatPlaybooksInput`: `{ ask, startWork }`, a
 * `chat-ask` and a `request` playbook). The body is checked in `saveChatPlaybookDefaults`, so
 * every invalid choice gets its own field error.
 */
export const PUT = apiHandler({ access: "admin", body: z.unknown() }, async ({ user, body }) =>
  saveChatPlaybookDefaults(getDb(), user, body),
);
