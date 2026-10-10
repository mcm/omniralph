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
  lockRun,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import { RALPH_REQUEST_JOB_TYPE } from "@omniralph/shared";
import { applyGuidance, queueLiveReply } from "./messages";
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
