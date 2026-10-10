import "server-only";
import { resolveEarlierOpenFindings, type Database, type FindingRow } from "@omniralph/db";
import { sameIssue, type FindingLocation } from "@omniralph/engine/same-issue";
import {
  MAX_REVIEW_FINDINGS,
  type ReviewJobPayload,
  type ReviewJobResult,
} from "@omniralph/shared";
import { reviewUrl } from "./post";
import { inlineCode } from "./sanitize";
import { closeFindingThreads } from "./threads";

const sameLocation = (a: FindingLocation, b: FindingLocation): boolean =>
  a.path === b.path &&
  a.startLine === b.startLine &&
  a.endLine === b.endLine &&
  a.category === b.category;

/**
 * After a re-review got through the whole diff (stopped `completed` with a
 * full scope): the PR's earlier `open` findings it didn't raise again become
 * `resolved`, and their SCM threads get a short reply linking the new review
 * and are resolved. A finding still counts as raised when a new finding
 * matches it (`sameIssue`) or the engine dropped one as its duplicate
 * (`repeatedOpenFindings`). Nothing is resolved for a review that stopped
 * early, hit the findings cap or came from an agent that doesn't report
 * repeats; findings on skipped files (excluded, over budget, ...) and ones
 * the review wasn't given stay open. Safe to call again.
 */
export async function resolveFindingsNotRaisedAgain(
  db: Database,
  input: { reviewId: string; payload: ReviewJobPayload; result: ReviewJobResult },
): Promise<FindingRow[]> {
  const { payload, result } = input;
  if (result.stopReason !== "completed" || result.scope.mode !== "full") return [];
  if (result.findings.length >= MAX_REVIEW_FINDINGS) return [];
  const fresh = payload.mode === "fresh";
  // Fresh reviews get no open findings, so the engine drops nothing as a repeat.
  if (!fresh && result.repeatedOpenFindings === undefined) return [];

  const given = fresh ? [] : (payload.previousReview?.openFindings ?? []);
  const repeated = (result.repeatedOpenFindings ?? []).flatMap((i) => given[i] ?? []);
  const skipped = new Set(result.skipped.map((s) => s.path));
  const resolved = await resolveEarlierOpenFindings(
    db,
    input.reviewId,
    (prior) =>
      skipped.has(prior.path) ||
      result.findings.some((f) => sameIssue(prior, f)) ||
      repeated.some((r) => sameLocation(prior, r)) ||
      (!fresh && !given.some((g) => sameLocation(prior, g))),
  );

  const link = reviewUrl(input.reviewId);
  await closeFindingThreads(db, input.reviewId, {
    kind: "stale",
    message: `A re-review of ${inlineCode(payload.headSha.slice(0, 12))} no longer raises this issue, so this thread is resolved.`,
    threads: resolved
      .filter((finding) => finding.scmCommentId !== null)
      .map((finding) => ({ finding, link })),
  });
  return resolved;
}
