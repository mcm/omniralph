import { apiHandler } from "@/lib/api/handler";
import { agentDefaultsSaveSchema, type AgentDefaults } from "@/lib/api/agent-defaults";
import { getDb } from "@/lib/db";
import { loadAgentDefaults, saveAgentDefaults } from "@/lib/agents/defaults";

/**
 * The organization's agent defaults (admins; Fleet edits the version policy): the desired
 * version. Slots and kinds are each agent's own (`settings.json`).
 */
export const GET = apiHandler({ access: "admin" }, async ({ user }): Promise<AgentDefaults> =>
  loadAgentDefaults(getDb(), user.organization.id),
);

/**
 * Saves the version policy (`maxConcurrency` or `defaults` is a 400): agents get it with
 * their next heartbeat.
 */
export const PUT = apiHandler(
  { access: "admin", body: agentDefaultsSaveSchema },
  async ({ user, body }) => saveAgentDefaults(getDb(), user, body),
);
