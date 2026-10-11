/**
 * Review runs, reviews and their findings. A review run is created for a PR
 * event with one review per review task it fans out to; a review row is
 * created when its `review.run` job is enqueued (`queued`), becomes `running`
 * when an agent starts the job and ends `completed` / `budget_exhausted`
 * (result), `failed` or `skipped`. The review run follows its reviews
 * (`settleReviewRun`). `summary_comment_id` is set once the review (or its
 * failure note) was posted to the code host, which makes posting idempotent
 * per review.
 */
import { and, asc, desc, eq, inArray, lt, ne, notInArray } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  findings,
  repositories,
  reviewProfiles,
  reviewRuns,
  reviews,
  rules,
  stickyComments,
  type ReviewScope,
  type SkippedFile,
} from "./schema.js";

export type Review = typeof reviews.$inferSelect;
export type ReviewRun = typeof reviewRuns.$inferSelect;
export type ReviewRunStatus = ReviewRun["status"];
export type ReviewStatus = Review["status"];
export type FindingRow = typeof findings.$inferSelect;
export type ReviewProfile = typeof reviewProfiles.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type StickyComment = typeof stickyComments.$inferSelect;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Statuses a review can still leave; the others are final. */
const ACTIVE_REVIEW_STATUSES: ReviewStatus[] = ["queued", "running"];
/** Reviews whose findings count as the PR's reviewed state. */
const FINISHED_REVIEW_STATUSES: ReviewStatus[] = ["completed", "budget_exhausted"];
/** Statuses a review run can still leave. */
const ACTIVE_REVIEW_RUN_STATUSES: ReviewRunStatus[] = ["queued", "running", "correlating"];
/** The error of a review whose job was canceled. */
export const CANCELED_REVIEW_ERROR = "Canceled";

export interface NewReviewRunInput {
  organizationId: string;
  repositoryId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  trigger: ReviewRun["trigger"];
  mode: ReviewRun["mode"];
  profileId: string;
  /** The PR/MR author (a mention the posted review keeps). */
  prAuthor?: string | null;
  /** The profile's name (the posted summary names it). */
  profileName?: string | null;
}

export async function createReviewRun(db: Database, input: NewReviewRunInput): Promise<ReviewRun> {
  const [row] = await db.insert(reviewRuns).values(input).returning();
  return row!;
}

/** Deletes a review run with its reviews. */
export async function deleteReviewRun(db: Database, reviewRunId: string): Promise<void> {
  await db.delete(reviewRuns).where(eq(reviewRuns.id, reviewRunId));
}

export async function getReviewRun(db: Database, reviewRunId: string): Promise<ReviewRun | null> {
  const [row] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, reviewRunId)).limit(1);
  return row ?? null;
}

/** The reviews of a review run (one per task), in creation order. */
export async function listReviewRunReviews(db: Database, reviewRunId: string): Promise<Review[]> {
  return db
    .select()
    .from(reviews)
    .where(eq(reviews.reviewRunId, reviewRunId))
    .orderBy(asc(reviews.createdAt), asc(reviews.id));
}

/** The findings of a review run's reviews (any status), oldest first. */
export async function listReviewRunFindings(
  db: Database,
  reviewRunId: string,
): Promise<FindingRow[]> {
  const rows = await db
    .select({ finding: findings })
    .from(findings)
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .where(eq(reviews.reviewRunId, reviewRunId))
    .orderBy(asc(findings.createdAt), asc(findings.id));
  return rows.map((r) => r.finding);
}

/** `queued` → `running`, once one of its task runs started. */
export async function markReviewRunRunning(db: Database, reviewRunId: string): Promise<void> {
  await db
    .update(reviewRuns)
    .set({ status: "running" })
    .where(and(eq(reviewRuns.id, reviewRunId), eq(reviewRuns.status, "queued")));
}

/** Ends review runs that are still active as `skipped` (e.g. superseded by a newer push). */
export async function skipReviewRuns(
  db: Database,
  reviewRunIds: readonly string[],
  error: string,
): Promise<void> {
  if (reviewRunIds.length === 0) return;
  await db
    .update(reviewRuns)
    .set({ status: "skipped", error })
    .where(
      and(
        inArray(reviewRuns.id, [...reviewRunIds]),
        inArray(reviewRuns.status, ACTIVE_REVIEW_RUN_STATUSES),
      ),
    );
}

/** A finished review of a review run with its open findings: one input of its correlation. */
export interface CorrelationInput {
  review: Review;
  findings: FindingRow[];
}

/**
 * Starts a review run's correlation inside `settleReviewRun`'s transaction
 * (`tx`, which holds the run's row lock): inserts the correlation job and
 * returns its ID, or returns an error when the run can't be correlated (e.g.
 * its correlation task is unknown).
 */
export type StartCorrelation = (
  tx: Database,
  run: ReviewRun,
  inputs: CorrelationInput[],
) => Promise<{ jobId: string } | { error: string }>;

/**
 * Once every review of a `queued`/`running` review run without a correlation
 * job has ended (summary-only ones aside, see `settlingReviews`), moves the run on. With two or more finished reviews
 * (`completed`/`budget_exhausted`) and a `correlate` callback, it starts the
 * correlation (`correlate` inserts its job) and becomes `correlating` with
 * `correlation_job_id` set (or `completed` with the error when it can't);
 * with one finished review (or no `correlate`) it is `completed`; with none,
 * `failed` when a review failed or was canceled, else `skipped` (e.g. every
 * task's head was already reviewed). Returns the run's new status, or null
 * when it was left alone. Holds a row lock on the run, so of concurrent
 * callers exactly one moves it on (and starts its correlation).
 */
export async function settleReviewRun(
  db: Database,
  reviewRunId: string,
  correlate?: StartCorrelation,
): Promise<ReviewRunStatus | null> {
  return db.transaction(async (tx: Transaction) => {
    const [run] = await tx
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, reviewRunId))
      .for("update");
    if (!run || (run.status !== "queued" && run.status !== "running")) return null;
    if (run.correlationJobId !== null) return null;
    const allReviews = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.reviewRunId, reviewRunId))
      .orderBy(asc(reviews.createdAt), asc(reviews.id));
    const runReviews = settlingReviews(allReviews);
    if (runReviews.some((r) => ACTIVE_REVIEW_STATUSES.includes(r.status))) return null;
    const finished = runReviews.filter((r) => FINISHED_REVIEW_STATUSES.includes(r.status));

    if (finished.length >= 2 && correlate) {
      const runFindings = await tx
        .select()
        .from(findings)
        .where(
          and(
            inArray(
              findings.reviewId,
              finished.map((r) => r.id),
            ),
            eq(findings.status, "open"),
          ),
        )
        .orderBy(asc(findings.createdAt), asc(findings.id));
      const inputs = finished.map((review) => ({
        review,
        findings: runFindings.filter((f) => f.reviewId === review.id),
      }));
      const started = await correlate(tx as unknown as Database, run, inputs);
      if ("jobId" in started) {
        await tx
          .update(reviewRuns)
          .set({ status: "correlating", correlationJobId: started.jobId, error: null })
          .where(eq(reviewRuns.id, reviewRunId));
        return "correlating";
      }
      await tx
        .update(reviewRuns)
        .set({ status: "completed", error: started.error })
        .where(eq(reviewRuns.id, reviewRunId));
      return "completed";
    }

    const status: ReviewRunStatus =
      finished.length > 0
        ? "completed"
        : runReviews.some(
              (r) =>
                r.status === "failed" ||
                (r.status === "skipped" && r.error === CANCELED_REVIEW_ERROR),
            )
          ? "failed"
          : "skipped";
    await tx
      .update(reviewRuns)
      .set({ status, error: status === "failed" ? "Every review task failed" : null })
      .where(eq(reviewRuns.id, reviewRunId));
    return status;
  });
}

/**
 * The reviews of a review run its status follows (`settleReviewRun`): all
 * but the summary-only ones, which post on their own and neither hold up nor
 * join its correlation and posted review; all of them when every task is
 * summary-only (the run then ends with them, but posts no review).
 */
export function settlingReviews<R extends Pick<Review, "summaryOnly">>(
  runReviews: readonly R[],
): R[] {
  const posted = runReviews.filter((r) => !r.summaryOnly);
  return posted.length > 0 ? posted : [...runReviews];
}

/** The parts of one correlated finding `applyCorrelation` stores. */
export interface CorrelatedFindingInput {
  sourceFindingIds: readonly string[];
  sourceTaskIds: readonly string[];
  severity: FindingRow["severity"];
  confidence: number;
  title: string;
  body: string;
  suggestion?: string | null;
}

/**
 * Applies the output of review run `reviewRunId`'s correlation job `jobId`,
 * while holding a row lock on the run (only while the job is still its
 * correlation job and the run `correlating`, or `completed` by it before).
 * For each correlated finding, the earliest of its source findings that
 * belong to the run (IDs outside the run, and IDs an earlier entry already
 * took, are ignored) gets the output's severity, confidence, title, body,
 * suggestion and the union of the source tasks; its other source findings
 * that are still `open` become `merged` into it. Findings the output leaves
 * out stay unchanged. The summary is stored on the run, which becomes
 * `completed`. Applying the same output again changes nothing more.
 * Returns whether it applied, and how many findings it merged away.
 */
export async function applyCorrelation(
  db: Database,
  input: {
    reviewRunId: string;
    jobId: string;
    findings: readonly CorrelatedFindingInput[];
    summary: string;
  },
): Promise<{ applied: boolean; merged: number }> {
  return db.transaction(async (tx: Transaction) => {
    const [run] = await tx
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, input.reviewRunId))
      .for("update");
    if (
      !run ||
      run.correlationJobId !== input.jobId ||
      (run.status !== "correlating" && run.status !== "completed")
    ) {
      return { applied: false, merged: 0 };
    }
    const runReviews = await tx
      .select({ id: reviews.id, taskId: reviews.taskId })
      .from(reviews)
      .where(eq(reviews.reviewRunId, run.id));
    const runTaskIds = new Set(runReviews.flatMap((r) => (r.taskId ? [r.taskId] : [])));
    const runFindings =
      runReviews.length === 0
        ? []
        : (
            await tx
              .select({ finding: findings })
              .from(findings)
              .where(
                inArray(
                  findings.reviewId,
                  runReviews.map((r) => r.id),
                ),
              )
              .orderBy(asc(findings.createdAt), asc(findings.id))
              .for("update")
          ).map((row) => row.finding);
    const taken = new Set<string>();
    let merged = 0;
    for (const entry of input.findings) {
      const ids = new Set(entry.sourceFindingIds);
      const sources = runFindings.filter((f) => ids.has(f.id) && !taken.has(f.id));
      for (const source of sources) taken.add(source.id);
      const [target, ...others] = sources;
      if (!target || target.status === "merged") continue;
      const sourceTaskIds = [
        ...new Set([
          ...target.sourceTaskIds,
          ...entry.sourceTaskIds.filter((id) => runTaskIds.has(id)),
          ...others.flatMap((f) => f.sourceTaskIds),
        ]),
      ];
      await tx
        .update(findings)
        .set({
          severity: entry.severity,
          confidence: entry.confidence,
          title: entry.title,
          body: entry.body,
          suggestion: entry.suggestion ?? null,
          sourceTaskIds,
        })
        .where(eq(findings.id, target.id));
      if (others.length === 0) continue;
      const rows = await tx
        .update(findings)
        .set({ status: "merged", mergedIntoFindingId: target.id })
        .where(
          and(
            inArray(
              findings.id,
              others.map((f) => f.id),
            ),
            eq(findings.status, "open"),
          ),
        )
        .returning({ id: findings.id });
      merged += rows.length;
    }
    await tx
      .update(reviewRuns)
      .set({ status: "completed", summary: input.summary.trim() || null, error: null })
      .where(eq(reviewRuns.id, run.id));
    return { applied: true, merged };
  });
}

/**
 * Ends review run `reviewRunId`'s correlation job `jobId` that failed (or
 * whose output was unusable): the run, if still `correlating` on that job,
 * becomes `completed` with `error` and every finding stays unmerged. Returns
 * whether it changed the run.
 */
export async function failCorrelation(
  db: Database,
  input: { reviewRunId: string; jobId: string; error: string },
): Promise<boolean> {
  const rows = await db
    .update(reviewRuns)
    .set({ status: "completed", error: input.error })
    .where(
      and(
        eq(reviewRuns.id, input.reviewRunId),
        eq(reviewRuns.correlationJobId, input.jobId),
        eq(reviewRuns.status, "correlating"),
      ),
    )
    .returning({ id: reviewRuns.id });
  return rows.length > 0;
}

/** A PR's review runs that are still active, other than those of head `exceptHeadSha`. */
export async function listActiveReviewRuns(
  db: Database,
  input: { repositoryId: string; prNumber: number; exceptHeadSha: string },
): Promise<ReviewRun[]> {
  return db
    .select()
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.repositoryId, input.repositoryId),
        eq(reviewRuns.prNumber, input.prNumber),
        ne(reviewRuns.headSha, input.exceptHeadSha),
        inArray(reviewRuns.status, ACTIVE_REVIEW_RUN_STATUSES),
      ),
    );
}

export interface NewReviewInput {
  repositoryId: string;
  prNumber: number;
  prTitle?: string | null;
  headSha: string;
  baseSha: string;
  trigger: Review["trigger"];
  profileId: string;
  model: string | null;
  budget: number;
  /** The review run the review is one task of. */
  reviewRunId?: string | null;
  /** The review task the review runs. */
  taskId?: string | null;
  /** The task is summary-only (sink `sticky-comment`). */
  summaryOnly?: boolean;
}

export async function createReview(db: Database, input: NewReviewInput): Promise<Review> {
  const [row] = await db.insert(reviews).values(input).returning();
  return row!;
}

export async function deleteReview(db: Database, reviewId: string): Promise<void> {
  await db.delete(reviews).where(eq(reviews.id, reviewId));
}

export async function getReview(db: Database, reviewId: string): Promise<Review | null> {
  const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  return row ?? null;
}

/** The organization of a finding (through its review's repository), or null if it doesn't exist. */
export async function getFindingOrganizationId(
  db: Database,
  findingId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: repositories.organizationId })
    .from(findings)
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .where(eq(findings.id, findingId))
    .limit(1);
  return row?.organizationId ?? null;
}

/** The open findings with these IDs of the reviews of one PR/MR, oldest first. */
export async function listOpenPullRequestFindings(
  db: Database,
  input: { repositoryId: string; prNumber: number; findingIds: readonly string[] },
): Promise<FindingRow[]> {
  if (input.findingIds.length === 0) return [];
  const rows = await db
    .select({ finding: findings })
    .from(findings)
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .where(
      and(
        inArray(findings.id, [...input.findingIds]),
        eq(reviews.repositoryId, input.repositoryId),
        eq(reviews.prNumber, input.prNumber),
        eq(findings.status, "open"),
      ),
    )
    .orderBy(asc(findings.createdAt), asc(findings.id));
  return rows.map((r) => r.finding);
}

/** Marks open findings `resolved` (they were fixed); returns the ones that were still open. */
export async function resolveOpenFindings(
  db: Database,
  findingIds: readonly string[],
): Promise<FindingRow[]> {
  if (findingIds.length === 0) return [];
  return db
    .update(findings)
    .set({ status: "resolved" })
    .where(and(inArray(findings.id, [...findingIds]), eq(findings.status, "open")))
    .returning();
}

export async function listReviewFindings(db: Database, reviewId: string): Promise<FindingRow[]> {
  return db
    .select()
    .from(findings)
    .where(eq(findings.reviewId, reviewId))
    .orderBy(asc(findings.createdAt), asc(findings.id));
}

/**
 * A `completed` review of this exact head SHA (other than `exceptReviewId`),
 * of review task `taskId` when given, if any.
 */
export async function findCompletedReview(
  db: Database,
  input: {
    repositoryId: string;
    prNumber: number;
    headSha: string;
    taskId?: string;
    exceptReviewId?: string;
  },
): Promise<Review | null> {
  const [row] = await db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.repositoryId, input.repositoryId),
        eq(reviews.prNumber, input.prNumber),
        eq(reviews.headSha, input.headSha),
        eq(reviews.status, "completed"),
        ...(input.taskId ? [eq(reviews.taskId, input.taskId)] : []),
        ...(input.exceptReviewId ? [ne(reviews.id, input.exceptReviewId)] : []),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface PreviousReviewState {
  /** Head SHA of the PR's most recent `completed` review; null if none. */
  headSha: string | null;
  /** Open findings of all finished reviews of the PR. */
  openFindings: Pick<
    FindingRow,
    "id" | "path" | "startLine" | "endLine" | "category" | "title" | "body"
  >[];
}

/**
 * The head of the PR's latest `completed` review of a different head SHA (the
 * next review only needs the commits since), plus the open findings of all
 * finished (`completed` / `budget_exhausted`) reviews. A `budget_exhausted`
 * review didn't get through its diff, so it never serves as the base. Null
 * when there is neither.
 */
export async function previousReviewState(
  db: Database,
  input: { repositoryId: string; prNumber: number; headSha: string },
): Promise<PreviousReviewState | null> {
  const prReviews = and(
    eq(reviews.repositoryId, input.repositoryId),
    eq(reviews.prNumber, input.prNumber),
    inArray(reviews.status, FINISHED_REVIEW_STATUSES),
  );
  const [latest] = await db
    .select({ headSha: reviews.headSha })
    .from(reviews)
    .where(and(prReviews, eq(reviews.status, "completed"), ne(reviews.headSha, input.headSha)))
    .orderBy(desc(reviews.createdAt))
    .limit(1);
  const openFindings = await db
    .select({
      id: findings.id,
      path: findings.path,
      startLine: findings.startLine,
      endLine: findings.endLine,
      category: findings.category,
      title: findings.title,
      body: findings.body,
    })
    .from(findings)
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .where(and(prReviews, eq(findings.status, "open")))
    .orderBy(asc(findings.createdAt))
    .limit(1000);
  if (!latest && openFindings.length === 0) return null;
  return { headSha: latest?.headSha ?? null, openFindings };
}

/** The repository's review settings: its profile and enabled rules (creation order). */
export async function getRepositoryReviewSettings(
  db: Database,
  repositoryId: string,
): Promise<{
  profile: ReviewProfile;
  customInstructions: string | null;
  pathExcludes: string[];
  rules: Rule[];
} | null> {
  const [row] = await db
    .select({ repository: repositories, profile: reviewProfiles })
    .from(repositories)
    .innerJoin(
      reviewProfiles,
      and(
        eq(reviewProfiles.organizationId, repositories.organizationId),
        eq(reviewProfiles.id, repositories.profileId),
      ),
    )
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!row) return null;
  const repoRules = await db
    .select()
    .from(rules)
    .where(and(eq(rules.repositoryId, repositoryId), eq(rules.enabled, true)))
    .orderBy(asc(rules.createdAt), asc(rules.id));
  return {
    profile: row.profile,
    customInstructions: row.repository.customInstructions,
    pathExcludes: row.repository.pathExcludes,
    rules: repoRules,
  };
}

/** `queued` → `running` on an agent (also on a redelivery to another agent). */
export async function markReviewRunning(
  db: Database,
  reviewId: string,
  harnessId: string,
): Promise<void> {
  await db
    .update(reviews)
    .set({ status: "running", harnessId, error: null })
    .where(and(eq(reviews.id, reviewId), inArray(reviews.status, ACTIVE_REVIEW_STATUSES)));
}

/** Back to `queued` after a retryable failure (the job is redelivered later). */
export async function markReviewQueued(
  db: Database,
  reviewId: string,
  error: string | null,
): Promise<void> {
  await db
    .update(reviews)
    .set({ status: "queued", error })
    .where(and(eq(reviews.id, reviewId), inArray(reviews.status, ACTIVE_REVIEW_STATUSES)));
}

/**
 * Ends a review that is still queued or running as `failed` or `skipped`.
 * Returns false when it had already finished.
 */
export async function finishReview(
  db: Database,
  reviewId: string,
  input: { status: "failed" | "skipped"; error: string | null },
): Promise<boolean> {
  const rows = await db
    .update(reviews)
    .set({ status: input.status, error: input.error })
    .where(and(eq(reviews.id, reviewId), inArray(reviews.status, ACTIVE_REVIEW_STATUSES)))
    .returning({ id: reviews.id });
  return rows.length > 0;
}

export interface ReviewOutcomeInput {
  status: "completed" | "budget_exhausted";
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  skippedFiles: SkippedFile[];
  /** The task run's summary (the review run's correlation reads it); null without one. */
  summary?: string | null;
  /** What the task run covered. */
  scope?: ReviewScope | null;
  /** The earlier open findings the task run re-checked and found fixed. */
  fixedFindingIds?: readonly string[];
  findings: Omit<
    typeof findings.$inferInsert,
    | "id"
    | "reviewId"
    | "scmCommentId"
    | "status"
    | "sourceTaskIds"
    | "mergedIntoFindingId"
    | "createdAt"
    | "updatedAt"
  >[];
}

/**
 * Stores a review's outcome, summary and findings (each reported by the
 * review's task, `source_task_ids`), once: a review that already left
 * `queued`/`running` is left alone (`saved: false`), so a replayed result
 * never duplicates findings.
 */
export async function saveReviewOutcome(
  db: Database,
  reviewId: string,
  input: ReviewOutcomeInput,
): Promise<{ saved: boolean }> {
  return db.transaction(async (tx) => {
    const [review] = await tx
      .select({ status: reviews.status, taskId: reviews.taskId })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .for("update");
    if (!review || !ACTIVE_REVIEW_STATUSES.includes(review.status)) return { saved: false };
    await tx
      .update(reviews)
      .set({
        status: input.status,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        durationMs: input.durationMs,
        skippedFiles: input.skippedFiles,
        summary: input.summary ?? null,
        scope: input.scope ?? null,
        fixedFindingIds: [...(input.fixedFindingIds ?? [])],
        error: null,
      })
      .where(eq(reviews.id, reviewId));
    if (input.findings.length > 0) {
      // Staggered timestamps keep the model's order when findings are read back.
      const base = Date.now();
      await tx.insert(findings).values(
        input.findings.map((finding, i) => ({
          ...finding,
          reviewId,
          sourceTaskIds: review.taskId ? [review.taskId] : [],
          createdAt: new Date(base + i),
        })),
      );
    }
    return { saved: true };
  });
}

/**
 * Runs `post` while holding a row lock on the review, unless it was already
 * posted (`summary_comment_id` set): concurrent or replayed calls wait for
 * the lock and then see the stored comment ID, so a review is posted at most
 * once. `post` returns the comment IDs to store, or null when it posted nothing.
 */
export async function postReviewOnce(
  db: Database,
  reviewId: string,
  post: (
    review: Review,
    findings: FindingRow[],
  ) => Promise<{ summaryCommentId: string; findingCommentIds?: Map<string, string> } | null>,
): Promise<{ posted: boolean }> {
  return db.transaction(async (tx: Transaction) => {
    const [review] = await tx.select().from(reviews).where(eq(reviews.id, reviewId)).for("update");
    if (!review || review.summaryCommentId !== null) return { posted: false };
    const rows = await tx
      .select()
      .from(findings)
      .where(eq(findings.reviewId, reviewId))
      .orderBy(asc(findings.createdAt), asc(findings.id));
    const posted = await post(review, rows);
    if (!posted) return { posted: false };
    const { summaryCommentId, findingCommentIds } = posted;
    await tx.update(reviews).set({ summaryCommentId }).where(eq(reviews.id, reviewId));
    for (const [findingId, commentId] of findingCommentIds ?? []) {
      await tx
        .update(findings)
        .set({ scmCommentId: commentId })
        .where(and(eq(findings.id, findingId), eq(findings.reviewId, reviewId)));
    }
    return { posted: true };
  });
}

/**
 * Runs `post` while holding a row lock on the review run, unless it was
 * already posted (`summary_comment_id` set), as `postReviewOnce` does for a
 * review: a review run is posted at most once. `post` gets the run, its
 * reviews and their findings (any status) and returns the comment IDs to
 * store (the inline ones on the run's findings), or null when it posted nothing.
 */
export async function postReviewRunOnce(
  db: Database,
  reviewRunId: string,
  post: (
    run: ReviewRun,
    reviews: Review[],
    findings: FindingRow[],
  ) => Promise<{ summaryCommentId: string; findingCommentIds?: Map<string, string> } | null>,
): Promise<{ posted: boolean }> {
  return db.transaction(async (tx: Transaction) => {
    const [run] = await tx
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, reviewRunId))
      .for("update");
    if (!run || run.summaryCommentId !== null) return { posted: false };
    const runReviews = await listReviewRunReviews(tx as unknown as Database, reviewRunId);
    const rows = await listReviewRunFindings(tx as unknown as Database, reviewRunId);
    const posted = await post(run, runReviews, rows);
    if (!posted) return { posted: false };
    const { summaryCommentId, findingCommentIds } = posted;
    await tx.update(reviewRuns).set({ summaryCommentId }).where(eq(reviewRuns.id, reviewRunId));
    const runFindingIds = new Set(rows.map((f) => f.id));
    for (const [findingId, commentId] of findingCommentIds ?? []) {
      if (!runFindingIds.has(findingId)) continue;
      await tx.update(findings).set({ scmCommentId: commentId }).where(eq(findings.id, findingId));
    }
    return { posted: true };
  });
}

/** Which sticky comment: one per PR/MR and summary-only review task. */
export interface StickyCommentKey {
  repositoryId: string;
  prNumber: number;
  taskId: string;
}

export async function getStickyComment(
  db: Database,
  key: StickyCommentKey,
): Promise<StickyComment | null> {
  const [row] = await db
    .select()
    .from(stickyComments)
    .where(
      and(
        eq(stickyComments.repositoryId, key.repositoryId),
        eq(stickyComments.prNumber, key.prNumber),
        eq(stickyComments.taskId, key.taskId),
      ),
    );
  return row ?? null;
}

/**
 * Writes a sticky comment: runs `write` with its stored comment ID (null
 * before it was first posted) while holding a row lock on its
 * `sticky_comments` row (created when missing), then stores the ID `write`
 * returns. Concurrent writers take turns, so the PR/MR keeps one comment.
 */
export async function writeStickyComment(
  db: Database,
  key: StickyCommentKey,
  write: (commentId: string | null) => Promise<{ id: string }>,
): Promise<StickyComment> {
  return db.transaction(async (tx: Transaction) => {
    await tx.insert(stickyComments).values(key).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(stickyComments)
      .where(
        and(
          eq(stickyComments.repositoryId, key.repositoryId),
          eq(stickyComments.prNumber, key.prNumber),
          eq(stickyComments.taskId, key.taskId),
        ),
      )
      .for("update");
    if (!row) throw new Error("sticky comment row not found");
    const { id } = await write(row.commentId);
    if (id === row.commentId) return row;
    const [updated] = await tx
      .update(stickyComments)
      .set({ commentId: id })
      .where(eq(stickyComments.id, row.id))
      .returning();
    return updated ?? row;
  });
}

/** A review, or every review of a review run: what supersedes or resolves earlier findings. */
export type ReviewTarget = { reviewId: string } | { reviewRunId: string };

/**
 * The PR, start time and review IDs of a review target (a review run starts
 * with its creation); null when it doesn't exist.
 */
async function reviewTargetScope(
  tx: Transaction,
  target: ReviewTarget,
): Promise<{
  repositoryId: string;
  prNumber: number;
  createdAt: Date;
  reviewIds: string[];
} | null> {
  if ("reviewId" in target) {
    const [review] = await tx
      .select({
        repositoryId: reviews.repositoryId,
        prNumber: reviews.prNumber,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .where(eq(reviews.id, target.reviewId));
    return review ? { ...review, reviewIds: [target.reviewId] } : null;
  }
  const [run] = await tx
    .select({
      repositoryId: reviewRuns.repositoryId,
      prNumber: reviewRuns.prNumber,
      createdAt: reviewRuns.createdAt,
    })
    .from(reviewRuns)
    .where(eq(reviewRuns.id, target.reviewRunId));
  if (!run) return null;
  const runReviews = await tx
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.reviewRunId, target.reviewRunId));
  return { ...run, reviewIds: runReviews.map((r) => r.id) };
}

/** The PR's reviews other than the target's (nor of its review run). */
function otherReviewsOf(scope: { repositoryId: string; prNumber: number; reviewIds: string[] }) {
  return and(
    eq(reviews.repositoryId, scope.repositoryId),
    eq(reviews.prNumber, scope.prNumber),
    ...(scope.reviewIds.length > 0 ? [notInArray(reviews.id, scope.reviewIds)] : []),
  );
}

export interface SupersededFinding {
  /** The earlier finding, now `superseded`. */
  finding: FindingRow;
  /** The new review's finding that replaced it. */
  by: FindingRow;
}

/**
 * After a fresh review (or review run): sets every `open` finding of the
 * PR's other reviews (not of the same review run) that `matches` one of the
 * target's findings (`merged` ones aside) to `superseded`, pointing at the
 * first match. Unmatched findings stay `open`. Runs once in effect: a replay
 * finds nothing open left to supersede.
 */
export async function supersedeOpenFindings(
  db: Database,
  target: ReviewTarget,
  matches: (prior: FindingRow, next: FindingRow) => boolean,
): Promise<SupersededFinding[]> {
  return db.transaction(async (tx: Transaction) => {
    const scope = await reviewTargetScope(tx, target);
    if (!scope || scope.reviewIds.length === 0) return [];
    const next = await tx
      .select()
      .from(findings)
      .where(and(inArray(findings.reviewId, scope.reviewIds), ne(findings.status, "merged")))
      .orderBy(asc(findings.createdAt), asc(findings.id));
    if (next.length === 0) return [];
    const prior = await tx
      .select({ finding: findings })
      .from(findings)
      .innerJoin(reviews, eq(reviews.id, findings.reviewId))
      .where(and(otherReviewsOf(scope), eq(findings.status, "open")))
      .orderBy(asc(findings.createdAt), asc(findings.id))
      .for("update", { of: findings });
    const superseded: SupersededFinding[] = [];
    for (const { finding } of prior) {
      const by = next.find((candidate) => matches(finding, candidate));
      if (!by) continue;
      const [updated] = await tx
        .update(findings)
        .set({ status: "superseded", supersededByFindingId: by.id })
        .where(and(eq(findings.id, finding.id), eq(findings.status, "open")))
        .returning();
      if (updated) superseded.push({ finding: updated, by });
    }
    return superseded;
  });
}

/**
 * Sets the `open` findings of the PR's earlier reviews (created before the
 * review or review run, and not of the same review run) that `resolve`
 * picks to `resolved`. Returns the findings it resolved. Runs once in
 * effect: a replay finds nothing open left to resolve.
 */
export async function resolveEarlierOpenFindings(
  db: Database,
  target: ReviewTarget,
  resolve: (prior: FindingRow) => boolean,
): Promise<FindingRow[]> {
  return db.transaction(async (tx: Transaction) => {
    const scope = await reviewTargetScope(tx, target);
    if (!scope) return [];
    const prior = await tx
      .select({ finding: findings })
      .from(findings)
      .innerJoin(reviews, eq(reviews.id, findings.reviewId))
      .where(
        and(
          otherReviewsOf(scope),
          lt(reviews.createdAt, scope.createdAt),
          eq(findings.status, "open"),
        ),
      )
      .orderBy(asc(findings.createdAt), asc(findings.id))
      .for("update", { of: findings });
    const ids = prior.filter(({ finding }) => resolve(finding)).map(({ finding }) => finding.id);
    if (ids.length === 0) return [];
    return tx
      .update(findings)
      .set({ status: "resolved" })
      .where(and(inArray(findings.id, ids), eq(findings.status, "open")))
      .returning();
  });
}
