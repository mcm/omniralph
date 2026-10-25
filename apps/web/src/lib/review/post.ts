import "server-only";
import {
  CANCELED_REVIEW_ERROR,
  getRepositoryWithConnection,
  postReviewRunOnce,
  type Database,
  type FindingRow,
  type Review,
  type ReviewRun,
} from "@omniralph/db";
import type { ReviewResult } from "@omniralph/engine";
import { renderSummary } from "@omniralph/engine/summary";
import type { InlineComment } from "@omniralph/scm";
import { REVIEW_DEPTHS, REVIEW_SKIP_REASONS, type Finding } from "@omniralph/shared";
import { getAppUrl } from "@/lib/app-url";
import { getPlaybookTask, organizationPlaybooks, type PlaybookSource } from "@/lib/definitions";
import { connectionBotHandle } from "@/lib/mentions/commands";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { scmAdapterFor } from "@/lib/scm/adapters";
import {
  capSummary,
  MAX_BODY_CHARS,
  inlineCode,
  sanitizeCapped,
  sanitizeFinding,
  sanitizeTitle,
  type SanitizeContext,
} from "./sanitize";

/** Longest error text quoted in a failure note. */
const MAX_FAILURE_NOTE_ERROR_CHARS = 1_000;

/** The review's page in the control panel (Epic B). */
export function reviewUrl(reviewId: string): string {
  return `${getAppUrl()}/reviews/${reviewId}`;
}

/** Where and how to post for a review: the SCM adapter, repository, bot handle and sanitize context. */
export async function repositoryTarget(
  db: Database,
  review: Pick<Review, "repositoryId">,
  author: string | null,
) {
  const found = await getRepositoryWithConnection(db, review.repositoryId);
  if (!found) throw new Error(`repository ${review.repositoryId} not found`);
  const { repository, connection } = found;
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const sanitize: SanitizeContext = { allowedHosts: [new URL(webUrl).hostname], author };
  return {
    adapter: scmAdapterFor(db, connection),
    handle: connectionBotHandle(connection),
    repo: { fullPath: repository.fullPath, externalId: repository.externalId },
    sanitize,
  };
}

/** Review task names by ID, looked up once: a task's name, or its ID when it isn't a known task. */
export async function reviewTaskNames(
  definitions: PlaybookSource,
  taskIds: Iterable<string>,
): Promise<(taskId: string) => string> {
  const names = new Map<string, string>();
  for (const id of new Set(taskIds))
    names.set(id, (await getPlaybookTask(definitions, id))?.name ?? id);
  return (taskId) => names.get(taskId) ?? taskId;
}

/**
 * A finding's inline comment; its footer names the tasks that reported it,
 * in `taskOrder` (a review run's task order) when given.
 */
function inlineComment(
  row: FindingRow,
  ctx: SanitizeContext,
  taskName: (taskId: string) => string,
  taskOrder: readonly (string | null)[] = [],
): InlineComment {
  const { title, body, suggestion } = sanitizeFinding(row, ctx);
  const confidence = Math.round(row.confidence * 100);
  const rank = (id: string) => {
    const i = taskOrder.indexOf(id);
    return i === -1 ? taskOrder.length : i;
  };
  const tasks = [...row.sourceTaskIds].sort((a, b) => rank(a) - rank(b));
  const footer = [
    row.category,
    `confidence ${confidence}%`,
    ...(tasks.length > 0 ? [sanitizeTitle(tasks.map(taskName).join(", "), ctx)] : []),
  ].join(" · ");
  return {
    path: row.path,
    line: row.endLine,
    ...(row.startLine !== row.endLine ? { startLine: row.startLine } : {}),
    side: "new",
    body: `**[${row.severity}] ${title}**\n\n${body}\n\n_${footer}_`,
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

/** Reviews whose findings were saved: a review run's completed task runs. */
function finishedReview(review: Review): boolean {
  return review.status === "completed" || review.status === "budget_exhausted";
}

/** The task name of a review of a review run. */
function reviewTaskLabel(review: Review, taskName: (taskId: string) => string): string {
  return review.taskId ? taskName(review.taskId) : "Review";
}

/** Names of the tasks of a review run's reviews and of the tasks that reported `rows`. */
function runTaskNames(
  db: Database,
  run: Pick<ReviewRun, "organizationId">,
  reviews: readonly Review[],
  rows: readonly FindingRow[] = [],
): Promise<(taskId: string) => string> {
  return reviewTaskNames(organizationPlaybooks(db, run.organizationId), [
    ...reviews.flatMap((r) => (r.taskId ? [r.taskId] : [])),
    ...rows.flatMap((row) => row.sourceTaskIds),
  ]);
}

/**
 * The `renderSummary` input of a review run: its posted findings, plus the
 * finished task runs' tokens and budgets summed, their skipped files merged
 * and the worst stop reason. The scope is incremental only when every
 * finished task run's was.
 */
export function reviewRunSummaryInput(
  run: Pick<ReviewRun, "depth" | "baseSha" | "headSha">,
  finished: readonly Review[],
  posted: readonly FindingRow[],
): ReviewResult {
  const skipped = new Map<string, ReviewResult["skipped"][number]>();
  for (const review of finished) {
    for (const file of review.skippedFiles) {
      const reason = REVIEW_SKIP_REASONS.find((r) => r === file.reason);
      if (reason && !skipped.has(file.path)) skipped.set(file.path, { path: file.path, reason });
    }
  }
  const scopes = finished.map((r) => r.scope);
  const [first] = scopes;
  const scope: ReviewResult["scope"] =
    first?.mode === "incremental" && scopes.every((s) => s?.mode === "incremental")
      ? first
      : { mode: "full", baseSha: run.baseSha, headSha: run.headSha };
  return {
    profile: run.depth
      ? { id: run.depth, name: REVIEW_DEPTHS[run.depth].label }
      : { id: "unknown", name: "unknown" },
    budget: finished.reduce((sum, r) => sum + r.budget, 0),
    findings: posted.map(asFinding),
    usage: {
      inputTokens: finished.reduce((sum, r) => sum + r.tokensIn, 0),
      outputTokens: finished.reduce((sum, r) => sum + r.tokensOut, 0),
    },
    skipped: [...skipped.values()],
    stopReason: finished.some((r) => r.status === "budget_exhausted")
      ? "budget_exhausted"
      : "completed",
    scope,
    discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
    fixedOpenFindings: [],
  };
}

/** The review run's page: that of its first review. */
function reviewRunUrl(reviews: readonly Review[]): string | null {
  const [first] = reviews;
  return first ? reviewUrl(first.id) : null;
}

/**
 * Posts a review run that ended, at most once (`postReviewRunOnce`); returns
 * whether this call posted. A `completed` run is posted as one review: an
 * inline comment per `open` finding of its finished task runs (their footer
 * naming the tasks that reported it; `merged` ones are left out) and a
 * summary of the correlation summary (sanitized, when there is one), the
 * names of the task runs that failed and `renderSummary`'s stats over the
 * finished task runs. A `failed` run (every task run failed) gets one short
 * failure note. Other runs post nothing. Summary-only task runs (which post
 * to a sticky comment) are left out; a run of only those posts nothing.
 */
export async function postReviewRun(db: Database, reviewRunId: string): Promise<boolean> {
  const { posted } = await postReviewRunOnce(db, reviewRunId, async (run, runReviews, rows) => {
    const reviews = runReviews.filter((r) => !r.summaryOnly);
    const url = reviewRunUrl(reviews);
    if (!url) return null;
    if (run.status === "failed") return postRunFailureNote(db, run, reviews, url);
    if (run.status !== "completed") return null;
    const finished = reviews.filter(finishedReview);
    if (finished.length === 0) return null;
    const finishedIds = new Set(finished.map((r) => r.id));
    const open = rows.filter((f) => f.status === "open" && finishedIds.has(f.reviewId));
    const { adapter, handle, repo, sanitize } = await repositoryTarget(db, run, run.prAuthor);
    const taskName = await runTaskNames(db, run, reviews, open);

    const failed = reviews.filter((r) => r.status === "failed");
    const preamble = [
      ...(run.summary ? [sanitizeCapped(run.summary, sanitize, MAX_BODY_CHARS)] : []),
      ...(failed.length > 0
        ? [
            `> [!CAUTION]\n> ${failed.length === 1 ? "This review task" : "These review tasks"} failed, so ${failed.length === 1 ? "its" : "their"} findings are missing: ${sanitizeTitle(failed.map((r) => reviewTaskLabel(r, taskName)).join(", "), sanitize)}.`,
          ]
        : []),
    ].join("\n\n");
    const summary = renderSummary(reviewRunSummaryInput(run, finished, open), url, {
      botHandle: handle,
      preamble,
    });
    const result = await adapter.postReview(repo, run.prNumber, {
      summary: capSummary(summary),
      inlineComments: open.map((row) =>
        inlineComment(
          row,
          sanitize,
          taskName,
          reviews.map((r) => r.taskId),
        ),
      ),
      commitSha: run.headSha,
    });
    const findingCommentIds = new Map<string, string>();
    open.forEach((row, i) => {
      const id = result.inlineCommentIds[i];
      if (id) findingCommentIds.set(row.id, id);
    });
    return { summaryCommentId: result.summaryCommentId, findingCommentIds };
  });
  return posted;
}

/** The failure note of a review run whose task runs all failed. */
async function postRunFailureNote(
  db: Database,
  run: ReviewRun,
  reviews: readonly Review[],
  url: string,
): Promise<{ summaryCommentId: string }> {
  const { adapter, repo, sanitize } = await repositoryTarget(db, run, run.prAuthor);
  const failed = reviews.filter(
    (r) => r.status === "failed" || (r.status === "skipped" && r.error === CANCELED_REVIEW_ERROR),
  );
  const taskName = await runTaskNames(db, run, failed);
  const errors = failed.map((r) => {
    const error = (r.error ?? "unknown error").replace(/\s+/g, " ").trim();
    return failed.length === 1 ? error : `${reviewTaskLabel(r, taskName)}: ${error}`;
  });
  const error = sanitizeCapped(
    errors.join("; ") || (run.error ?? "unknown error"),
    sanitize,
    MAX_FAILURE_NOTE_ERROR_CHARS,
  );
  const summary = [
    "## Omniralph review",
    "",
    `The review of ${inlineCode(run.headSha.slice(0, 12))} failed: ${error}`,
    "",
    `[View the review](${url})`,
    "",
  ].join("\n");
  const result = await adapter.postReview(repo, run.prNumber, {
    summary,
    inlineComments: [],
    commitSha: run.headSha,
  });
  return { summaryCommentId: result.summaryCommentId };
}
