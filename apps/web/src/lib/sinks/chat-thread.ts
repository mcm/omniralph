import "server-only";
import type { Database, Job } from "@omniralph/db";
import { normalizeReplyAnswer } from "@omniralph/engine/reply";
import { RunSpecJobPayload, type ChatAskFileReference } from "@omniralph/shared";
import { z } from "zod";
import {
  defaultChatChannel,
  loadChatTarget,
  type ChatSource,
  type ChatTarget,
} from "@/lib/ralph/conversation";
import { recordChatRunEvent, type ChatRunEventBody } from "@/lib/chat/run-events";
import { fileWebUrl } from "@/lib/repositories/web-url";
import { inlineCode } from "@/lib/review/sanitize";
import type { Sink, SinkResult } from "./index";

/** What the sink needs from the trigger context `enqueueChatAsk` stores. */
export const ChatThreadContext = z.object({
  /** `owner/repo` or `group/project`. */
  repository: z.string().min(1),
  /** The branch the question is answered from (the default branch). */
  branch: z.string().min(1),
  /** The repository's code host, for the answer's file links. */
  provider: z.enum(["github", "gitlab"]),
  /** The chat thread (`chat_threads.id`) the answer is recorded for. */
  chatThreadId: z.uuid(),
  /** The run's token budget when it was enqueued, quoted when it runs out. */
  budgetTokens: z.int().min(1),
});
export type ChatThreadContext = z.infer<typeof ChatThreadContext>;

type ThreadJob = Pick<Job, "id" | "organizationId" | "payload" | "repositoryId">;

/**
 * Records `render`'s event (sanitized) for the job's thread instead of
 * posting it: the chat responder relays it. At most once per job and kind.
 * False when nothing was recorded: already recorded, or the thread, its
 * connection or the job's mapping to it is gone (logged).
 */
async function recordInThread(
  job: ThreadJob,
  source: ChatSource,
  kind: "response" | "failure",
  render: (context: ChatThreadContext, target: ChatTarget) => ChatRunEventBody,
): Promise<boolean> {
  const payload = RunSpecJobPayload.parse(job.payload);
  const context = ChatThreadContext.parse(payload.trigger.context);
  const target = await loadChatTarget(source, {
    chatThreadId: context.chatThreadId,
    organizationId: job.organizationId,
    repositoryId: payload.repositoryId ?? job.repositoryId,
  });
  if (!target) {
    console.warn(
      `Skipping the answer of code question job ${job.id}: the thread or its chat connection is gone`,
    );
    return false;
  }
  return recordChatRunEvent(target, {
    organizationId: job.organizationId,
    run: { jobId: job.id },
    kind,
    body: render(context, target),
    key: kind,
  });
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
 * For a completed `builtin:ask-about-code` run: records the answer (trimmed,
 * with links to the files it cites), or a note why there is none, as the
 * thread's `response` event. Safe to call again for a replayed result: it
 * records at most once. `source` is the deployment's chat bot unless a test
 * passes another.
 */
export async function applyChatAnswer(
  _db: Database,
  job: ThreadJob,
  result: SinkResult<null>,
  source: ChatSource = defaultChatChannel,
): Promise<boolean> {
  const answer = result.answer !== null ? normalizeReplyAnswer(result.answer) : null;
  return recordInThread(job, source, "response", (context, target) => {
    const repo = inlineCode(context.repository);
    const details = { outcome: result.outcome, repository: context.repository };
    switch (result.outcome) {
      case "answered": {
        const files = referencesLine(context, result.references, target.repositoryUrl);
        return { ...details, text: files ? `${answer ?? ""}\n\n${files}` : (answer ?? "") };
      }
      case "budget_exhausted":
        return {
          ...details,
          text: `Sorry, I couldn't finish an answer about ${repo} within the token budget for code questions (${context.budgetTokens.toLocaleString("en-US")} tokens). Try a narrower question.`,
        };
      case "no_checkout":
        return {
          ...details,
          text: `Sorry, I couldn't answer: ${repo} has no ${inlineCode(context.branch)} branch to read.`,
        };
    }
  });
}

/** A code question that failed for good: the thread's `failure` event (once). */
export async function onChatAnswerFailed(
  _db: Database,
  job: ThreadJob,
  source: ChatSource = defaultChatChannel,
  error: string | null = null,
): Promise<boolean> {
  return recordInThread(job, source, "failure", (context) => ({
    repository: context.repository,
    error,
    text: `Sorry, I couldn't answer that question about ${inlineCode(context.repository)}; the job failed. Try asking again later.`,
  }));
}

/** `chat-thread`: records a run's Markdown answer as an event of the chat thread it was asked in. */
export const chatThreadSink: Sink<null> = {
  kind: "chat-thread",
  taskType: "query",
  outputSchema: null,
  apply: (db, job, result) => applyChatAnswer(db, job, result),
  onFailed: (db, job, error) => onChatAnswerFailed(db, job, defaultChatChannel, error),
};
