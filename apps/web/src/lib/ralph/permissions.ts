/**
 * Permission prompts of a live session, asked in the run's conversation (its
 * Linear agent session, or its chat thread). Request sessions
 * bypass Claude Code's permission checks, but a repository's own Claude Code
 * settings can still `ask` about a call (e.g. `"ask": ["Bash(git commit:*)"]`).
 * The agent then asks here (`POST /api/agent/jobs/{id}/permissions`): the
 * question is stored on the run and posted as an Allow/Deny elicitation. A
 * reply answers it (`answerPermission`, from `handleReply` or, in chat,
 * `sendToChatRun`); the agent polls
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
import type { ActivityContent, TrackerGateway } from "@omniralph/tracker";
import { conversationFor, type ChatSource } from "./conversation";
import { postActivity } from "./notify";
import { FINISHED_RUN_STATUSES } from "./run";

export interface PermissionDeps {
  db: Database;
  /** The gateway of an organization's tracker workspace. */
  tracker: (organizationId: string) => Promise<TrackerGateway>;
  /** Posts chat runs (default: the deployment's chat bot). */
  chat?: ChatSource;
}

/** The run's conversation, getting the tracker gateway only when it's needed. */
function conversation(deps: PermissionDeps, run: RalphRun) {
  return conversationFor(run, { tracker: () => deps.tracker(run.organizationId), chat: deps.chat });
}

type RalphJob = Pick<Job, "id" | "ralphRunId">;

/** The run's question about this job's call, if it's the one asked. */
function questionOf(run: RalphRun, job: RalphJob, requestId: string) {
  const question = run.permission;
  return question?.requestId === requestId && question.jobId === job.id ? question : null;
}

/**
 * Asks the run's conversation to approve a tool call (idempotent per
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
    const timeoutMinutes = Math.max(1, Math.round(request.timeoutSeconds / 60));
    await postActivity(
      conversation(deps, asked.run),
      {
        type: "elicitation",
        body: permissionQuestion({
          tool: request.tool,
          detail: request.detail,
          reason: request.reason,
          timeoutMinutes,
        }),
      },
      {
        signal: "select",
        signalMetadata: { options: PERMISSION_OPTIONS.map((value) => ({ value })) },
        event: {
          kind: "permission_request",
          key: `permission:${requestId}`,
          details: {
            requestId,
            tool: request.tool,
            detail: request.detail,
            reason: request.reason ?? null,
            timeoutSeconds: request.timeoutSeconds,
            timeoutMinutes,
            options: [...PERMISSION_OPTIONS],
          },
        },
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

/** Leeway for the agent's and our clocks when telling a timeout from an early close. */
const EXPIRY_LEEWAY_MS = 60_000;

/**
 * The agent stopped waiting: a pending question is closed as expired. Only a
 * timeout (the question reached its `expiresAt`) is announced in the thread;
 * a session that ended first (the job was canceled or stopped) closes it
 * quietly.
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
    const timedOut = now.getTime() >= Date.parse(question.expiresAt) - EXPIRY_LEEWAY_MS;
    return { run, tool: question.tool, timedOut };
  });
  if (!expired?.timedOut || FINISHED_RUN_STATUSES.has(expired.run.status)) return;
  // In chat, a new message under the question rather than an edit of the status message.
  await postActivity(
    conversation(deps, expired.run),
    { type: "thought", body: `Nobody answered in time, so I didn't use **${expired.tool}**.` },
    { notice: true, event: { key: `permission:${requestId}:expired` } },
  );
}

/**
 * A reply that answers the run's open permission question (inside the run's
 * lock, from `handleReply` or `sendToChatRun`). Returns the note for the thread, or null when
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
