import "server-only";
import { getAgent, type Database } from "@omniralph/db";
import { readHotState } from "@/lib/hot-state";

/**
 * An agent's organization, cached in Redis (`agent-organization:{id}`) so an idle
 * claim long-poll finds its organization's due set without querying Postgres. A
 * agent never changes organization, so the entry needs no writer or rebuild.
 */

const KEY_PREFIX = "agent-organization:";
const TTL_SECONDS = 7 * 24 * 3600;

/** The agent's organization ID, or null for an unknown agent. */
export async function readAgentOrganization(db: Database, agentId: string): Promise<string | null> {
  const fromPostgres = async () => (await getAgent(db, agentId))?.organizationId ?? null;
  return readHotState(
    db,
    async (redis) => {
      const key = `${KEY_PREFIX}${agentId}`;
      const cached = await redis.get(key);
      if (cached) return cached;
      const organizationId = await fromPostgres();
      if (organizationId) await redis.set(key, organizationId, "EX", TTL_SECONDS);
      return organizationId;
    },
    fromPostgres,
  );
}
