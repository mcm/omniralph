/**
 * Replies in a triage session (a session with a `triage_runs` row; ralph's
 * `handleReply` takes every other session):
 *
 * 1. Stop (Linear's Stop signal, or "stop"): the queued or running job is
 *    canceled and the run ends `stopped`; its pending replies are dropped.
 * 2. Anything else, while a job is queued or running, is stored and starts
 *    the next job once that one is over (`continueTriageAfterJob`).
 * 3. Otherwise the run triages again: a new `triage.run` job over the
 *    issue's current content, with the reply and the run's last result, so
 *    the answers are folded into the PRD and the questions they answer dropped.
 */
import {
  getTriageRun,
  getTriageRunBySession,
  replyToTriageRun,
  setTriageRunStatus,
  stopTriageRun,
  takeTriageRunPendingReply,
  type TriageRun,
  type TriageRunReplyResult,
} from "@omniralph/db";
import { isStopRequest, parseInstruction } from "@omniralph/ralph";
import { TriageRunResult, type TriageOutcome } from "@omniralph/shared";
import type { LinearWebhookEvent } from "@/lib/linear/webhook";
import { postActivity, quietly } from "@/lib/ralph/notify";
import { linearConversation } from "@/lib/ralph/conversation";
import { removeTriageLabelQuietly } from "./label";
import { enqueueTriage, prepareTriage, type StartTriageOutcome, type TriageDeps } from "./start";

export type SessionPromptedEvent = Extract<LinearWebhookEvent, { kind: "session_prompted" }>;

export type TriageReplyOutcome =
  /** The run was stopped (`canceled`: its job was asked to cancel). */
  | { kind: "stop"; canceled: boolean }
  /** Nothing to stop: the run wasn't queued or running. */
  | { kind: "not_running" }
  /** Stored for the job after the current one. */
  | { kind: "pending" }
  /** Another run of the issue is queued or running: the reply wasn't taken. */
  | { kind: "conflict" }
  /** The run triaged again (or tried to: see `outcome`). */
  | { kind: "retriage"; outcome: ContinueTriageOutcome }
  /** An empty reply. */
  | { kind: "ignored" };

type ContinueTriageOutcome = Exclude<StartTriageOutcome, { status: "exists" | "already_running" }>;

/** The previous triage the run's last result holds, if it produced one. */
export function previousOutcome(run: Pick<TriageRun, "lastResult">): TriageOutcome | null {
  const parsed = TriageRunResult.safeParse(run.lastResult);
  return parsed.success ? parsed.data.outcome : null;
}

/**
 * Handles `AgentSessionEvent.prompted` in a triage session; null when the
 * session has no triage run (it is ralph's).
 */
export async function handleTriageReply(
  event: SessionPromptedEvent,
  deps: TriageDeps,
): Promise<TriageReplyOutcome | null> {
  const run = await getTriageRunBySession(deps.db, event.sessionId);
  if (!run) return null;
  if (isStopRequest(event)) return stopTriage(deps, run, event.authorName);

  const text = parseInstruction(event.body).text || event.body.trim();
  if (!text) return { kind: "ignored" };
  const taken = await replyToTriageRun(deps.db, run.id, text);
  return afterReply(deps, run, taken);
}

/**
 * A triage job of the run is over (its outcome applied, or it failed): a
 * reply that arrived meanwhile starts the next job. Errors are logged.
 */
export async function continueTriageAfterJob(deps: TriageDeps, runId: string): Promise<void> {
  await quietly(`Continuing triage run ${runId} with its pending reply`, async () => {
    const run = await getTriageRun(deps.db, runId);
    if (!run) return;
    const taken = await takeTriageRunPendingReply(deps.db, run.id);
    if (taken.status === "none" || taken.status === "pending") return;
    await afterReply(deps, run, taken);
  });
}

async function afterReply(
  deps: TriageDeps,
  run: TriageRun,
  taken: TriageRunReplyResult,
): Promise<TriageReplyOutcome> {
  const sessionId = run.linearAgentSessionId;
  switch (taken.status) {
    case "none":
      return { kind: "ignored" };
    case "pending":
      await postActivity(linearConversation(deps.linear, sessionId), {
        type: "thought",
        body: "Got it. Triage is still running; I'll triage again with this once it finishes.",
      });
      return { kind: "pending" };
    case "conflict":
      await postActivity(linearConversation(deps.linear, sessionId), {
        type: "response",
        body: "The issue is being triaged in another session right now, so I didn't act on this. Reply again once that triage is over.",
      });
      return { kind: "conflict" };
    case "requeued":
      return { kind: "retriage", outcome: await retriage(deps, taken.run, taken.reply) };
  }
}

/** Triages the requeued run again over the issue's current content, with the reply. */
async function retriage(
  deps: TriageDeps,
  run: TriageRun,
  reply: string,
): Promise<ContinueTriageOutcome> {
  await postActivity(linearConversation(deps.linear, run.linearAgentSessionId), {
    type: "thought",
    body: "Got it. Triaging again with your reply…",
  });
  const prepared = await prepareTriage(
    deps,
    run.linearIssueId,
    run.linearAgentSessionId,
    async (status) => {
      await setTriageRunStatus(deps.db, run.id, status);
    },
  );
  if (prepared.status !== "ready") return prepared;
  return enqueueTriage(deps, run, prepared.context, {
    reply,
    previousResult: previousOutcome(run),
  });
}

/** Stop: the queued or running job is canceled and the run ends `stopped`. */
async function stopTriage(
  deps: TriageDeps,
  run: TriageRun,
  authorName: string | undefined,
): Promise<TriageReplyOutcome> {
  const stopped = await stopTriageRun(deps.db, run.id);
  if (!stopped) {
    await postActivity(linearConversation(deps.linear, run.linearAgentSessionId), {
      type: "response",
      body: "Triage isn't running, so there is nothing to stop. Reply here to triage again.",
    });
    return { kind: "not_running" };
  }
  const jobId = stopped.currentJobId;
  let canceled = false;
  if (jobId) {
    await quietly(`Canceling job ${jobId} of triage run ${run.id}`, async () => {
      const result = await deps.dispatcher.cancel(jobId);
      canceled = result === "canceled" || result === "cancel_requested";
    });
  }
  // A canceled job reports nothing more, so the label trigger ends here.
  await removeTriageLabelQuietly(deps.linear, run.linearIssueId);
  const by = authorName ? ` (requested by ${authorName})` : "";
  await postActivity(linearConversation(deps.linear, run.linearAgentSessionId), {
    type: "response",
    body: `Stopped${by}. ${canceled ? "I canceled the triage job, and " : ""}nothing more changes in Linear. Reply here to triage again.`,
  });
  return { kind: "stop", canceled };
}
