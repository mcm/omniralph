import "server-only";
import { getAgentAuthState, type Database } from "@omniralph/db";
import { readHotState, registerHotStateRebuilder, writeHotState } from "@/lib/hot-state";
import "@/lib/hot-state/rebuilders";

/**
 * A harness's auth state (`active`/`revoked`), cached in Redis so `requireHarness` and
 * `requireJob` don't query Postgres on every harness request. Revocation writes
 * `revoked` after its Postgres commit, so it still takes effect on the next request.
 */

export type HarnessAuthState = Awaited<ReturnType<typeof getAgentAuthState>>;

const KEY_PREFIX = "harness-auth:";
/** How long a state read from Postgres stays cached. */
export const HARNESS_AUTH_TTL_SECONDS = 3600;

export function harnessAuthKey(harnessId: string): string {
  return `${KEY_PREFIX}${harnessId}`;
}

function isCachedState(value: string | null): value is "active" | "revoked" {
  return value === "active" || value === "revoked";
}

/**
 * The harness's auth state: from Redis, or on a miss from Postgres (then cached for an
 * hour). `unknown` isn't cached: our tokens are only issued to existing harnesses.
 */
export async function readHarnessAuthState(
  db: Database,
  harnessId: string,
): Promise<HarnessAuthState> {
  return readHotState(
    db,
    async (redis) => {
      const key = harnessAuthKey(harnessId);
      const cached = await redis.get(key);
      if (isCachedState(cached)) return cached;
      const state = await getAgentAuthState(db, harnessId);
      // NX: a revocation committed after our read may already have written `revoked`.
      if (state !== "unknown") await redis.set(key, state, "EX", HARNESS_AUTH_TTL_SECONDS, "NX");
      return state;
    },
    () => getAgentAuthState(db, harnessId),
  );
}

/** Records a revocation in Redis; call after the Postgres commit. */
export async function cacheHarnessRevoked(harnessId: string): Promise<void> {
  await writeHotState((redis) =>
    redis.set(harnessAuthKey(harnessId), "revoked", "EX", HARNESS_AUTH_TTL_SECONDS),
  );
}

// A rebuild may follow a failed revocation write: drop every cached state so each is
// read from Postgres again on its next request.
registerHotStateRebuilder("harness-auth", async (redis) => {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== "0");
});
