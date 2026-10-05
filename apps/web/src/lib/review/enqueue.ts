import "server-only";
import {
  createReview,
  deleteReview,
  finishReview,
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  getReviewProfile,
  listActiveJobsByDedupePrefix,
  previousReviewState,
  type Database,
  type Review,
} from "@omniralph/db";
import {
  FindingCategory,
  REVIEW_CAPABILITY,
  REVIEW_JOB_TYPE,
  ReviewJobPayload,
  type ReviewMode,
} from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { jobRepository } from "@/lib/scm/adapters";

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
   * earlier open findings are superseded when it completes.
   */
  mode?: ReviewMode;
  /** Review profile to use instead of the repository's (`@bot review deep`). */
  profileId?: string | null;
}

export type EnqueueReviewResult =
  | {
      status: "enqueued" | "duplicate";
      reviewId: string;
      jobId: string;
      /** Jobs of older head SHAs of the PR that were canceled. */
      canceledJobIds: string[];
    }
  | { status: "repository_unavailable" }
  | { status: "profile_not_found" };

/** Dedupe key prefix of a PR's review jobs; the full key adds the head SHA. */
export function reviewJobKeyPrefix(repositoryId: string, prNumber: number): string {
  return `${REVIEW_JOB_TYPE}:${repositoryId}:${prNumber}:`;
}

/**
 * Enqueues a review of a PR/MR head: cancels the PR's queued or running review
 * jobs for older head SHAs, creates the `queued` review and publishes a
 * `review.run` job carrying the review config resolved now (profile, rules,
 * instructions, excludes) and the previous review's head SHA (none for a
 * `full` review) and open findings (neither for a `fresh` one). The payload holds
 * no credentials. A second call for the same head while its job is active
 * returns that job (`duplicate`).
 */
export async function enqueueReview(
  db: Database,
  dispatcher: JobDispatcher,
  input: EnqueueReviewInput,
): Promise<EnqueueReviewResult> {
  const found = await getRepositoryWithConnection(db, input.repositoryId);
  const settings = found && (await getRepositoryReviewSettings(db, input.repositoryId));
  if (!found || !settings || !found.repository.enabled || found.repository.disconnectedAt) {
    return { status: "repository_unavailable" };
  }

  const profile = input.profileId ? await getReviewProfile(db, input.profileId) : settings.profile;
  if (!profile) return { status: "profile_not_found" };

  const prefix = reviewJobKeyPrefix(input.repositoryId, input.prNumber);
  const canceledJobIds: string[] = [];
  for (const job of await listActiveJobsByDedupePrefix(db, prefix)) {
    if (job.dedupeKey === `${prefix}${input.headSha}`) continue;
    await dispatcher.cancel(job.id);
    canceledJobIds.push(job.id);
    const reviewId = ReviewJobPayload.shape.reviewId.safeParse(job.payload.reviewId);
    if (reviewId.success) {
      await finishReview(db, reviewId.data, {
        status: "skipped",
        error: `Superseded by a newer push (${input.headSha.slice(0, 12)})`,
      });
    }
  }

  const mode = input.mode ?? "incremental";
  const previous = mode === "fresh" ? null : await previousReviewState(db, input);
  const review = await createReview(db, {
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
  const payload = ReviewJobPayload.parse({
    reviewId: review.id,
    repositoryId: input.repositoryId,
    repository: jobRepository(found.repository, found.connection),
    prNumber: input.prNumber,
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
        return category.success ? [{ ...f, category: category.data }] : [];
      }),
    },
  } satisfies ReviewJobPayload);

  try {
    const { job, created } = await dispatcher.createAndPublish({
      capability: REVIEW_CAPABILITY,
      type: REVIEW_JOB_TYPE,
      payload,
      repositoryId: input.repositoryId,
      dedupeKey: `${prefix}${input.headSha}`,
    });
    if (created) return { status: "enqueued", reviewId: review.id, jobId: job.id, canceledJobIds };
    await deleteReview(db, review.id);
    const existing = ReviewJobPayload.shape.reviewId.parse(job.payload.reviewId);
    return { status: "duplicate", reviewId: existing, jobId: job.id, canceledJobIds };
  } catch (error) {
    // A job inserted before publishing failed keeps its review (the next enqueue of this
    // head publishes it again); otherwise the review has no job and is removed.
    const active = await listActiveJobsByDedupePrefix(db, `${prefix}${input.headSha}`);
    if (!active.some((job) => job.payload.reviewId === review.id)) {
      await deleteReview(db, review.id);
    }
    throw error;
  }
}
