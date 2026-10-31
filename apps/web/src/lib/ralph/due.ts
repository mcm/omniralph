import "server-only";
import { listUnfinishedRunIds, type Database, type Job, type RalphRun } from "@omniralph/db";
import {
  getRedis,
  hotStateEnabled,
  readHotState,
  registerHotStateRebuilder,
  writeHotState,
} from "@/lib/hot-state";
import "@/lib/hot-state/rebuilders";
import type { AdvanceResult } from "./run";

/**
 * The reconcile cron's schedule. `ralph:due` is a sorted set of the ralph work the cron
 * checks next, scored by when it's due (ms): `run:<id>` members advance a run. The cron
 * reads the entries due (`checkRalphReconcile`) and touches Postgres only when there are
 * some, or when the full pass is due.
 *
 * Who writes a run's entry (`writeHotState`, so a failed write forces a rebuild):
 * - `advanceRun` schedules a safety check (`RALPH_SAFETY_MS`) before it starts and
 *   replaces it from its result after (`runDueAt`). A throw (or Vercel killing the
 *   function) leaves the safety check, so a failed advance is retried.
 * - Run creation (`start.ts`, `chat-start.ts`) schedules the safety check before its
 *   commit, then advances the run or schedules it by its status (`scheduleRunByStatus`).
 * - A ralph job's completion, failure or cancel schedules the safety check before it
 *   commits (`scheduleJobOutcomeCheck`): the outcome hook's advance replaces it.
 *
 * `ralph:reconciled` (24h TTL) records the last full pass: once it's gone, the cron runs
 * every organization's runs, cleanup and CI. Lost (a flush): the `ralph-due` rebuilder
 * schedules every unfinished run now.
 */

const DUE_KEY = "ralph:due";
const RECONCILED_KEY = "ralph:reconciled";
const RUN_PREFIX = "run:";
/** Longest the cron goes without a full pass. */
const FULL_PASS_INTERVAL_SECONDS = 24 * 60 * 60;
/** When a write that leaves follow-up work is checked again if nothing replaces its entry. */
export const RALPH_SAFETY_MS = 10 * 60_000;
/** How often a run waiting on a blocker or a person is re-checked, for a missed webhook. */
export const RALPH_WAITING_MS = 60 * 60_000;
/** How long a pending or running run without a job may sit before the cron advances it. */
export const RECONCILE_STALE_MS = 10 * 60_000;

function runMember(runId: string): string {
  return `${RUN_PREFIX}${runId}`;
}

/** Schedules the run's check at `at` (ms), or removes it (null); call around the Postgres commit. */
export async function scheduleRun(runId: string, at: number | null): Promise<void> {
  await writeHotState((redis) =>
    at === null ? redis.zrem(DUE_KEY, runMember(runId)) : redis.zadd(DUE_KEY, at, runMember(runId)),
  );
}

/** Schedules the safety check of a write that leaves follow-up work; call before its commit. */
export function scheduleRunSafetyCheck(runId: string, now = Date.now()): Promise<void> {
  return scheduleRun(runId, now + RALPH_SAFETY_MS);
}

/**
 * When a run that advanced to `result` is checked next (ms), or null for never: a job in
 * flight is its own event (its outcome advances the run), a finished or gone run needs
 * nothing, a waiting one is re-checked hourly, a pending or running one without a job
 * after `RECONCILE_STALE_MS`.
 */
export function runDueAt(result: AdvanceResult, now = Date.now()): number | null {
  switch (result.action) {
    case "gone":
    case "finished":
    case "completed":
    case "failed":
    case "busy":
    case "enqueued":
    case "pushing":
    case "describing":
    case "preparing":
    case "requesting":
      return null;
    case "waiting":
      return runStatusDueAt(result.run, now);
  }
}

/** When a run with no job in flight is checked next, by its status (ms), or null. */
function runStatusDueAt(run: Pick<RalphRun, "status">, now: number): number | null {
  switch (run.status) {
    case "waiting":
      return now + RALPH_WAITING_MS;
    case "pending":
    case "running":
      return now + RECONCILE_STALE_MS;
    default:
      return null;
  }
}

/** Replaces the run's safety check with its schedule after `advanceRun`. */
export function scheduleAdvancedRun(runId: string, result: AdvanceResult): Promise<void> {
  return scheduleRun(runId, runDueAt(result));
}

/** Schedules a run nothing advanced (e.g. one just created to ask a person) by its status. */
export function scheduleRunByStatus(run: Pick<RalphRun, "id" | "status">): Promise<void> {
  return scheduleRun(run.id, runStatusDueAt(run, Date.now()));
}

/**
 * A job is about to complete, fail or be canceled: when it's a ralph job, schedules its
 * run's safety check first, so the run is advanced even if the outcome hook never runs.
 */
export async function scheduleJobOutcomeCheck(
  job: Pick<Job, "ralphRunId"> | null | undefined,
): Promise<void> {
  if (job?.ralphRunId) await scheduleRunSafetyCheck(job.ralphRunId);
}

export interface RalphReconcileCheck {
  /** Whether the cron runs every organization's runs, cleanup and CI. */
  fullPass: boolean;
  /** The runs due by `ralph:due` (empty when Redis can't tell). */
  dueRunIds: string[];
}

/**
 * What the reconcile cron has to do: the runs due, and whether the full pass is due (the
 * last one is a day old, or Redis can't tell: hot state off, a rebuild elsewhere, Redis
 * down). Queries Postgres only when Redis can't tell.
 */
export async function checkRalphReconcile(
  db: Database,
  now = new Date(),
): Promise<RalphReconcileCheck> {
  return readHotState(
    db,
    async (redis) => {
      const [members, reconciled] = await Promise.all([
        redis.zrangebyscore(DUE_KEY, "-inf", now.getTime()),
        redis.exists(RECONCILED_KEY),
      ]);
      const dueRunIds = members
        .filter((member) => member.startsWith(RUN_PREFIX))
        .map((member) => member.slice(RUN_PREFIX.length));
      return { fullPass: reconciled === 0, dueRunIds };
    },
    async () => ({ fullPass: true, dueRunIds: [] }),
  );
}

/** Records a full pass: the next one is due in a day. */
export async function finishRalphFullPass(now = new Date()): Promise<void> {
  if (!hotStateEnabled()) return;
  try {
    await getRedis().set(RECONCILED_KEY, String(now.getTime()), "EX", FULL_PASS_INTERVAL_SECONDS);
  } catch (error) {
    console.warn("hot-state: recording the ralph full pass failed", error);
  }
}

// A flushed Redis lost the schedule: every unfinished run is due now.
registerHotStateRebuilder("ralph-due", async (redis, db) => {
  const now = Date.now();
  const multi = redis.multi().del(DUE_KEY);
  for (const runId of await listUnfinishedRunIds(db)) multi.zadd(DUE_KEY, now, runMember(runId));
  const results = await multi.exec();
  if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
});
