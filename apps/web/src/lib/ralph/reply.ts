/**
 * Replies in a run's agent session (ported from cyralph's
 * `SessionManager.onPrompted`), handled in this order (FR-15):
 *
 * 1. Stop (Linear's Stop signal, or "stop"): the run is stopped, its job canceled.
 * 2. An answer to the open preparation question ("Run it", "I'll do it myself", "Not yet").
 * 3. `rerun preparation`: the earliest open manual story's preparation is asked about again.
 * 4. "start anyway": outside blockers are ignored from now on.
 * 5. Anything else is guidance: stored (the latest ten), the attempts of the
 *    unfinished stories reset (exhausted ones get another go) and a waiting
 *    PR/MR step retried.
 *
 * Every reply but stop and "Not yet" advances the run; one that asks for
 * work (3 to 5) resumes a stopped run.
 */
import {
  appendGuidance,
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
import { postActivity, quietly } from "./notify";
import { preparationOf } from "./preparation";
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
  "stop" | "preparation_answer" | "rerun_preparation" | "start_anyway" | "guidance";

export interface ReplyResult {
  kind: ReplyKind;
  /** The run's advance, when the reply moved it. */
  advanced?: AdvanceResult;
}

/** Story statuses guidance doesn't touch: done, or a person's to do. */
const SETTLED_STORY_STATUSES = new Set(["completed", "canceled", "manual"]);

export async function handleReply(
  event: SessionPromptedEvent,
  deps: RalphDeps,
): Promise<ReplyResult | null> {
  const run = await getRunBySession(deps.db, event.sessionId);
  if (!run) return null;
  if (isStopRequest(event)) return stop(deps, run, event.authorName);

  const text = event.body.trim();
  if (!text) return null;
  if (run.status === "completed" || run.status === "failed") {
    await postActivity(deps.linear, run.linearAgentSessionId, {
      type: "response",
      body: `This run is over (${run.status}), so I didn't act on that. Delegate **${run.linearIdentifier}** to me again to start a new run.`,
    });
    return null;
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
    await appendGuidance(tx, resumed.id, text);
    await resetAttempts(tx, resumed.id);
    // A waiting run's error is a failed PR/MR step: clearing it retries the step.
    if (resumed.status === "waiting" && resumed.error) {
      await updateRun(tx, resumed.id, { error: null });
    }
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
  await postActivity(deps.linear, run.linearAgentSessionId, handled.note);
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

/**
 * Stop: the run becomes `stopped`, its queued or running jobs are canceled
 * (`JobDispatcher.cancel`; a running job through its heartbeat), its running
 * stories go back to pending and the open preparation question is dropped.
 * Guidance resumes it later.
 */
async function stop(
  deps: RalphDeps,
  run: RalphRun,
  authorName: string | undefined,
): Promise<ReplyResult | null> {
  const stopped = await lockRun(deps.db, run.id, async (tx, current) => {
    if (FINISHED_RUN_STATUSES.has(current.status)) return { already: current.status };
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
    };
  });
  if (!stopped) return null;
  if ("already" in stopped) {
    await postActivity(deps.linear, run.linearAgentSessionId, {
      type: "response",
      body:
        stopped.already === "stopped"
          ? "This run is already stopped. Reply with guidance to resume it."
          : `This run is already over (${stopped.already}).`,
    });
    return { kind: "stop" };
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
    ].join(" "),
  };
  await postActivity(deps.linear, run.linearAgentSessionId, content);
  return { kind: "stop" };
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

/**
 * Guidance gives every unfinished story a fresh set of attempts (cyralph
 * resets `attempts`): exhausted stories become pending again.
 */
async function resetAttempts(tx: RalphTransaction, runId: string): Promise<void> {
  for (const story of await listStories(tx, runId)) {
    if (SETTLED_STORY_STATUSES.has(story.status)) continue;
    if (story.status === "exhausted") {
      await updateStory(tx, story.id, { status: "pending", attempts: 0 });
    } else if (story.attempts !== 0) {
      await updateStory(tx, story.id, { attempts: 0 });
    }
  }
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
