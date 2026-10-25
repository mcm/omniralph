/**
 * What a user may do with a run: which retry targets (`POST /api/ui/runs/{id}/retry`) and
 * whether Stop (`POST /api/ui/runs/{id}/stop`) apply. Pure, so the run detail's `actions`
 * and the action endpoints decide the same way.
 */
import type { RunKind, RunStatus } from "@omniralph/db";
import { RALPH_REQUEST_JOB_TYPE } from "@omniralph/shared";
import type { RunActions } from "@/lib/api/runs";
import { hasRole, type Role } from "@/lib/auth/roles";

/** The role each run action needs in the run's organization. */
export const RUN_ACTION_ROLES = { retry: "member", stop: "member" } as const satisfies Record<
  string,
  Role
>;

/** A run that is retried as a whole from these statuses. */
export const RETRYABLE_RUN_STATUSES = [
  "failed",
  "stopped",
  "waiting",
] as const satisfies readonly RunStatus[];

/** An attempt that is retried from these statuses. */
export const RETRYABLE_ATTEMPT_STATUSES = ["failed", "canceled", "expired"] as const;

/** Runs that Stop applies to, while they haven't finished. */
const STOPPABLE_KINDS: readonly RunKind[] = ["epic", "request"];
const UNFINISHED: readonly RunStatus[] = ["queued", "running", "waiting"];

export interface RunActionStory {
  id: string;
  status: string;
  /** Its lane's PR/MR, when it has one. */
  pullRequest: { merged: boolean; closed: boolean } | null;
}

export interface RunActionAttempt {
  id: string;
  type: string;
  status: string;
  /** The step it belongs to (null: outside the steps). */
  step: string | null;
}

/** Story statuses a story is retried from (a finished epic re-runs only completed ones). */
const RETRYABLE_STORY_STATUSES = ["pending", "blocked", "exhausted", "completed"];

/**
 * Whether a story of an epic in `runStatus` can be retried: the epic stopped, failed, waits
 * or (to re-run one story) completed; the story isn't running, manual or canceled; and its
 * PR/MR is still open.
 */
export function storyRetryable(runStatus: RunStatus, story: RunActionStory): boolean {
  if (story.pullRequest?.merged || story.pullRequest?.closed) return false;
  if (runStatus === "completed") return story.status === "completed";
  return (
    (RETRYABLE_RUN_STATUSES as readonly string[]).includes(runStatus) &&
    RETRYABLE_STORY_STATUSES.includes(story.status)
  );
}

/** Whether a request run's newest `ralph.request` attempt failed, was canceled or expired. */
export function lastRequestAttemptRetryable(attempts: readonly RunActionAttempt[]): boolean {
  const last = attempts.find((a) => a.type === RALPH_REQUEST_JOB_TYPE);
  return !!last && (RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(last.status);
}

/**
 * The actions open to a user with `role` in the run's organization. An attempt is retried
 * when it failed, was canceled or expired, is the newest of its kind in its step (a later
 * one replaced it otherwise), and the run isn't busy (queued or running) or a completed
 * epic (which re-runs a story instead). A request run is retried as a whole also when its
 * newest request attempt didn't succeed (the run itself completes with the error).
 */
export function runActions(
  run: { kind: RunKind; status: RunStatus },
  role: Role,
  { stories = [], attempts = [] }: { stories?: RunActionStory[]; attempts?: RunActionAttempt[] },
): RunActions {
  const canRetry = hasRole({ role }, RUN_ACTION_ROLES.retry);
  const stop =
    hasRole({ role }, RUN_ACTION_ROLES.stop) &&
    STOPPABLE_KINDS.includes(run.kind) &&
    UNFINISHED.includes(run.status);
  if (!canRetry) return { stop, retry: { run: false, storyIds: [], attemptIds: [] } };

  const busy = run.status === "queued" || run.status === "running";
  const completedEpic = run.kind === "epic" && run.status === "completed";
  // Attempts come newest first: the first of each (step, type) is the newest.
  const newest = new Set<string>();
  const seen = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.step ?? ""}\u0000${attempt.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    newest.add(attempt.id);
  }
  return {
    stop,
    retry: {
      run:
        (RETRYABLE_RUN_STATUSES as readonly string[]).includes(run.status) ||
        (run.kind === "request" && !busy && lastRequestAttemptRetryable(attempts)),
      storyIds:
        run.kind === "epic"
          ? stories.filter((s) => storyRetryable(run.status, s)).map((s) => s.id)
          : [],
      attemptIds:
        busy || completedEpic
          ? []
          : attempts
              .filter(
                (a) =>
                  newest.has(a.id) &&
                  (RETRYABLE_ATTEMPT_STATUSES as readonly string[]).includes(a.status),
              )
              .map((a) => a.id),
    },
  };
}
