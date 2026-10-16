import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { saveChatTaskDefaults } from "@/lib/integrations/manage";

/**
 * Sets the organization's chat tasks (`{ askAboutCode, startWork }`). The body is checked in
 * `saveChatTaskDefaults`, so every invalid choice gets its own field error.
 */
export const PUT = apiHandler({ access: "admin", body: z.unknown() }, async ({ user, body }) =>
  saveChatTaskDefaults(getDb(), user, body),
);
