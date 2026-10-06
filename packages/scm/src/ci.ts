/**
 * CI results of a PR/MR's head commit (GitHub Actions workflow runs, GitLab
 * pipelines), ported from cyralph's `src/git/ci.ts`. The ralph CI-fix loop
 * hands the failed jobs and the tails of their logs to a request session.
 */

/** Only this much of the end of a job log is kept. */
export const MAX_CI_LOG_CHARS = 4000;

/** A failed CI job of the head commit. */
export interface CiFailedJob {
  /** Job ID on the code host (`getCiJobLog`); the run/pipeline ID when `noLog`. */
  id: string;
  name: string;
  url: string | null;
  /**
   * The entry is the run or pipeline itself, which has no log of its own (a
   * GitHub workflow that failed to start, a failed GitLab downstream pipeline).
   */
  noLog: boolean;
}

/**
 * CI state of the head commit. `none`: no CI for it (yet), or it was
 * canceled/skipped/manual; `pending`: queued or running.
 */
export type CiState = "none" | "pending" | "passed" | "failed";

export interface CiStatus {
  state: CiState;
  headSha: string;
  /** Empty unless `state` is `failed`. */
  failedJobs: CiFailedJob[];
}

/** Open/closed/merged state of a PR/MR, without its CI. */
export interface ChangeRequestStatus {
  state: "open" | "merged" | "closed";
  headSha: string;
  /** The merge (or squash) commit, once merged; `null` otherwise or when unknown. */
  mergeSha: string | null;
}

/** Strips ANSI colours and GitLab's collapsible-section markers from a job log. */
export function cleanCiLog(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- ANSI escape sequences
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/section_(start|end):\d+:[^\r\n]*?\r/g, "")
      .replace(/\r\n?/g, "\n")
  );
}

/** The cleaned log, cut to its last {@link MAX_CI_LOG_CHARS} chars (prefixed with "…"). */
export function ciLogTail(text: string): string {
  const log = cleanCiLog(text);
  return log.length > MAX_CI_LOG_CHARS ? `…${log.slice(-MAX_CI_LOG_CHARS)}` : log;
}
