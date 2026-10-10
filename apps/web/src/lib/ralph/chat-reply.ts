/**
 * Messages from a chat thread to its ralph run (the chat counterpart of a
 * Linear `session_prompted` reply, `reply.ts` step 5 and 6): while one of the
 * run's live-session jobs runs, the message is stored for it and the agent
 * gets it in its next heartbeat (`queueLiveReply`); otherwise it becomes a
 * pending request (`addInstruction`) and the run is advanced, so it runs as
 * soon as the current job finishes. Chat runs stay in request mode: there is
 * no `/ralph`, stop or preparation handling here.
 */
import {
  getActiveRunByChatThread,
  getActiveRunJob,
  getRun,
  getRunByChatThread,
  isLinearRun,
  listActiveRunJobIds,
  listLanes,
  lockRun,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import { RALPH_REQUEST_JOB_TYPE } from "@omniralph/shared";
import { conversationFor } from "./conversation";
import { applyGuidance, queueLiveReply } from "./messages";
import { postActivity, quote } from "./notify";
import { addInstruction } from "./requests";
import { advanceRun, FINISHED_RUN_STATUSES, type RalphDeps } from "./run";

/** The thread's run while its session works: a queued or running `ralph.request` job. */
export interface ChatRunSession {
  run: RalphRun;
  job: Job;
}

/**
 * The thread's unfinished run with a queued or running request job (plain
 * replies in the thread then go to that session), or null.
 */
export async function chatRunSession(
  db: Database,
  chatThreadId: string,
): Promise<ChatRunSession | null> {
  const run = await getActiveRunByChatThread(db, chatThreadId);
  if (!run) return null;
  const job = await getActiveRunJob(db, run.id, [RALPH_REQUEST_JOB_TYPE]);
  return job ? { run, job } : null;
}

/**
 * The thread's latest run when one of its lanes has an open cleanup question
 * (asked after its PR/MR merged), else null: a plain reply may answer it
 * (`answerCleanup`), as a reply in a Linear session does.
 */
export async function chatRunAskingCleanup(
  db: Database,
  chatThreadId: string,
): Promise<RalphRun | null> {
  const run = await getRunByChatThread(db, chatThreadId);
  if (!run) return null;
  const lanes = await listLanes(db, run.id);
  return lanes.some((lane) => (lane.cleanup?.questions.length ?? 0) > 0) ? run : null;
}

export type ChatRunMessageOutcome =
  /** The thread has no unfinished run (of this organization). */
  | { status: "no_run" }
  /** Stored for the running job's live session: the agent gets it in its next heartbeat. */
  | { status: "live"; run: RalphRun }
  /** A pending request: it runs once the current job finishes (or right away when none runs). */
  | { status: "queued"; run: RalphRun };

/** Passes `text` to the thread's unfinished run (see the module comment). */
export async function sendToChatRun(
  deps: RalphDeps,
  input: { chatThreadId: string; text: string; author: string | null },
): Promise<ChatRunMessageOutcome> {
  const text = input.text.trim();
  const run = await getActiveRunByChatThread(deps.db, input.chatThreadId);
  if (!run || run.organizationId !== deps.organizationId || !text) return { status: "no_run" };
  const handled = await lockRun(deps.db, run.id, async (tx, current) => {
    if (FINISHED_RUN_STATUSES.has(current.status)) return null;
    const live = await queueLiveReply(tx, current, text, input.author ?? undefined);
    if (live) return { status: "live" as const, run: current };
    const added = await addInstruction(
      tx,
      current,
      { text, author: input.author, wantsLoop: false },
      applyGuidance,
    );
    return { status: "queued" as const, run: added.run };
  });
  if (!handled) return { status: "no_run" };
  if (handled.status === "queued") {
    try {
      await advanceRun(run.id, deps);
    } catch (error) {
      // The request stays pending: the next advance (job end, reconcile) runs it.
      console.error(`Advancing chat ralph run ${run.id} failed`, error);
    }
  }
  return handled;
}

export type GuidanceOutcome =
  /** No run of this organization has that id. */
  | { status: "not_found" }
  /** The run is over (completed, failed or stopped): it takes no more guidance. */
  | { status: "finished"; run: RalphRun }
  /**
   * Stored as guidance and/or a pending request (`addInstruction`); `busy`:
   * a job of the run is queued or running, so it applies once that finishes.
   */
  | { status: "applied"; run: RalphRun; busy: boolean };

/**
 * Guidance from chat for any unfinished run of the organization, Linear or
 * chat (`send_ralph_guidance`): applied like a Linear reply's instruction
 * (`addInstruction` under `lockRun`, then the run advances), with `author`
 * noting that it came from chat. A Linear run's session also shows it, so
 * Linear watchers see who steered it.
 */
export async function sendGuidance(
  deps: RalphDeps,
  input: { runId: string; text: string; author: string | null },
): Promise<GuidanceOutcome> {
  const text = input.text.trim();
  const run = await getRun(deps.db, input.runId);
  if (!run || run.organizationId !== deps.organizationId) return { status: "not_found" };
  const author = `${input.author ?? "Someone"} (from chat)`;
  const handled = await lockRun(deps.db, run.id, async (tx, current) => {
    if (FINISHED_RUN_STATUSES.has(current.status)) {
      return { status: "finished" as const, run: current };
    }
    const added = await addInstruction(
      tx,
      current,
      { text, author, wantsLoop: false },
      applyGuidance,
    );
    const busy = (await listActiveRunJobIds(tx, current.id)).length > 0;
    return { status: "applied" as const, run: added.run, busy };
  });
  if (!handled) return { status: "not_found" };
  if (handled.status === "finished") return handled;
  if (isLinearRun(run)) {
    await postActivity(conversationFor(run, deps), {
      type: "thought",
      body: `Guidance from ${author}:\n\n${quote(text)}`,
    });
  }
  try {
    await advanceRun(run.id, deps);
  } catch (error) {
    // The guidance is stored: the next advance (job end, reconcile) applies it.
    console.error(`Advancing ralph run ${run.id} after guidance from chat failed`, error);
  }
  return handled;
}
