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
  type RalphPendingFollowUp,
  type RalphStory,
  type RalphTaskVerification,
  type RalphTransaction,
  isTrackerRun,
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
import { trackerName } from "@/lib/tracker/adapters";
import { organizationPlaybooks } from "@/lib/playbooks";
import type { CreateIssueInput, IssuePriority, IssueSummary } from "@omniralph/tracker";
import { createIssueWithExtras, readIssuePlacement } from "@/lib/tracker/placement";
import { jobStoryCaps, type StoryCaps } from "./coding";
import { conversationFor } from "./conversation";
import { runManualLabels } from "./epic-loader";
import { recordStoryHiddenRef } from "./hidden-refs";
import { storyLane } from "./lanes";
import { postActivity, quietly, quote, tail } from "./notify";
import { addRecommendations } from "./recommendations";
import { addRoundMetric, bestValue, isStalled, metricTrend } from "./rounds";
import type { RalphDeps } from "./run";
import { runningVerification, startTaskVerifier, verificationOutcome } from "./verify";

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
    // The task verifier of an attempt its session reported complete finished.
    const verification = runningVerification(story);
    if (verification) {
      await applyVerification(ctx, story, verification, job);
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
    if (parsed?.success && job) await applyStoryResult(ctx, story, job, parsed.data, caps);
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
  job: Job,
  result: RalphStoryResult,
  caps: StoryCaps,
): Promise<void> {
  const { tx } = ctx;
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
    // Follow-ups that follow the epic never hold the story, so they don't make a round.
    if (blocked && result.followUps.some((f) => !followsEpic(f))) {
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

  // Done only once an independent verifier has checked it against its acceptance criteria.
  const verifier = await startTaskVerifier({ ...ctx, run }, story, job, result);
  if (verifier.started) return;
  if (verifier.problem) {
    await postActivity(conversationFor(run, ctx), {
      type: "thought",
      body: `⚠️ I couldn't start the verifier for **${story.identifier}** (${verifier.problem}), so it counts as done as its session reported.`,
    });
  }
  await completeStory({ ...ctx, run }, story, {
    summary: result.summary,
    commitSha: result.commitSha ?? null,
    followUps: result.followUps,
    wroteProgress: result.progress !== undefined,
  });
}

/**
 * Applies a finished task verifier (`verification`, its job `job`) to its story, under
 * the run's row lock: the check is stored in the story's `verifications`; a verdict that
 * accepts every criterion completes the story; one that sends a criterion back fails the
 * attempt with the reasons as its feedback (`recordFailedAttempt`, the story job's
 * attempts); a verifier that couldn't check (it failed, was canceled or answered nothing
 * usable) is noted in the thread and the story completes as its session reported, so a
 * broken verifier never holds the epic up.
 */
async function applyVerification(
  ctx: OutcomeContext,
  story: RalphStory,
  verification: RalphTaskVerification,
  job: Job | null,
): Promise<void> {
  const now = ctx.now ?? new Date();
  const outcome = verificationOutcome(verification, job, now);
  const verifications = story.verifications.map((v) =>
    v.jobId === verification.jobId ? outcome.verification : v,
  );
  const updated =
    (await updateStory(ctx.tx, story.id, {
      verifications,
      // A sent-back attempt's commit is on the branch all the same.
      ...(outcome.kind === "rejected" && verification.commitSha
        ? { commitSha: verification.commitSha }
        : {}),
    })) ?? story;
  const pending = verification.pending ?? { summary: "", followUps: [], wroteProgress: true };
  if (outcome.kind === "rejected") {
    const storyJob = await getJob(ctx.db, verification.storyJobId);
    const caps = await jobStoryCaps(
      storyJob,
      organizationPlaybooks(ctx.db, ctx.run.organizationId),
    );
    await recordFailedAttempt(ctx, updated, outcome.feedback, {
      maxAttempts: caps.maxAttemptsPerStory,
    });
    return;
  }
  if (outcome.kind === "failed") {
    await postActivity(conversationFor(ctx.run, ctx), {
      type: "thought",
      body: `⚠️ I couldn't verify **${story.identifier}** against its acceptance criteria (${outcome.verification.error}), so it counts as done as its session reported.`,
    });
  }
  await completeStory(ctx, updated, {
    summary: pending.summary,
    commitSha: verification.commitSha,
    followUps: pending.followUps,
    wroteProgress: pending.wroteProgress,
    verified: outcome.kind === "accepted" ? outcome.verification.criteria.length : null,
  });
}

/** What completing a story applies: its session's report. */
interface CompletedAttempt {
  summary: string;
  commitSha: string | null;
  followUps: readonly (RalphFollowUp | RalphPendingFollowUp)[];
  /** The session wrote the progress log itself (else an entry is added from the summary). */
  wroteProgress: boolean;
  /** Criteria the verifier accepted; null or absent when it wasn't verified. */
  verified?: number | null;
}

/**
 * Completes a story: `completed` with the attempt counted and its commit, a progress
 * entry when its session didn't write one, the work item completed with a comment (not
 * for a single issue, whose PR/MR finishes it), a note in the thread and its follow-ups
 * filed (they block its open dependents).
 */
async function completeStory(
  ctx: OutcomeContext,
  story: RalphStory,
  attempt: CompletedAttempt,
): Promise<void> {
  const { tx, tracker } = ctx;
  let run = ctx.run;
  const sha = attempt.commitSha;
  await updateStory(tx, story.id, {
    status: "completed",
    attempts: story.attempts + 1,
    commitSha: sha,
    lastFeedback: null,
  });
  if (!attempt.wroteProgress) {
    const base = run.progress || initialProgress(runReference(run));
    const entry = progressEntry(story, attempt.summary, ctx.now ?? new Date());
    run = (await updateRun(tx, run.id, { progress: appendProgress(base, entry) })) ?? run;
  }

  // A single issue stays open for review: its run's PR/MR is what finishes it.
  if (run.kind !== "single") {
    await quietly(`Completing ${story.identifier} in the tracker`, () =>
      tracker.setIssueState(story.trackerIssueId, { type: "completed" }),
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
      tail(attempt.summary.trim() || "Done.", 4000),
    ].join("\n");
    await quietly(`Commenting on ${story.identifier}`, () =>
      tracker.addComment(story.trackerIssueId, note),
    );
  }

  const stories = await listStories(tx, run.id);
  const done = stories.filter((s) => s.status === "completed" || s.status === "canceled").length;
  const verified = attempt.verified
    ? ` Verified against ${attempt.verified === 1 ? "its acceptance criterion" : `its ${attempt.verified} acceptance criteria`}.`
    : "";
  await postActivity(conversationFor(run, ctx), {
    type: "thought",
    body: `✅ **${story.identifier}** complete${sha ? ` (\`${sha.slice(0, 10)}\`)` : ""}.${verified} ${done}/${stories.length} stories done.`,
  });
  await fileFollowUps({ ...ctx, run }, story, attempt.followUps, { blocking: false });
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

/** A follow-up that can only happen once the epic ships (`after: "epic"`). */
function followsEpic(followUp: RalphFollowUp): boolean {
  return followUp.after === "epic";
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
 * reports the same work again doesn't file it twice. A follow-up that follows
 * the epic (`after: "epic"`) is filed as a standalone task in the epic's team
 * and project instead, blocked by the epic and blocking nothing
 * (`fileEpicFollowers`). Single-issue and chat runs have no epic to file them in.
 */
export async function fileFollowUps(
  ctx: OutcomeContext,
  story: RalphStory,
  followUps: readonly RalphFollowUp[],
  options: { blocking: boolean },
): Promise<void> {
  const { tracker, run } = ctx;
  if (followUps.length === 0 || run.kind === "single" || !isTrackerRun(run)) return;
  let siblings;
  let parent;
  try {
    parent = await tracker.getIssue(run.trackerIssueId);
    siblings = await tracker.getChildren(parent.id);
  } catch (error) {
    console.warn(`${run.trackerIdentifier}: could not read the epic to file follow-ups`, error);
    await postActivity(conversationFor(run, ctx), {
      type: "thought",
      body: `I couldn't file the follow-ups of **${story.identifier}** in ${trackerName(run.trackerProvider)}: ${followUps.map((f) => `"${f.title}"`).join(", ")}.`,
    });
    return;
  }
  const open = new Map(
    siblings.filter((s) => !isDoneStateType(s.stateType)).map((s) => [s.title.toLowerCase(), s]),
  );
  const own = siblings.find((s) => s.id === story.trackerIssueId);
  const target = await followUpTarget(ctx, story, parent, own);
  const { manualLabel } = target;
  // A blocking follow-up holds the story, so its dependents wait for it already.
  const dependents = options.blocking
    ? []
    : await openDependents(ctx, story, [...open.values()]).catch((error: unknown) => {
        console.warn(
          `${run.trackerIdentifier}: could not read the dependents of ${story.identifier}`,
          error,
        );
        return [];
      });
  const filed: string[] = [];
  const forPerson: string[] = [];
  const failed: string[] = [];
  const following = await fileEpicFollowers(
    ctx,
    story,
    parent,
    target,
    followUps.filter(followsEpic),
  );
  forPerson.push(...following.forPerson);
  failed.push(...following.failed);
  for (const followUp of followUps.filter((f) => !followsEpic(f))) {
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
          ...(labels.length > 0 && { labels }),
        }));
      open.set(followUp.title.toLowerCase(), issue);
      // A reused open sub-issue too (unless it's the story itself).
      if (issue.id !== story.trackerIssueId) {
        await recordFollowUpSource(ctx.tx, run.organizationId, issue.id, story.trackerIssueId);
        if (options.blocking) await tracker.createBlocksRelation(issue.id, story.trackerIssueId);
      }
      for (const dependent of dependents) {
        // A reused follow-up may already block it, or be one of the dependents itself.
        if (dependent.issue.id === issue.id || dependent.blockerIds.has(issue.id)) continue;
        await tracker.createBlocksRelation(issue.id, dependent.issue.id);
        dependent.blockerIds.add(issue.id);
      }
      filed.push(`**${issue.identifier}**`);
      if (followUp.manual) forPerson.push(`**${issue.identifier}**`);
    } catch (error) {
      console.warn(`${run.trackerIdentifier}: could not file follow-up "${followUp.title}"`, error);
      failed.push(`"${followUp.title}"`);
    }
  }
  const lines: string[] = [];
  if (filed.length > 0) {
    const blocked = options.blocking
      ? [story.identifier]
      : dependents.map((d) => d.issue.identifier);
    lines.push(
      `Filed ${filed.join(", ")} as ${filed.length === 1 ? "a new story" : "new stories"} of **${run.trackerIdentifier}**` +
        (target.repository ? ` in \`${target.repository}\`` : "") +
        `${blocked.length > 0 ? `, blocking ${blocked.map((id) => `**${id}**`).join(", ")}` : ""}.`,
    );
  }
  if (following.filed.length > 0) {
    const tasks = following.filed;
    lines.push(
      `Filed ${tasks.join(", ")} as ${tasks.length === 1 ? "a task" : "tasks"} that ${tasks.length === 1 ? "follows" : "follow"} **${run.trackerIdentifier}**` +
        (target.repository ? ` in \`${target.repository}\`` : "") +
        `, blocked by it: ${tasks.length === 1 ? "it needs" : "they need"} the epic to ship first, so ${tasks.length === 1 ? "it doesn't" : "they don't"} hold up its stories.`,
    );
  }
  if (forPerson.length > 0) {
    lines.push(
      `${forPerson.join(", ")} ${forPerson.length === 1 ? "is a manual step" : "are manual steps"} for a person ` +
        `(labelled \`${manualLabel}\`): I won't work ${forPerson.length === 1 ? "it" : "them"}.`,
    );
  }
  if (failed.length > 0) {
    lines.push(`I couldn't file ${failed.join(", ")} in ${trackerName(run.trackerProvider)}.`);
  }
  if (lines.length > 0) {
    await postActivity(conversationFor(run, ctx), {
      type: "thought",
      body: lines.join(" "),
    });
  }
}

/** A gap an epic audit found, to file as a task of the epic (`fileAuditGaps`). */
export interface AuditGap {
  /** The requirement (`FR-2`) and its text. */
  id: string;
  text: string;
  /** What is missing, and the title of the task that closes it (may be blank). */
  missing: string;
  title: string;
}

/** The title of the task that closes an audit gap: the audit's, else one from the requirement. */
export function auditGapTitle(gap: Pick<AuditGap, "id" | "text" | "title">): string {
  const title = gap.title.replace(/\s+/g, " ").trim();
  if (title) return title.slice(0, 200);
  const text = gap.text.replace(/\s+/g, " ").trim();
  return `Meet ${gap.id}: ${text.length > 150 ? `${text.slice(0, 149)}…` : text}`;
}

/** The description of the task that closes an audit gap: the requirement it covers, what's missing and its criterion. */
function auditGapDescription(run: RalphRun, gap: AuditGap, round: number): string {
  return [
    `Covers: ${gap.id}`,
    "",
    `The audit of ${run.trackerIdentifier} against its requirements (round ${round}) found this requirement isn't met yet:`,
    "",
    quote(`${gap.id}: ${gap.text}`),
    "",
    gap.missing.trim() ? `What is missing: ${gap.missing.trim()}` : "",
    "",
    "## Acceptance Criteria",
    "",
    `- [ ] ${gap.id} holds: ${gap.text.replace(/\s+/g, " ").trim()}`,
    "",
    `_${FOLLOW_UP_MARK} the audit of ${run.trackerIdentifier}._`,
  ]
    .filter((line, i, lines) => line !== "" || lines[i - 1] !== "")
    .join("\n");
}

/**
 * Files the gaps an epic audit found as new tasks (sub-issues) of the epic, with the
 * epic's team, project, the tracker's extras (e.g. a milestone and cycle) and priority,
 * so the run works them before its PR/MR opens. A gap whose task title matches an open
 * sub-issue reuses it, so an audit that reports the same gap again doesn't file it twice.
 * Returns the identifiers of the tasks filed (or reused) and the titles it couldn't file.
 */
export async function fileAuditGaps(
  ctx: OutcomeContext,
  gaps: readonly AuditGap[],
  round: number,
): Promise<{ filed: string[]; failed: string[] }> {
  const { tracker, run } = ctx;
  const filed: string[] = [];
  const failed: string[] = [];
  if (gaps.length === 0 || !isTrackerRun(run)) return { filed, failed };
  let parent;
  let siblings;
  try {
    parent = await tracker.getIssue(run.trackerIssueId);
    siblings = await tracker.getChildren(parent.id);
  } catch (error) {
    console.warn(`${run.trackerIdentifier}: could not read the epic to file its audit gaps`, error);
    return { filed, failed: gaps.map(auditGapTitle) };
  }
  const open = new Map(
    siblings.filter((s) => !isDoneStateType(s.stateType)).map((s) => [s.title.toLowerCase(), s]),
  );
  const placement = await readIssuePlacement(tracker, parent.id).catch((error: unknown) => {
    console.warn(`${run.trackerIdentifier}: could not read the epic's fields`, error);
    return null;
  });
  const target: FollowUpTarget = {
    teamId: placement?.teamId ?? parent.teamId,
    ...((placement?.projectId ?? parent.projectId) && {
      projectId: placement?.projectId ?? parent.projectId,
    }),
    ...((placement?.projectName ?? parent.projectName) && {
      projectName: placement?.projectName ?? parent.projectName,
    }),
    extras: placement?.extras ?? {},
    priority: placement?.priority ?? parent.priority ?? 0,
    labels: [],
    manualLabel: "manual",
  };
  for (const gap of gaps) {
    const title = auditGapTitle(gap);
    try {
      const issue =
        open.get(title.toLowerCase()) ??
        (await createFollowUp(ctx, target, {
          teamId: target.teamId,
          parentId: parent.id,
          title,
          description: auditGapDescription(run, gap, round),
          priority: target.priority,
          ...(target.projectId && { projectId: target.projectId }),
          ...(target.projectName && { projectName: target.projectName }),
        }));
      open.set(title.toLowerCase(), issue);
      if (!filed.includes(issue.identifier)) filed.push(issue.identifier);
    } catch (error) {
      console.warn(`${run.trackerIdentifier}: could not file audit gap "${title}"`, error);
      failed.push(title);
    }
  }
  return { filed, failed };
}

/**
 * Files the follow-ups that can only happen once the epic ships as standalone
 * tasks: in the epic's team and project (none of the story's milestone or
 * cycle), with the story's priority and labels, blocked by the epic. They
 * never block the story or any other task. An open standalone task with the
 * same title that the epic already blocks is reused, so a retry doesn't file
 * it twice.
 */
async function fileEpicFollowers(
  ctx: OutcomeContext,
  story: RalphStory,
  epic: IssueSummary,
  target: FollowUpTarget,
  followUps: readonly RalphFollowUp[],
): Promise<{ filed: string[]; forPerson: string[]; failed: string[] }> {
  const { tracker, run } = ctx;
  const filed: string[] = [];
  const forPerson: string[] = [];
  const failed: string[] = [];
  for (const followUp of followUps) {
    const labels = labelsFor(target, followUp.manual);
    const reason = followUp.reason?.trim();
    try {
      const issue =
        (await existingEpicFollower(ctx, epic, followUp.title)) ??
        (await tracker.createIssue({
          teamId: epic.teamId,
          title: followUp.title,
          description: [
            followUp.description,
            reason ? `It follows ${epic.identifier}: ${reason}` : `It follows ${epic.identifier}.`,
            `_${FOLLOW_UP_MARK} ${story.identifier}._`,
          ]
            .filter((part) => part.trim())
            .join("\n\n"),
          priority: target.priority,
          ...(epic.projectId && { projectId: epic.projectId }),
          ...(epic.projectName && { projectName: epic.projectName }),
          ...(labels.length > 0 && { labels }),
        }));
      await recordFollowUpSource(ctx.tx, run.organizationId, issue.id, story.trackerIssueId);
      const blockers = await tracker.getBlockers(issue.id);
      if (!blockers.some((b) => b.id === epic.id)) {
        await tracker.createBlocksRelation(epic.id, issue.id);
      }
      filed.push(`**${issue.identifier}**`);
      if (followUp.manual) forPerson.push(`**${issue.identifier}**`);
    } catch (error) {
      console.warn(`${run.trackerIdentifier}: could not file follow-up "${followUp.title}"`, error);
      failed.push(`"${followUp.title}"`);
    }
  }
  return { filed, forPerson, failed };
}

/** An open standalone task titled `title` that `epic` blocks (a follow-up filed before). */
async function existingEpicFollower(
  ctx: OutcomeContext,
  epic: IssueSummary,
  title: string,
): Promise<IssueSummary | undefined> {
  const matches = await ctx.tracker.searchIssues(title, { first: 20 }).catch((error: unknown) => {
    console.warn(`${ctx.run.trackerIdentifier}: could not search for "${title}"`, error);
    return [];
  });
  for (const issue of matches) {
    if (issue.title.toLowerCase() !== title.toLowerCase()) continue;
    if (issue.parentId || isDoneStateType(issue.stateType)) continue;
    const blockers = await ctx.tracker.getBlockers(issue.id);
    if (blockers.some((b) => b.id === epic.id)) return issue;
  }
  return undefined;
}

/**
 * Creates a follow-up with the target's tracker-specific extras. When the
 * tracker refuses one (e.g. a completed cycle), it retries without it, and
 * later follow-ups skip it.
 */
async function createFollowUp(
  ctx: OutcomeContext,
  target: FollowUpTarget,
  input: CreateIssueInput,
): Promise<IssueSummary> {
  const { issue, extras } = await createIssueWithExtras(ctx.tracker, input, target.extras);
  target.extras = extras;
  return issue;
}

/** What a story's follow-ups are filed with (`followUpTarget`). */
interface FollowUpTarget {
  teamId: string;
  /** The project: by ID when known (else by name). */
  projectId?: string;
  projectName?: string;
  /** Tracker-specific fields copied as they are (e.g. a milestone and cycle). */
  extras: Record<string, string>;
  priority: IssuePriority;
  /** Labels every follow-up gets: all of the story's. */
  labels: string[];
  manualLabel: string;
  /** The full path of the story's repository when it isn't the main lane's. */
  repository?: string;
}

/**
 * What a story's follow-ups copy: its team, project, priority, labels and the
 * tracker's extras such as a milestone and cycle (read from the tracker; when that fails, what the epic's children say,
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
  const [manualLabel = "manual"] = await runManualLabels(ctx.db, run);
  const where = { manualLabel, ...(repository && { repository: repository.fullPath }) };
  const source = await readIssuePlacement(ctx.tracker, story.trackerIssueId).catch(
    (error: unknown) => {
      console.warn(`${run.trackerIdentifier}: could not read ${story.identifier}'s fields`, error);
      return null;
    },
  );
  if (source) {
    return {
      teamId: source.teamId ?? own?.teamId ?? parent.teamId,
      ...(source.projectId && { projectId: source.projectId }),
      ...(source.projectName && { projectName: source.projectName }),
      extras: source.extras,
      priority: source.priority,
      labels: source.labels,
      ...where,
    };
  }
  const from = own ?? parent;
  return {
    teamId: from.teamId,
    ...(from.projectName && { projectName: from.projectName }),
    extras: {},
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
      .filter((s) => s.id !== story.trackerIssueId)
      .map(async (issue) => ({
        issue,
        blockerIds: new Set((await ctx.tracker.getBlockers(issue.id)).map((b) => b.id)),
      })),
  );
  return siblings.filter((s) => s.blockerIds.has(story.trackerIssueId));
}
