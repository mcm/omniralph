import "server-only";
import { getAgent, type Database } from "@omniralph/db";
import { readHotState } from "@/lib/hot-state";

/**
 * A harness's organization, cached in Redis (`harness-organization:{id}`) so an idle
 * claim long-poll finds its organization's due set without querying Postgres. A
 * harness never changes organization, so the entry needs no writer or rebuild.
 */

const KEY_PREFIX = "harness-organization:";
const TTL_SECONDS = 7 * 24 * 3600;

/** The harness's organization ID, or null for an unknown harness. */
export async function readHarnessOrganization(
  db: Database,
  harnessId: string,
): Promise<string | null> {
  const fromPostgres = async () => (await getAgent(db, harnessId))?.organizationId ?? null;
  return readHotState(
    db,
    async (redis) => {
      const key = `${KEY_PREFIX}${harnessId}`;
      const cached = await redis.get(key);
      if (cached) return cached;
      const organizationId = await fromPostgres();
      if (organizationId) await redis.set(key, organizationId, "EX", TTL_SECONDS);
      return organizationId;
    },
    fromPostgres,
  );
}
