import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLearnRulePrompt, diff, findingHunks, type RuleLearner } from "@omniralph/engine";
import {
  LearnRuleJobPayload,
  MAX_LEASE_SECONDS,
  type JobPayload,
  type LearnRuleJobResult,
} from "@omniralph/shared";
import { RetryableJobError, type JobContext } from "./index.js";
import { reviewSessionProvider } from "./review.js";

export interface LearnRuleOptions {
  /** Defaults to the engine's Claude Agent SDK provider (host `claude` login). */
  learner?: RuleLearner;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
}

/**
 * The finding's diff hunk from the repo cache (`git diff base...head -- path`),
 * or null when it can't be computed (e.g. the commits are gone after a
 * force-push); the rule is then generated from the finding and note alone.
 */
async function loadHunk(payload: LearnRuleJobPayload, ctx: JobContext): Promise<string | null> {
  const { repository, baseSha, headSha, finding } = payload;
  try {
    await ctx.repos.sync(repository, {
      env: ctx.env(),
      signal: ctx.signal,
      shas: [baseSha, headSha],
    });
    const text = await diff(
      ctx.repos.repoDir(repository),
      `${baseSha}...${headSha}`,
      ctx.repos.gitEnv(ctx.env()),
      [finding.path],
    );
    return findingHunks(text, finding);
  } catch (error) {
    ctx.signal.throwIfAborted();
    ctx.logger.info(
      { err: error, findingId: payload.findingId },
      "finding diff hunk not available",
    );
    return null;
  }
}

/**
 * `review.learn-rule`: turns a false-positive dismissal into one generalized
 * "do not flag" rule (or none). Claude gets the finding, its diff hunk and the
 * dismissal note in the prompt, with no tools, in an empty directory, capped
 * at the payload's `maxTokens`. The control panel dedupes and stores the rule.
 */
export async function runLearnRule(
  job: JobPayload,
  ctx: JobContext,
  options: LearnRuleOptions = {},
): Promise<LearnRuleJobResult> {
  const parsed = LearnRuleJobPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid review.learn-rule payload");
  const payload = parsed.data;
  const started = Date.now();
  const hunk = await loadHunk(payload, ctx);
  const learner = options.learner ?? reviewSessionProvider(ctx.logger);

  // No tools, so the session never reads it; empty so nothing in it can be loaded either.
  const cwd = await mkdtemp(path.join(tmpdir(), "omniralph-learn-rule-"));
  const outcome = await learner
    .learnRule({
      prompt: buildLearnRulePrompt({ finding: payload.finding, hunk, note: payload.note }),
      cwd,
      model: payload.model ?? undefined,
      maxTokens: payload.maxTokens,
      signal: ctx.signal,
    })
    .finally(() => rm(cwd, { recursive: true, force: true }));

  const base = { usage: outcome.usage, durationMs: Date.now() - started };
  ctx.logger.info(
    { findingId: payload.findingId, status: outcome.status, usage: outcome.usage },
    "rule generation finished",
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
      throw new Error(outcome.error ?? "rule generation failed");
    case "rule":
      return { ...base, outcome: "rule", rule: outcome.rule };
    case "none":
      return { ...base, outcome: "none", rule: null };
    case "rejected":
      return {
        ...base,
        outcome: "rejected",
        rule: null,
        ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
      };
    case "budget_exhausted":
      return { ...base, outcome: "budget_exhausted", rule: null };
  }
}
