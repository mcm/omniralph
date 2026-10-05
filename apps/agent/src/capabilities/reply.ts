import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildReplyPrompt,
  ClaudeAgentProvider,
  diff,
  findingHunks,
  type QuestionAnswerer,
  type ReplyOutcome,
} from "@omniralph/engine";
import {
  MAX_LEASE_SECONDS,
  ReviewReplyJobPayload,
  type JobPayload,
  type ReviewReplyJobResult,
} from "@omniralph/shared";
import { RetryableJobError, type JobContext } from "./index.js";

export interface ReplyOptions {
  /** Defaults to the engine's Claude Agent SDK provider (host `claude` login). */
  answerer?: QuestionAnswerer;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
}

/**
 * `review.reply`: answers a question asked in a finding's thread. Claude gets
 * the finding, its diff hunk and the question in the prompt and the review's
 * read-only tools (Read/Grep/Glob) in a worktree at the review's head, capped
 * at the payload's `maxTokens` (10% of the profile budget). When the commits
 * are gone (e.g. after a force-push) it answers without the hunk and without
 * tools, in an empty directory. The control panel posts the answer.
 */
export async function runReply(
  job: JobPayload,
  ctx: JobContext,
  options: ReplyOptions = {},
): Promise<ReviewReplyJobResult> {
  const parsed = ReviewReplyJobPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid review.reply payload");
  const payload = parsed.data;
  const { repository, baseSha, headSha, finding } = payload;
  const started = Date.now();
  const git = { env: ctx.env(), signal: ctx.signal };
  const answerer = options.answerer ?? new ClaudeAgentProvider({ logger: ctx.logger });
  const request = {
    model: payload.model ?? undefined,
    maxTokens: payload.maxTokens,
    signal: ctx.signal,
  };

  let synced = true;
  await ctx.repos.sync(repository, { ...git, shas: [baseSha, headSha] }).catch((error: unknown) => {
    ctx.signal.throwIfAborted();
    ctx.logger.info({ err: error, findingId: payload.findingId }, "review commits not available");
    synced = false;
  });

  let outcome: ReplyOutcome;
  if (synced) {
    const hunk = await diff(
      ctx.repos.repoDir(repository),
      `${baseSha}...${headSha}`,
      ctx.repos.gitEnv(ctx.env()),
      [finding.path],
    ).then(
      (text) => findingHunks(text, finding),
      () => null,
    );
    outcome = await ctx.repos.withWorktree(
      repository,
      headSha,
      { ...git, jobId: job.id },
      (worktree) =>
        answerer.answer({
          ...request,
          prompt: buildReplyPrompt({ finding, hunk, question: payload.question }),
          cwd: worktree.path,
          allowExploration: true,
        }),
    );
  } else {
    const cwd = await mkdtemp(path.join(tmpdir(), "omniralph-reply-"));
    outcome = await answerer
      .answer({
        ...request,
        prompt: buildReplyPrompt({ finding, hunk: null, question: payload.question }),
        cwd,
        allowExploration: false,
      })
      .finally(() => rm(cwd, { recursive: true, force: true }));
  }

  const base = { usage: outcome.usage, durationMs: Date.now() - started };
  ctx.logger.info(
    { findingId: payload.findingId, status: outcome.status, usage: outcome.usage },
    "thread reply finished",
  );
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
      throw new Error(outcome.error ?? "the reply failed");
    case "budget_exhausted":
      return { ...base, outcome: "budget_exhausted", answer: null };
    case "answered":
      if (outcome.answer === null) throw new Error("the reply was empty");
      return { ...base, outcome: "answered", answer: outcome.answer };
  }
}
