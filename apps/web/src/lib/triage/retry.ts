/**
 * Retrying a triage run from Omniralph (`POST /api/ui/runs/{id}/retry`): a new `triage.run`
 * attempt on the same run, over the issue's current content, as a session reply does
 * (`lib/triage/reply.ts`). The attempt repeats the reply its last attempt had (and any reply
 * that arrived since), and builds on the run's last triage.
 */
import { getJob, requeueTriageRunForRetry, setTriageRunStatus } from "@omniralph/db";
import { RunSpecJobPayload } from "@omniralph/shared";
import { trackerConversation } from "@/lib/ralph/conversation";
import { postActivity } from "@/lib/ralph/notify";
import { previousOutcome } from "./reply";
import { enqueueTriage, prepareTriage, type StartTriageOutcome, type TriageDeps } from "./start";

export type RetryTriageOutcome =
  | { status: "gone" }
  /** The run is queued or running. */
  | { status: "busy" }
  /** Another run of the issue is queued or running. */
  | { status: "conflict" }
  | Exclude<StartTriageOutcome, { status: "exists" | "already_running" }>;

/** The reply `jobId`'s trigger context gave the triage, if any. */
async function attemptReply(deps: TriageDeps, jobId: string | null): Promise<string | null> {
  if (!jobId) return null;
  const job = await getJob(deps.db, jobId);
  const payload = RunSpecJobPayload.safeParse(job?.payload);
  if (!payload.success) return null;
  const reply = (payload.data.trigger.context as { reply?: unknown }).reply;
  return typeof reply === "string" && reply.trim() ? reply.trim() : null;
}

/**
 * Queues triage run `runId` again and enqueues its next attempt. `lastAttemptId` is the
 * attempt being retried (its reply is given again). The session gets a note naming who
 * retried it; when triage can't start (the issue is in progress or done, Linear fails…) the
 * run ends as `prepareTriage` decides and the session says why.
 */
export async function retryTriageRun(
  deps: TriageDeps,
  runId: string,
  lastAttemptId: string | null,
  retriedBy: string | undefined,
): Promise<RetryTriageOutcome> {
  const reply = await attemptReply(deps, lastAttemptId);
  const taken = await requeueTriageRunForRetry(deps.db, runId);
  switch (taken.status) {
    case "none":
      return { status: "gone" };
    case "active":
      return { status: "busy" };
    case "conflict":
      return { status: "conflict" };
    case "requeued":
      break;
  }
  const { run } = taken;
  await postActivity(
    trackerConversation(deps.tracker, run.linearAgentSessionId, run.linearIssueId),
    {
      type: "thought",
      body: retriedBy ? `Retried from Omniralph by ${retriedBy}.` : "Retried from Omniralph.",
    },
  );
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
    reply: [reply, taken.reply].filter(Boolean).join("\n\n") || null,
    previousResult: previousOutcome(run),
  });
}
