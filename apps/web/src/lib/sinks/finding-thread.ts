import "server-only";
import {
  getRepositoryWithConnection,
  postJobCommentOnce,
  type Database,
  type Job,
} from "@omniralph/db";
import { normalizeReplyAnswer } from "@omniralph/engine/reply";
import { RunSpecJobPayload } from "@omniralph/shared";
import { z } from "zod";
import { reviewUrl } from "@/lib/review/post";
import { sanitizeCapped, MAX_BODY_CHARS, type SanitizeContext } from "@/lib/review/sanitize";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { tokenCount } from "./budget";
import type { Sink, SinkResult } from "./index";

/** What the sink needs from the trigger context `enqueueReply` stores. */
export const FindingThreadContext = z.object({
  pr: z.object({ number: z.int().min(1) }),
  review: z.object({ id: z.uuid() }),
  finding: z.object({ id: z.uuid() }),
  /** Code-host login of whoever asked. */
  askedBy: z.string().min(1).max(255),
  /** The finding's SCM comment (thread) the answer is posted in. */
  threadCommentId: z.string().min(1).max(255),
  /** The run's token budget when it was enqueued, quoted when it runs out; null for "No limit". */
  budgetTokens: z.int().min(1).nullable(),
});
export type FindingThreadContext = z.infer<typeof FindingThreadContext>;

type ThreadJob = Pick<Job, "id" | "payload" | "repositoryId">;

/** Posts `render(...)` (built from sanitized text) in the finding's thread, at most once per job. */
async function postInThread(
  db: Database,
  job: ThreadJob,
  render: (context: FindingThreadContext, ctx: SanitizeContext) => string,
): Promise<boolean> {
  const payload = RunSpecJobPayload.parse(job.payload);
  const context = FindingThreadContext.parse(payload.trigger.context);
  const repositoryId = payload.repositoryId ?? job.repositoryId;
  if (!repositoryId) throw new Error(`Reply job ${job.id} has no repository`);
  const { posted } = await postJobCommentOnce(db, job.id, async () => {
    const found = await getRepositoryWithConnection(db, repositoryId);
    if (!found) return null;
    const { repository, connection } = found;
    const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
    const ctx: SanitizeContext = {
      allowedHosts: [new URL(webUrl).hostname],
      author: context.askedBy,
    };
    const { id } = await scmAdapterFor(db, connection).replyToComment(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      context.pr.number,
      context.threadCommentId,
      render(context, ctx),
    );
    return id;
  });
  return posted;
}

/** Our own text (not model output): the asker and a link to the finding in the control panel. */
function footer(context: FindingThreadContext): string {
  const link = `${reviewUrl(context.review.id)}#finding-${context.finding.id}`;
  return `_Omniralph · answering @${context.askedBy} · [View the finding](${link})_`;
}

function failureNote(context: FindingThreadContext): string {
  return `Sorry, I couldn't answer this question; the job failed. Ask again later, @${context.askedBy}.`;
}

/**
 * For a completed `builtin:reply-to-finding` run: posts the answer (trimmed, capped at
 * `MAX_REPLY_ANSWER_LENGTH`, through the output sanitizer) in the finding's
 * thread, or a note that the reply budget ran out. Safe to call again for a
 * replayed result: it posts at most once.
 */
export async function applyThreadReply(
  db: Database,
  job: ThreadJob,
  result: SinkResult<null>,
): Promise<boolean> {
  const answer = result.answer !== null ? normalizeReplyAnswer(result.answer) : null;
  return postInThread(db, job, (context, ctx) => {
    if (answer !== null) {
      return `${sanitizeCapped(answer, ctx, MAX_BODY_CHARS)}\n\n${footer(context)}`;
    }
    const text =
      result.outcome === "budget_exhausted"
        ? `Sorry, I couldn't finish an answer within this repo's reply budget${tokenCount(context.budgetTokens)}.`
        : failureNote(context);
    return `${sanitizeCapped(text, ctx, MAX_BODY_CHARS)}\n\n${footer(context)}`;
  });
}

/** A thread reply that failed for good: a short apology in the thread (once). */
export async function onThreadReplyFailed(db: Database, job: ThreadJob): Promise<boolean> {
  return postInThread(db, job, (context, ctx) =>
    sanitizeCapped(failureNote(context), ctx, MAX_BODY_CHARS),
  );
}

/** `finding-thread`: posts a run's Markdown answer in a review finding's thread. */
export const findingThreadSink: Sink<null> = {
  kind: "finding-thread",
  taskType: "query",
  outputSchema: null,
  apply: applyThreadReply,
  onFailed: (db, job) => onThreadReplyFailed(db, job),
};
