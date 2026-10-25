import { apiHandler } from "@/lib/api/handler";
import type { IntegrationsSettings } from "@/lib/api/integrations";
import { getDb } from "@/lib/db";
import { loadIntegrations } from "@/lib/integrations/manage";

/** Settings › Integrations (admins): Linear, Slack and Discord connections, and the chat playbooks. */
export const GET = apiHandler(
  { access: "admin" },
  async ({ user }): Promise<IntegrationsSettings> => loadIntegrations(getDb(), user),
);
