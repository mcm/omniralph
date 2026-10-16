import { INSTALL_JOB_TYPE, REPO_SYNC_JOB_TYPE, REVIEW_TASK_JOB_TYPE } from "@omniralph/shared";
import { reviewIdOfJob } from "@/lib/review/job-review";

/**
 * How a failed job is rerun from the Jobs page: `review` re-runs its review on the PR's
 * current head (as the review's Re-run does), `copy` dispatches the same job again (a system
 * RPC to its harness, with no other state behind it). Null: the job can't be rerun from the
 * Jobs page, since its coding task, triage run or conversation decides what runs next.
 */
export type JobRerunKind = "review" | "copy";

const COPIED_TYPES: readonly string[] = [REPO_SYNC_JOB_TYPE, INSTALL_JOB_TYPE];

/** How `job` is rerun (whatever its status), or null when it can't be. */
export function jobRerunKind(job: { type: string; payload: unknown }): JobRerunKind | null {
  if (job.type === REVIEW_TASK_JOB_TYPE) return reviewIdOfJob(job.payload) ? "review" : null;
  return COPIED_TYPES.includes(job.type) ? "copy" : null;
}

/** Whether the Jobs page offers to rerun `job`: a failed job of a kind that can be. */
export function isRerunnable(job: { type: string; status: string; payload: unknown }): boolean {
  return job.status === "failed" && jobRerunKind(job) !== null;
}
