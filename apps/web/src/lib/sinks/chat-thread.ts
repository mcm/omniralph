import "server-only";
import { appendChatMessage, postJobCommentOnce, type Database, type Job } from "@omniralph/db";
import { normalizeReplyAnswer } from "@omniralph/engine/reply";
import { RunSpecJobPayload, type ChatAskFileReference } from "@omniralph/shared";
import { z } from "zod";
import {
  defaultChatChannel,
  loadChatTarget,
  type ChatSource,
  type ChatTarget,
} from "@/lib/ralph/conversation";
import { fileWebUrl } from "@/lib/repositories/web-url";
import { inlineCode, MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import type { Sink, SinkResult } from "./index";

/** What the sink needs from the trigger context `enqueueChatAsk` stores. */
export const ChatThreadContext = z.object({
  /** `owner/repo` or `group/project`. */
  repository: z.string().min(1),
  /** The branch the question is answered from (the default branch). */
  branch: z.string().min(1),
  /** The repository's code host, for the answer's file links. */
  provider: z.enum(["github", "gitlab"]),
  /** The chat thread (`chat_threads.id`) the answer is posted in. */
  chatThreadId: z.uuid(),
  /** The run's token budget when it was enqueued, quoted when it runs out. */
  budgetTokens: z.int().min(1),
});
export type ChatThreadContext = z.infer<typeof ChatThreadContext>;

type ThreadJob = Pick<Job, "id" | "organizationId" | "payload" | "repositoryId">;

/**
 * Posts `render`'s text (sanitized) in the job's thread and records it as an
 * assistant message, at most once per job (the posted message's ID is kept
 * on the job). False when nothing was posted: already posted, or the thread
 * or its connection is gone (logged).
 */
async function postInThread(
  db: Database,
  job: ThreadJob,
  source: ChatSource,
  render: (context: ChatThreadContext, target: ChatTarget) => string,
): Promise<boolean> {
  const payload = RunSpecJobPayload.parse(job.payload);
  const context = ChatThreadContext.parse(payload.trigger.context);
  const { posted } = await postJobCommentOnce(db, job.id, async () => {
    const target = await loadChatTarget(source, {
      chatThreadId: context.chatThreadId,
      organizationId: job.organizationId,
      repositoryId: payload.repositoryId ?? job.repositoryId,
    });
    if (!target) {
      console.warn(
        `Skipping the answer of code question job ${job.id}: the thread or its chat connection is gone`,
      );
      return null;
    }
    const markdown = sanitizeCapped(
      render(context, target),
      { allowedHosts: target.allowedHosts },
      MAX_BODY_CHARS,
    );
    const message = await target.send(() =>
      target.adapter.postMessage(target.thread.externalThreadId, { markdown }),
    );
    await appendChatMessage(db, {
      threadId: target.thread.id,
      role: "assistant",
      content: markdown,
    });
    return message.id;
  });
  return posted;
}

/** Our own text (not model output): the files the answer cites, linked on the code host. */
function referencesLine(
  context: ChatThreadContext,
  references: readonly ChatAskFileReference[],
  repositoryUrl: string | null,
): string | null {
  if (references.length === 0) return null;
  const links = references.map((reference) => {
    const lines =
      reference.startLine === undefined
        ? ""
        : reference.endLine !== undefined && reference.endLine !== reference.startLine
          ? `:${reference.startLine}-${reference.endLine}`
          : `:${reference.startLine}`;
    const label = inlineCode(`${reference.path}${lines}`);
    return repositoryUrl
      ? `[${label}](${fileWebUrl(context.provider, repositoryUrl, context.branch, reference)})`
      : label;
  });
  return `Files: ${links.join(", ")}`;
}

/**
 * For a completed `builtin:ask-about-code` run: posts the answer (trimmed,
 * capped at 4000 characters, with links to the files it cites), or a note
 * why there is none, in the thread. Safe to call again for a replayed
 * result: it posts at most once. `source` is the deployment's chat bot
 * unless a test passes another.
 */
export async function applyChatAnswer(
  db: Database,
  job: ThreadJob,
  result: SinkResult<null>,
  source: ChatSource = defaultChatChannel,
): Promise<boolean> {
  const answer = result.answer !== null ? normalizeReplyAnswer(result.answer) : null;
  return postInThread(db, job, source, (context, target) => {
    const repo = inlineCode(context.repository);
    switch (result.outcome) {
      case "answered": {
        const files = referencesLine(context, result.references, target.repositoryUrl);
        return files ? `${answer ?? ""}\n\n${files}` : (answer ?? "");
      }
      case "budget_exhausted":
        return `Sorry, I couldn't finish an answer about ${repo} within the token budget for code questions (${context.budgetTokens.toLocaleString("en-US")} tokens). Try a narrower question.`;
      case "no_checkout":
        return `Sorry, I couldn't answer: ${repo} has no ${inlineCode(context.branch)} branch to read.`;
    }
  });
}

/** A code question that failed for good: a short apology in the thread (once). */
export async function onChatAnswerFailed(
  db: Database,
  job: ThreadJob,
  source: ChatSource = defaultChatChannel,
): Promise<boolean> {
  return postInThread(
    db,
    job,
    source,
    (context) =>
      `Sorry, I couldn't answer that question about ${inlineCode(context.repository)}; the job failed. Try asking again later.`,
  );
}

/** `chat-thread`: posts a run's Markdown answer in the chat thread it was asked in. */
export const chatThreadSink: Sink<null> = {
  kind: "chat-thread",
  outputSchema: null,
  apply: (db, job, result) => applyChatAnswer(db, job, result),
  onFailed: (db, job) => onChatAnswerFailed(db, job),
};
