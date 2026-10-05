/**
 * Review history (Repository › Reviews) and review detail pages: paginated,
 * filterable review lists with per-severity finding counts, and a single
 * review with its repository, profile, agent and findings.
 */
import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { listFindingFeedback, type FeedbackEntry } from "./feedback.js";
import type { FindingRow, Review } from "./reviews.js";
import {
  agents,
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
  /** Only this repository's reviews; all repositories when omitted. */
  repositoryId?: string;
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
  agentId: agents.id,
  agentName: agents.name,
};

/**
 * One page of reviews, newest first, filtered by repository, status and
 * trigger, with the number of findings per severity. A page past the last one
 * comes back empty (with the real `total`).
 */
export async function listReviews(
  db: Database,
  filter: ReviewListFilter = {},
): Promise<ReviewListPage> {
  const pageSize = Math.max(1, Math.floor(filter.pageSize ?? REVIEW_PAGE_SIZE));
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const conditions: SQL[] = [];
  if (filter.repositoryId) conditions.push(eq(reviews.repositoryId, filter.repositoryId));
  if (filter.status) conditions.push(eq(reviews.status, filter.status));
  if (filter.trigger) conditions.push(eq(reviews.trigger, filter.trigger));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [[totalRow], rows] = await Promise.all([
    db.select({ total: count() }).from(reviews).where(where),
    db
      .select(reviewColumns)
      .from(reviews)
      .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
      .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
      .leftJoin(reviewProfiles, eq(reviewProfiles.id, reviews.profileId))
      .leftJoin(agents, eq(agents.id, reviews.agentId))
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
    reviews: rows.map(({ profileId, profileName, agentId, agentName, ...row }) => ({
      ...row,
      profile: profileId && profileName ? { id: profileId, name: profileName } : null,
      agent: agentId && agentName ? { id: agentId, name: agentName } : null,
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
}

/** A review with its repository, profile, agent and findings; null if it doesn't exist. */
export async function getReviewDetail(
  db: Database,
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
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(reviews)
    .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .leftJoin(reviewProfiles, eq(reviewProfiles.id, reviews.profileId))
    .leftJoin(agents, eq(agents.id, reviews.agentId))
    .where(eq(reviews.id, reviewId))
    .limit(1);
  if (!row) return null;
  const rows = await db
    .select()
    .from(findings)
    .where(eq(findings.reviewId, reviewId))
    .orderBy(asc(findings.createdAt), asc(findings.id));
  return {
    review: row.review,
    repository: row.repository,
    profile: row.profileId && row.profileName ? { id: row.profileId, name: row.profileName } : null,
    agent: row.agentId && row.agentName ? { id: row.agentId, name: row.agentName } : null,
    findings: rows,
    feedback: await listFindingFeedback(
      db,
      rows.map((f) => f.id),
    ),
  };
}
