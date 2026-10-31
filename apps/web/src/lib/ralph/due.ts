import "server-only";
import {
  getLane,
  listLaneCleanups,
  listUnfinishedRunIds,
  type Database,
  type Job,
  type RalphLane,
  type RalphRun,
} from "@omniralph/db";
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
 * some, or when the full pass is due. `lane:<id>` members check a lane's cleanup: a failed
 * one is retried, a kept branch nobody answered about is deleted at its deadline. A lane
 * with an open PR/MR has none: webhooks follow it, and the daily full pass is the fallback.
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
 * And a lane's (`laneDueAt`):
 * - A cleanup job's completion, failure or cancel schedules the lane's safety check before
 *   it commits (`scheduleJobOutcomeCheck`); applying its outcome replaces it.
 * - Recording a PR/MR closed or merged (`recordClosedPullRequest`) schedules the safety
 *   check before the write, and replaces it once the cleanup started.
 * - The cron reschedules each lane it checked (`scheduleCheckedLane`).
 *
 * `ralph:reconciled` (24h TTL) records the last full pass: once it's gone, the cron runs
 * every organization's runs, cleanup and CI. Lost (a flush): the `ralph-due` rebuilder
 * schedules every unfinished run now, every lane with a kept-branch question at its
 * deadline, and every failed or pending cleanup now.
 */

const DUE_KEY = "ralph:due";
const RECONCILED_KEY = "ralph:reconciled";
const RUN_PREFIX = "run:";
const LANE_PREFIX = "lane:";
/** The dedupe key prefix of a lane's cleanup jobs (`cleanupDedupeKey`), followed by its ID. */
export const CLEANUP_DEDUPE_PREFIX = "ralph-cleanup:";
/** Longest the cron goes without a full pass. */
const FULL_PASS_INTERVAL_SECONDS = 24 * 60 * 60;
/** When a write that leaves follow-up work is checked again if nothing replaces its entry. */
export const RALPH_SAFETY_MS = 10 * 60_000;
/** How often a run waiting on a blocker or a person is re-checked, for a missed webhook. */
export const RALPH_WAITING_MS = 60 * 60_000;
/** How long a pending or running run without a job may sit before the cron advances it. */
export const RECONCILE_STALE_MS = 10 * 60_000;
/** When a cleanup that failed, or that the cron couldn't carry out, is tried again. */
export const RALPH_RETRY_MS = 60 * 60_000;

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

function laneMember(laneId: string): string {
  return `${LANE_PREFIX}${laneId}`;
}

/** Schedules the lane's check at `at` (ms), or removes it (null). */
export async function scheduleLane(laneId: string, at: number | null): Promise<void> {
  await writeHotState((redis) =>
    at === null
      ? redis.zrem(DUE_KEY, laneMember(laneId))
      : redis.zadd(DUE_KEY, at, laneMember(laneId)),
  );
}

/** Schedules the lane's safety check before a write that leaves cleanup work. */
export function scheduleLaneSafetyCheck(laneId: string, now = Date.now()): Promise<void> {
  return scheduleLane(laneId, now + RALPH_SAFETY_MS);
}

/**
 * When a lane's cleanup is checked next (ms), or null for never: a cleanup job in flight is
 * its own event (its outcome is applied), so is a pending one (the run's job it waits for);
 * a failed one is retried after `RALPH_RETRY_MS`; a kept-branch question is due at its
 * deadline. A done cleanup with only stash questions (no timeout) needs nothing, nor does a
 * lane without one (its PR/MR's webhooks start it).
 */
export function laneDueAt(lane: Pick<RalphLane, "cleanup">, now = Date.now()): number | null {
  const cleanup = lane.cleanup;
  if (!cleanup || cleanup.jobId || cleanup.status === "pending") return null;
  if (cleanup.status === "failed") return now + RALPH_RETRY_MS;
  const branch = cleanup.questions.find((q) => q.kind === "branch");
  return branch?.kind === "branch" ? Date.parse(branch.deadline) : null;
}

/**
 * Reschedules a lane the cron just checked from its state: what's still due right away
 * (a deadline the cron couldn't act on) is tried again after `RALPH_RETRY_MS`.
 */
export function scheduleCheckedLane(
  lane: Pick<RalphLane, "id" | "cleanup">,
  now = Date.now(),
): Promise<void> {
  const at = laneDueAt(lane, now);
  return scheduleLane(lane.id, at !== null && at <= now ? now + RALPH_RETRY_MS : at);
}

/** Replaces the lane's safety check with its schedule, from its current state. */
export async function rescheduleLane(db: Database, laneId: string): Promise<void> {
  const lane = await getLane(db, laneId);
  await scheduleLane(laneId, lane && laneDueAt(lane));
}

/** The lane a cleanup job works on (from its dedupe key), or null for any other job. */
export function cleanupJobLaneId(job: Partial<Pick<Job, "dedupeKey">>): string | null {
  return job.dedupeKey?.startsWith(CLEANUP_DEDUPE_PREFIX)
    ? job.dedupeKey.slice(CLEANUP_DEDUPE_PREFIX.length)
    : null;
}

/**
 * A job is about to complete, fail or be canceled: when it's a ralph job, schedules its
 * run's safety check first, so the run is advanced even if the outcome hook never runs;
 * a lane's cleanup job also schedules the lane's, so its outcome is applied.
 */
export async function scheduleJobOutcomeCheck(
  job: (Pick<Job, "ralphRunId"> & Partial<Pick<Job, "dedupeKey">>) | null | undefined,
): Promise<void> {
  if (!job?.ralphRunId) return;
  await scheduleRunSafetyCheck(job.ralphRunId);
  const laneId = cleanupJobLaneId(job);
  if (laneId) await scheduleLaneSafetyCheck(laneId);
}

export interface RalphReconcileCheck {
  /** Whether the cron runs every organization's runs, cleanup and CI. */
  fullPass: boolean;
  /** The runs due by `ralph:due` (empty when Redis can't tell). */
  dueRunIds: string[];
  /** The lanes due by `ralph:due` (empty when Redis can't tell). */
  dueLaneIds: string[];
}

function membersWith(members: readonly string[], prefix: string): string[] {
  return members.filter((m) => m.startsWith(prefix)).map((m) => m.slice(prefix.length));
}

/**
 * What the reconcile cron has to do: the runs and lanes due, and whether the full pass is due (the
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
      return {
        fullPass: reconciled === 0,
        dueRunIds: membersWith(members, RUN_PREFIX),
        dueLaneIds: membersWith(members, LANE_PREFIX),
      };
    },
    async () => ({ fullPass: true, dueRunIds: [], dueLaneIds: [] }),
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

// A flushed Redis lost the schedule: every unfinished run is due now, a kept-branch
// question at its deadline, a failed or pending cleanup now.
registerHotStateRebuilder("ralph-due", async (redis, db) => {
  const now = Date.now();
  const multi = redis.multi().del(DUE_KEY);
  for (const runId of await listUnfinishedRunIds(db)) multi.zadd(DUE_KEY, now, runMember(runId));
  for (const lane of await listLaneCleanups(db)) {
    const cleanup = lane.cleanup!;
    const branch = cleanup.questions.find((q) => q.kind === "branch");
    const at =
      cleanup.status === "pending" || cleanup.status === "failed"
        ? now
        : branch?.kind === "branch"
          ? Date.parse(branch.deadline)
          : null;
    if (at !== null) multi.zadd(DUE_KEY, at, laneMember(lane.id));
  }
  const results = await multi.exec();
  if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
});
