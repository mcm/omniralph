import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hasRalphWork, ralphWorkFingerprint, type Database } from "@omniralph/db";
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
 *
 * `ralph:backoff` spaces out the passes while ralph work exists but nothing changes:
 * `{interval}|{due}|{fingerprint}`. After each pass the interval doubles from 10 minutes
 * up to an hour when the pass left the work's fingerprint (`ralphWorkFingerprint`) as the
 * previous pass did and nobody marked ralph work meanwhile; otherwise it's back to 10
 * minutes. Until it's due, the cron returns without querying Postgres. A write from
 * outside the cron (`markRalphActive`: webhooks, UI actions, job outcomes, run creation)
 * deletes it, so the next invocation runs; the cron's own `advanceRun` calls run inside
 * `runReconcilePass` and leave it (and the marker's value) alone. Lost (a flush, a
 * rebuild): the next invocation runs and starts again at 10 minutes.
 */

const ACTIVE_KEY = "ralph:active";
const RECONCILED_KEY = "ralph:reconciled";
const BACKOFF_KEY = "ralph:backoff";
/** Longest the cron goes without a full run. */
const FULL_RUN_INTERVAL_SECONDS = 24 * 60 * 60;
/** The cron's schedule (`vercel.json`): the interval after a pass that changed something. */
export const RECONCILE_BASE_INTERVAL_MS = 10 * 60_000;
/** The longest interval between passes while ralph work exists. */
export const RECONCILE_MAX_INTERVAL_MS = 60 * 60_000;
/** Taken off each interval, so an invocation a little early on the schedule still runs. */
const RECONCILE_SLACK_MS = 5 * 60_000;

const COMPARE_AND_DELETE = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

/**
 * KEYS: marker, backoff. ARGV: the marker the pass read ("" for none), the fingerprint
 * after the pass, the pass's start (ms), base, max, slack, TTL (ms). Doubles the interval
 * when the marker and fingerprint are unchanged, else starts again at the base; returns it.
 */
const BACK_OFF = `
local interval = tonumber(ARGV[4])
local previous = redis.call("GET", KEYS[2])
if previous and redis.call("GET", KEYS[1]) == ARGV[1] then
  local last, fingerprint = string.match(previous, "^(%d+)|%d+|(.*)$")
  if last and fingerprint == ARGV[2] then
    interval = math.min(tonumber(last) * 2, tonumber(ARGV[5]))
  end
end
local due = tonumber(ARGV[3]) + interval - tonumber(ARGV[6])
redis.call("SET", KEYS[2], string.format("%d|%d|%s", interval, due, ARGV[2]), "PX", ARGV[7])
return interval`;

/** Set while the reconcile cron's own pass runs (`runReconcilePass`). */
const reconcilePass = new AsyncLocalStorage<true>();

/**
 * Runs the reconcile cron's pass: `markRalphActive` calls inside it (its own
 * `advanceRun`s) aren't changes from outside, so they don't reset the backoff.
 */
export function runReconcilePass<T>(pass: () => Promise<T>): Promise<T> {
  return reconcilePass.run(true, pass);
}

/**
 * Marks ralph work to reconcile; call after the Postgres commit. From outside the cron's
 * pass, it's a change: the next cron invocation runs and the backoff starts again.
 */
export async function markRalphActive(): Promise<void> {
  if (reconcilePass.getStore()) {
    // The cron's own pass: keep a marker, but only what the pass changed counts.
    await writeHotState((redis) => redis.set(ACTIVE_KEY, randomUUID(), "NX"));
    return;
  }
  await writeHotState(async (redis) => {
    const results = await redis.multi().set(ACTIVE_KEY, randomUUID()).del(BACKOFF_KEY).exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
  });
}

export interface RalphReconcileCheck {
  /** Whether the cron should run. */
  run: boolean;
  /** The marker's value when read, for `finishRalphReconcile`. */
  marker: string | null;
  /** When the check ran (ms): the backoff's next interval starts from it. */
  at: number;
}

/** When the backoff (`{interval}|{due}|{fingerprint}`) lets the next pass run, if it's readable. */
function backoffDue(backoff: string | null): number | null {
  const due = backoff?.split("|")[1];
  return due && /^\d+$/.test(due) ? Number(due) : null;
}

/**
 * Whether the reconcile cron has anything to do: the last full run is a day old, the
 * marker is set and the backoff is due (or missing), or Redis can't tell (hot state off,
 * a rebuild elsewhere, Redis down).
 */
export async function checkRalphReconcile(
  db: Database,
  now = new Date(),
): Promise<RalphReconcileCheck> {
  const at = now.getTime();
  return readHotState(
    db,
    async (redis) => {
      const [marker, reconciled, backoff] = await redis.mget(
        ACTIVE_KEY,
        RECONCILED_KEY,
        BACKOFF_KEY,
      );
      const due = backoffDue(backoff ?? null);
      const run = reconciled === null || (marker !== null && (due === null || due <= at));
      return { run, marker: marker ?? null, at };
    },
    async () => ({ run: true, marker: null, at }),
  );
}

/**
 * Records a full run. With ralph work left, sets the marker when a forced run found
 * some and schedules the next pass (the backoff); without, clears the marker (when it
 * still holds the value `check` read) and the backoff.
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
      const fingerprint = await ralphWorkFingerprint(db);
      await redis.eval(
        BACK_OFF,
        2,
        ACTIVE_KEY,
        BACKOFF_KEY,
        check.marker ?? "",
        fingerprint,
        check.at,
        RECONCILE_BASE_INTERVAL_MS,
        RECONCILE_MAX_INTERVAL_MS,
        RECONCILE_SLACK_MS,
        FULL_RUN_INTERVAL_SECONDS * 1000,
      );
    } else {
      if (check.marker !== null) await redis.eval(COMPARE_AND_DELETE, 1, ACTIVE_KEY, check.marker);
      await redis.del(BACKOFF_KEY);
    }
  } catch (error) {
    console.warn("hot-state: recording the ralph reconcile failed", error);
  }
}

// A flushed Redis may have lost a marker: the next cron runs and decides again.
registerHotStateRebuilder("ralph-active", async (redis) => {
  const results = await redis.multi().set(ACTIVE_KEY, randomUUID()).del(BACKOFF_KEY).exec();
  if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
});
