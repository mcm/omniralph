import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { saveChatPlaybookDefaults } from "@/lib/integrations/manage";

/**
 * Sets the organization's chat playbooks (`ChatPlaybooksInput`: `{ ask, startWork }`, a
 * `chat-ask` and a `request` playbook). The body is checked in `saveChatPlaybookDefaults`, so
 * every invalid choice gets its own field error.
 */
export const PUT = apiHandler({ access: "admin", body: z.unknown() }, async ({ user, body }) =>
  saveChatPlaybookDefaults(getDb(), user, body),
);
