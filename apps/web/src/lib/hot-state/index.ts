import type { Database } from "@omniralph/db";
import type { Redis } from "ioredis";
import { getRedis, hotStateEnabled } from "./client";
import { EPOCH_KEY, ensureHotStateEpoch } from "./epoch";

export { closeRedis, getRedis, hotStateEnabled } from "./client";
export {
  EPOCH_KEY,
  REBUILD_LOCK_KEY,
  ensureHotStateEpoch,
  registerHotStateRebuilder,
  unregisterHotStateRebuilder,
  type HotStateRebuilder,
} from "./epoch";

/**
 * Reads hot state from Redis, or from Postgres when it can't be trusted: `fromRedis`
 * runs when `REDIS_URL` is set and the epoch is current; `fromPostgres` runs when hot
 * state is off, while another instance rebuilds it, or when Redis or the rebuild fails.
 */
export async function readHotState<T>(
  db: Database,
  fromRedis: (redis: Redis) => Promise<T>,
  fromPostgres: () => Promise<T>,
): Promise<T> {
  if (!hotStateEnabled()) return fromPostgres();
  let value: { result: T } | undefined;
  try {
    const redis = getRedis();
    if (await ensureHotStateEpoch(redis, db)) value = { result: await fromRedis(redis) };
  } catch (error) {
    console.warn("hot-state: falling back to Postgres", error);
  }
  return value ? value.result : fromPostgres();
}

/**
 * Applies a writer's change to Redis after its Postgres commit. A no-op with hot state
 * off; on a Redis error, deletes the epoch (best effort) so readers rebuild from
 * Postgres rather than trust a key that missed the change.
 */
export async function writeHotState(update: (redis: Redis) => Promise<unknown>): Promise<void> {
  if (!hotStateEnabled()) return;
  const redis = getRedis();
  try {
    await update(redis);
  } catch (error) {
    console.warn("hot-state: write failed, forcing a rebuild", error);
    await redis.del(EPOCH_KEY).catch(() => undefined);
  }
}
