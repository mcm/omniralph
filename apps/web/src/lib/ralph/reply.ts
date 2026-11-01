/**
 * Replies in a run's agent session (ported from cyralph's
 * `SessionManager.onPrompted`), handled in this order (FR-15):
 *
 * 1. Stop (the tracker's Stop signal, or "stop"): the run is stopped, its job canceled.
 * 1'. "Allow"/"Deny" while a live session waits for a person to approve a tool
 *     call (`permissions.ts`): the agent reads the answer.
 * 1a. An answer to an open question about a merged PR/MR's leftovers
 *     (`cleanup.ts`: stash entries, a branch with unmerged commits), in any
 *     run status: a `worktree.cleanup` RPC carries it out.
 * 1b. While the run asks which repository to use, the answer to that
 *     (`repository-selection.ts`); an unmatched reply asks again.
 * 2. An answer to the open preparation question ("Run it", "I'll do it myself", "Not yet").
 * 2a. `/continue` at the start resets the iteration cap. Bare, it also gives
 *     the unfinished stories fresh attempts; otherwise the text after it is
 *     handled as below.
 * 3. `rerun preparation` (epic mode): the earliest open manual story's preparation is asked about again.
 * 4. "start anyway" (epic mode): outside blockers are ignored from now on.
 * 4a. `/ship [notes]`: a pending request that a `ralph.request` job ships
 *     (it commits and pushes the branch itself, and opens the PR/MR if there
 *     is none). Never passed to a running session, never story guidance.
 * 5. Anything else, while a `ralph.story` or `ralph.request` job runs, is a
 *    message for its live session (`messages.ts`): nothing else happens until
 *    the agent delivers it or it turns out it can't. A push/PR/MR request
 *    never goes to a story agent: it becomes a pending request.
 * 6. Otherwise (`requests.ts`, without `/coding` and a leading `@name`): in
 *    epic mode it is guidance (stored, the attempts of the unfinished stories
 *    reset, a waiting PR/MR step retried) and a pending request, which runs
 *    directly when no story takes it (the epic is done, or blocked); in
 *    request mode (a mention) only a pending request. `/coding` switches a
 *    request-mode run to epic mode (refused while the PRD has open questions).
 *
 * The answers to the run's questions (1', 1a, 1b and 2) are `answerRunQuestion`, which
 * Omniralph's Answer (`POST /api/ui/runs/{id}/answer`) calls too.
 *
 * Every reply but stop, "Not yet" and a message for a running job advances
 * the run; one that asks for work (2a to 6) resumes a stopped run, and reopens
 * a completed one (cyralph runs a reply on a finished session as a request).
 */
import {
  getRun,
  getRunBySession,
  listActiveRunJobIds,
  listStories,
  lockRun,
  updateRun,
  updateStory,
  type RalphRun,
  type TrackerRun,
  type RalphTransaction,
  getMainLane,
  isTrackerRun,
} from "@omniralph/db";
import {
  isRerunPreparationRequest,
  isStartAnywayRequest,
  isStopRequest,
  matchPermissionAnswer,
  matchPreparationAnswer,
  parseShipRequest,
  parseContinueRequest,
  parseInstruction,
  PREPARATION_LATER,
  PREPARATION_MYSELF,
  SHIP_REQUEST_TEXT,
  type PreparationAnswer,
} from "@omniralph/ralph";
import { bumpAgentHeartbeat } from "@/lib/agents/heartbeat-cache";
import { trackerName } from "@/lib/tracker/adapters";
import type {
  ActivityContent,
  SessionPromptedEvent as TrackerSessionPromptedEvent,
} from "@omniralph/tracker";
import { conversationFor } from "./conversation";
import { featureMessage, featureToRun, type FeatureFound } from "./feature";
import { relationsMessage, relationViolations } from "./relations";
import { mainBranch } from "./lanes";
import { loadEpic, runEpicOptions } from "./epic-loader";
import { answerCleanup, cleanUpStoppedRun } from "./cleanup";
import { applyGuidance, queueLiveReply, undeliveredNote } from "./messages";
import { postActivity, quietly } from "./notify";
import { answerPermission } from "./permissions";
import { ignoreBlockers, START_ANYWAY_NOTE } from "./person-actions";
import { preparationOf } from "./preparation";
import { answerRepositorySelection, repositorySelectionOf } from "./repository-selection";
import { addInstruction } from "./requests";
import { continueRun, newerRunMessage, resumeRun } from "./retry";
import { openQuestionsCheckFailedMessage, openQuestionsMessage, withOpenQuestions } from "./start";
import {
  advanceRun,
  FINISHED_RUN_STATUSES,
  publishPlan,
  type AdvanceResult,
  type RalphDeps,
} from "./run";

export type SessionPromptedEvent = TrackerSessionPromptedEvent;

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
  /** An answer to a live session's permission question (`permissions.ts`). */
  | "permission_answer"
  /** `/ship`: a pending request that commits, pushes and opens the PR/MR. */
  | "ship"
  /** `/continue` without guidance: the iteration cap and story attempts start over. */
  | "continue"
  /** Stored for the running job's live session. */
  | "live"
  /** A push/PR/MR request kept away from a running story agent. */
  | "request"
  | "guidance"
  /** `/coding` on a mention's run whose PRD still has open questions (or couldn't be checked): refused. */
  | "open_questions"
  /**
   * `/coding` on a mention's run of a feature (or a task directly under one), or when the
   * tracker couldn't be read to tell: refused.
   */
  | "feature"
  /**
   * `/coding` on a mention's run, or `start anyway` on an epic, whose work has a blocks
   * relation breaking the dependency rules (or couldn't be checked): refused.
   */
  | "relations";

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
  // A tool permission, then a question about a merged PR/MR's leftovers (any run status).
  for (const kind of ["permission", "cleanup"] as const) {
    const answered = await answerRunQuestion(deps, run, { kind, text }, event.authorName);
    if (answered) return asReply(answered);
  }
  if (run.status === "failed") {
    await postActivity(conversationFor(run, deps), {
      type: "response",
      body: `This run is over (${run.status}), so I didn't act on that. Delegate **${run.trackerIdentifier}** to me again to start a new run.`,
    });
    return null;
  }
  // The repository question, then the preparation question.
  for (const kind of ["repository", "preparation"] as const) {
    const answered = await answerRunQuestion(deps, run, { kind, text }, event.authorName);
    if (answered) return asReply(answered);
  }

  // `/continue [guidance]`: the rest of the reply is handled as usual.
  const continued = parseContinueRequest(text);
  const body = continued ?? text;
  const ship = parseShipRequest(body);
  const instruction = parseInstruction(body);
  // `/coding` on a mention's run switches it to the story loop: not while the PRD has open questions.
  if (instruction.wantsLoop && run.mode === "request" && isTrackerRun(run)) {
    const issueId = run.focusStoryId ?? run.trackerIssueId;
    let feature: FeatureFound | null;
    try {
      feature = await featureToRun(deps.tracker, issueId);
    } catch (error) {
      console.error(`Checking whether ${issueId} is a feature failed`, error);
      await postActivity(conversationFor(run, deps), {
        type: "error",
        body: `I couldn't load the issue from ${trackerName(run.trackerProvider)}, so I didn't switch to coding: ${error instanceof Error ? error.message : String(error)}. Reply \`/coding\` again to retry.`,
      });
      return { kind: "feature" };
    }
    if (feature) {
      await postActivity(conversationFor(run, deps), {
        type: "response",
        body: featureMessage(feature),
      });
      return { kind: "feature" };
    }
    if (await refusedForRelations(deps, run, issueId, "switch to coding", "Reply `/coding`")) {
      return { kind: "relations" };
    }
    let found: Awaited<ReturnType<typeof withOpenQuestions>>;
    try {
      found = await withOpenQuestions(deps, issueId);
    } catch (error) {
      console.error(`Checking open questions of ${issueId} failed`, error);
      await postActivity(conversationFor(run, deps), {
        type: "error",
        body: openQuestionsCheckFailedMessage(
          error,
          "Reply `/coding` again to retry.",
          run.trackerProvider,
        ),
      });
      return { kind: "open_questions" };
    }
    if (found) {
      await postActivity(conversationFor(run, deps), {
        type: "response",
        body: openQuestionsMessage(found.issue, found.epic, "Then reply `/coding` again."),
      });
      return { kind: "open_questions" };
    }
  }
  // `start anyway` ignores the epic's outside blockers, never a relation breaking the rules.
  if (
    run.mode === "epic" &&
    isTrackerRun(run) &&
    isStartAnywayRequest(body) &&
    (await refusedForRelations(
      deps,
      run,
      run.trackerIssueId,
      "start anyway",
      "Reply `start anyway`",
    ))
  ) {
    return { kind: "relations" };
  }
  const handled = await lockRun(deps.db, run.id, async (tx, current) => {
    if (current.status === "failed") return null;
    const newerRun = {
      kind: "guidance" as const,
      advance: false,
      note: { type: "response" as const, body: newerRunMessage(current) },
    };
    // A bare `/continue` goes on without guidance (shared with Omniralph's Retry).
    if (continued !== null && !instruction.text && !instruction.wantsLoop) {
      const resumed = await continueRun(tx, current);
      if (!resumed) return newerRun;
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
    // A stopped run resumes; a finished one takes the reply as a direct request (cyralph).
    let resumed = await resumeRun(tx, current);
    if (!resumed) return newerRun;
    // `/continue` with text: the iteration cap starts over.
    if (continued !== null) {
      resumed = (await updateRun(tx, resumed.id, { iterations: 0 })) ?? resumed;
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
      await ignoreBlockers(tx, resumed);
      return {
        kind: "start_anyway" as const,
        advance: true,
        note: { type: "thought" as const, body: START_ANYWAY_NOTE },
      };
    }
    // `/ship`: always a request job of its own, after whatever runs now.
    if (ship !== null) {
      await addInstruction(
        tx,
        resumed,
        {
          text: ship || SHIP_REQUEST_TEXT,
          author: event.authorName ?? null,
          wantsLoop: false,
          ship: true,
          trigger: "tracker.mention",
        },
        applyGuidance,
      );
      return {
        kind: "ship" as const,
        advance: true,
        note: {
          type: "thought" as const,
          body: await whenFree(
            tx,
            resumed,
            "I'll commit, push and open the PR/MR",
            "Shipping: I'll commit the work, push the branch and open the PR/MR if there isn't one.",
          ),
        },
      };
    }
    // Running: a message for the live session (push/PR requests stay away from a story agent).
    if (instruction.text && !instruction.wantsLoop) {
      const live = await queueLiveReply(
        tx,
        resumed,
        instruction.text,
        event.authorName,
        "tracker.mention",
      );
      if (live) {
        const liveAgentId = live.kind === "live" ? live.agentId : null;
        return { kind: live.kind, advance: false, note: live.note, liveAgentId };
      }
    }
    const added = await addInstruction(
      tx,
      resumed,
      {
        text: instruction.text,
        author: event.authorName ?? null,
        wantsLoop: instruction.wantsLoop,
        trigger: "tracker.mention",
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
  if ("liveAgentId" in handled) await bumpAgentHeartbeat(handled.liveAgentId);
  if (handled.note) await postActivity(conversationFor(run, deps), handled.note);
  // `/coding` on a mention's run: the story loop needs the epic's stories as sub-issues.
  if ("switched" in handled && handled.switched) await materializeStories(deps, run);
  if (!handled.advance) return { kind: handled.kind };
  return { kind: handled.kind, advanced: await advanceRun(run.id, deps) };
}

/** A question's answer as `handleReply`'s result. */
function asReply({ kind, advanced }: RunQuestionAnswer): ReplyResult {
  return { kind, ...(advanced && { advanced }) };
}

/** The questions a run asks a person (`answerRunQuestion`). */
export type RunQuestionKind = "repository" | "preparation" | "cleanup" | "permission";

/** An answer to one of a run's questions: its kind, and the reply text its matcher takes. */
export interface RunQuestionReply {
  kind: RunQuestionKind;
  text: string;
  /** A cleanup question: only the question of this lane. */
  laneId?: string;
}

export interface RunQuestionAnswer extends ReplyResult {
  /**
   * `answered`: the question took the answer. `closed`: it isn't open anymore (it expired, or
   * the session that asked ended). `busy`: the previous answer is still being carried out.
   * `failed`: carrying the answer out failed. The run's conversation is told in every case.
   */
  outcome: "answered" | "closed" | "busy" | "failed";
}

/**
 * Answers the run's open question of `answer.kind` with a reply's text, as a reply in the
 * run's conversation does (`handleReply` calls it, and so does Omniralph's Answer,
 * `POST /api/ui/runs/{id}/answer`): a tool permission (`answerPermission`), a question about a
 * merged PR/MR's leftovers (`answerCleanup`), the repository question
 * (`answerRepositorySelection`) or the preparation question (`answerPreparation`). The answer's
 * note goes to the run's conversation and the run advances as after a reply. Null when the run
 * has no open question of that kind the text answers. Doesn't depend on the tracker: a chat run's
 * questions are answered the same way.
 */
export async function answerRunQuestion(
  deps: RalphDeps,
  run: RalphRun,
  answer: RunQuestionReply,
  authorName: string | undefined,
): Promise<RunQuestionAnswer | null> {
  const { text } = answer;
  switch (answer.kind) {
    case "permission": {
      const asked = run.permission && !run.permission.answer ? run.permission : null;
      const permission = asked ? matchPermissionAnswer(text) : undefined;
      if (!asked || !permission) return null;
      const note = await lockRun(deps.db, run.id, (tx, current) =>
        answerPermission(tx, deps.db, current, permission, authorName),
      );
      if (!note) return null;
      await postActivity(conversationFor(run, deps), note);
      const after = (await getRun(deps.db, run.id))?.permission;
      const took =
        after?.requestId === asked.requestId &&
        (after.answer === "allowed" || after.answer === "denied");
      return { kind: "permission_answer", outcome: took ? "answered" : "closed" };
    }
    case "cleanup": {
      const cleanup = await answerCleanup(
        deps,
        run.id,
        parseInstruction(text).text || text,
        answer.laneId ? { laneId: answer.laneId } : undefined,
      );
      if (!cleanup) return null;
      return {
        kind: "cleanup_answer",
        outcome: cleanup.status === "enqueued" ? "answered" : cleanup.status,
      };
    }
    case "repository": {
      const offered = repositorySelectionOf(run);
      if (!offered || run.repositoryId || run.status === "stopped" || run.status === "failed") {
        return null;
      }
      const answered = await answerRepositorySelection(deps, run, offered, text);
      return {
        kind: "repository_selection",
        outcome:
          answered.status === "selected"
            ? "answered"
            : answered.status === "unmatched"
              ? "closed"
              : "failed",
        ...(answered.status === "selected" && { advanced: answered.advanced }),
      };
    }
    case "preparation": {
      const choice = matchPreparationAnswer(text);
      if (!choice) return null;
      const handled = await lockRun(deps.db, run.id, async (tx, current) => {
        const request = preparationOf(current).request;
        if (current.status === "failed" || current.status === "stopped") return null;
        if (!request || request.jobId) return null;
        return answerPreparation(tx, current, choice);
      });
      if (!handled) return null;
      await postActivity(conversationFor(run, deps), handled.note);
      return {
        kind: handled.kind,
        outcome: "answered",
        ...(handled.advance && { advanced: await advanceRun(run.id, deps) }),
      };
    }
  }
}

/** Creates a PRD's missing stories as sub-issues (a request-mode run switched to the epic loop). */
async function materializeStories(deps: RalphDeps, run: RalphRun): Promise<void> {
  if (run.kind === "single" || !isTrackerRun(run)) return;
  await quietly(`Creating the stories of ${run.trackerIdentifier}`, async () => {
    const options = await runEpicOptions(deps.db, run);
    await loadEpic(deps.tracker, run.trackerIssueId, { ...options, completePrd: true });
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
 * Stop (the tracker's stop reply, and the Ralph run page's Stop button): the run
 * becomes `stopped`, its queued or running jobs are canceled
 * (`JobDispatcher.cancel`; a running job through its heartbeat), its running
 * stories go back to pending and the open preparation question is dropped.
 * The session is told (by `authorName`, when given). Guidance resumes it later.
 * Each lane's worktree is then cleaned up keeping its local branch
 * (`cleanUpStoppedRun`), once the canceled jobs are through.
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
    await postActivity(conversationFor(run, deps), {
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
    const ok = await quietly(`Canceling job ${jobId} of coding task ${run.id}`, () =>
      deps.dispatcher.cancel(jobId),
    );
    if (ok) canceled += 1;
  }
  await quietly(`Posting the plan of session ${run.trackerSessionId}`, () =>
    publishPlan(conversationFor(run, deps), stopped.stories),
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
  await postActivity(conversationFor(run, deps), content);
  await cleanUpStoppedRun(deps, run.id);
  return { status: "stopped", canceled };
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

/**
 * Posts why the work a run of `issueId` would build can't go on when one of its blocks
 * relations breaks the dependency rules, or when they couldn't be read (`retry` says how to
 * try again); true then.
 */
async function refusedForRelations(
  deps: RalphDeps,
  run: TrackerRun<RalphRun>,
  issueId: string,
  action: string,
  retry: string,
): Promise<boolean> {
  try {
    const violations = await relationViolations(deps.tracker, issueId);
    if (violations.length === 0) return false;
    await postActivity(conversationFor(run, deps), {
      type: "response",
      body: relationsMessage(violations, `${retry.replace("Reply", "reply")} again`),
    });
  } catch (error) {
    console.error(`Checking the relations of ${issueId} failed`, error);
    await postActivity(conversationFor(run, deps), {
      type: "error",
      body: `I couldn't load the issue's relations from ${trackerName(run.trackerProvider)}, so I didn't ${action}: ${error instanceof Error ? error.message : String(error)}. ${retry} again to retry.`,
    });
  }
  return true;
}
