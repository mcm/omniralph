import "server-only";
import { randomUUID } from "node:crypto";
import { hasRalphWork, type Database } from "@omniralph/db";
import {
  getRedis,
  hotStateEnabled,
  readHotState,
  registerHotStateRebuilder,
  writeHotState,
} from "@/lib/hot-state";
import "@/lib/hot-state/rebuilders";

/**
 * The reconcile cron's idle check. `ralph:active` (a fresh random value on every write)
 * is set after every commit that creates or advances a run (`advanceRun`, which also
 * opens PRs/MRs, and run creation): while it's absent, the cron returns without querying
 * Postgres. The cron clears it only after a run that found nothing to do anywhere
 * (`hasRalphWork`), and only if nobody set it since it read it (compare-and-delete), so
 * a writer committing during the run is never lost.
 *
 * `ralph:reconciled` (24h TTL) records the last full run: once it's gone, the cron runs
 * regardless of the marker.
 */

const ACTIVE_KEY = "ralph:active";
const RECONCILED_KEY = "ralph:reconciled";
/** Longest the cron goes without a full run. */
const FULL_RUN_INTERVAL_SECONDS = 24 * 60 * 60;

const COMPARE_AND_DELETE = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

/** Marks ralph work to reconcile; call after the Postgres commit. */
export async function markRalphActive(): Promise<void> {
  await writeHotState((redis) => redis.set(ACTIVE_KEY, randomUUID()));
}

export interface RalphReconcileCheck {
  /** Whether the cron should run. */
  run: boolean;
  /** The marker's value when read, for `finishRalphReconcile`. */
  marker: string | null;
}

/**
 * Whether the reconcile cron has anything to do: the marker is set, the last full run is
 * a day old, or Redis can't tell (hot state off, a rebuild elsewhere, Redis down).
 */
export async function checkRalphReconcile(db: Database): Promise<RalphReconcileCheck> {
  return readHotState(
    db,
    async (redis) => {
      const [marker, reconciled] = await redis.mget(ACTIVE_KEY, RECONCILED_KEY);
      return { run: marker !== null || reconciled === null, marker: marker ?? null };
    },
    async () => ({ run: true, marker: null }),
  );
}

/**
 * Records a full run, then clears the marker when there's no ralph work left (and it
 * still holds the value `check` read), or sets it when a forced run found some.
 */
export async function finishRalphReconcile(
  db: Database,
  check: RalphReconcileCheck,
  now = new Date(),
): Promise<void> {
  if (!hotStateEnabled()) return;
  try {
    const redis = getRedis();
    await redis.set(RECONCILED_KEY, String(now.getTime()), "EX", FULL_RUN_INTERVAL_SECONDS);
    if (await hasRalphWork(db)) {
      if (check.marker === null) await redis.set(ACTIVE_KEY, randomUUID(), "NX");
    } else if (check.marker !== null) {
      await redis.eval(COMPARE_AND_DELETE, 1, ACTIVE_KEY, check.marker);
    }
  } catch (error) {
    console.warn("hot-state: recording the ralph reconcile failed", error);
  }
}

// A flushed Redis may have lost a marker: the next cron runs and decides again.
registerHotStateRebuilder("ralph-active", async (redis) => {
  await redis.set(ACTIVE_KEY, randomUUID());
});
