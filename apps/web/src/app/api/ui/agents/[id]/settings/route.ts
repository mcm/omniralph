import { apiHandler } from "@/lib/api/handler";
import { agentSettingsSaveSchema } from "@/lib/api/agents";
import { getDb } from "@/lib/db";
import { saveAgentSettings } from "@/lib/agents/manage";

/**
 * Saves the Settings tab's changes in one request (config and desired version):
 * the agent gets them with its next heartbeat after `savedAt`.
 */
export const PUT = apiHandler<"admin", typeof agentSettingsSaveSchema, undefined, { id: string }>(
  { access: "admin", body: agentSettingsSaveSchema },
  async ({ user, params, body }) => {
    const result = await saveAgentSettings(getDb(), user.organization.id, params.id, body);
    return result.ok ? { ...result, savedAt: new Date().toISOString() } : result;
  },
);
