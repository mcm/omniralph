import "server-only";
import {
  createReview,
  createReviewRun,
  deleteReviewRun,
  finishReview,
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  getReview,
  listActiveJobsByDedupePrefix,
  listActiveReviewRuns,
  listReviewRunReviews,
  previousReviewState,
  skipReviewRuns,
  type Database,
  type Job,
  type Repository,
  type Review,
} from "@omniralph/db";
import {
  DOCUMENTATION_DEPTHS,
  documentationCheckContext,
  FindingCategory,
  LOOPED_REVIEW_CHECK_TYPES,
  MAX_OPEN_FINDING_BODY_CHARS,
  REVIEW_TASK_JOB_TYPE,
  ReviewTriggerContext,
  reviewProfileConfigForDepth,
  type ReviewCheckType,
  type ReviewDepth,
  type ReviewMode,
} from "@omniralph/shared";
import {
  playbookLoopSettings,
  type Playbook,
  type TaskDefinition,
  type TriggerKind,
} from "@omniralph/tasks";
import type { JobDispatcher } from "@/lib/dispatch";
import { advanceLoop } from "@/lib/runs/loop";
import {
  getPlaybookTask,
  organizationPlaybooks,
  taskJobInput,
  type PlaybookSource,
} from "@/lib/playbooks";
import { documentationIterationJobKey } from "./docs-loop";
import { reviewIdOfJob, reviewJobKey, reviewJobKeyPrefix, reviewPassJobKey } from "./job-review";
import { firstPass, startDocumentationCheckLoop, startReviewLoop } from "./loop";

export interface EnqueueReviewInput {
  repositoryId: string;
  /** PR number (GitHub) or MR IID (GitLab). */
  prNumber: number;
  baseSha: string;
  headSha: string;
  title: string;
  description: string | null;
  /** PR/MR author's username. */
  author: string | null;
  trigger: Review["trigger"];
  /**
   * `incremental` (default, webhooks) reviews only the commits since the PR's
   * last completed review; `full` reviews the whole diff at head
   * (`@bot review`, Re-run › Incremental). Both drop duplicates of the PR's
   * open findings. `fresh` (`@bot review fresh`, Re-run › Fresh) reviews the
   * whole diff with no open findings passed, so nothing is dropped; matching
   * earlier open findings are superseded when it completes. `incremental`
   * and `full` reviews also re-check the open findings they're given and
   * resolve the ones they find fixed.
   */
  mode?: ReviewMode;
  /** Review depth to use instead of the repository's (`@bot review deep`, a re-run). */
  depth?: ReviewDepth | null;
}

/** The longest PR/MR description a review trigger context carries. */
export const MAX_DESCRIPTION_CHARS = 100_000;
const TRUNCATED_MARKER = "\n\n[Description truncated: it is longer than 100,000 characters.]";

/**
 * Cuts a PR/MR description longer than the trigger context allows, ending it
 * with a marker, so a long description doesn't keep the review from being
 * enqueued.
 */
export function truncateDescription(description: string | null): string | null {
  if (description === null || description.length <= MAX_DESCRIPTION_CHARS) return description;
  return description.slice(0, MAX_DESCRIPTION_CHARS - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
}

/**
 * One task run of a review run: the review task, its review and its job (a
 * looped review's: one check type's review and its first pass's job).
 */
export interface ReviewTaskRun {
  taskId: string;
  /** The check type of a looped review's task run; null for a single pass. */
  checkType: ReviewCheckType | null;
  reviewId: string;
  jobId: string;
}

export type EnqueueReviewResult =
  | {
      status: "enqueued" | "duplicate";
      reviewRunId: string;
      /** The review run's task runs, in the repository's task order. */
      runs: ReviewTaskRun[];
      /** The first task run's review and job (e.g. for a link to the review). */
      reviewId: string;
      jobId: string;
      /** Jobs of older head SHAs of the PR that were canceled. */
      canceledJobIds: string[];
    }
  | { status: "repository_unavailable" }
  /** None of the repository's review tasks is a review task taking this trigger. */
  | { status: "no_review_tasks" };

/** The task trigger of each way a review is requested. */
const TRIGGER_KINDS: Record<Review["trigger"], TriggerKind> = {
  webhook: "pr.updated",
  mention: "pr.mention",
  manual: "review.rerun",
};

export { reviewIdOfJob };

export { reviewJobKey, reviewJobKeyPrefix };

/** The documentation check a review run adds when its repo's check isn't off. */
export const DOCUMENTATION_CHECK_TASK_ID = "builtin:check-docs";

/** The playbook role of documentation checks: they run only as the repo's documentation check. */
const DOCUMENTATION_CHECK_ROLE = "docs-check";

/**
 * The review task IDs of a review run of `repository`: its review tasks,
 * then the documentation check (`builtin:check-docs`) when its
 * `documentationCheck` isn't `off`. A repo with the check off runs exactly
 * its review tasks.
 */
export function reviewTaskIdsOf(
  repository: Pick<Repository, "reviewPlaybookIds" | "documentationCheck">,
): string[] {
  if (repository.documentationCheck === "off") return [...repository.reviewPlaybookIds];
  return [...repository.reviewPlaybookIds, DOCUMENTATION_CHECK_TASK_ID];
}

/**
 * A review task that only writes a summary: its sink is `sticky-comment`, so
 * its review is left out of the run's correlation and posted review.
 */
export function isSummaryOnlyTask(task: Pick<TaskDefinition, "sink">): boolean {
  return task.sink === "sticky-comment";
}

/**
 * Whether runs of review task `task` (playbook `playbook`) loop: a review
 * task that posts findings, whose playbook names a finding verifier
 * (`loop.verifierPlaybookId`). Its run fans out one looped review per check
 * type (`LOOPED_REVIEW_CHECK_TYPES`); any other review task runs one pass.
 */
export function isLoopedReviewTask(
  task: Pick<TaskDefinition, "sink">,
  playbook: Pick<Playbook, "role" | "loop"> | null,
): boolean {
  if (!playbook || isSummaryOnlyTask(task)) return false;
  return (playbookLoopSettings(playbook)?.verifierPlaybookId ?? null) !== null;
}

/**
 * The review tasks a review run of `trigger` fans out to: each of
 * `taskIds` (deduplicated, in order) that is a review task accepting the
 * trigger. Unknown and non-review task IDs are skipped with a warning.
 */
export async function reviewTasksFor(
  taskIds: readonly string[],
  trigger: Review["trigger"],
  context: { repositoryId: string },
  definitions: PlaybookSource,
): Promise<TaskDefinition[]> {
  const tasks: TaskDefinition[] = [];
  for (const id of new Set(taskIds)) {
    const task = await getPlaybookTask(definitions, id);
    if (!task || task.taskType !== "review") {
      console.warn(
        task
          ? "skipping a review task that isn't a review task"
          : "skipping an unknown review task",
        { repositoryId: context.repositoryId, taskId: id },
      );
      continue;
    }
    if (task.triggers.includes(TRIGGER_KINDS[trigger])) tasks.push(task);
  }
  return tasks;
}

/**
 * Enqueues a review run of a PR/MR head: cancels the PR's queued or running
 * review jobs for older head SHAs (all tasks; their reviews and review runs
 * become `skipped`, and the correlation job of a correlating one is
 * canceled), then creates the `queued` review run and, for each of
 * the repository's review tasks taking this trigger (`reviewTasksFor`), a
 * `queued` review and a `review.task` job running that task (routed by the
 * task: task type `review`). A looped review task (`isLoopedReviewTask`)
 * gets one review per check type instead, each the loop of its passes
 * (`startReviewLoop`) whose first pass's job is created now, capped at the
 * depth's passes. When the repo's documentation check isn't `off`, the run
 * also has the documentation check (`builtin:check-docs`, `reviewTaskIdsOf`):
 * one summary-only review whose loop (`startDocumentationCheckLoop`) runs at
 * the repo's documentation depth over the whole diff, posted as its sticky
 * comment once it ends. Each job's trigger (`pr.updated`,
 * `pr.mention` or `review.rerun`) carries the review config resolved now
 * (the depth's preset, rules, instructions, excludes), the PR text, the mode and the
 * previous review's head SHA (none for a `full` review) and open findings
 * (neither for a `fresh` one), read once for the whole run, as a
 * `ReviewTriggerContext`; the job is claimed as a run spec and its result
 * applied by the `review` sink. The payload holds no credentials. A second
 * call for the same head while its jobs are active returns that review run
 * (`duplicate`) and creates nothing.
 */
export async function enqueueReview(
  db: Database,
  dispatcher: JobDispatcher,
  input: EnqueueReviewInput,
): Promise<EnqueueReviewResult> {
  const found = await getRepositoryWithConnection(db, input.repositoryId);
  const settings = found && (await getRepositoryReviewSettings(db, input.repositoryId));
  if (!found || !settings || found.repository.disconnectedAt || !found.repository.reviewsEnabled) {
    return { status: "repository_unavailable" };
  }
  const { repository } = found;

  const depth = input.depth ?? settings.depth;
  const profile = reviewProfileConfigForDepth(depth);

  const definitions = organizationPlaybooks(db, repository.organizationId);
  const tasks = await reviewTasksFor(
    reviewTaskIdsOf(repository),
    input.trigger,
    { repositoryId: repository.id },
    definitions,
  );
  if (tasks.length === 0) return { status: "no_review_tasks" };

  const prefix = reviewJobKeyPrefix(input.repositoryId, input.prNumber);
  const headKey = `${prefix}${input.headSha}:`;
  const active = await listActiveJobsByDedupePrefix(db, prefix);

  // The same head's review run is still active: return it.
  const sameHead = active.filter((job) => job.dedupeKey?.startsWith(headKey));
  const existing = await activeReviewRun(db, sameHead);
  if (existing) return { status: "duplicate", ...existing, canceledJobIds: [] };

  const canceledJobIds: string[] = [];
  const superseded = `Superseded by a newer push (${input.headSha.slice(0, 12)})`;
  const older = active.filter(
    (job) => job.dedupeKey !== `${prefix}${input.headSha}` && !sameHead.includes(job),
  );
  const olderRunIds = new Set<string>();
  for (const job of older) {
    const reviewId = reviewIdOfJob(job.payload);
    const review = reviewId ? await getReview(db, reviewId) : null;
    if (review?.reviewRunId) olderRunIds.add(review.reviewRunId);
  }
  // Older runs without active review jobs, e.g. correlating: their correlation job is canceled too.
  const olderRuns = await listActiveReviewRuns(db, {
    repositoryId: input.repositoryId,
    prNumber: input.prNumber,
    exceptHeadSha: input.headSha,
  });
  for (const run of olderRuns) olderRunIds.add(run.id);
  // The runs first, so that their canceled reviews don't fail them.
  await skipReviewRuns(db, [...olderRunIds], superseded);
  for (const run of olderRuns) {
    if (run.status !== "correlating" || !run.correlationJobId) continue;
    await dispatcher.cancel(run.correlationJobId);
    canceledJobIds.push(run.correlationJobId);
  }
  for (const job of older) {
    const canceled = await dispatcher.cancel(job.id);
    canceledJobIds.push(job.id);
    const reviewId = reviewIdOfJob(job.payload);
    if (reviewId) await finishReview(db, reviewId, { status: "skipped", error: superseded });
    // A looped review's queued pass or verifier ends its loop now (a running one when its
    // agent stops it): the loop leaves the superseded review skipped.
    if (canceled === "canceled") await advanceLoop(db, job, { status: "canceled" });
  }

  const mode = input.mode ?? "incremental";
  const previous = mode === "fresh" ? null : await previousReviewState(db, input);
  const reviewRun = await createReviewRun(db, {
    organizationId: repository.organizationId,
    repositoryId: input.repositoryId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    trigger: input.trigger,
    mode,
    depth,
    prAuthor: input.author,
  });
  const context = {
    repositoryId: input.repositoryId,
    repository: repository.fullPath,
    prNumber: input.prNumber,
    pr: {
      number: input.prNumber,
      title: input.title.trim(),
      body: truncateDescription(input.description?.trim() || null),
    },
    baseSha: input.baseSha,
    headSha: input.headSha,
    changeRequest: {
      title: input.title,
      description: truncateDescription(input.description),
      author: input.author,
    },
    reviewConfig: {
      profile,
      customInstructions: settings.customInstructions,
      rules: settings.rules.map((r) => ({ kind: r.kind, text: r.text, enabled: r.enabled })),
      pathExcludes: settings.pathExcludes,
    },
    mode,
    previousReview: previous && {
      headSha: mode === "full" ? null : previous.headSha,
      openFindings: previous.openFindings.flatMap((f) => {
        const category = FindingCategory.safeParse(f.category);
        return category.success
          ? [
              {
                ...f,
                category: category.data,
                title: f.title.slice(0, 200),
                body: f.body.slice(0, MAX_OPEN_FINDING_BODY_CHARS),
              },
            ]
          : [];
      }),
    },
  } satisfies Omit<ReviewTriggerContext, "reviewId">;

  /**
   * The documentation check's task run: one summary-only review whose loop
   * (`startDocumentationCheckLoop`) runs at the repo's documentation depth
   * (its model and token cap), over the whole diff at head (`full`, no
   * open findings): its comment replaces the last head's.
   */
  async function enqueueDocumentationCheck(
    task: TaskDefinition,
    playbook: Playbook,
  ): Promise<ReviewTaskRun> {
    const documentationDepth = repository.documentationDepth;
    const preset = DOCUMENTATION_DEPTHS[documentationDepth];
    const review = await createReview(db, {
      reviewRunId: reviewRun.id,
      taskId: task.id,
      summaryOnly: isSummaryOnlyTask(task),
      checkType: null,
      repositoryId: input.repositoryId,
      prNumber: input.prNumber,
      prTitle: input.title,
      headSha: input.headSha,
      baseSha: input.baseSha,
      trigger: input.trigger,
      depth,
      model: preset.model,
      budget: preset.maxTokens,
    });
    const triggerContext = ReviewTriggerContext.parse({
      ...context,
      reviewId: review.id,
      mode: "full",
      previousReview: null,
      documentation: documentationCheckContext(documentationDepth),
    });
    const { job, created } = await startDocumentationCheckLoop(
      db,
      dispatcher,
      review,
      playbook,
      documentationDepth,
      {
        organizationId: repository.organizationId,
        type: REVIEW_TASK_JOB_TYPE,
        ...(await taskJobInput(definitions, task, {
          trigger: { kind: TRIGGER_KINDS[input.trigger], context: triggerContext },
          repositoryId: input.repositoryId,
          ref: input.headSha,
        })),
        reviewRunId: reviewRun.id,
        dedupeKey: documentationIterationJobKey(triggerContext, task.id, 1),
      },
    );
    // A concurrent enqueue of the same head got there first.
    if (!created) throw new DuplicateReviewRun(job);
    return { taskId: task.id, checkType: null, reviewId: review.id, jobId: job.id };
  }

  const runs: ReviewTaskRun[] = [];
  try {
    for (const task of tasks) {
      const playbook = await definitions.getPlaybook(task.id);
      if (playbook?.role === DOCUMENTATION_CHECK_ROLE) {
        runs.push(await enqueueDocumentationCheck(task, playbook));
        continue;
      }
      const checkTypes: readonly (ReviewCheckType | null)[] = isLoopedReviewTask(task, playbook)
        ? LOOPED_REVIEW_CHECK_TYPES
        : [null];
      for (const checkType of checkTypes) {
        const review = await createReview(db, {
          reviewRunId: reviewRun.id,
          taskId: task.id,
          summaryOnly: isSummaryOnlyTask(task),
          checkType,
          repositoryId: input.repositoryId,
          prNumber: input.prNumber,
          prTitle: input.title,
          headSha: input.headSha,
          baseSha: input.baseSha,
          trigger: input.trigger,
          depth,
          model: profile.model,
          budget: profile.maxTokensPerReview,
        });
        const jobInput = {
          organizationId: repository.organizationId,
          type: REVIEW_TASK_JOB_TYPE,
          ...(await taskJobInput(definitions, task, {
            trigger: {
              kind: TRIGGER_KINDS[input.trigger],
              context: ReviewTriggerContext.parse({
                ...context,
                reviewId: review.id,
                ...(checkType && { pass: firstPass(checkType) }),
              }),
            },
            repositoryId: input.repositoryId,
            ref: input.headSha,
          })),
          reviewRunId: reviewRun.id,
        };
        const { job, created } =
          checkType && playbook
            ? await startReviewLoop(db, dispatcher, review, playbook, depth, {
                ...jobInput,
                dedupeKey: reviewPassJobKey(
                  input.repositoryId,
                  input.prNumber,
                  input.headSha,
                  task.id,
                  checkType,
                  1,
                ),
              })
            : await dispatcher.createAndPublish({
                ...jobInput,
                dedupeKey: reviewJobKey(input.repositoryId, input.prNumber, input.headSha, task.id),
              });
        if (!created) {
          // A concurrent enqueue of the same head got there first.
          throw new DuplicateReviewRun(job);
        }
        runs.push({ taskId: task.id, checkType, reviewId: review.id, jobId: job.id });
      }
    }
  } catch (error) {
    // Nothing of this review run is left: its jobs (also one inserted before
    // the error) are canceled, then the run and its reviews deleted.
    const reviewIds = new Set(
      (await listReviewRunReviews(db, reviewRun.id)).map((review) => review.id),
    );
    for (const job of await listActiveJobsByDedupePrefix(db, headKey)) {
      const reviewId = reviewIdOfJob(job.payload);
      if (reviewId && reviewIds.has(reviewId)) await dispatcher.cancel(job.id);
    }
    await deleteReviewRun(db, reviewRun.id);
    if (!(error instanceof DuplicateReviewRun)) throw error;
    const duplicate = await activeReviewRun(db, [error.job]);
    if (!duplicate) throw new Error(`Review job ${error.job.id} has no review run`);
    return { status: "duplicate", ...duplicate, canceledJobIds };
  }
  return {
    status: "enqueued",
    reviewRunId: reviewRun.id,
    runs,
    reviewId: runs[0]!.reviewId,
    jobId: runs[0]!.jobId,
    canceledJobIds,
  };
}

/** A job of the same head was already active when a review run of the head was enqueued. */
class DuplicateReviewRun extends Error {
  constructor(readonly job: Job) {
    super(`Review job ${job.id} of the same head is active`);
  }
}

/**
 * The review run of the first of `jobs` that has one, with its task runs
 * whose jobs are still active; null when none has a review run.
 */
async function activeReviewRun(
  db: Database,
  jobs: readonly Job[],
): Promise<{
  reviewRunId: string;
  runs: ReviewTaskRun[];
  reviewId: string;
  jobId: string;
} | null> {
  for (const job of jobs) {
    const reviewId = reviewIdOfJob(job.payload);
    const review = reviewId ? await getReview(db, reviewId) : null;
    if (!review?.reviewRunId) continue;
    const reviewRunId = review.reviewRunId;
    const runReviews = await listReviewRunReviews(db, reviewRunId);
    const prefix = reviewJobKeyPrefix(review.repositoryId, review.prNumber);
    const runJobs = await listActiveJobsByDedupePrefix(db, `${prefix}${review.headSha}:`);
    const runs = runReviews.flatMap((r) => {
      const runJob = runJobs.find((j) => reviewIdOfJob(j.payload) === r.id);
      return runJob && r.taskId
        ? [
            {
              taskId: r.taskId,
              checkType: (r.checkType as ReviewCheckType | null) ?? null,
              reviewId: r.id,
              jobId: runJob.id,
            },
          ]
        : [];
    });
    const first = runs[0] ?? { reviewId: review.id, jobId: job.id };
    return { reviewRunId, runs, reviewId: first.reviewId, jobId: first.jobId };
  }
  return null;
}
