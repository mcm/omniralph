/**
 * Replies in a run's agent session (ported from cyralph's
 * `SessionManager.onPrompted`), handled in this order (FR-15):
 *
 * 1. Stop (Linear's Stop signal, or "stop"): the run is stopped, its job canceled.
 * 1a. An answer to an open question about a merged PR/MR's leftovers
 *     (`cleanup.ts`: stash entries, a branch with unmerged commits), in any
 *     run status: a `ralph.cleanup` job carries it out.
 * 1b. While the run asks which repository to use, the answer to that
 *     (`repository-selection.ts`); an unmatched reply asks again.
 * 2. An answer to the open preparation question ("Run it", "I'll do it myself", "Not yet").
 * 2a. `/continue` at the start resets the iteration cap. Bare, it also gives
 *     the unfinished stories fresh attempts; otherwise the text after it is
 *     handled as below.
 * 3. `rerun preparation` (epic mode): the earliest open manual story's preparation is asked about again.
 * 4. "start anyway" (epic mode): outside blockers are ignored from now on.
 * 5. Anything else, while a `ralph.story` or `ralph.request` job runs, is a
 *    message for its live session (`messages.ts`): nothing else happens until
 *    the agent delivers it or it turns out it can't. A push/PR/MR request
 *    never goes to a story agent: it becomes a pending request.
 * 6. Otherwise (`requests.ts`, without `/ralph` and a leading `@name`): in
 *    epic mode it is guidance (stored, the attempts of the unfinished stories
 *    reset, a waiting PR/MR step retried) and a pending request, which runs
 *    directly when no story takes it (the epic is done, or blocked); in
 *    request mode (a mention) only a pending request. `/ralph` switches a
 *    request-mode run to epic mode.
 *
 * Every reply but stop, "Not yet" and a message for a running job advances
 * the run; one that asks for work (2a to 6) resumes a stopped run, and reopens
 * a completed one (cyralph runs a reply on a finished session as a request).
 */
import {
  getRunBySession,
  listActiveRunJobIds,
  listStories,
  lockRun,
  updateRun,
  updateStory,
  type RalphRun,
  type RalphTransaction,
  getMainLane,
  getActiveRunOfSameOrigin,
  isLinearRun,
  linearSessionOf,
} from "@omniralph/db";
import {
  isRerunPreparationRequest,
  isStartAnywayRequest,
  isStopRequest,
  matchPreparationAnswer,
  parseContinueRequest,
  parseInstruction,
  PREPARATION_LATER,
  PREPARATION_MYSELF,
  type PreparationAnswer,
} from "@omniralph/ralph";
import type { ActivityContent } from "@/lib/linear/gateway";
import type { LinearWebhookEvent } from "@/lib/linear/webhook";
import { mainBranch } from "./lanes";
import { loadEpic, runEpicOptions } from "./epic-loader";
import { answerCleanup } from "./cleanup";
import { applyGuidance, freshAttempts, queueLiveReply, undeliveredNote } from "./messages";
import { postActivity, quietly } from "./notify";
import { preparationOf } from "./preparation";
import { answerRepositorySelection, repositorySelectionOf } from "./repository-selection";
import { addInstruction } from "./requests";
import {
  advanceRun,
  FINISHED_RUN_STATUSES,
  publishPlan,
  type AdvanceResult,
  type RalphDeps,
} from "./run";

export type SessionPromptedEvent = Extract<LinearWebhookEvent, { kind: "session_prompted" }>;

/** What a reply turned out to be. */
export type ReplyKind =
  | "stop"
  /** An answer to a question about a merged PR/MR's leftovers (`cleanup.ts`). */
  | "cleanup_answer"
  /** An answer (or a reply that matched nothing) to the repository question. */
  | "repository_selection"
  | "preparation_answer"
  | "rerun_preparation"
  | "start_anyway"
  /** `/continue` without guidance: the iteration cap and story attempts start over. */
  | "continue"
  /** Stored for the running job's live session. */
  | "live"
  /** A push/PR/MR request kept away from a running story agent. */
  | "request"
  | "guidance";

export interface ReplyResult {
  kind: ReplyKind;
  /** The run's advance, when the reply moved it. */
  advanced?: AdvanceResult;
}

export async function handleReply(
  event: SessionPromptedEvent,
  deps: RalphDeps,
): Promise<ReplyResult | null> {
  const run = await getRunBySession(deps.db, event.sessionId);
  if (!run) return null;
  if (isStopRequest(event)) {
    await stopRun(deps, run, event.authorName);
    return { kind: "stop" };
  }

  const text = event.body.trim();
  if (!text) return null;
  // An answer to a question about a merged PR/MR's leftovers (stashes, unmerged commits).
  const cleanup = await answerCleanup(deps, run.id, parseInstruction(text).text || text);
  if (cleanup) return { kind: "cleanup_answer" };
  if (run.status === "failed") {
    await postActivity(deps.linear, linearSessionOf(run), {
      type: "response",
      body: `This run is over (${run.status}), so I didn't act on that. Delegate **${run.linearIdentifier}** to me again to start a new run.`,
    });
    return null;
  }

  const offered = repositorySelectionOf(run);
  if (offered && !run.repositoryId && run.status !== "stopped") {
    const answered = await answerRepositorySelection(deps, run, offered, text);
    return {
      kind: "repository_selection",
      ...(answered.status === "selected" && { advanced: answered.advanced }),
    };
  }

  const answer = matchPreparationAnswer(text);
  // `/continue [guidance]`: the rest of the reply is handled as usual.
  const continued = parseContinueRequest(text);
  const body = continued ?? text;
  const instruction = parseInstruction(body);
  const handled = await lockRun(deps.db, run.id, async (tx, current) => {
    if (current.status === "failed") return null;
    const request = preparationOf(current).request;
    if (answer && request && !request.jobId && current.status !== "stopped") {
      return answerPreparation(tx, current, answer);
    }
    // A stopped run resumes; a finished one takes the reply as a direct request (cyralph).
    let resumed =
      current.status === "stopped" || current.status === "completed"
        ? await resume(tx, current)
        : current;
    if (!resumed) {
      return {
        kind: "guidance" as const,
        advance: false,
        note: {
          type: "response" as const,
          body: `A newer run of **${current.linearIdentifier}** is under way, so this ${current.status} run stays ${current.status}. Reply in that run's session instead.`,
        },
      };
    }
    if (continued !== null) {
      // The iteration cap starts over; a bare `/continue` goes on without guidance.
      resumed = (await updateRun(tx, resumed.id, { iterations: 0 })) ?? resumed;
      if (!instruction.text && !instruction.wantsLoop) {
        await freshAttempts(tx, resumed);
        return {
          kind: "continue" as const,
          advance: true,
          note: {
            type: "thought" as const,
            body: await whenFree(
              tx,
              resumed,
              "OK, I'll continue with a fresh iteration budget",
              "OK, continuing with a fresh iteration budget.",
            ),
          },
        };
      }
    }
    if (resumed.mode === "epic" && isRerunPreparationRequest(body)) {
      const state = preparationOf(resumed);
      await updateRun(tx, resumed.id, { preparation: { ...state, rerun: true } });
      return {
        kind: "rerun_preparation" as const,
        advance: true,
        note: {
          type: "thought" as const,
          body: await whenFree(
            tx,
            resumed,
            "I'll ask about the preparation again",
            "Looking for a manual step whose preparation can run again…",
          ),
        },
      };
    }
    if (resumed.mode === "epic" && isStartAnywayRequest(body)) {
      await updateRun(tx, resumed.id, { ignoreBlockers: true, waitingOn: null });
      return {
        kind: "start_anyway" as const,
        advance: true,
        note: {
          type: "thought" as const,
          body: "OK, I'll ignore the open blockers and start anyway.",
        },
      };
    }
    // Running: a message for the live session (push/PR requests stay away from a story agent).
    if (instruction.text && !instruction.wantsLoop) {
      const live = await queueLiveReply(tx, resumed, instruction.text, event.authorName);
      if (live) return { kind: live.kind, advance: false, note: live.note };
    }
    const added = await addInstruction(
      tx,
      resumed,
      {
        text: instruction.text,
        author: event.authorName ?? null,
        wantsLoop: instruction.wantsLoop,
      },
      applyGuidance,
    );
    const busy = (await listActiveRunJobIds(tx, resumed.id)).length > 0;
    if (added.run.mode === "request") {
      return {
        kind: "request" as const,
        advance: true,
        switched: false,
        note: {
          type: "thought" as const,
          body: busy ? undeliveredNote("request") : "On it.",
        },
      };
    }
    return {
      kind: "guidance" as const,
      advance: true,
      switched: added.switched,
      note: {
        type: "thought" as const,
        body: busy
          ? "Got it. I'll apply this from the next story attempt once the current job finishes."
          : "Got it. Applying this from the next story attempt.",
      },
    };
  });
  if (!handled) return null;
  if (handled.note) await postActivity(deps.linear, linearSessionOf(run), handled.note);
  // `/ralph` on a mention's run: the story loop needs the epic's stories as sub-issues.
  if ("switched" in handled && handled.switched) await materializeStories(deps, run);
  if (!handled.advance) return { kind: handled.kind };
  return { kind: handled.kind, advanced: await advanceRun(run.id, deps) };
}

/** Creates a PRD's missing stories as sub-issues (a request-mode run switched to the epic loop). */
async function materializeStories(deps: RalphDeps, run: RalphRun): Promise<void> {
  if (run.kind === "single" || !isLinearRun(run)) return;
  await quietly(`Creating the stories of ${run.linearIdentifier}`, async () => {
    const options = await runEpicOptions(deps.db, run);
    await loadEpic(deps.linear, run.linearIssueId, { ...options, completePrd: true });
  });
}

/** `busy` (with a note that it waits for the job) while one of the run's jobs runs, else `free`. */
async function whenFree(
  tx: RalphTransaction,
  run: RalphRun,
  busy: string,
  free: string,
): Promise<string> {
  const active = await listActiveRunJobIds(tx, run.id);
  return active.length > 0 ? `${busy} once the current job finishes.` : free;
}

/** What `stopRun` did. */
export type StopRunResult =
  | { status: "stopped"; /** Jobs canceled (or asked to cancel). */ canceled: number }
  | { status: "already"; runStatus: RalphRun["status"] }
  | { status: "gone" };

/**
 * Stop (the Linear stop reply, and the Ralph run page's Stop button): the run
 * becomes `stopped`, its queued or running jobs are canceled
 * (`JobDispatcher.cancel`; a running job through its heartbeat), its running
 * stories go back to pending and the open preparation question is dropped.
 * The session is told (by `authorName`, when given). Guidance resumes it later.
 */
export async function stopRun(
  deps: RalphDeps,
  run: RalphRun,
  authorName: string | undefined,
): Promise<StopRunResult> {
  const stopped = await lockRun(deps.db, run.id, async (tx, current) => {
    if (FINISHED_RUN_STATUSES.has(current.status)) {
      return { already: current.status as RalphRun["status"] };
    }
    const state = preparationOf(current);
    await updateRun(tx, current.id, {
      status: "stopped",
      waitingOn: null,
      pendingElicitation: null,
      prJobId: null,
      requestJobId: null,
      preparation: { ...state, request: null },
      error: null,
    });
    for (const story of await listStories(tx, current.id)) {
      if (story.status === "running") await updateStory(tx, story.id, { status: "pending" });
    }
    return {
      jobIds: await listActiveRunJobIds(tx, current.id),
      stories: await listStories(tx, current.id),
      prUrl: (await getMainLane(tx, current))?.prUrl ?? null,
    };
  });
  if (!stopped) return { status: "gone" };
  if ("already" in stopped && stopped.already) {
    await postActivity(deps.linear, linearSessionOf(run), {
      type: "response",
      body:
        stopped.already === "stopped"
          ? "This run is already stopped. Reply with guidance to resume it."
          : `This run is already over (${stopped.already}).`,
    });
    return { status: "already", runStatus: stopped.already };
  }
  let canceled = 0;
  for (const jobId of stopped.jobIds) {
    const ok = await quietly(`Canceling job ${jobId} of ralph run ${run.id}`, () =>
      deps.dispatcher.cancel(jobId),
    );
    if (ok) canceled += 1;
  }
  await quietly(`Posting the plan of session ${run.linearAgentSessionId}`, () =>
    publishPlan(deps.linear, run, stopped.stories),
  );
  const by = authorName ? ` (requested by ${authorName})` : "";
  const content: ActivityContent = {
    type: "response",
    body: [
      `Stopped${by}.${canceled > 0 ? ` I canceled the ${canceled === 1 ? "job that was running" : `${canceled} jobs that were running`}.` : ""}`,
      "Reply with guidance to resume the run; finished stories stay done.",
      stopped.prUrl ? `The draft stays open: ${stopped.prUrl}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
  await postActivity(deps.linear, linearSessionOf(run), content);
  return { status: "stopped", canceled };
}

/**
 * A stopped run asked to work again becomes `pending` (advancing it decides
 * what's next). Not while another run of the issue (or chat thread) is
 * unfinished (it was delegated again): null.
 */
async function resume(tx: RalphTransaction, run: RalphRun): Promise<RalphRun | null> {
  const other = await getActiveRunOfSameOrigin(tx, run);
  if (other && other.id !== run.id) return null;
  return updateRun(tx, run.id, { status: "pending", error: null });
}

/** An answer to the open preparation question. */
async function answerPreparation(
  tx: RalphTransaction,
  run: RalphRun,
  answer: PreparationAnswer,
): Promise<{
  kind: "preparation_answer";
  advance: boolean;
  note: ActivityContent;
}> {
  const state = preparationOf(run);
  const request = state.request!;
  const at = new Date().toISOString();
  const story = `**${request.identifier}**`;
  if (answer === PREPARATION_LATER) {
    await updateRun(tx, run.id, {
      preparation: { ...state, request: { ...request, answer: "later", answeredAt: at } },
    });
    return {
      kind: "preparation_answer",
      advance: false,
      note: {
        type: "thought",
        body: `OK, I won't run anything for ${story} yet. The question stays open: answer it whenever you're ready.`,
      },
    };
  }
  if (answer === PREPARATION_MYSELF) {
    await updateRun(tx, run.id, {
      preparation: {
        ...state,
        request: null,
        handled: { ...state.handled, [request.storyIssueId]: { how: "myself", at } },
      },
    });
    return {
      kind: "preparation_answer",
      advance: true,
      note: {
        type: "thought",
        body: `OK, the preparation of ${story} is yours to do, and I won't ask about it again (reply \`rerun preparation\` if you change your mind).`,
      },
    };
  }
  // PREPARATION_RUN: approved.
  await updateRun(tx, run.id, {
    preparation: { ...state, request: { ...request, answer: "run", answeredAt: at } },
  });
  const busy = (await listActiveRunJobIds(tx, run.id)).length > 0;
  return {
    kind: "preparation_answer",
    advance: true,
    note: {
      type: "thought",
      body: `I'll run the preparation of ${story}${busy ? " once the current job finishes" : ""}, if its commands and \`${await mainBranch(tx, run)}\` haven't changed.`,
    },
  };
}
