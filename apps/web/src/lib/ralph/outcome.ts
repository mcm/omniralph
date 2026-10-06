/**
 * Applies the outcome of a finished `ralph.story` job to its run (ported from
 * cyralph's `EpicEngine.runStory`, `completeStory` and `fileFollowUps`). Runs
 * inside the run's row lock, from `advanceRun`: the story being `running`
 * with this job as its `last_job_id` is what makes it happen exactly once.
 */
import {
  getJob,
  getRepository,
  listStories,
  updateRun,
  updateStory,
  type Job,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
} from "@omniralph/db";
import { appendProgress, initialProgress, isDoneStateType } from "@omniralph/ralph";
import { MAX_ATTEMPTS_PER_STORY, RalphStoryResult, type RalphFollowUp } from "@omniralph/shared";
import { runManualLabels } from "./epic-loader";
import { storyLane } from "./lanes";
import { postActivity, quietly, quote, tail } from "./notify";
import type { RalphDeps } from "./run";

/** Marks follow-ups the orchestrator filed (cyralph's `FOLLOW_UP_MARK`). */
export const FOLLOW_UP_MARK = "Filed by Omniralph while working on";

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["queued", "running"]);

/** Why a job that didn't complete failed, for the next attempt's feedback. */
export function jobFailure(job: Job | null): string {
  if (!job) return "its job is gone";
  if (job.error) return job.error;
  switch (job.status) {
    case "canceled":
      return "the job was canceled";
    case "expired":
      return "no agent picked up the job in time";
    case "skipped":
      return "the job was skipped";
    default:
      return "the job failed without an error message";
  }
}

/** The stored feedback for a story result that didn't complete. */
function resultFeedback(result: RalphStoryResult): string {
  if (result.feedback?.trim()) return result.feedback;
  const summary = quote(tail(result.summary || "(no summary)", 3000));
  switch (result.status) {
    case "blocked":
      return `${BLOCKED_FEEDBACK} Its summary was:\n\n${summary}`;
    case "incomplete":
      return `The previous session reported the story incomplete. Its summary was:\n\n${summary}`;
    default:
      return `The previous attempt failed. Its summary was:\n\n${summary}`;
  }
}

/** The progress log entry of a completed story whose session didn't write one. */
function progressEntry(story: RalphStory, summary: string, now: Date): string {
  return [
    `## [${now.toISOString().slice(0, 10)}] - ${story.identifier}: ${story.title}`,
    summary.trim() || "Completed.",
    "---",
  ].join("\n");
}

/** The progress log entry of a blocked story whose work so far was committed as `wip`. */
function wipProgressEntry(story: RalphStory, sha: string, summary: string, now: Date): string {
  return [
    `## [${now.toISOString().slice(0, 10)}] - ${story.identifier}: ${story.title} (blocked)`,
    `- Work so far committed as \`wip(${story.identifier})\` in \`${sha.slice(0, 10)}\`.`,
    `- Blocked: ${tail(summary.trim() || "no summary", 1500)}`,
    "---",
  ].join("\n");
}

/** Whether a story's stored feedback says its session reported it blocked. */
export function isBlockedFeedback(feedback: string | null | undefined): boolean {
  return feedback?.startsWith(BLOCKED_FEEDBACK) === true;
}

const BLOCKED_FEEDBACK = "The previous session reported it was blocked.";

export interface OutcomeContext extends RalphDeps {
  tx: RalphTransaction;
  run: RalphRun;
  now?: Date;
}

/**
 * Applies the outcome of every `running` story whose job has finished. Returns
 * true while one of the run's story jobs is still queued or running.
 */
export async function applyJobOutcomes(ctx: OutcomeContext): Promise<{ busy: boolean }> {
  let busy = false;
  for (const story of await listStories(ctx.tx, ctx.run.id)) {
    if (story.status !== "running") continue;
    const job = story.lastJobId ? await getJob(ctx.db, story.lastJobId) : null;
    if (job && ACTIVE_JOB_STATUSES.has(job.status)) {
      busy = true;
      continue;
    }
    const parsed = job?.status === "completed" ? RalphStoryResult.safeParse(job.result) : null;
    if (parsed?.success) await applyStoryResult(ctx, story, parsed.data);
    else {
      const why = parsed ? "the agent sent an invalid result" : jobFailure(job);
      await recordFailedAttempt(ctx, story, `The previous attempt failed: ${why}.`);
    }
  }
  return { busy };
}

async function applyStoryResult(
  ctx: OutcomeContext,
  story: RalphStory,
  result: RalphStoryResult,
): Promise<void> {
  const { tx, linear } = ctx;
  let run = ctx.run;
  if (result.progress !== undefined) {
    run = (await updateRun(tx, run.id, { progress: result.progress })) ?? run;
  }
  if (result.status !== "complete") {
    const blocked = result.status === "blocked";
    const wipSha = blocked ? (result.commitSha ?? null) : null;
    if (wipSha) {
      // The blocked story's work so far, pushed as `wip(<ID>)`: it's on the branch now.
      await updateStory(tx, story.id, { commitSha: wipSha });
      const base = run.progress || initialProgress(run.linearIdentifier);
      const entry = wipProgressEntry(story, wipSha, result.summary, ctx.now ?? new Date());
      run = (await updateRun(tx, run.id, { progress: appendProgress(base, entry) })) ?? run;
    }
    await recordFailedAttempt({ ...ctx, run }, story, resultFeedback(result), {
      // Another attempt can't get past it; blocking follow-ups hold its retry instead.
      setAside: blocked && result.followUps.length === 0,
      wipSha,
    });
    // Work the story turned up has to be done first (cyralph: follow-ups of an unfinished story block it).
    await fileFollowUps({ ...ctx, run }, story, result.followUps, { blocking: true });
    return;
  }

  const sha = result.commitSha ?? null;
  await updateStory(tx, story.id, {
    status: "completed",
    attempts: story.attempts + 1,
    commitSha: sha,
    lastFeedback: null,
  });
  if (result.progress === undefined) {
    const base = run.progress || initialProgress(run.linearIdentifier);
    const entry = progressEntry(story, result.summary, ctx.now ?? new Date());
    run = (await updateRun(tx, run.id, { progress: appendProgress(base, entry) })) ?? run;
  }

  // A single issue stays open for review: its run's PR/MR is what finishes it.
  if (run.kind !== "single") {
    await quietly(`Completing ${story.identifier} in Linear`, () =>
      linear.setIssueState(story.linearIssueId, { type: "completed" }),
    );
    const lane = await storyLane(tx, run, story);
    // A story of another lane says which repository it was done in.
    const repository =
      lane && lane.repositoryId !== run.repositoryId
        ? await getRepository(ctx.db, lane.repositoryId)
        : null;
    const where = repository ? ` in \`${repository.fullPath}\`` : "";
    const note = [
      `✅ Completed by Omniralph${sha ? ` in \`${sha.slice(0, 10)}\`` : ""} on \`${lane?.branch ?? ""}\`${where}.`,
      "",
      tail(result.summary.trim() || "Done.", 4000),
    ].join("\n");
    await quietly(`Commenting on ${story.identifier}`, () =>
      linear.addComment(story.linearIssueId, note),
    );
  }

  const stories = await listStories(tx, run.id);
  const done = stories.filter((s) => s.status === "completed" || s.status === "canceled").length;
  await postActivity(linear, run.linearAgentSessionId, {
    type: "thought",
    body: `✅ **${story.identifier}** complete${sha ? ` (\`${sha.slice(0, 10)}\`)` : ""}. ${done}/${stories.length} stories done.`,
  });
  await fileFollowUps({ ...ctx, run }, story, result.followUps, { blocking: false });
}

/**
 * Counts a finished attempt that didn't complete the story (failed,
 * incomplete or blocked): stores the feedback and retries it, or, out of
 * attempts, sets it aside as `exhausted`. `setAside` (a blocked story) uses
 * up the remaining attempts at once, as cyralph does: the run carries on with
 * other stories and a reply gives it new ones. A blocked story's blocking
 * follow-ups hold its retry until they're done.
 */
export async function recordFailedAttempt(
  ctx: OutcomeContext,
  story: RalphStory,
  feedback: string,
  options: { setAside?: boolean; wipSha?: string | null } = {},
): Promise<void> {
  const max = MAX_ATTEMPTS_PER_STORY;
  const attempt = options.setAside ? Math.max(story.attempts + 1, max) : story.attempts + 1;
  const exhausted = attempt >= max;
  await updateStory(ctx.tx, story.id, {
    status: exhausted ? "exhausted" : "pending",
    attempts: attempt,
    lastFeedback: feedback,
  });
  const sessionId = ctx.run.linearAgentSessionId;
  const saved = options.wipSha
    ? ` Its work so far is committed as \`${options.wipSha.slice(0, 10)}\`.`
    : "";
  if (options.setAside) {
    await postActivity(ctx.linear, sessionId, {
      type: "thought",
      body: `🚧 **${story.identifier}** is blocked, so I'm setting it aside without retrying.${saved} Stories that don't depend on it carry on.\n\n${tail(feedback, 1500)}`,
    });
  } else if (exhausted) {
    await postActivity(ctx.linear, sessionId, {
      type: "error",
      body: `⚠️ **${story.identifier}** did not complete after ${attempt} attempts, so I'm setting it aside. Stories that don't depend on it carry on.\n\n${tail(feedback, 1500)}`,
    });
  } else {
    await postActivity(ctx.linear, sessionId, {
      type: "thought",
      body: `**${story.identifier}** attempt ${attempt}/${max} did not complete; retrying with feedback.${saved}\n\n${tail(feedback, 1500)}`,
    });
  }
}

/**
 * Files the follow-ups a story turned up as sub-issues of the epic (manual
 * ones with the manual label); `blocking` makes them block the story. A
 * follow-up with the title of an open sub-issue reuses it, so a retry that
 * reports the same work again doesn't file it twice. Single-issue runs have
 * no epic to file them in.
 */
export async function fileFollowUps(
  ctx: OutcomeContext,
  story: RalphStory,
  followUps: readonly RalphFollowUp[],
  options: { blocking: boolean },
): Promise<void> {
  const { linear, run } = ctx;
  if (followUps.length === 0 || run.kind === "single") return;
  let siblings;
  let parent;
  try {
    parent = await linear.getIssue(run.linearIssueId);
    siblings = await linear.getChildren(parent.id);
  } catch (error) {
    console.warn(`${run.linearIdentifier}: could not read the epic to file follow-ups`, error);
    await postActivity(linear, run.linearAgentSessionId, {
      type: "thought",
      body: `I couldn't file the follow-ups of **${story.identifier}** in Linear: ${followUps.map((f) => `"${f.title}"`).join(", ")}.`,
    });
    return;
  }
  const open = new Map(
    siblings.filter((s) => !isDoneStateType(s.stateType)).map((s) => [s.title.toLowerCase(), s]),
  );
  const priority = siblings.find((s) => s.id === story.linearIssueId)?.priority ?? 0;
  const [manualLabel = "manual"] = await runManualLabels(ctx.db, run);
  const filed: string[] = [];
  const forPerson: string[] = [];
  const failed: string[] = [];
  for (const followUp of followUps) {
    try {
      const issue =
        open.get(followUp.title.toLowerCase()) ??
        (await linear.createIssue({
          teamId: parent.teamId,
          parentId: parent.id,
          title: followUp.title,
          description: `${followUp.description}\n\n_${FOLLOW_UP_MARK} ${story.identifier}._`.trim(),
          priority,
          ...(parent.projectName && { projectName: parent.projectName }),
          ...(followUp.manual && { labels: [manualLabel] }),
        }));
      open.set(followUp.title.toLowerCase(), issue);
      if (options.blocking && issue.id !== story.linearIssueId) {
        await linear.createBlocksRelation(issue.id, story.linearIssueId);
      }
      filed.push(`**${issue.identifier}**`);
      if (followUp.manual) forPerson.push(`**${issue.identifier}**`);
    } catch (error) {
      console.warn(`${run.linearIdentifier}: could not file follow-up "${followUp.title}"`, error);
      failed.push(`"${followUp.title}"`);
    }
  }
  const lines: string[] = [];
  if (filed.length > 0) {
    lines.push(
      `Filed ${filed.join(", ")} as ${filed.length === 1 ? "a new story" : "new stories"} of **${run.linearIdentifier}**` +
        `${options.blocking ? `, blocking **${story.identifier}**` : ""}.`,
    );
  }
  if (forPerson.length > 0) {
    lines.push(
      `${forPerson.join(", ")} ${forPerson.length === 1 ? "is a manual step" : "are manual steps"} for a person ` +
        `(labelled \`${manualLabel}\`): I won't work ${forPerson.length === 1 ? "it" : "them"}.`,
    );
  }
  if (failed.length > 0) lines.push(`I couldn't file ${failed.join(", ")} in Linear.`);
  if (lines.length > 0) {
    await postActivity(linear, run.linearAgentSessionId, {
      type: "thought",
      body: lines.join(" "),
    });
  }
}
