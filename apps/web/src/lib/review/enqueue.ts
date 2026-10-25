import "server-only";
import {
  createReview,
  createReviewRun,
  deleteReviewRun,
  finishReview,
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  getReview,
  getReviewProfile,
  listActiveJobsByDedupePrefix,
  listActiveReviewRuns,
  listReviewRunReviews,
  previousReviewState,
  skipReviewRuns,
  type Database,
  type Job,
  type Review,
  resolveRepositorySwitches,
} from "@omniralph/db";
import {
  FindingCategory,
  MAX_OPEN_FINDING_BODY_CHARS,
  REVIEW_TASK_JOB_TYPE,
  ReviewTriggerContext,
  type ReviewMode,
} from "@omniralph/shared";
import type { TaskDefinition, TriggerKind } from "@omniralph/tasks";
import type { JobDispatcher } from "@/lib/dispatch";
import { organizationDefinitions, taskJobInput, type DefinitionSource } from "@/lib/definitions";
import { reviewIdOfJob } from "./job-review";

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
  /** Review profile to use instead of the repository's (`@bot review deep`). */
  profileId?: string | null;
}

/** One task run of a review run: the review task, its review and its job. */
export interface ReviewTaskRun {
  taskId: string;
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
  | { status: "profile_not_found" }
  /** None of the repository's review tasks is a review task taking this trigger. */
  | { status: "no_review_tasks" };

/** The task trigger of each way a review is requested. */
const TRIGGER_KINDS: Record<Review["trigger"], TriggerKind> = {
  webhook: "pr.updated",
  mention: "pr.mention",
  manual: "review.rerun",
};

export { reviewIdOfJob };

/**
 * Dedupe key prefix of a PR's review jobs; the full key adds the head SHA and
 * the review task ID (`review.run:<repositoryId>:<pr>:<headSha>:<taskId>`).
 * It keeps the name of the removed `review.run` job type, so the keys of jobs
 * enqueued before review task jobs became `review.task` still match.
 */
export function reviewJobKeyPrefix(repositoryId: string, prNumber: number): string {
  return `review.run:${repositoryId}:${prNumber}:`;
}

/** Dedupe key of the job of review task `taskId` of a PR head. */
export function reviewJobKey(
  repositoryId: string,
  prNumber: number,
  headSha: string,
  taskId: string,
): string {
  return `${reviewJobKeyPrefix(repositoryId, prNumber)}${headSha}:${taskId}`;
}

/**
 * A review task that only writes a summary: its sink is `sticky-comment`, so
 * its review is left out of the run's correlation and posted review.
 */
export function isSummaryOnlyTask(task: Pick<TaskDefinition, "sink">): boolean {
  return task.sink === "sticky-comment";
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
  definitions: DefinitionSource,
): Promise<TaskDefinition[]> {
  const tasks: TaskDefinition[] = [];
  for (const id of new Set(taskIds)) {
    const task = await definitions.getTask(id);
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
 * task: task type `review`, its pool). Each job's trigger (`pr.updated`,
 * `pr.mention` or `review.rerun`) carries the review config resolved now
 * (profile, rules, instructions, excludes), the PR text, the mode and the
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
  if (
    !found ||
    !settings ||
    found.repository.disconnectedAt ||
    !(await resolveRepositorySwitches(db, found.repository)).review
  ) {
    return { status: "repository_unavailable" };
  }
  const { repository } = found;

  // Only a profile of the repository's organization.
  const profile = input.profileId
    ? await getReviewProfile(db, repository.organizationId, input.profileId)
    : settings.profile;
  if (!profile) return { status: "profile_not_found" };

  const definitions = organizationDefinitions(db, repository.organizationId);
  const tasks = await reviewTasksFor(
    repository.reviewTaskIds,
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
    await dispatcher.cancel(job.id);
    canceledJobIds.push(job.id);
    const reviewId = reviewIdOfJob(job.payload);
    if (reviewId) await finishReview(db, reviewId, { status: "skipped", error: superseded });
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
    profileId: profile.id,
    profileName: profile.name,
    prAuthor: input.author,
  });
  const context = {
    repositoryId: input.repositoryId,
    repository: repository.fullPath,
    prNumber: input.prNumber,
    pr: {
      number: input.prNumber,
      title: input.title.trim(),
      body: input.description?.trim() || null,
    },
    baseSha: input.baseSha,
    headSha: input.headSha,
    changeRequest: {
      title: input.title,
      description: input.description,
      author: input.author,
    },
    reviewConfig: {
      profile: {
        id: profile.id,
        name: profile.name,
        model: profile.model,
        maxTokensPerReview: profile.maxTokensPerReview,
        maxFiles: profile.maxFiles,
        allowRepoExploration: profile.allowRepoExploration,
      },
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

  const runs: ReviewTaskRun[] = [];
  try {
    for (const task of tasks) {
      const review = await createReview(db, {
        reviewRunId: reviewRun.id,
        taskId: task.id,
        summaryOnly: isSummaryOnlyTask(task),
        repositoryId: input.repositoryId,
        prNumber: input.prNumber,
        prTitle: input.title,
        headSha: input.headSha,
        baseSha: input.baseSha,
        trigger: input.trigger,
        profileId: profile.id,
        model: profile.model,
        budget: profile.maxTokensPerReview,
      });
      const { job, created } = await dispatcher.createAndPublish({
        organizationId: repository.organizationId,
        type: REVIEW_TASK_JOB_TYPE,
        ...(await taskJobInput(definitions, task, {
          trigger: {
            kind: TRIGGER_KINDS[input.trigger],
            context: ReviewTriggerContext.parse({ ...context, reviewId: review.id }),
          },
          repositoryId: input.repositoryId,
          ref: input.headSha,
        })),
        reviewRunId: reviewRun.id,
        dedupeKey: reviewJobKey(input.repositoryId, input.prNumber, input.headSha, task.id),
      });
      if (!created) {
        // A concurrent enqueue of the same head got there first.
        throw new DuplicateReviewRun(job);
      }
      runs.push({ taskId: task.id, reviewId: review.id, jobId: job.id });
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
      return runJob && r.taskId ? [{ taskId: r.taskId, reviewId: r.id, jobId: runJob.id }] : [];
    });
    const first = runs[0] ?? { reviewId: review.id, jobId: job.id };
    return { reviewRunId, runs, reviewId: first.reviewId, jobId: first.jobId };
  }
  return null;
}
