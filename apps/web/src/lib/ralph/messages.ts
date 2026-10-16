/**
 * Replies delivered into a running job's live Claude session (ported from
 * cyralph's injectors and `SessionManager.onPrompted`). A reply for a run
 * with a running `ralph.story` or `ralph.request` job is stored as a `ralph_messages` row for
 * that job; the agent gets it in its next heartbeat (`jobMessages`), injects
 * it and acknowledges it in the heartbeat after (`deliveredMessageIds`, or
 * `rejectedMessageIds` when the job has no live session). A message that
 * can't be delivered becomes guidance (epic mode) or a pending request, and
 * the run is advanced again when the job ends (`advanceRun` settles them).
 */
import {
  appendGuidance,
  getLaneByRepository,
  getRunningRunJob,
  insertMessage,
  listHarnessUndeliveredMessages,
  listStories,
  listStrandedMessages,
  listUndeliveredJobMessages,
  lockRun,
  updateMessage,
  updateRun,
  updateStory,
  type Database,
  type Job,
  type RalphMessage,
  type RalphMessageTrigger,
  type RalphRun,
  type RalphTransaction,
} from "@omniralph/db";
import { asksForPushOrPullRequest } from "@omniralph/ralph";
import {
  RALPH_REQUEST_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
  type JobMessageDelivery,
} from "@omniralph/shared";
import type { ActivityContent, LinearGateway } from "@/lib/linear/gateway";
import { conversationFor } from "./conversation";
import { postActivity } from "./notify";

/** Job types whose live Claude session takes replies. */
export const LIVE_SESSION_JOB_TYPES: readonly string[] = [
  RALPH_STORY_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
];

/** How a run treats replies: as guidance for its stories (`epic`), or as requests. */
export type RalphRunMode = RalphRun["mode"];

/** A run's mode: `request` for a mention (until `/coding`), else `epic`. */
export function runMode(run: Pick<RalphRun, "mode">): RalphRunMode {
  return run.mode;
}

export const DELIVERED_NOTE = "Passed this to the agent that's working right now.";

/** The note for a reply that waits for the running job to finish (cyralph's wording). */
export function undeliveredNote(mode: RalphRunMode): string {
  return mode === "epic"
    ? "Got it. I'll apply this from the next story iteration, or handle it directly once the stories are done."
    : "Got it. I'll handle this as soon as the current step finishes.";
}

/** Story statuses guidance doesn't touch: done, or a person's to do. */
const SETTLED_STORY_STATUSES = new Set(["completed", "canceled", "manual"]);

/**
 * Stores a reply as guidance for the next story attempts, with fresh
 * attempts and rounds (`freshAttempts`; cyralph resets `attempts`).
 */
export async function applyGuidance(
  tx: RalphTransaction,
  run: RalphRun,
  text: string,
): Promise<void> {
  await appendGuidance(tx, run.id, text);
  await freshAttempts(tx, run);
}

/**
 * The attempts and rounds (with their metric history) of the unfinished
 * stories reset (exhausted ones get another go) and a waiting PR/MR step is
 * retried: guidance, or a bare `/continue`.
 */
export async function freshAttempts(tx: RalphTransaction, run: RalphRun): Promise<void> {
  const fresh = { attempts: 0, rounds: 0, roundMetrics: null };
  for (const story of await listStories(tx, run.id)) {
    if (SETTLED_STORY_STATUSES.has(story.status)) continue;
    if (story.status === "exhausted") {
      await updateStory(tx, story.id, { status: "pending", ...fresh });
    } else if (story.attempts !== 0 || story.rounds !== 0 || story.roundMetrics !== null) {
      await updateStory(tx, story.id, fresh);
    }
  }
  // A waiting run's error is a failed PR/MR step: clearing it retries the step.
  if (run.status === "waiting" && run.error) {
    await updateRun(tx, run.id, { error: null });
  }
}

/** What happened to a reply for a run with a running job. */
export type LiveReply =
  /**
   * Stored for the running job's live session; the agent (`harnessId`, whose heartbeat
   * response the caller bumps after the commit) gets it in its next heartbeat.
   */
  | { kind: "live"; note: null; harnessId: string | null }
  /** Push/PR text kept away from the story agent: a pending request. */
  | { kind: "request"; note: ActivityContent };

/**
 * The reply handling's last step while one of the run's `LIVE_SESSION_JOB_TYPES`
 * jobs runs (inside `lockRun`): the reply is stored as a message for that job,
 * and nothing else happens yet. In epic mode, a push/PR/MR request never goes
 * to a story agent (it may not push): it becomes a pending request. Null
 * when no such job runs.
 */
export async function queueLiveReply(
  tx: RalphTransaction,
  run: RalphRun,
  text: string,
  author: string | undefined,
  trigger: RalphMessageTrigger,
): Promise<LiveReply | null> {
  const job = await getRunningRunJob(tx, run.id, LIVE_SESSION_JOB_TYPES);
  if (!job) return null;
  const mode = runMode(run);
  if (mode === "epic" && asksForPushOrPullRequest(text)) {
    await insertMessage(tx, {
      runId: run.id,
      kind: "request",
      text,
      author: author ?? null,
      trigger,
    });
    return { kind: "request", note: { type: "thought", body: undeliveredNote(mode) } };
  }
  await insertMessage(tx, {
    runId: run.id,
    jobId: job.id,
    // A request job's lane: should the message be stranded, it stays that lane's request.
    laneId: await jobLaneId(tx, run, job),
    kind: mode === "epic" ? "guidance" : "request",
    text,
    author: author ?? null,
    trigger,
  });
  return { kind: "live", note: null, harnessId: job.harnessId };
}

/** The lane a running job works in, null for the main lane. */
async function jobLaneId(
  tx: RalphTransaction,
  run: Pick<RalphRun, "id" | "repositoryId">,
  job: Pick<Job, "repositoryId">,
): Promise<string | null> {
  if (!job.repositoryId || job.repositoryId === run.repositoryId) return null;
  return (await getLaneByRepository(tx, run.id, job.repositoryId))?.id ?? null;
}

/**
 * Hands a message to the run's running live-session job, if it has one: a
 * mention on an issue whose run is working right now. Returns the job's harness
 * (whose heartbeat response the caller bumps after the commit), or null when no
 * such job runs.
 */
export async function deliverToRunningJob(
  tx: RalphTransaction,
  run: RalphRun,
  text: string,
  author: string | undefined,
  trigger: RalphMessageTrigger,
): Promise<{ harnessId: string | null } | null> {
  const job = await getRunningRunJob(tx, run.id, LIVE_SESSION_JOB_TYPES);
  if (!job) return null;
  await insertMessage(tx, {
    runId: run.id,
    jobId: job.id,
    laneId: await jobLaneId(tx, run, job),
    kind: runMode(run) === "epic" ? "guidance" : "request",
    text,
    author: author ?? null,
    trigger,
  });
  return { harnessId: job.harnessId };
}

/**
 * A message that can no longer reach its job (rejected, or the job ended):
 * guidance is stored for the next story attempts, a request stays pending
 * (detached from the job). Returns the note telling the session.
 */
async function strand(
  tx: RalphTransaction,
  run: RalphRun,
  message: RalphMessage,
  now: Date,
): Promise<ActivityContent> {
  if (message.kind === "guidance") {
    await appendGuidance(tx, run.id, message.text, now);
    await updateMessage(tx, message.id, { consumedAt: now });
  } else {
    await updateMessage(tx, message.id, { jobId: null });
  }
  return { type: "thought", body: undeliveredNote(runMode(run)) };
}

/**
 * Settles the run's messages whose job ended before they were delivered
 * (inside `advanceRun`'s lock, so late messages are never lost), posting the
 * note for each.
 */
export async function settleStrandedMessages(
  linear: LinearGateway,
  tx: RalphTransaction,
  run: RalphRun,
  now = new Date(),
): Promise<void> {
  for (const message of await listStrandedMessages(tx, run.id)) {
    const note = await strand(tx, run, message, now);
    await postActivity(conversationFor(run, { linear }), note);
  }
}

export interface JobMessageAcks {
  deliveredMessageIds: readonly string[];
  rejectedMessageIds: readonly string[];
}

/**
 * The heartbeat's part: applies the agent's acknowledgements, then returns
 * the undelivered messages of the jobs it keeps running. Delivered: the
 * session is told and, in epic mode, the text is kept as guidance for later
 * stories too. Rejected: stranded (guidance, or a pending request).
 * Acknowledgements of messages that aren't the agent's, or were settled
 * already, are ignored.
 */
export async function exchangeJobMessages(
  /** `linear` gives the gateway of an organization's workspace (each run's is told). */
  deps: { db: Database; linear: (organizationId: string) => Promise<LinearGateway> },
  harnessId: string,
  runningJobIds: readonly string[],
  acks: JobMessageAcks,
): Promise<JobMessageDelivery[]> {
  const delivered = new Set(acks.deliveredMessageIds);
  const ids = [...delivered, ...acks.rejectedMessageIds];
  const acked = await listHarnessUndeliveredMessages(deps.db, harnessId, ids);
  const runIds = [...new Set(acked.map((m) => m.runId))];
  const notes: { run: RalphRun; content: ActivityContent }[] = [];
  for (const runId of runIds) {
    await lockRun(deps.db, runId, async (tx, run) => {
      const now = new Date();
      // Re-read under the lock: the job's end may have settled them meanwhile.
      const messages = await listHarnessUndeliveredMessages(tx, harnessId, ids);
      for (const message of messages.filter((m) => m.runId === runId)) {
        if (delivered.has(message.id)) {
          if (message.kind === "guidance") await appendGuidance(tx, run.id, message.text, now);
          await updateMessage(tx, message.id, { deliveredAt: now, consumedAt: now });
          notes.push({ run, content: { type: "thought", body: DELIVERED_NOTE } });
        } else {
          const content = await strand(tx, run, message, now);
          notes.push({ run, content });
        }
      }
    });
  }
  // One gateway per organization, fetched only when a note posts to Linear.
  const gateways = new Map<string, Promise<LinearGateway>>();
  const linearOf = (organizationId: string) => () => {
    let gateway = gateways.get(organizationId);
    if (!gateway) {
      gateway = deps.linear(organizationId);
      gateways.set(organizationId, gateway);
    }
    return gateway;
  };
  for (const note of notes) {
    const linear = linearOf(note.run.organizationId);
    await postActivity(conversationFor(note.run, { linear }), note.content);
  }
  const pending = await listUndeliveredJobMessages(deps.db, runningJobIds);
  return pending.map((m) => ({ jobId: m.jobId!, messageId: m.id, text: m.text }));
}
