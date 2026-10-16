import "server-only";
import { randomUUID } from "node:crypto";
import { hasPendingRunEvents, type Database } from "@omniralph/db";
import {
  getRedis,
  hotStateEnabled,
  readHotState,
  registerHotStateRebuilder,
  writeHotState,
} from "@/lib/hot-state";
import "@/lib/hot-state/rebuilders";

/**
 * The `chat-run-events` cron's idle check. `chat-run-events:pending` (a fresh random value
 * on every write) is set after every commit that records a run event
 * (`recordChatRunEvent`): while it's absent, the cron returns without querying Postgres or
 * initialising the chat bot. The cron clears it only after a run that left no run event
 * pending (`hasPendingRunEvents`, however recent), and only if nobody set it since it read
 * it (compare-and-delete), so an event recorded during the run is never lost.
 */

const PENDING_KEY = "chat-run-events:pending";
/** Failed turns after which an event is left alone (the cron stops retrying it). */
export const MAX_WAKE_ATTEMPTS = 5;

const COMPARE_AND_DELETE = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

/** Marks run events to relay; call after the Postgres commit. */
export async function markRunEventsPending(): Promise<void> {
  await writeHotState((redis) => redis.set(PENDING_KEY, randomUUID()));
}

export interface PendingRunEventsCheck {
  /** Whether the cron should run. */
  run: boolean;
  /** The marker's value when read, for `finishPendingRunEvents`. */
  marker: string | null;
}

/**
 * Whether the cron has anything to do: the marker is set, or Redis can't tell (hot state
 * off, a rebuild elsewhere, Redis down).
 */
export async function checkPendingRunEvents(db: Database): Promise<PendingRunEventsCheck> {
  return readHotState(
    db,
    async (redis) => {
      const marker = await redis.get(PENDING_KEY);
      return { run: marker !== null, marker };
    },
    async () => ({ run: true, marker: null }),
  );
}

/**
 * Clears the marker when no run event is left pending, and it still holds the value
 * `check` read.
 */
export async function finishPendingRunEvents(
  db: Database,
  check: PendingRunEventsCheck,
): Promise<void> {
  if (!hotStateEnabled() || check.marker === null) return;
  try {
    if (await hasPendingRunEvents(db, { maxAttempts: MAX_WAKE_ATTEMPTS })) return;
    await getRedis().eval(COMPARE_AND_DELETE, 1, PENDING_KEY, check.marker);
  } catch (error) {
    console.warn("hot-state: clearing the pending chat run events marker failed", error);
  }
}

// A flushed Redis may have lost a marker: the next cron runs and decides again.
registerHotStateRebuilder("chat-run-events-pending", async (redis) => {
  await redis.set(PENDING_KEY, randomUUID());
});
