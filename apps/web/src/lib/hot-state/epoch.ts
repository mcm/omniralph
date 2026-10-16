import { randomUUID } from "node:crypto";
import type { Database } from "@omniralph/db";
import type { Redis } from "ioredis";

/**
 * Hot state is derived from Postgres. `hot-state:epoch` (no TTL) marks a Redis whose
 * derived keys have been rebuilt: when it's missing (a new or flushed Redis), the
 * registered rebuilders repopulate their keys from Postgres before anyone trusts them.
 */
export const EPOCH_KEY = "hot-state:epoch";
/** Held (`SET NX`) by the one instance rebuilding, so concurrent readers don't all rebuild. */
export const REBUILD_LOCK_KEY = "hot-state:rebuild-lock";
/** Longest a rebuild may hold the lock before another instance can take over. */
const REBUILD_LOCK_TTL_MS = 30_000;

/** Repopulates one family of derived keys from Postgres. Must be idempotent. */
export type HotStateRebuilder = (redis: Redis, db: Database) => Promise<void>;

const rebuilders = new Map<string, HotStateRebuilder>();

/**
 * Registers a rebuilder under `name` (re-registering a name replaces it). Modules that
 * cache something in Redis register theirs at import time.
 */
export function registerHotStateRebuilder(name: string, rebuild: HotStateRebuilder): void {
  rebuilders.set(name, rebuild);
}

/** Removes a rebuilder (tests). */
export function unregisterHotStateRebuilder(name: string): void {
  rebuilders.delete(name);
}

// Deletes the lock only if this instance still holds it (it may have expired and been
// taken by another).
const RELEASE_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Makes sure Redis's derived state is current: when `hot-state:epoch` is missing, takes
 * the rebuild lock, runs every registered rebuilder and sets the epoch. Resolves `true`
 * when the hot state can be trusted, `false` while another instance is rebuilding (the
 * caller should read Postgres this time). A failing rebuilder rejects, leaving the epoch
 * unset so the next call retries.
 */
export async function ensureHotStateEpoch(redis: Redis, db: Database): Promise<boolean> {
  if ((await redis.exists(EPOCH_KEY)) === 1) return true;
  const token = randomUUID();
  const locked = await redis.set(REBUILD_LOCK_KEY, token, "PX", REBUILD_LOCK_TTL_MS, "NX");
  if (locked !== "OK") return false;
  try {
    // Another instance may have finished between our check and taking the lock.
    if ((await redis.exists(EPOCH_KEY)) === 1) return true;
    for (const rebuild of rebuilders.values()) await rebuild(redis, db);
    await redis.set(EPOCH_KEY, new Date().toISOString());
    return true;
  } finally {
    await redis.eval(RELEASE_LOCK, 1, REBUILD_LOCK_KEY, token).catch(() => undefined);
  }
}
