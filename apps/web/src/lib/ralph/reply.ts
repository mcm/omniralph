/**
 * Replies in a run's agent session (ported from cyralph's
 * `SessionManager.onPrompted`), handled in this order (FR-15):
 *
 * 1. Stop (Linear's Stop signal, or "stop"): the run is stopped, its job canceled.
 * 1a. While the run asks which repository to use, the answer to that
 *     (`repository-selection.ts`); an unmatched reply asks again.
 * 2. An answer to the open preparation question ("Run it", "I'll do it myself", "Not yet").
 * 3. `rerun preparation`: the earliest open manual story's preparation is asked about again.
 * 4. "start anyway": outside blockers are ignored from now on.
 * 5. Anything else, while a `ralph.story` job runs, is a message for its live
 *    session (`messages.ts`): nothing else happens until the agent delivers it
 *    or it turns out it can't. A push/PR/MR request never goes to a story
 *    agent: it becomes a pending request.
 * 6. Otherwise it is guidance: stored (the latest ten), the attempts of the
 *    unfinished stories reset (exhausted ones get another go) and a waiting
 *    PR/MR step retried.
 *
 * Every reply but stop, "Not yet" and a message for a running job advances
 * the run; one that asks for work (3 to 6) resumes a stopped run.
 */
import {
  getRunByIssue,
  getRunBySession,
  listActiveRunJobIds,
  listStories,
  lockRun,
  updateRun,
  updateStory,
  type RalphRun,
  type RalphTransaction,
} from "@omniralph/db";
import {
  isRerunPreparationRequest,
  isStartAnywayRequest,
  isStopRequest,
  matchPreparationAnswer,
  PREPARATION_LATER,
  PREPARATION_MYSELF,
  type PreparationAnswer,
} from "@omniralph/ralph";
import type { ActivityContent } from "@/lib/linear/gateway";
import type { LinearWebhookEvent } from "@/lib/linear/webhook";
import { applyGuidance, queueLiveReply } from "./messages";
import { postActivity, quietly } from "./notify";
import { preparationOf } from "./preparation";
import { answerRepositorySelection, repositorySelectionOf } from "./repository-selection";
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
  /** An answer (or a reply that matched nothing) to the repository question. */
  | "repository_selection"
  | "preparation_answer"
  | "rerun_preparation"
  | "start_anyway"
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
  if (run.status === "completed" || run.status === "failed") {
    await postActivity(deps.linear, run.linearAgentSessionId, {
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
  const handled = await lockRun(deps.db, run.id, async (tx, current) => {
    if (current.status === "completed" || current.status === "failed") return null;
    const request = preparationOf(current).request;
    if (answer && request && !request.jobId && current.status !== "stopped") {
      return answerPreparation(tx, current, answer);
    }
    const resumed = current.status === "stopped" ? await resume(tx, current) : current;
    if (!resumed) {
      return {
        kind: "guidance" as const,
        advance: false,
        note: {
          type: "response" as const,
          body: `A newer run of **${current.linearIdentifier}** is under way, so this stopped run stays stopped. Reply in that run's session instead.`,
        },
      };
    }
    if (isRerunPreparationRequest(text)) {
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
    if (isStartAnywayRequest(text)) {
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
    const live = await queueLiveReply(tx, resumed, text, event.authorName);
    if (live) return { kind: live.kind, advance: false, note: live.note };
    await applyGuidance(tx, resumed, text);
    return {
      kind: "guidance" as const,
      advance: true,
      note: {
        type: "thought" as const,
        body: await whenFree(
          tx,
          resumed,
          "Got it. I'll apply this from the next story attempt",
          "Got it. Applying this from the next story attempt.",
        ),
      },
    };
  });
  if (!handled) return null;
  if (handled.note) await postActivity(deps.linear, run.linearAgentSessionId, handled.note);
  if (!handled.advance) return { kind: handled.kind };
  return { kind: handled.kind, advanced: await advanceRun(run.id, deps) };
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
      preparation: { ...state, request: null },
      error: null,
    });
    for (const story of await listStories(tx, current.id)) {
      if (story.status === "running") await updateStory(tx, story.id, { status: "pending" });
    }
    return {
      jobIds: await listActiveRunJobIds(tx, current.id),
      stories: await listStories(tx, current.id),
      prUrl: current.prUrl,
    };
  });
  if (!stopped) return { status: "gone" };
  if ("already" in stopped && stopped.already) {
    await postActivity(deps.linear, run.linearAgentSessionId, {
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
  await postActivity(deps.linear, run.linearAgentSessionId, content);
  return { status: "stopped", canceled };
}

/**
 * A stopped run asked to work again becomes `pending` (advancing it decides
 * what's next). Not while another run of the issue is unfinished (it was
 * delegated again): null.
 */
async function resume(tx: RalphTransaction, run: RalphRun): Promise<RalphRun | null> {
  const other = await getRunByIssue(tx, run.linearIssueId, { activeOnly: true });
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
      body: `I'll run the preparation of ${story}${busy ? " once the current job finishes" : ""}, if its commands and \`${run.branch}\` haven't changed.`,
    },
  };
}
