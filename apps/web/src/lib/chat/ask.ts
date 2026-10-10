import "server-only";
import { appendChatMessage, postJobCommentOnce, type Database, type Job } from "@omniralph/db";
import { ChatAskJobPayload, ChatAskJobResult } from "@omniralph/shared";
import {
  defaultChatChannel,
  loadChatTarget,
  type ChatSource,
  type ChatTarget,
} from "@/lib/ralph/conversation";
import { fileWebUrl } from "@/lib/repositories/web-url";
import { inlineCode, MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";

/**
 * Code questions from chat: a `chat.ask` job answers a question about a
 * repository on an agent host (read-only, in the review sandbox); these
 * hooks post its answer in the chat thread it came from and record it in the
 * thread's history. The control panel never reads the code itself.
 */

/** Validates a code question's result before the job is completed. */
export function parseChatAskResult(result: unknown): ChatAskJobResult | null {
  const parsed = ChatAskJobResult.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/**
 * Posts `render`'s text (sanitized) in the job's thread and records it as an
 * assistant message, at most once per job (the posted message's ID is kept
 * on the job). False when nothing was posted: already posted, or the thread
 * or its connection is gone (logged). `source` is the deployment's chat bot
 * unless a test passes another.
 */
async function postInThread(
  db: Database,
  job: Job,
  source: ChatSource,
  render: (payload: ChatAskJobPayload, target: ChatTarget) => string,
): Promise<boolean> {
  const payload = ChatAskJobPayload.parse(job.payload);
  const { posted } = await postJobCommentOnce(db, job.id, async () => {
    const target = await loadChatTarget(source, {
      chatThreadId: payload.chatThreadId,
      organizationId: job.organizationId,
      repositoryId: payload.repositoryId,
    });
    if (!target) {
      console.warn(
        `Skipping the answer of chat.ask job ${job.id}: the thread or its chat connection is gone`,
      );
      return null;
    }
    const markdown = sanitizeCapped(
      render(payload, target),
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
  payload: ChatAskJobPayload,
  result: ChatAskJobResult,
  repositoryUrl: string | null,
): string | null {
  const references = result.references ?? [];
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
      ? `[${label}](${fileWebUrl(payload.repository.provider, repositoryUrl, payload.defaultBranch, reference)})`
      : label;
  });
  return `Files: ${links.join(", ")}`;
}

/**
 * For a `completed` code question: posts the answer (with links to the
 * files it cites), or a note why there is none, in the thread. Safe to call
 * again for a replayed result: it posts at most once.
 */
export async function onChatAskJobCompleted(
  db: Database,
  job: Job,
  source: ChatSource = defaultChatChannel,
): Promise<boolean> {
  const result = ChatAskJobResult.parse(job.result);
  return postInThread(db, job, source, (payload, target) => {
    const repo = inlineCode(payload.repository.fullPath);
    switch (result.outcome) {
      case "answered": {
        const files = referencesLine(payload, result, target.repositoryUrl);
        return files ? `${result.answer}\n\n${files}` : (result.answer ?? "");
      }
      case "budget_exhausted":
        return `Sorry, I couldn't finish an answer about ${repo} within the token budget for code questions (${payload.maxTokens.toLocaleString("en-US")} tokens). Try a narrower question.`;
      case "no_checkout":
        return `Sorry, I couldn't answer: ${repo} has no ${inlineCode(payload.defaultBranch)} branch to read.`;
    }
  });
}

/** A code question that failed for good: a short apology in the thread (once). */
export async function onChatAskJobFailed(
  db: Database,
  job: Job,
  source: ChatSource = defaultChatChannel,
): Promise<boolean> {
  return postInThread(
    db,
    job,
    source,
    (payload) =>
      `Sorry, I couldn't answer that question about ${inlineCode(payload.repository.fullPath)}; the job failed. Try asking again later.`,
  );
}
