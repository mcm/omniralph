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
  recordFollowUpSource,
  updateRun,
  updateStory,
  type Job,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
  isLinearRun,
  runReference,
} from "@omniralph/db";
import { appendProgress, initialProgress, isDoneStateType } from "@omniralph/ralph";
import {
  excerpt,
  MAX_ATTEMPTS_PER_STORY,
  RalphStoryResult,
  type RalphFollowUp,
  type RalphStoryMetric,
} from "@omniralph/shared";
import { organizationPlaybooks } from "@/lib/definitions";
import type { CreateIssueInput, IssueSummary } from "@/lib/linear/gateway";
import { jobStoryCaps, type StoryCaps } from "./coding";
import { conversationFor } from "./conversation";
import { repositoryManualLabels, runManualLabels } from "./epic-loader";
import { recordStoryHiddenRef } from "./hidden-refs";
import { storyLane } from "./lanes";
import { postActivity, quietly, quote, tail } from "./notify";
import { addRecommendations } from "./recommendations";
import { addRoundMetric, bestValue, isStalled, metricTrend } from "./rounds";
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
    // A coding run's story gets its task's attempts and rounds.
    const caps = await jobStoryCaps(job, organizationPlaybooks(ctx.db, ctx.run.organizationId));
    if (parsed?.success && parsed.data.hiddenRef) {
      // The story commits sit on the run's hidden ref: deleted once the run is over.
      const repositoryId = (await storyLane(ctx.tx, ctx.run, story))?.repositoryId;
      if (repositoryId) await recordStoryHiddenRef(ctx.tx, ctx.run, repositoryId, parsed.data);
    }
    if (parsed?.success) await applyStoryResult(ctx, story, parsed.data, caps);
    else {
      const why = parsed ? "the agent sent an invalid result" : jobFailure(job);
      await recordFailedAttempt(ctx, story, `The previous attempt failed: ${why}.`, {
        maxAttempts: caps.maxAttemptsPerStory,
      });
    }
  }
  return { busy };
}

async function applyStoryResult(
  ctx: OutcomeContext,
  story: RalphStory,
  result: RalphStoryResult,
  caps: StoryCaps,
): Promise<void> {
  const { tx, linear } = ctx;
  let run = ctx.run;
  if (result.progress !== undefined) {
    run = (await updateRun(tx, run.id, { progress: result.progress })) ?? run;
  }
  if (result.recommendations?.length) {
    // Advice for other projects: shown in the run, never filed, and it doesn't change the outcome.
    const recommendations = addRecommendations(
      story.recommendations,
      result.recommendations,
      ctx.now ?? new Date(),
    );
    await updateStory(tx, story.id, { recommendations });
  }
  if (result.status !== "complete") {
    const blocked = result.status === "blocked";
    const wipSha = blocked ? (result.commitSha ?? null) : null;
    if (wipSha) {
      // The blocked story's work so far, pushed as `wip(<ID>)`: it's on the branch now.
      await updateStory(tx, story.id, { commitSha: wipSha });
      const base = run.progress || initialProgress(runReference(run));
      const entry = wipProgressEntry(story, wipSha, result.summary, ctx.now ?? new Date());
      run = (await updateRun(tx, run.id, { progress: appendProgress(base, entry) })) ?? run;
    }
    if (blocked && result.followUps.length > 0) {
      // A round of a review loop: it runs again once its follow-ups are done.
      await recordRound({ ...ctx, run }, story, resultFeedback(result), {
        metric: result.metric,
        wipSha,
        caps,
      });
    } else {
      await recordFailedAttempt({ ...ctx, run }, story, resultFeedback(result), {
        // Another attempt can't get past it.
        setAside: blocked,
        wipSha,
        maxAttempts: caps.maxAttemptsPerStory,
      });
    }
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
    const base = run.progress || initialProgress(runReference(run));
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
  await postActivity(conversationFor(run, ctx), {
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
 * other stories and a reply gives it new ones. A blocked story that filed
 * follow-ups is a round instead (`recordRound`).
 */
export async function recordFailedAttempt(
  ctx: OutcomeContext,
  story: RalphStory,
  feedback: string,
  options: { setAside?: boolean; wipSha?: string | null; maxAttempts?: number } = {},
): Promise<void> {
  const max = options.maxAttempts ?? MAX_ATTEMPTS_PER_STORY;
  const attempt = options.setAside ? Math.max(story.attempts + 1, max) : story.attempts + 1;
  const exhausted = attempt >= max;
  await updateStory(ctx.tx, story.id, {
    status: exhausted ? "exhausted" : "pending",
    attempts: attempt,
    lastFeedback: feedback,
  });
  const conversation = conversationFor(ctx.run, ctx);
  const saved = options.wipSha
    ? ` Its work so far is committed as \`${options.wipSha.slice(0, 10)}\`.`
    : "";
  if (options.setAside) {
    await postActivity(conversation, {
      type: "thought",
      body: `🚧 **${story.identifier}** is blocked, so I'm setting it aside without retrying.${saved} Stories that don't depend on it carry on.\n\n${excerpt(feedback, 1500)}`,
    });
  } else if (exhausted) {
    await postActivity(conversation, {
      type: "error",
      body: `⚠️ **${story.identifier}** did not complete after ${attempt} attempts, so I'm setting it aside. Stories that don't depend on it carry on.\n\n${excerpt(feedback, 1500)}`,
    });
  } else {
    await postActivity(conversation, {
      type: "thought",
      body: `**${story.identifier}** attempt ${attempt}/${max} did not complete; retrying with feedback.${saved}\n\n${excerpt(feedback, 1500)}`,
    });
  }
}

/**
 * Counts a round: a blocked result that filed follow-ups (a review loop
 * filing its fixes), which doesn't use an attempt. The story waits for its
 * blocking follow-ups and runs again, until it reaches `maxRoundsPerStory`
 * or the metric it reports stops beating its best for `stallRounds` rounds:
 * then it is set aside as `exhausted` until a reply gives it fresh rounds.
 */
export async function recordRound(
  ctx: OutcomeContext,
  story: RalphStory,
  feedback: string,
  options: { metric?: RalphStoryMetric; wipSha?: string | null; caps: StoryCaps },
): Promise<void> {
  const { maxRoundsPerStory: max, stallRounds } = options.caps;
  const round = story.rounds + 1;
  const metrics = options.metric
    ? addRoundMetric(story.roundMetrics, options.metric, round, ctx.now ?? new Date())
    : story.roundMetrics;
  const capped = round >= max;
  const stalled = metrics ? isStalled(metrics, stallRounds) : false;
  await updateStory(ctx.tx, story.id, {
    status: capped || stalled ? "exhausted" : "pending",
    rounds: round,
    roundMetrics: metrics,
    lastFeedback: feedback,
  });
  const conversation = conversationFor(ctx.run, ctx);
  const saved = options.wipSha
    ? ` Its work so far is committed as \`${options.wipSha.slice(0, 10)}\`.`
    : "";
  const trend = metrics ? `\n\nTrend: ${metricTrend(metrics)}` : "";
  const setAside =
    "Stories that don't depend on it carry on; reply `/continue` to give it more rounds.";
  if (capped) {
    await postActivity(conversation, {
      type: "error",
      body: `⚠️ **${story.identifier}** reached its round cap (${max} rounds) without completing, so I'm setting it aside.${saved} ${setAside}${trend}\n\n${excerpt(feedback, 1500)}`,
    });
  } else if (stalled && metrics) {
    await postActivity(conversation, {
      type: "error",
      body: `⚠️ **${story.identifier}**'s ${metrics.name} hasn't beaten its best (${bestValue(metrics)}) in ${stallRounds} rounds, so I'm setting it aside after round ${round}.${saved} ${setAside}${trend}\n\n${excerpt(feedback, 1500)}`,
    });
  } else {
    await postActivity(conversation, {
      type: "thought",
      body: `🔁 **${story.identifier}** round ${round}/${max} filed follow-ups; it runs again once they're done.${saved}${trend}\n\n${excerpt(feedback, 1500)}`,
    });
  }
}

/**
 * Files the follow-ups a story turned up as sub-issues of the epic, with the
 * story's team, project, milestone, cycle, priority and labels (manual ones also
 * with the manual label of the story's repository), and records the story as
 * each one's source (`recordFollowUpSource`), so they route as the story does
 * (to its lane's repository); `blocking` makes them block the story, else
 * they block the story's open dependents (the stories it blocks, such as the
 * epic's validation story) so those still wait for the follow-up work. A
 * follow-up with the title of an open sub-issue reuses it, so a retry that
 * reports the same work again doesn't file it twice. Single-issue and chat runs have
 * no epic to file them in.
 */
export async function fileFollowUps(
  ctx: OutcomeContext,
  story: RalphStory,
  followUps: readonly RalphFollowUp[],
  options: { blocking: boolean },
): Promise<void> {
  const { linear, run } = ctx;
  if (followUps.length === 0 || run.kind === "single" || !isLinearRun(run)) return;
  let siblings;
  let parent;
  try {
    parent = await linear.getIssue(run.linearIssueId);
    siblings = await linear.getChildren(parent.id);
  } catch (error) {
    console.warn(`${run.linearIdentifier}: could not read the epic to file follow-ups`, error);
    await postActivity(conversationFor(run, ctx), {
      type: "thought",
      body: `I couldn't file the follow-ups of **${story.identifier}** in Linear: ${followUps.map((f) => `"${f.title}"`).join(", ")}.`,
    });
    return;
  }
  const open = new Map(
    siblings.filter((s) => !isDoneStateType(s.stateType)).map((s) => [s.title.toLowerCase(), s]),
  );
  const own = siblings.find((s) => s.id === story.linearIssueId);
  const target = await followUpTarget(ctx, story, parent, own);
  const { manualLabel } = target;
  // A blocking follow-up holds the story, so its dependents wait for it already.
  const dependents = options.blocking
    ? []
    : await openDependents(ctx, story, [...open.values()]).catch((error: unknown) => {
        console.warn(
          `${run.linearIdentifier}: could not read the dependents of ${story.identifier}`,
          error,
        );
        return [];
      });
  const filed: string[] = [];
  const forPerson: string[] = [];
  const failed: string[] = [];
  for (const followUp of followUps) {
    const labels = labelsFor(target, followUp.manual);
    try {
      const issue =
        open.get(followUp.title.toLowerCase()) ??
        (await createFollowUp(ctx, target, {
          teamId: target.teamId,
          parentId: parent.id,
          title: followUp.title,
          description: `${followUp.description}\n\n_${FOLLOW_UP_MARK} ${story.identifier}._`.trim(),
          priority: target.priority,
          ...(target.projectId && { projectId: target.projectId }),
          ...(target.projectName && { projectName: target.projectName }),
          ...(target.projectMilestoneId && { projectMilestoneId: target.projectMilestoneId }),
          ...(target.cycleId && { cycleId: target.cycleId }),
          ...(labels.length > 0 && { labels }),
        }));
      open.set(followUp.title.toLowerCase(), issue);
      // A reused open sub-issue too (unless it's the story itself).
      if (issue.id !== story.linearIssueId) {
        await recordFollowUpSource(ctx.tx, run.organizationId, issue.id, story.linearIssueId);
        if (options.blocking) await linear.createBlocksRelation(issue.id, story.linearIssueId);
      }
      for (const dependent of dependents) {
        // A reused follow-up may already block it, or be one of the dependents itself.
        if (dependent.issue.id === issue.id || dependent.blockerIds.has(issue.id)) continue;
        await linear.createBlocksRelation(issue.id, dependent.issue.id);
        dependent.blockerIds.add(issue.id);
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
    const blocked = options.blocking
      ? [story.identifier]
      : dependents.map((d) => d.issue.identifier);
    lines.push(
      `Filed ${filed.join(", ")} as ${filed.length === 1 ? "a new story" : "new stories"} of **${run.linearIdentifier}**` +
        (target.repository ? ` in \`${target.repository}\`` : "") +
        `${blocked.length > 0 ? `, blocking ${blocked.map((id) => `**${id}**`).join(", ")}` : ""}.`,
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
    await postActivity(conversationFor(run, ctx), {
      type: "thought",
      body: lines.join(" "),
    });
  }
}

/**
 * Creates a follow-up. Linear may refuse the story's cycle (e.g. once it's
 * completed): then it retries once without it, and later follow-ups skip it.
 */
async function createFollowUp(
  ctx: OutcomeContext,
  target: FollowUpTarget,
  input: CreateIssueInput,
): Promise<IssueSummary> {
  try {
    return await ctx.linear.createIssue(input);
  } catch (error) {
    if (!input.cycleId) throw error;
    console.warn(
      `${ctx.run.linearIdentifier}: could not file follow-up "${input.title}" in cycle ${input.cycleId}, retrying without it`,
      error,
    );
    const { cycleId: _cycleId, ...withoutCycle } = input;
    const issue = await ctx.linear.createIssue(withoutCycle);
    target.cycleId = undefined;
    return issue;
  }
}

/** What a story's follow-ups are filed with (`followUpTarget`). */
interface FollowUpTarget {
  teamId: string;
  /** The project: by ID when known (else by name). */
  projectId?: string;
  projectName?: string;
  projectMilestoneId?: string;
  cycleId?: string;
  priority: number;
  /** Labels every follow-up gets: all of the story's. */
  labels: string[];
  manualLabel: string;
  /** The full path of the story's repository when it isn't the main lane's. */
  repository?: string;
}

/**
 * What a story's follow-ups copy: its team, project, milestone, cycle, priority
 * and labels (read from Linear; when that fails, what the epic's children say,
 * else the epic's team and project). The manual label is the story's lane's
 * repository's.
 */
async function followUpTarget(
  ctx: OutcomeContext,
  story: RalphStory,
  parent: IssueSummary,
  own: IssueSummary | undefined,
): Promise<FollowUpTarget> {
  const { run } = ctx;
  const lane = await storyLane(ctx.tx, run, story);
  const repository =
    lane && lane.repositoryId !== run.repositoryId
      ? await getRepository(ctx.db, lane.repositoryId)
      : null;
  const [manualLabel = "manual"] = repository
    ? repositoryManualLabels(repository)
    : await runManualLabels(ctx.db, run);
  const where = { manualLabel, ...(repository && { repository: repository.fullPath }) };
  const source = await ctx.linear.getRoutingFields(story.linearIssueId).then(
    (fields) => fields.issue,
    (error: unknown) => {
      console.warn(`${run.linearIdentifier}: could not read ${story.identifier}'s fields`, error);
      return null;
    },
  );
  if (source) {
    return {
      teamId: source.teamId ?? own?.teamId ?? parent.teamId,
      ...(source.projectId && { projectId: source.projectId }),
      ...(source.project && { projectName: source.project }),
      ...(source.projectMilestoneId && { projectMilestoneId: source.projectMilestoneId }),
      ...(source.cycle && { cycleId: source.cycle }),
      priority: source.priority,
      labels: source.labels,
      ...where,
    };
  }
  const from = own ?? parent;
  return {
    teamId: from.teamId,
    ...(from.projectName && { projectName: from.projectName }),
    priority: own?.priority ?? 0,
    labels: own?.labels ?? [],
    ...where,
  };
}

/** A follow-up's labels: the target's, and the manual label for a manual one. */
function labelsFor(target: FollowUpTarget, manual: boolean): string[] {
  const has = target.labels.some((l) => l.toLowerCase() === target.manualLabel.toLowerCase());
  return manual && !has ? [...target.labels, target.manualLabel] : target.labels;
}

/** The open sibling stories `story` blocks, with the IDs of their blockers. */
async function openDependents(
  ctx: OutcomeContext,
  story: RalphStory,
  openSiblings: readonly IssueSummary[],
): Promise<{ issue: IssueSummary; blockerIds: Set<string> }[]> {
  const siblings = await Promise.all(
    openSiblings
      .filter((s) => s.id !== story.linearIssueId)
      .map(async (issue) => ({
        issue,
        blockerIds: new Set((await ctx.linear.getBlockers(issue.id)).map((b) => b.id)),
      })),
  );
  return siblings.filter((s) => s.blockerIds.has(story.linearIssueId));
}
