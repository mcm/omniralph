import { apiHandler } from "@/lib/api/handler";
import { agentDefaultsSaveSchema, type AgentDefaults } from "@/lib/api/agent-defaults";
import { getDb } from "@/lib/db";
import { loadAgentDefaults, saveAgentDefaults } from "@/lib/agents/defaults";

/** The organization's agent defaults (admins; Fleet edits the version policy): the desired version and the task-type and concurrency defaults. */
export const GET = apiHandler({ access: "admin" }, async ({ user }): Promise<AgentDefaults> =>
  loadAgentDefaults(getDb(), user.organization.id),
);

/**
 * Saves the Defaults tab's changes in one request (defaults, then the version): agents get
 * them with their next claim or heartbeat.
 */
export const PUT = apiHandler(
  { access: "admin", body: agentDefaultsSaveSchema },
  async ({ user, body }) => saveAgentDefaults(getDb(), user, body),
);
