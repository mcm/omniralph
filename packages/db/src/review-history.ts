/**
 * Review history (Repository › Reviews) and review detail pages: paginated,
 * filterable review lists with per-severity finding counts, and a single
 * review with its repository, profile, agent and findings.
 */
import { and, asc, count, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { listFindingFeedback, type FeedbackEntry } from "./feedback.js";
import type { FindingRow, Review } from "./reviews.js";
import {
  harnesses,
  findings,
  findingSeverity,
  repositories,
  reviewProfiles,
  reviews,
  scmConnections,
} from "./schema.js";

export type FindingSeverity = (typeof findingSeverity.enumValues)[number];
export type ReviewTrigger = Review["trigger"];

/** Reviews per page of the history list. */
export const REVIEW_PAGE_SIZE = 25;

export interface ReviewListFilter {
  /** Only reviews of this organization's repositories. */
  organizationId: string;
  /** Only this repository's reviews; all repositories when omitted. */
  repositoryId?: string;
  /** Only reviews of this PR/MR number (meaningful with `repositoryId`). */
  prNumber?: number;
  status?: Review["status"];
  trigger?: ReviewTrigger;
  /** 1-based page number. */
  page?: number;
  pageSize?: number;
}

export interface ReviewRepositoryRef {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
  /** The connection's base URL, to build code-host links. */
  baseUrl: string;
}

export interface ReviewListEntry {
  id: string;
  repository: ReviewRepositoryRef;
  prNumber: number;
  prTitle: string | null;
  headSha: string;
  trigger: ReviewTrigger;
  status: Review["status"];
  profile: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
  findingCounts: Record<FindingSeverity, number>;
  tokensIn: number;
  tokensOut: number;
  budget: number;
  durationMs: number | null;
  error: string | null;
  createdAt: Date;
}

export interface ReviewListPage {
  reviews: ReviewListEntry[];
  /** Reviews matching the filter across all pages. */
  total: number;
  /** The page returned (1-based). */
  page: number;
  pageSize: number;
}

export function emptyFindingCounts(): Record<FindingSeverity, number> {
  return Object.fromEntries(findingSeverity.enumValues.map((s) => [s, 0])) as Record<
    FindingSeverity,
    number
  >;
}

/** Joins a review's profile, which is one of its repository's organization. */
const profileOfReview = and(
  eq(reviewProfiles.organizationId, repositories.organizationId),
  eq(reviewProfiles.id, reviews.profileId),
);

const reviewColumns = {
  id: reviews.id,
  prNumber: reviews.prNumber,
  prTitle: reviews.prTitle,
  headSha: reviews.headSha,
  trigger: reviews.trigger,
  status: reviews.status,
  tokensIn: reviews.tokensIn,
  tokensOut: reviews.tokensOut,
  budget: reviews.budget,
  durationMs: reviews.durationMs,
  error: reviews.error,
  createdAt: reviews.createdAt,
  repository: {
    id: repositories.id,
    provider: repositories.provider,
    fullPath: repositories.fullPath,
    baseUrl: scmConnections.baseUrl,
  },
  profileId: reviewProfiles.id,
  profileName: reviewProfiles.name,
  harnessId: harnesses.id,
  harnessName: harnesses.name,
};

/**
 * One page of reviews, newest first, filtered by repository, status and
 * trigger, with the number of findings per severity. A page past the last one
 * comes back empty (with the real `total`).
 */
export async function listReviews(db: Database, filter: ReviewListFilter): Promise<ReviewListPage> {
  const pageSize = Math.max(1, Math.floor(filter.pageSize ?? REVIEW_PAGE_SIZE));
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const conditions: SQL[] = [eq(repositories.organizationId, filter.organizationId)];
  if (filter.repositoryId) conditions.push(eq(reviews.repositoryId, filter.repositoryId));
  if (filter.prNumber !== undefined) conditions.push(eq(reviews.prNumber, filter.prNumber));
  if (filter.status) conditions.push(eq(reviews.status, filter.status));
  if (filter.trigger) conditions.push(eq(reviews.trigger, filter.trigger));
  const where = and(...conditions);

  const [[totalRow], rows] = await Promise.all([
    db
      .select({ total: count() })
      .from(reviews)
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      .where(where),
    db
      .select(reviewColumns)
      .from(reviews)
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
      .leftJoin(reviewProfiles, profileOfReview)
      .leftJoin(harnesses, eq(harnesses.id, reviews.harnessId))
      .where(where)
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  const counts = new Map<string, Record<FindingSeverity, number>>();
  if (rows.length > 0) {
    const grouped = await db
      .select({ reviewId: findings.reviewId, severity: findings.severity, n: count() })
      .from(findings)
      .where(
        inArray(
          findings.reviewId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(findings.reviewId, findings.severity);
    for (const { reviewId, severity, n } of grouped) {
      const byReview = counts.get(reviewId) ?? emptyFindingCounts();
      byReview[severity] = n;
      counts.set(reviewId, byReview);
    }
  }

  return {
    reviews: rows.map(({ profileId, profileName, harnessId, harnessName, ...row }) => ({
      ...row,
      profile: profileId && profileName ? { id: profileId, name: profileName } : null,
      agent: harnessId && harnessName ? { id: harnessId, name: harnessName } : null,
      findingCounts: counts.get(row.id) ?? emptyFindingCounts(),
    })),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  };
}

export interface ReviewDetail {
  review: Review;
  repository: ReviewRepositoryRef;
  profile: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
  /** In the order the model reported them. */
  findings: FindingRow[];
  /** Feedback on the findings (dismissals from the UI and `@bot dismiss`), oldest first. */
  feedback: FeedbackEntry[];
  /** Review ID of each `supersededByFindingId` of the findings (by that finding's ID). */
  supersedingReviewIds: Record<string, string>;
  /**
   * The newest later review of the same PR/MR by the same review task (a re-run, or a review
   * of a newer push); null when this one is the latest.
   */
  newerReview: { id: string; status: Review["status"]; createdAt: Date } | null;
}

/**
 * A review of the organization with its repository, profile, agent and findings; null
 * if the organization has no such review.
 */
export async function getReviewDetail(
  db: Database,
  organizationId: string,
  reviewId: string,
): Promise<ReviewDetail | null> {
  const [row] = await db
    .select({
      review: reviews,
      repository: {
        id: repositories.id,
        provider: repositories.provider,
        fullPath: repositories.fullPath,
        baseUrl: scmConnections.baseUrl,
      },
      profileId: reviewProfiles.id,
      profileName: reviewProfiles.name,
      harnessId: harnesses.id,
      harnessName: harnesses.name,
    })
    .from(reviews)
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .leftJoin(reviewProfiles, profileOfReview)
    .leftJoin(harnesses, eq(harnesses.id, reviews.harnessId))
    .where(and(eq(reviews.id, reviewId), eq(repositories.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  const rows = await db
    .select()
    .from(findings)
    .where(eq(findings.reviewId, reviewId))
    .orderBy(asc(findings.createdAt), asc(findings.id));
  const supersedingIds = [
    ...new Set(rows.flatMap((f) => (f.supersededByFindingId ? [f.supersededByFindingId] : []))),
  ];
  const superseding =
    supersedingIds.length === 0
      ? []
      : await db
          .select({ id: findings.id, reviewId: findings.reviewId })
          .from(findings)
          .where(inArray(findings.id, supersedingIds));
  const { review } = row;
  const [newer] = await db
    .select({ id: reviews.id, status: reviews.status, createdAt: reviews.createdAt })
    .from(reviews)
    .where(
      and(
        eq(reviews.repositoryId, review.repositoryId),
        eq(reviews.prNumber, review.prNumber),
        eq(reviews.summaryOnly, review.summaryOnly),
        // Reviews from before review tasks have none: any later review of the PR is newer.
        review.taskId === null ? undefined : eq(reviews.taskId, review.taskId),
        gt(reviews.createdAt, review.createdAt),
      ),
    )
    .orderBy(desc(reviews.createdAt), desc(reviews.id))
    .limit(1);
  return {
    review: row.review,
    repository: row.repository,
    profile: row.profileId && row.profileName ? { id: row.profileId, name: row.profileName } : null,
    agent: row.harnessId && row.harnessName ? { id: row.harnessId, name: row.harnessName } : null,
    findings: rows,
    feedback: await listFindingFeedback(
      db,
      rows.map((f) => f.id),
    ),
    supersedingReviewIds: Object.fromEntries(superseding.map((f) => [f.id, f.reviewId])),
    newerReview: newer ?? null,
  };
}
