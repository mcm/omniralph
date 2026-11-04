/**
 * Runs a task again once the outside blockers its session reported (its cross-epic
 * dependencies, `ralph_stories.cross_epic_blockers`, recorded by `blockOnReported`) are over.
 * Their work reaches the task's branch only through the default branch, never through a merge:
 *
 * - When at least one of them was completed, the task's lane is rebased onto its base branch
 *   first: a request (`ralph_messages`) the orchestrator queues on that lane, run as a
 *   `ralph.request` job before the task (`prepareCrossEpicStories`). Its outcome
 *   (`settleRebaseRequests`) clears the pending rebase and lets the task run, or sets the task
 *   aside with the rebase still pending until a reply or `/continue`. Under
 *   `historyRewrite: never` no request is queued: the task is set aside and a person is asked.
 * - When every one of them was canceled, the default branch has nothing new from them: the
 *   task runs again as it is (`rerunAfterCancel`; a rerun that doesn't complete files a
 *   follow-up for a person, `outcome.ts`).
 */
import {
  getRepositoryWithConnection,
  insertMessage,
  listPendingRequests,
  updateStory,
  type Job,
  type RalphCrossEpicBlocker,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
} from "@omniralph/db";
import { isStoryReady, type Story } from "@omniralph/ralph";
import { excerpt, type RalphRequestResult } from "@omniralph/shared";
import { conversationFor } from "./conversation";
import { storyLane } from "./lanes";
import { postActivity } from "./notify";
import { jobFailure, REBASE_FEEDBACK } from "./outcome";
import type { RalphDeps } from "./run";

/** How a rebase request's session says it couldn't rebase (the start of its summary). */
export const REBASE_FAILED_MARK = "Rebase failed:";

const bold = (blockers: readonly Pick<RalphCrossEpicBlocker, "identifier">[]) =>
  blockers.map((b) => `**${b.identifier}**`).join(", ");

/** "**ENG-1** is" / "**ENG-1**, **ENG-2** are". */
const areDone = (blockers: readonly RalphCrossEpicBlocker[]) =>
  `${bold(blockers)} ${blockers.length === 1 ? "is" : "are"} done`;

/**
 * The request that rebases a lane's branch onto its base branch, for `story`, which waited on
 * `blockers`. It never merges: a rebase that can't be finished is aborted and reported.
 */
export function rebaseRequestText(input: {
  story: Pick<RalphStory, "identifier" | "title">;
  blockers: readonly RalphCrossEpicBlocker[];
  branch: string;
  baseBranch: string;
}): string {
  const { story, blockers, branch, baseBranch } = input;
  return [
    `Rebase \`${branch}\` onto the latest \`${baseBranch}\`. ${areDone(blockers)}, so ${blockers.length === 1 ? "its" : "their"} work is on \`${baseBranch}\` now, and ${story.identifier} (${story.title}) needs it before it runs again. This is the rebase the orchestrator asks for: do it.`,
    [
      `1. \`git fetch origin && git rebase origin/${baseBranch}\`.`,
      "2. Resolve any conflicts, keeping the intent of both sides.",
      "3. Run the repository's quality gates and fix what the rebase broke.",
      `4. Call \`ship\` with \`forceWithLease: true\` to publish \`${branch}\`. If the lease is rejected (someone else pushed), stop and report it instead of overwriting their work.`,
    ].join("\n"),
    `Never merge \`${baseBranch}\` or any other branch into \`${branch}\`, not even when the rebase is hard: a merge mixes other history into this branch. Don't start ${story.identifier} either; it runs after this request.`,
    `If you can't finish the rebase cleanly, run \`git rebase --abort\` so \`${branch}\` stays as it was, push nothing, and start your summary with \`${REBASE_FAILED_MARK}\` followed by why.`,
  ].join("\n\n");
}

/** What `prepareCrossEpicStories` decided. */
export interface CrossEpicPreparation {
  /** Keys of stories that may not run now (their rebase is queued or running). */
  held: Set<string>;
  /** The pending rebase request to run before anything else, if any. */
  rebaseRequestId: string | null;
  /** Whether a story row changed (re-read them). */
  changed: boolean;
}

/**
 * Before a story is selected (inside `lockRun`): each pending, otherwise ready story with
 * recorded cross-epic blockers that are all over gets its rebase pending (one was completed)
 * or is marked to rerun as it is (all were canceled). A story with its rebase pending is held
 * while its rebase request is queued or running; one without a request gets one on its lane,
 * unless the lane repository's `historyRewrite` is `never`: then it's set aside (`exhausted`,
 * until a reply or `/continue`) and the thread asks a person to step in.
 */
export async function prepareCrossEpicStories(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { stories: readonly Story[]; rows: readonly RalphStory[] },
): Promise<CrossEpicPreparation> {
  const out: CrossEpicPreparation = { held: new Set(), rebaseRequestId: null, changed: false };
  const candidates = input.rows.filter(
    (r) =>
      r.status === "pending" &&
      (r.crossEpicBlockers.length > 0 || r.rebasePending || r.rebaseRequestId),
  );
  if (candidates.length === 0) return out;
  const pending = new Set((await listPendingRequests(tx, run.id)).map((m) => m.id));
  const stories = [...input.stories];
  for (let row of candidates) {
    const story = stories.find((s) => (s.issueId ?? s.key) === row.trackerIssueId);
    if (!story) continue;
    // Its rebase request is queued or running: it waits for that.
    if (row.rebaseRequestId && pending.has(row.rebaseRequestId)) {
      out.held.add(story.key);
      out.rebaseRequestId ??= row.rebaseRequestId;
      continue;
    }
    if (row.rebaseRequestId) {
      row = (await updateStory(tx, row.id, { rebaseRequestId: null })) ?? row;
      out.changed = true;
    }
    if (!isStoryReady(story, stories)) continue;
    if (!row.rebasePending) {
      const over = await blockersOver(deps, row.crossEpicBlockers);
      // One is still open (the run was told to start anyway): it runs as it is.
      if (!over) continue;
      out.changed = true;
      if (over.completed.length > 0) {
        row = (await updateStory(tx, row.id, { rebasePending: true })) ?? row;
      } else {
        await updateStory(tx, row.id, {
          crossEpicBlockers: [],
          rerunAfterCancel: true,
          canceledBlockers: row.crossEpicBlockers,
        });
        await postActivity(conversationFor(run, deps), {
          type: "thought",
          body: `${bold(row.crossEpicBlockers)} ${row.crossEpicBlockers.length === 1 ? "was" : "were"} canceled, so the default branch has nothing new for **${row.identifier}**: it runs again as it is, without a rebase.`,
        });
        continue;
      }
    }
    const queued = await queueRebase(deps, tx, run, row);
    out.changed = true;
    if (queued) {
      out.held.add(story.key);
      out.rebaseRequestId ??= queued;
    }
  }
  return out;
}

/** Whether every recorded blocker is over (null while one is open or can't be read), and which were completed. */
async function blockersOver(
  deps: RalphDeps,
  blockers: readonly RalphCrossEpicBlocker[],
): Promise<{ completed: RalphCrossEpicBlocker[] } | null> {
  // Independent reads, so they run together rather than one round trip after another.
  const states = await Promise.all(
    blockers.map((blocker) =>
      deps.tracker.getIssue(blocker.id).then(
        (issue): string | null => issue.stateType,
        (error) => {
          console.warn(`Could not read ${blocker.identifier}`, error);
          return null;
        },
      ),
    ),
  );
  if (states.some((state) => state !== "completed" && state !== "canceled")) return null;
  const completed = blockers.filter((_, i) => states[i] === "completed");
  return { completed };
}

/**
 * Queues the request that rebases `row`'s lane onto its base branch, returning its ID; or,
 * when the lane repository forbids history rewrites, sets the story aside with the rebase
 * pending and asks a person to step in (null).
 */
async function queueRebase(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  row: RalphStory,
): Promise<string | null> {
  const lane = await storyLane(tx, run, row);
  if (!lane) return null;
  const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
  const blockers = row.crossEpicBlockers;
  const conversation = conversationFor(run, deps);
  if (found?.repository.historyRewrite === "never") {
    const why =
      `\`${found.repository.fullPath}\` doesn't allow history rewrites (**Rewrite history** is set to never), ` +
      `so I can't rebase \`${lane.branch}\` onto \`${lane.baseBranch}\`, and I never merge another branch into it instead.`;
    await updateStory(tx, row.id, {
      status: "exhausted",
      lastFeedback: `${REBASE_FEEDBACK} ${areDone(blockers)}, but ${why}`,
    });
    await postActivity(conversation, {
      type: "elicitation",
      body: [
        `🙋 ${areDone(blockers)}, so **${row.identifier}** needs \`${lane.branch}\` brought up to date with \`${lane.baseBranch}\` before it runs again. ${why}`,
        `I'm setting **${row.identifier}** aside. Please step in: rebase the branch yourself, or allow history rewrites for the repository under **Repos**, then reply or send \`/continue\` and I'll check again.`,
      ].join("\n\n"),
    });
    return null;
  }
  const message = await insertMessage(tx, {
    runId: run.id,
    // The main lane's requests have no lane.
    laneId: lane.repositoryId === run.repositoryId ? null : lane.id,
    kind: "request",
    text: rebaseRequestText({
      story: row,
      blockers,
      branch: lane.branch,
      baseBranch: lane.baseBranch,
    }),
    author: null,
  });
  await updateStory(tx, row.id, { rebaseRequestId: message.id });
  await postActivity(conversation, {
    type: "thought",
    body: `🔀 ${areDone(blockers)}, so I'm rebasing \`${lane.branch}\` onto \`${lane.baseBranch}\` before **${row.identifier}** runs again.`,
  });
  return message.id;
}

/** Why a finished rebase request didn't rebase, or null when it did. */
export function rebaseFailure(job: Job, result: RalphRequestResult | null): string | null {
  if (!result)
    return job.status === "completed" ? "the agent sent an invalid result" : jobFailure(job);
  if (result.error) return result.error;
  const summary = result.summary.trim();
  if (summary.toLowerCase().startsWith(REBASE_FAILED_MARK.toLowerCase())) {
    return summary.slice(REBASE_FAILED_MARK.length).trim() || "the session didn't say why";
  }
  return null;
}

/**
 * Applies a finished `ralph.request` job to the stories whose rebase request it ran (inside
 * `lockRun`, from `applyRequestJob`): a rebase that went through clears the pending rebase and
 * the recorded blockers, and the story runs next with its attempts and rounds; one that didn't
 * sets the story aside with the rebase still pending (a reply or `/continue` queues it again)
 * and says why in the thread.
 */
export async function settleRebaseRequests(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: {
    job: Job;
    requestIds: readonly string[];
    rows: readonly RalphStory[];
    result: RalphRequestResult | null;
    branch: string;
    baseBranch: string;
  },
): Promise<void> {
  const ids = new Set(input.requestIds);
  const rows = input.rows.filter((r) => r.rebaseRequestId && ids.has(r.rebaseRequestId));
  if (rows.length === 0) return;
  const failure = rebaseFailure(input.job, input.result);
  const { branch, baseBranch } = input;
  const conversation = conversationFor(run, deps);
  for (const row of rows) {
    const blockers = row.crossEpicBlockers;
    if (failure === null) {
      await updateStory(tx, row.id, {
        rebasePending: false,
        rebaseRequestId: null,
        crossEpicBlockers: [],
        lastFeedback:
          `The session reported it was blocked by ${bold(blockers)}. ${areDone(blockers)} now, and ` +
          `\`${branch}\` was rebased onto \`${baseBranch}\`, which has ${blockers.length === 1 ? "its" : "their"} work: continue the story.`,
      });
      await postActivity(conversation, {
        type: "thought",
        body: `🔀 Rebased \`${branch}\` onto \`${baseBranch}\`, which now has the work of ${bold(blockers)}. **${row.identifier}** is continuing.`,
      });
      continue;
    }
    const why = excerpt(failure, 1500);
    await updateStory(tx, row.id, {
      status: "exhausted",
      rebaseRequestId: null,
      lastFeedback: `${REBASE_FEEDBACK} Rebasing \`${branch}\` onto \`${baseBranch}\` failed: ${why}`,
    });
    await postActivity(conversation, {
      type: "error",
      body: `⚠️ I couldn't rebase \`${branch}\` onto \`${baseBranch}\`, so **${row.identifier}** stays set aside with the rebase pending: ${why}\n\nReply or send \`/continue\` to try the rebase again before **${row.identifier}** runs.`,
    });
  }
}
