/**
 * Permission requests of any run (`run_permission_requests`): a session asks
 * to approve a tool call, the harness polls for the answer. A ralph run's
 * question is also asked in its conversation (`lib/ralph/permissions.ts`),
 * and the answer recorded there is copied to the stored request.
 */
import "server-only";
import {
  answerRunPermissionRequest,
  getRun,
  getRunPermissionRequest,
  type Database,
  type Job,
  type RunPermissionRequest,
} from "@omniralph/db";
import type { RalphPermissionAnswer } from "@omniralph/shared";
import { readPermission } from "@/lib/ralph/permissions";

/**
 * The answer to a stored request so far: its answer, else `expired` once
 * past `expires_at` (or when it was never asked), else `pending`.
 */
export function storedPermissionAnswer(
  request: RunPermissionRequest | null,
  now = new Date(),
): RalphPermissionAnswer {
  if (!request) return { status: "expired", answeredBy: null };
  if (request.answer) return { status: request.answer, answeredBy: request.answeredBy };
  if (request.expiresAt.getTime() <= now.getTime()) return { status: "expired", answeredBy: null };
  return { status: "pending", answeredBy: null };
}

/**
 * The answer to a job's permission request, read from the stored request. For
 * a ralph job, an answer recorded on its run (`ralph_runs.permission`) is first
 * copied to the stored request; a request asked before requests were stored
 * reads from the run alone.
 */
export async function readRunPermission(
  db: Database,
  job: Pick<Job, "id" | "ralphRunId">,
  requestId: string,
  now = new Date(),
): Promise<RalphPermissionAnswer> {
  let stored = await getRunPermissionRequest(db, job.id, requestId);
  if (job.ralphRunId) {
    const run = await getRun(db, job.ralphRunId);
    const fromRun = readPermission(run, job, requestId);
    if (!stored) return fromRun;
    if (!stored.answer && fromRun.status !== "pending") {
      const question = run?.permission?.requestId === requestId ? run.permission : null;
      ({ request: stored } = await answerRunPermissionRequest(db, {
        jobId: job.id,
        requestId,
        answer: fromRun.status,
        answeredBy: fromRun.answeredBy,
        answeredAt: question?.answeredAt ? new Date(question.answeredAt) : now,
      }));
    }
  }
  return storedPermissionAnswer(stored, now);
}
