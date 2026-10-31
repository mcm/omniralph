import "server-only";
import { getAgent, type Database } from "@omniralph/db";
import { msUntilNextDailyWindow } from "@/lib/daily-window";
import { readHotState } from "@/lib/hot-state";

/**
 * An agent's organization, cached in Redis (`agent-organization:{id}`) so an idle
 * claim long-poll finds its organization's due set without querying Postgres. A
 * agent never changes organization, so the entry needs no writer or rebuild. It expires at a
 * daily window start about a week after it was set, so the Postgres read that refills it lands
 * in the window.
 */

const KEY_PREFIX = "agent-organization:";
/** Whole days past the next daily window the entry lives. */
const TTL_EXTRA_DAYS = 6;

export function agentOrganizationKey(agentId: string): string {
  return `${KEY_PREFIX}${agentId}`;
}

/** How long a cached organization lives when set at `now`: until a window start 6–7 days on. */
export function agentOrganizationTtlMs(now: Date): number {
  return msUntilNextDailyWindow(now, TTL_EXTRA_DAYS);
}

/** The agent's organization ID, or null for an unknown agent. */
export async function readAgentOrganization(db: Database, agentId: string): Promise<string | null> {
  const fromPostgres = async () => (await getAgent(db, agentId))?.organizationId ?? null;
  return readHotState(
    db,
    async (redis) => {
      const key = agentOrganizationKey(agentId);
      const cached = await redis.get(key);
      if (cached) return cached;
      const organizationId = await fromPostgres();
      if (organizationId)
        await redis.set(key, organizationId, "PX", agentOrganizationTtlMs(new Date()));
      return organizationId;
    },
    fromPostgres,
  );
}
