import { stat } from "node:fs/promises";
import path from "node:path";
import {
  buildChatAskPrompt,
  CHAT_ASK_SYSTEM_PROMPT,
  CONVENTIONS_PATH,
  extractFileReferences,
  showFile,
  type QuestionAnswerer,
  type ReplyOutcome,
} from "@omniralph/engine";
import {
  ChatAskJobPayload,
  MAX_CHAT_ASK_REFERENCES,
  MAX_LEASE_SECONDS,
  type ChatAskFileReference,
  type ChatAskJobResult,
  type JobPayload,
} from "@omniralph/shared";
import { RetryableJobError, type JobContext } from "./index.js";
import { reviewSessionProvider } from "./review.js";

/** Most turns a code question may take: more than a thread reply, since it starts from nothing. */
export const CHAT_ASK_MAX_TURNS = 30;

export interface ChatAskOptions {
  /** Defaults to the engine's Claude Agent SDK provider (host `claude` login). */
  answerer?: QuestionAnswerer;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
}

/** The answer's references to files that exist in the checkout, at most `MAX_CHAT_ASK_REFERENCES`. */
async function existingReferences(answer: string, root: string): Promise<ChatAskFileReference[]> {
  const kept: ChatAskFileReference[] = [];
  for (const reference of extractFileReferences(answer)) {
    const file = path.resolve(root, reference.path);
    if (path.relative(root, file).startsWith("..")) continue;
    const isFile = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!isFile) continue;
    kept.push(reference);
    if (kept.length === MAX_CHAT_ASK_REFERENCES) break;
  }
  return kept;
}

/**
 * `chat.ask`: answers a question about a repository from a chat thread.
 * Claude gets the question, the conversation excerpt and the default
 * branch's `CLAUDE.md` (all quoted as data) and the review sandbox
 * (`REVIEW_TOOL_POLICY`: Read/Grep/Glob confined to a fresh worktree of the
 * default branch, no settings), capped at the payload's `maxTokens`. The
 * answer's references to files of the checkout come back with it; the
 * control panel posts the answer in the thread.
 */
export async function runChatAsk(
  job: JobPayload,
  ctx: JobContext,
  options: ChatAskOptions = {},
): Promise<ChatAskJobResult> {
  const parsed = ChatAskJobPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid chat.ask payload");
  const payload = parsed.data;
  const { repository, defaultBranch } = payload;
  const started = Date.now();
  const git = { env: ctx.env(), signal: ctx.signal };
  const log = ctx.logger.child({
    repo: `${repository.provider}/${repository.fullPath}`,
    chatThreadId: payload.chatThreadId,
  });
  const answerer = options.answerer ?? reviewSessionProvider(log);

  const sha = await ctx.repos.branchHead(repository, defaultBranch, git);
  if (!sha) {
    log.warn({ branch: defaultBranch }, "the default branch doesn't exist; not answering");
    return {
      outcome: "no_checkout",
      answer: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - started,
    };
  }

  const { outcome, references } = await ctx.repos.withWorktree(
    repository,
    sha,
    { ...git, jobId: job.id },
    async (worktree): Promise<{ outcome: ReplyOutcome; references: ChatAskFileReference[] }> => {
      const conventions = await showFile(
        worktree.path,
        sha,
        CONVENTIONS_PATH,
        ctx.repos.gitEnv(ctx.env()),
      );
      const outcome = await answerer.answer({
        prompt: buildChatAskPrompt({
          repository: repository.fullPath,
          branch: defaultBranch,
          question: payload.question,
          context: payload.context,
          conventions: conventions ?? null,
        }),
        systemPrompt: CHAT_ASK_SYSTEM_PROMPT,
        cwd: worktree.path,
        allowExploration: true,
        maxTurns: CHAT_ASK_MAX_TURNS,
        model: payload.model ?? undefined,
        maxTokens: payload.maxTokens,
        signal: ctx.signal,
      });
      const references =
        outcome.status === "answered" && outcome.answer !== null
          ? await existingReferences(outcome.answer, worktree.path)
          : [];
      return { outcome, references };
    },
  );

  const base = { usage: outcome.usage, durationMs: Date.now() - started };
  log.info({ status: outcome.status, usage: outcome.usage }, "code question finished");
  switch (outcome.status) {
    case "rate_limited": {
      const seconds =
        outcome.retryAfterMs !== undefined
          ? Math.ceil(outcome.retryAfterMs / 1000)
          : (options.defaultRetryAfterSeconds ?? 300);
      throw new RetryableJobError(
        outcome.error ?? "Claude rate limit",
        Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
      );
    }
    case "error":
      throw new Error(outcome.error ?? "the code question failed");
    case "budget_exhausted":
      return { ...base, outcome: "budget_exhausted", answer: null };
    case "answered":
      if (outcome.answer === null) throw new Error("the answer was empty");
      return { ...base, outcome: "answered", answer: outcome.answer, references };
  }
}
