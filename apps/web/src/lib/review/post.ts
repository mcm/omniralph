import "server-only";
import {
  getRepositoryWithConnection,
  postReviewOnce,
  type Database,
  type FindingRow,
  type Review,
} from "@omniralph/db";
import type { ReviewResult } from "@omniralph/engine";
import { renderSummary } from "@omniralph/engine/summary";
import type { InlineComment } from "@omniralph/scm";
import type { Finding, ReviewJobPayload, ReviewJobResult } from "@omniralph/shared";
import { getAppUrl } from "@/lib/app-url";
import { connectionBotHandle } from "@/lib/mentions/commands";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { scmAdapterFor } from "@/lib/scm/adapters";
import {
  capSummary,
  inlineCode,
  sanitizeCapped,
  sanitizeFinding,
  type SanitizeContext,
} from "./sanitize";

/** Longest error text quoted in a failure note. */
const MAX_FAILURE_NOTE_ERROR_CHARS = 1_000;

/** The review's page in the control panel (Epic B). */
export function reviewUrl(reviewId: string): string {
  return `${getAppUrl()}/reviews/${reviewId}`;
}

async function repositoryTarget(db: Database, review: Review, payload: ReviewJobPayload) {
  const found = await getRepositoryWithConnection(db, review.repositoryId);
  if (!found) throw new Error(`repository ${review.repositoryId} not found`);
  const { repository, connection } = found;
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const sanitize: SanitizeContext = {
    allowedHosts: [new URL(webUrl).hostname],
    author: payload.changeRequest.author,
  };
  return {
    adapter: scmAdapterFor(db, connection),
    handle: connectionBotHandle(connection),
    repo: { fullPath: repository.fullPath, externalId: repository.externalId },
    sanitize,
  };
}

function inlineComment(row: FindingRow, ctx: SanitizeContext): InlineComment {
  const { title, body, suggestion } = sanitizeFinding(row, ctx);
  const confidence = Math.round(row.confidence * 100);
  return {
    path: row.path,
    line: row.endLine,
    ...(row.startLine !== row.endLine ? { startLine: row.startLine } : {}),
    side: "new",
    body: `**[${row.severity}] ${title}**\n\n${body}\n\n_${row.category} · confidence ${confidence}%_`,
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

function asFinding(row: FindingRow): Finding {
  return {
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    severity: row.severity,
    category: row.category as Finding["category"],
    title: row.title,
    body: row.body,
    confidence: row.confidence,
  };
}

/**
 * Posts a finished review (inline comments with sanitized text and suggestion
 * blocks, plus the summary comment) and stores the comment IDs. At most once
 * per review: a replayed or concurrent call finds the stored summary comment
 * ID and posts nothing. Returns whether this call posted.
 */
export async function postReview(
  db: Database,
  input: { reviewId: string; payload: ReviewJobPayload; result: ReviewJobResult },
): Promise<boolean> {
  const { posted } = await postReviewOnce(db, input.reviewId, async (review, rows) => {
    if (review.status !== "completed" && review.status !== "budget_exhausted") return null;
    const { adapter, handle, repo, sanitize } = await repositoryTarget(db, review, input.payload);
    const { profile } = input.payload.reviewConfig;
    const summaryInput: ReviewResult = {
      profile: { id: profile.id, name: profile.name },
      budget: review.budget,
      findings: rows.map(asFinding),
      usage: input.result.usage,
      skipped: input.result.skipped,
      stopReason: input.result.stopReason,
      scope: input.result.scope,
      discarded: input.result.discarded,
      repeatedOpenFindings: input.result.repeatedOpenFindings ?? [],
    };
    const posted = await adapter.postReview(repo, review.prNumber, {
      summary: capSummary(renderSummary(summaryInput, reviewUrl(review.id), { botHandle: handle })),
      inlineComments: rows.map((row) => inlineComment(row, sanitize)),
      commitSha: review.headSha,
    });
    const findingCommentIds = new Map<string, string>();
    rows.forEach((row, i) => {
      const id = posted.inlineCommentIds[i];
      if (id) findingCommentIds.set(row.id, id);
    });
    return { summaryCommentId: posted.summaryCommentId, findingCommentIds };
  });
  return posted;
}

/** Posts a short note that the review failed, at most once per review. */
export async function postFailureNote(
  db: Database,
  input: { reviewId: string; payload: ReviewJobPayload; error: string },
): Promise<boolean> {
  const { posted } = await postReviewOnce(db, input.reviewId, async (review) => {
    if (review.status !== "failed") return null;
    const { adapter, repo, sanitize } = await repositoryTarget(db, review, input.payload);
    const error = sanitizeCapped(
      input.error.replace(/\s+/g, " ").trim(),
      sanitize,
      MAX_FAILURE_NOTE_ERROR_CHARS,
    );
    const summary = [
      "## Omniralph review",
      "",
      `The review of ${inlineCode(review.headSha.slice(0, 12))} failed: ${error}`,
      "",
      `[View the review](${reviewUrl(review.id)})`,
      "",
    ].join("\n");
    const result = await adapter.postReview(repo, review.prNumber, {
      summary,
      inlineComments: [],
      commitSha: review.headSha,
    });
    return { summaryCommentId: result.summaryCommentId };
  });
  return posted;
}
