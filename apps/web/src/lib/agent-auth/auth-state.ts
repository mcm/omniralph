import "server-only";
import { getAgentAuthState, type Database } from "@omniralph/db";
import { msUntilNextDailyWindow } from "@/lib/daily-window";
import { readHotState, registerHotStateRebuilder, writeHotState } from "@/lib/hot-state";
import "@/lib/hot-state/rebuilders";

/**
 * An agent's auth state (`active`/`revoked`), cached in Redis so `requireAgent` and
 * `requireJob` don't query Postgres on every agent request. Revocation writes
 * `revoked` after its Postgres commit, so it still takes effect on the next request.
 */

export type AgentAuthState = Awaited<ReturnType<typeof getAgentAuthState>>;

const KEY_PREFIX = "agent-auth:";

/**
 * How long a cached state lives (ms): until the next daily window, so an idle agent's
 * requests reach Postgres once a day, while Neon is awake for the window anyway (a 24h TTL
 * drifted with when the state was cached). Revocation overwrites it (`cacheAgentRevoked`).
 */
function cachedStateTtlMs(): number {
  return msUntilNextDailyWindow(new Date());
}

export function agentAuthKey(agentId: string): string {
  return `${KEY_PREFIX}${agentId}`;
}

function isCachedState(value: string | null): value is "active" | "revoked" {
  return value === "active" || value === "revoked";
}

/**
 * The agent's auth state: from Redis, or on a miss from Postgres (then cached until the
 * next daily window). `unknown` isn't cached: our tokens are only issued to existing agents.
 */
export async function readAgentAuthState(db: Database, agentId: string): Promise<AgentAuthState> {
  return readHotState(
    db,
    async (redis) => {
      const key = agentAuthKey(agentId);
      const cached = await redis.get(key);
      if (isCachedState(cached)) return cached;
      const state = await getAgentAuthState(db, agentId);
      // NX: a revocation committed after our read may already have written `revoked`.
      if (state !== "unknown") await redis.set(key, state, "PX", cachedStateTtlMs(), "NX");
      return state;
    },
    () => getAgentAuthState(db, agentId),
  );
}

/** Records a revocation in Redis; call after the Postgres commit. */
export async function cacheAgentRevoked(agentId: string): Promise<void> {
  await writeHotState((redis) =>
    redis.set(agentAuthKey(agentId), "revoked", "PX", cachedStateTtlMs()),
  );
}

/**
 * Records a re-enrollment (TOOL-925) in Redis, overwriting a cached `revoked`; call after the
 * Postgres commit.
 */
export async function cacheAgentActive(agentId: string): Promise<void> {
  await writeHotState((redis) =>
    redis.set(agentAuthKey(agentId), "active", "PX", cachedStateTtlMs()),
  );
}

// A rebuild may follow a failed revocation write: drop every cached state so each is
// read from Postgres again on its next request.
registerHotStateRebuilder("agent-auth", async (redis) => {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== "0");
});
