import "server-only";
import { countUnreplayedFailedDeliveries, listAgentOverview, type Database } from "@omniralph/db";
import type { NavIndicators } from "@/lib/api/nav-indicators";
import type { ScopedOrganization } from "@/lib/api/scope";
import { organizationAgentVersion } from "@/lib/agents/desired-version";
import { agentRow } from "@/lib/agents/rows";

/** npm's `latest` is cached; never let it hold up the nav for long (as Fleet). */
const NPM_TIMEOUT_MS = 2_000;

/**
 * The Fleet and Settings nav dots' counts: Fleet over `organizations` (the scope), with
 * Fleet's own rules (`agentRow`: online from `agents.live_online`, the update state against
 * the version the agent should run); Settings over the `active` organization. A fixed number
 * of queries per organization, whatever the number of agents and deliveries.
 */
export async function loadNavIndicators(
  db: Database,
  { organizations, active }: { organizations: readonly ScopedOrganization[]; active: string },
): Promise<NavIndicators> {
  const now = new Date();
  const [fleet, failed] = await Promise.all([
    Promise.all(
      organizations.map(async (organization) => {
        const [agents, version] = await Promise.all([
          listAgentOverview(db, organization.id),
          organizationAgentVersion(db, organization.id, { timeoutMs: NPM_TIMEOUT_MS }),
        ]);
        return agents.map((agent) => agentRow(agent, now, version.version, version.tracksLatest));
      }),
    ),
    countUnreplayedFailedDeliveries(db, active, now),
  ]);
  const counts = { offline: 0, updateFailed: 0 };
  for (const row of fleet.flat()) {
    if (row.revoked) continue;
    if (!row.online) counts.offline += 1;
    else if (row.updateStatus === "failed") counts.updateFailed += 1;
  }
  // A delivery that came through no connection can't be replayed from any connection page.
  const byConnection = [...failed]
    .filter(([id, count]) => id !== null && count > 0)
    .map(([id, count]) => ({ id, failed: count }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    fleet: counts,
    settings: {
      failedDeliveries: byConnection.reduce((sum, { failed: count }) => sum + count, 0),
      byConnection,
    },
  };
}
