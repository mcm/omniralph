/**
 * Reviews and their findings. A review row is created when its `review.run`
 * job is enqueued (`queued`), becomes `running` when an agent starts the job
 * and ends `completed` / `budget_exhausted` (result), `failed` or `skipped`.
 * `summary_comment_id` is set once the review (or its failure note) was
 * posted to the code host, which makes posting idempotent per review.
 */
import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  findings,
  repositories,
  reviewProfiles,
  reviews,
  rules,
  type SkippedFile,
} from "./schema.js";

export type Review = typeof reviews.$inferSelect;
export type ReviewStatus = Review["status"];
export type FindingRow = typeof findings.$inferSelect;
export type ReviewProfile = typeof reviewProfiles.$inferSelect;
export type Rule = typeof rules.$inferSelect;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Statuses a review can still leave; the others are final. */
const ACTIVE_REVIEW_STATUSES: ReviewStatus[] = ["queued", "running"];
/** Reviews whose findings count as the PR's reviewed state. */
const FINISHED_REVIEW_STATUSES: ReviewStatus[] = ["completed", "budget_exhausted"];

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

/** A `completed` review of this exact head SHA (other than `exceptReviewId`), if any. */
export async function findCompletedReview(
  db: Database,
  input: { repositoryId: string; prNumber: number; headSha: string; exceptReviewId?: string },
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
  agentId: string,
): Promise<void> {
  await db
    .update(reviews)
    .set({ status: "running", agentId, error: null })
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
  findings: Omit<
    typeof findings.$inferInsert,
    "id" | "reviewId" | "scmCommentId" | "status" | "createdAt" | "updatedAt"
  >[];
}

/**
 * Stores a review's outcome and findings, once: a review that already left
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
      .select({ status: reviews.status })
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

export interface SupersededFinding {
  /** The earlier finding, now `superseded`. */
  finding: FindingRow;
  /** The new review's finding that replaced it. */
  by: FindingRow;
}

/**
 * After a fresh review: sets every `open` finding of the PR's other reviews
 * that `matches` one of this review's findings to `superseded` (pointing at
 * the first match). Unmatched findings stay `open`. Runs once in effect: a
 * replay finds nothing open left to supersede.
 */
export async function supersedeOpenFindings(
  db: Database,
  reviewId: string,
  matches: (prior: FindingRow, next: FindingRow) => boolean,
): Promise<SupersededFinding[]> {
  return db.transaction(async (tx: Transaction) => {
    const [review] = await tx
      .select({ repositoryId: reviews.repositoryId, prNumber: reviews.prNumber })
      .from(reviews)
      .where(eq(reviews.id, reviewId));
    if (!review) return [];
    const next = await tx
      .select()
      .from(findings)
      .where(eq(findings.reviewId, reviewId))
      .orderBy(asc(findings.createdAt), asc(findings.id));
    if (next.length === 0) return [];
    const prior = await tx
      .select({ finding: findings })
      .from(findings)
      .innerJoin(reviews, eq(reviews.id, findings.reviewId))
      .where(
        and(
          eq(reviews.repositoryId, review.repositoryId),
          eq(reviews.prNumber, review.prNumber),
          ne(reviews.id, reviewId),
          eq(findings.status, "open"),
        ),
      )
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
 * Sets the `open` findings of the PR's earlier reviews (created before this
 * one) that `resolve` picks to `resolved`. Returns the findings it resolved.
 * Runs once in effect: a replay finds nothing open left to resolve.
 */
export async function resolveEarlierOpenFindings(
  db: Database,
  reviewId: string,
  resolve: (prior: FindingRow) => boolean,
): Promise<FindingRow[]> {
  return db.transaction(async (tx: Transaction) => {
    const [review] = await tx
      .select({
        repositoryId: reviews.repositoryId,
        prNumber: reviews.prNumber,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .where(eq(reviews.id, reviewId));
    if (!review) return [];
    const prior = await tx
      .select({ finding: findings })
      .from(findings)
      .innerJoin(reviews, eq(reviews.id, findings.reviewId))
      .where(
        and(
          eq(reviews.repositoryId, review.repositoryId),
          eq(reviews.prNumber, review.prNumber),
          ne(reviews.id, reviewId),
          lt(reviews.createdAt, review.createdAt),
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
