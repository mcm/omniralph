import "server-only";
import { onCommittedChange, type RecordedChange } from "@omniralph/db/changes";
import { getRedis, hotStateEnabled } from "@/lib/hot-state";
import type { OrganizationBacklog } from "./backlog";

/**
 * The Backlog cache: each organization's routed, grouped items (`OrganizationBacklog`), read
 * by the list, its counts and Up next alike, so they cost one tracker read per fill. Kept in
 * Redis (hot state) when `REDIS_URL` is set, else in this instance's memory, for at most
 * `BACKLOG_CACHE_TTL_MS`.
 *
 * An entry is dropped as soon as a change that may alter it is committed (`onCommittedChange`,
 * `affectsBacklog`): a `work_item` change (an action, a tracker webhook, a run or triage of
 * an item, a repo choice), a repository connected, disconnected or saved (Coding, its work
 * item match), a tracker connection's change (its state mapping or fix labels) or a routing rules save.
 * A rolled-back write commits no change, so it drops nothing.
 */

export const BACKLOG_CACHE_TTL_MS = 5 * 60_000;

const entryKey = (organizationId: string) => `backlog:${organizationId}`;
/** Bumped on every drop, so a fill that started before it doesn't store what it read. */
const generationKey = (organizationId: string) => `backlog:${organizationId}:generation`;

/** Settings sections whose save changes which items route where. */
const ROUTING_SECTIONS = new Set(["routing_rules", "repository.coding", "connection"]);

/** Whether a committed change may change an organization's Backlog. */
export function affectsBacklog(change: Pick<RecordedChange, "resource" | "section">): boolean {
  switch (change.resource) {
    case "work_item":
    case "repository":
    case "connection":
      return true;
    case "settings":
      return change.section !== undefined && ROUTING_SECTIONS.has(change.section);
    default:
      return false;
  }
}

const memory = new Map<string, { value: OrganizationBacklog; expiresAt: number }>();
const generations = new Map<string, number>();
/** Fills in progress on this instance, so concurrent reads share one. */
const filling = new Map<string, { generation: number; promise: Promise<OrganizationBacklog> }>();

const localGeneration = (organizationId: string) => generations.get(organizationId) ?? 0;

async function readRedis(organizationId: string): Promise<{
  value: OrganizationBacklog | null;
  generation: string | null;
}> {
  const [value, generation] = await getRedis().mget(
    entryKey(organizationId),
    generationKey(organizationId),
  );
  return {
    value: value ? (JSON.parse(value) as OrganizationBacklog) : null,
    generation: generation ?? null,
  };
}

/**
 * The organization's Backlog from the cache, else `load`'s (stored unless the cache was
 * dropped meanwhile). A failed `load` isn't stored. Redis failing falls back to `load`.
 */
export async function cachedBacklog(
  organizationId: string,
  load: () => Promise<OrganizationBacklog>,
): Promise<OrganizationBacklog> {
  let redisGeneration: string | null | undefined;
  if (hotStateEnabled()) {
    try {
      const cached = await readRedis(organizationId);
      if (cached.value) return cached.value;
      redisGeneration = cached.generation;
    } catch (error) {
      console.warn("backlog cache: Redis failed, reading the tracker", error);
    }
  } else {
    const cached = memory.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    memory.delete(organizationId);
  }

  const generation = localGeneration(organizationId);
  const current = filling.get(organizationId);
  if (current && current.generation === generation) return current.promise;
  const promise = load().then(async (value) => {
    if (localGeneration(organizationId) !== generation) return value;
    if (redisGeneration !== undefined) {
      try {
        const redis = getRedis();
        // Dropped on another instance while this one read: don't store a stale list.
        if ((await redis.get(generationKey(organizationId))) === redisGeneration) {
          await redis.set(
            entryKey(organizationId),
            JSON.stringify(value),
            "PX",
            BACKLOG_CACHE_TTL_MS,
          );
        }
      } catch (error) {
        console.warn("backlog cache: storing in Redis failed", error);
      }
    } else if (!hotStateEnabled()) {
      memory.set(organizationId, { value, expiresAt: Date.now() + BACKLOG_CACHE_TTL_MS });
    }
    return value;
  });
  filling.set(organizationId, { generation, promise });
  const clear = () => {
    if (filling.get(organizationId)?.promise === promise) filling.delete(organizationId);
  };
  promise.then(clear, clear);
  return promise;
}

/**
 * Drops the organization's cached Backlog (its next read recomputes it). Redis is updated in
 * the background; the returned promise settles when it is (never rejects).
 */
export function dropBacklogCache(organizationId: string): Promise<void> {
  generations.set(organizationId, localGeneration(organizationId) + 1);
  memory.delete(organizationId);
  filling.delete(organizationId);
  if (!hotStateEnabled()) return Promise.resolve();
  try {
    return getRedis()
      .multi()
      .incr(generationKey(organizationId))
      .pexpire(generationKey(organizationId), BACKLOG_CACHE_TTL_MS * 2)
      .del(entryKey(organizationId))
      .exec()
      .then(
        () => undefined,
        (error: unknown) => console.warn("backlog cache: dropping in Redis failed", error),
      );
  } catch (error) {
    console.warn("backlog cache: dropping in Redis failed", error);
    return Promise.resolve();
  }
}

/** Whether this instance holds the organization's Backlog in memory (tests). */
export function hasCachedBacklog(organizationId: string): boolean {
  const cached = memory.get(organizationId);
  return !!cached && cached.expiresAt > Date.now();
}

/** Forgets every entry this instance holds (tests). */
export function resetBacklogCache(): void {
  memory.clear();
  generations.clear();
  filling.clear();
}

onCommittedChange((change) => {
  if (affectsBacklog(change)) void dropBacklogCache(change.organizationId);
});
