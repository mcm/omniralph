/**
 * Messages from a chat thread to its ralph run (the chat counterpart of a
 * Linear `session_prompted` reply, `reply.ts` step 5 and 6): while one of the
 * run's live-session jobs runs, the message is stored for it and the agent
 * gets it in its next heartbeat (`queueLiveReply`); otherwise it becomes a
 * pending request (`addInstruction`) and the run is advanced, so it runs as
 * soon as the current job finishes. Chat runs stay in request mode: there is
 * no `/coding`, stop or preparation handling here, and permission answers come
 * from the chat assistant's `answer_run_permission` tool (`answerPermission`)
 * rather than from matching the text. `/ship [notes]` is always a pending ship
 * request (`reply.ts` step 4a).
 */
import {
  getActiveRunByChatThread,
  getActiveRunJob,
  getRun,
  isLinearRun,
  listActiveRunJobIds,
  lockRun,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import { parseShipRequest, SHIP_REQUEST_TEXT } from "@omniralph/ralph";
import { RALPH_REQUEST_JOB_TYPE } from "@omniralph/shared";
import { bumpAgentHeartbeat } from "@/lib/agents/heartbeat-cache";
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
 * The thread's unfinished run with a queued or running request job (its
 * session works right now), or null.
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
  /** `ship`: a ship request even without a `/ship` prefix (the chat assistant's `ship` flag). */
  input: {
    chatThreadId: string;
    text: string;
    author: string | null;
    ship?: boolean;
    /** The message's attachments for the session (`sessionAttachmentNote`), appended to its text. */
    attachments?: string | null;
  },
): Promise<ChatRunMessageOutcome> {
  const text = input.text.trim();
  const withFiles = (body: string) =>
    [body, input.attachments?.trim()].filter(Boolean).join("\n\n");
  const run = await getActiveRunByChatThread(deps.db, input.chatThreadId);
  if (!run || run.organizationId !== deps.organizationId || !withFiles(text)) {
    return { status: "no_run" };
  }
  const ship = parseShipRequest(text) ?? (input.ship ? text : null);
  const handled = await lockRun(deps.db, run.id, async (tx, current) => {
    if (FINISHED_RUN_STATUSES.has(current.status)) return null;
    if (ship === null) {
      const live = await queueLiveReply(
        tx,
        current,
        withFiles(text),
        input.author ?? undefined,
        "chat.request",
      );
      if (live) {
        const liveAgentId = live.kind === "live" ? live.agentId : null;
        return { status: "live" as const, run: current, liveAgentId };
      }
    }
    const added = await addInstruction(
      tx,
      current,
      ship === null
        ? { text: withFiles(text), author: input.author, wantsLoop: false, trigger: "chat.request" }
        : {
            text: withFiles(ship || SHIP_REQUEST_TEXT),
            author: input.author,
            wantsLoop: false,
            ship: true,
            trigger: "chat.request",
          },
      applyGuidance,
    );
    return { status: "queued" as const, run: added.run };
  });
  if (!handled) return { status: "no_run" };
  if ("liveAgentId" in handled) {
    await bumpAgentHeartbeat(handled.liveAgentId);
    return { status: handled.status, run: handled.run };
  }
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
      { text, author, wantsLoop: false, trigger: "chat.request" },
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
