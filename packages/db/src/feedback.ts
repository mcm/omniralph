/**
 * Finding feedback: dismissing a finding (from the control panel or with
 * `@bot dismiss` in its thread) records a `feedback` row with its source and
 * author; restoring the finding keeps that row and marks it restored.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./client.js";
import { recordReviewChanges, type FindingRow, type Review } from "./reviews.js";
import type { feedbackReason, feedbackSource } from "./schema.js";
import { feedback, findings, reviews, users } from "./schema.js";

export type Feedback = typeof feedback.$inferSelect;
export type FeedbackReason = (typeof feedbackReason.enumValues)[number];
export type FeedbackSource = (typeof feedbackSource.enumValues)[number];

export interface DismissFindingInput {
  findingId: string;
  source: FeedbackSource;
  reason: FeedbackReason;
  note?: string | null;
  /** The control panel user who dismissed it (`ui`), if known. */
  userId?: string | null;
  /** The code-host login of whoever dismissed it in the thread (`scm`). */
  scmUsername?: string | null;
}

export type DismissFindingResult =
  | { status: "dismissed"; finding: FindingRow; review: Review; feedback: Feedback }
  | { status: "not_found" }
  /** The finding isn't `open` (already dismissed, or resolved). */
  | { status: "not_open"; finding: FindingRow };

export type RestoreFindingResult =
  | { status: "restored"; finding: FindingRow; review: Review }
  | { status: "not_found" }
  | { status: "not_dismissed"; finding: FindingRow };

async function findingWithReview(db: Pick<Database, "select">, findingId: string) {
  const [row] = await db
    .select({ finding: findings, review: reviews })
    .from(findings)
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .where(eq(findings.id, findingId))
    .limit(1);
  return row ?? null;
}

/** Sets an open finding to `dismissed` and records the feedback, atomically. */
export async function dismissFinding(
  db: Database,
  input: DismissFindingInput,
): Promise<DismissFindingResult> {
  return db.transaction(async (tx) => {
    const found = await findingWithReview(tx, input.findingId);
    if (!found) return { status: "not_found" };
    const [finding] = await tx
      .update(findings)
      .set({ status: "dismissed" })
      .where(and(eq(findings.id, input.findingId), eq(findings.status, "open")))
      .returning();
    if (!finding) return { status: "not_open", finding: found.finding };
    const [row] = await tx
      .insert(feedback)
      .values({
        findingId: finding.id,
        source: input.source,
        reason: input.reason,
        note: input.note?.trim() || null,
        userId: input.userId ?? null,
        scmUsername: input.scmUsername ?? null,
      })
      .returning();
    await recordReviewChanges(tx as unknown as Database, [found.review.id]);
    return { status: "dismissed", finding, review: found.review, feedback: row! };
  });
}

/**
 * Sets a dismissed finding back to `open`. Its feedback rows are kept and
 * marked restored (by `userId`), so they stay in the finding's history.
 */
export async function restoreFinding(
  db: Database,
  input: { findingId: string; userId?: string | null },
): Promise<RestoreFindingResult> {
  return db.transaction(async (tx) => {
    const found = await findingWithReview(tx, input.findingId);
    if (!found) return { status: "not_found" };
    const [finding] = await tx
      .update(findings)
      .set({ status: "open" })
      .where(and(eq(findings.id, input.findingId), eq(findings.status, "dismissed")))
      .returning();
    if (!finding) return { status: "not_dismissed", finding: found.finding };
    await tx
      .update(feedback)
      .set({ restoredAt: new Date(), restoredBy: input.userId ?? null })
      .where(and(eq(feedback.findingId, finding.id), isNull(feedback.restoredAt)));
    await recordReviewChanges(tx as unknown as Database, [found.review.id]);
    return { status: "restored", finding, review: found.review };
  });
}

export interface FeedbackUserRef {
  id: string;
  name: string | null;
  email: string | null;
}

export interface FeedbackEntry {
  id: string;
  findingId: string;
  source: FeedbackSource;
  reason: FeedbackReason;
  note: string | null;
  user: FeedbackUserRef | null;
  scmUsername: string | null;
  createdAt: Date;
  restoredAt: Date | null;
  restoredBy: FeedbackUserRef | null;
}

/** Feedback on the given findings, oldest first, with the users who gave and restored it. */
export async function listFindingFeedback(
  db: Database,
  findingIds: string[],
): Promise<FeedbackEntry[]> {
  if (findingIds.length === 0) return [];
  const author = alias(users, "author");
  const restorer = alias(users, "restorer");
  const rows = await db
    .select({
      feedback,
      author: { id: author.id, name: author.name, email: author.email },
      restorer: { id: restorer.id, name: restorer.name, email: restorer.email },
    })
    .from(feedback)
    .leftJoin(author, eq(author.id, feedback.userId))
    .leftJoin(restorer, eq(restorer.id, feedback.restoredBy))
    .where(inArray(feedback.findingId, findingIds))
    .orderBy(asc(feedback.createdAt), asc(feedback.id));
  return rows.map(({ feedback: f, author: a, restorer: r }) => ({
    id: f.id,
    findingId: f.findingId,
    source: f.source,
    reason: f.reason,
    note: f.note,
    user: a,
    scmUsername: f.scmUsername,
    createdAt: f.createdAt,
    restoredAt: f.restoredAt,
    restoredBy: r,
  }));
}

/**
 * The finding whose inline SCM comment (thread) is one of `commentIds`, in a
 * review of this PR/MR (the newest, should several match).
 */
export async function findFindingByScmComment(
  db: Database,
  input: { repositoryId: string; prNumber: number; commentIds: readonly string[] },
): Promise<{ finding: FindingRow; review: Review } | null> {
  if (input.commentIds.length === 0) return null;
  const [row] = await db
    .select({ finding: findings, review: reviews })
    .from(findings)
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .where(
      and(
        eq(reviews.repositoryId, input.repositoryId),
        eq(reviews.prNumber, input.prNumber),
        inArray(findings.scmCommentId, [...input.commentIds]),
      ),
    )
    .orderBy(desc(reviews.createdAt))
    .limit(1);
  return row ?? null;
}
