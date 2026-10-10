/**
 * Permission prompts of a live session, asked in Linear. Request sessions
 * bypass Claude Code's permission checks, but a repository's own Claude Code
 * settings can still `ask` about a call (e.g. `"ask": ["Bash(git commit:*)"]`).
 * The agent then asks here (`POST /api/agent/jobs/{id}/permissions`): the
 * question is stored on the run and posted as an Allow/Deny elicitation. A
 * reply answers it (`answerPermission`, from `handleReply`); the agent polls
 * for the answer and denies the call itself when nobody answers in time,
 * telling us (`expirePermission`). One question at a time per run.
 */
import {
  getJob,
  lockRun,
  updateRun,
  type Database,
  type Job,
  type RalphRun,
  type RalphTransaction,
} from "@omniralph/db";
import {
  PERMISSION_ALLOW,
  PERMISSION_OPTIONS,
  permissionQuestion,
  type PermissionAnswer,
} from "@omniralph/ralph";
import type { RalphPermissionAnswer, RalphPermissionRequest } from "@omniralph/shared";
import type { ActivityContent, LinearGateway } from "@/lib/linear/gateway";
import { postActivity } from "./notify";
import { FINISHED_RUN_STATUSES } from "./run";

export interface PermissionDeps {
  db: Database;
  /** The gateway of an organization's Linear workspace. */
  linear: (organizationId: string) => Promise<LinearGateway>;
}

type RalphJob = Pick<Job, "id" | "ralphRunId">;

/** The run's question about this job's call, if it's the one asked. */
function questionOf(run: RalphRun, job: RalphJob, requestId: string) {
  const question = run.permission;
  return question?.requestId === requestId && question.jobId === job.id ? question : null;
}

/**
 * Asks the run's Linear session to approve a tool call (idempotent per
 * `requestId`). Any earlier question still open is replaced. `no_run`: the
 * job has no run, or the run is over; the agent denies the call.
 */
export async function askPermission(
  deps: PermissionDeps,
  job: RalphJob,
  request: RalphPermissionRequest,
  now = new Date(),
): Promise<{ status: "asked" } | { status: "no_run" }> {
  if (!job.ralphRunId) return { status: "no_run" };
  const requestId = request.requestId.toLowerCase();
  const asked = await lockRun(deps.db, job.ralphRunId, async (tx, run) => {
    if (FINISHED_RUN_STATUSES.has(run.status)) return null;
    if (questionOf(run, job, requestId)) return { run, post: false };
    const updated =
      (await updateRun(tx, run.id, {
        permission: {
          requestId,
          jobId: job.id,
          tool: request.tool,
          detail: request.detail,
          askedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + request.timeoutSeconds * 1000).toISOString(),
        },
      })) ?? run;
    return { run: updated, post: true };
  });
  if (!asked) return { status: "no_run" };
  if (asked.post) {
    const linear = await deps.linear(asked.run.organizationId);
    await postActivity(
      linear,
      asked.run.linearAgentSessionId,
      {
        type: "elicitation",
        body: permissionQuestion({
          tool: request.tool,
          detail: request.detail,
          reason: request.reason,
          timeoutMinutes: Math.max(1, Math.round(request.timeoutSeconds / 60)),
        }),
      },
      {
        signal: "select",
        signalMetadata: { options: PERMISSION_OPTIONS.map((value) => ({ value })) },
      },
    );
  }
  return { status: "asked" };
}

/**
 * The answer to a job's question so far. A question that isn't the run's
 * current one (replaced, or never asked) counts as expired.
 */
export function readPermission(
  run: RalphRun | null,
  job: RalphJob,
  requestId: string,
): RalphPermissionAnswer {
  const question = run ? questionOf(run, job, requestId) : null;
  if (!question) return { status: "expired", answeredBy: null };
  return { status: question.answer ?? "pending", answeredBy: question.answeredBy ?? null };
}

/**
 * The agent stopped waiting (timeout, or the session ended): a pending
 * question is closed as expired, and the thread is told the call was denied.
 */
export async function expirePermission(
  deps: PermissionDeps,
  job: RalphJob,
  requestId: string,
  now = new Date(),
): Promise<void> {
  if (!job.ralphRunId) return;
  const expired = await lockRun(deps.db, job.ralphRunId, async (tx, run) => {
    const question = questionOf(run, job, requestId);
    if (!question || question.answer) return null;
    await updateRun(tx, run.id, {
      permission: { ...question, answer: "expired", answeredAt: now.toISOString() },
    });
    return { run, tool: question.tool };
  });
  if (!expired || FINISHED_RUN_STATUSES.has(expired.run.status)) return;
  const linear = await deps.linear(expired.run.organizationId);
  await postActivity(linear, expired.run.linearAgentSessionId, {
    type: "thought",
    body: `Nobody answered in time, so I didn't use **${expired.tool}**.`,
  });
}

/**
 * A reply that answers the run's open permission question (inside the run's
 * lock, from `handleReply`). Returns the note for the thread, or null when
 * the run has no open question this reply answers: none is pending, it
 * expired, or the job that asked isn't running anymore (then it's closed).
 */
export async function answerPermission(
  tx: RalphTransaction,
  db: Database,
  run: RalphRun,
  answer: PermissionAnswer,
  author: string | undefined,
  now = new Date(),
): Promise<ActivityContent | null> {
  const question = run.permission;
  if (!question || question.answer) return null;
  const job = await getJob(db, question.jobId);
  if (job?.status !== "running" || Date.parse(question.expiresAt) <= now.getTime()) {
    await updateRun(tx, run.id, {
      permission: { ...question, answer: "expired", answeredAt: now.toISOString() },
    });
    return {
      type: "thought",
      body: `That question about **${question.tool}** isn't open anymore, so I didn't act on the answer.`,
    };
  }
  const allowed = answer === PERMISSION_ALLOW;
  await updateRun(tx, run.id, {
    permission: {
      ...question,
      answer: allowed ? "allowed" : "denied",
      answeredAt: now.toISOString(),
      answeredBy: author ?? null,
    },
  });
  return {
    type: "thought",
    body: allowed
      ? `Allowed **${question.tool}**. Carrying on.`
      : `OK, I won't use **${question.tool}** for that.`,
  };
}
