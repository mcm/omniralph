import "server-only";
import { RalphPushResult, RalphRequestResult, RalphStoryResult } from "@omniralph/shared";
import { onRalphJobFinished, onRalphJobStarted } from "@/lib/ralph/jobs";
import type { Sink } from "./index";

/**
 * `ralph-run`: hands a coding run's result (`builtin:implement-story`,
 * `builtin:handle-request`) to its ralph run: the delivery makes its harness
 * the run's sticky harness (or is skipped once the run is over), and
 * `advanceRun` applies the outcome it finds through the story's `last_job_id`,
 * the run's `request_job_id` or (a lane's `ralph.push` run) its `pr_job_id`,
 * so attempts stay separate from redeliveries.
 */
export const ralphRunSink: Sink<never, RalphStoryResult | RalphRequestResult | RalphPushResult> = {
  kind: "ralph-run",
  taskType: "coding",
  outputSchema: null,
  parseResult(result) {
    const story = RalphStoryResult.safeParse(result);
    if (story.success) return story.data;
    const request = RalphRequestResult.safeParse(result);
    if (request.success) return request.data;
    const push = RalphPushResult.safeParse(result);
    return push.success ? push.data : null;
  },
  onStarted: onRalphJobStarted,
  apply: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
};
