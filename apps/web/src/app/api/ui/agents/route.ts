import { listAgentOverview } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import type { AgentList } from "@/lib/api/agents";
import { getDb } from "@/lib/db";
import { organizationAgentVersion } from "@/lib/agents/desired-version";
import { withLastSeen } from "@/lib/agents/last-seen";
import { agentRow } from "@/lib/agents/rows";

/** npm's `latest` is read at most every 5 minutes (cached); never let it hold up a poll for long. */
const NPM_TIMEOUT_MS = 2_000;

/** The active organization's agents: the Agents page. */
export const GET = apiHandler({}, async ({ user }): Promise<AgentList> => {
  const db = getDb();
  const now = new Date();
  const [agents, version] = await Promise.all([
    listAgentOverview(db, user.organization.id).then(withLastSeen),
    organizationAgentVersion(db, user.organization.id, { timeoutMs: NPM_TIMEOUT_MS }),
  ]);
  return {
    agents: agents.map((agent) => agentRow(agent, now, version.version, version.tracksLatest)),
  };
});
