import {
  DISALLOWED_TOOLS,
  EXPLORATION_TOOLS,
  runReview,
  type ReviewProvider,
} from "@omniralph/engine";
import {
  FINDING_SEVERITIES,
  MAX_LEASE_SECONDS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_SKIPPED,
  LEARN_RULE_JOB_TYPE,
  REVIEW_CAPABILITY,
  REVIEW_JOB_TYPE,
  ReviewJobPayload,
  type Finding,
  type LearnRuleJobResult,
  type ReviewJobResult,
} from "@omniralph/shared";
import { RetryableJobError, type Capability, type ToolPolicy } from "./index.js";
import { runLearnRule, type LearnRuleOptions } from "./learn-rule.js";

/** Review sessions only read the job's worktree (the engine's Claude provider enforces the same lists). */
export const REVIEW_TOOL_POLICY: ToolPolicy = {
  allowedTools: EXPLORATION_TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  fileScope: "worktree",
  permissionMode: "dontAsk",
  loadProjectSettings: false,
};

/**
 * The `limit` most severe (then most confident) findings, in their original
 * order, so the result fits `ReviewJobResult`.
 */
export function capFindings(findings: readonly Finding[], limit = MAX_REVIEW_FINDINGS): Finding[] {
  if (findings.length <= limit) return [...findings];
  const rank = (f: Finding) => FINDING_SEVERITIES.indexOf(f.severity);
  const kept = new Set(
    findings
      .map((finding, index) => ({ finding, index }))
      .sort(
        (a, b) =>
          rank(a.finding) - rank(b.finding) ||
          b.finding.confidence - a.finding.confidence ||
          a.index - b.index,
      )
      .slice(0, limit)
      .map(({ index }) => index),
  );
  return findings.filter((_, index) => kept.has(index));
}

export interface ReviewCapabilityOptions extends Pick<LearnRuleOptions, "learner"> {
  /** Defaults to the engine's Claude Agent SDK provider (host `claude` login). */
  provider?: ReviewProvider;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
}

/**
 * Code review (`review.run`), plus learned-rule generation from false-positive
 * dismissals (`review.learn-rule`, see `learn-rule.ts`). Makes sure the repo cache has the PR's base and
 * head (and the previous review's head, for incremental reviews), runs the
 * engine in a fresh worktree at head and returns the `ReviewJobResult`. It
 * calls no code-host API and holds no write credential: git authenticates
 * through the broker with the job token, and the control panel posts the
 * result.
 */
export function createReviewCapability(options: ReviewCapabilityOptions = {}): Capability {
  return {
    name: REVIEW_CAPABILITY,
    jobTypes: [REVIEW_JOB_TYPE, LEARN_RULE_JOB_TYPE],
    toolPolicy: REVIEW_TOOL_POLICY,
    async run(job, ctx): Promise<ReviewJobResult | LearnRuleJobResult> {
      if (job.type === LEARN_RULE_JOB_TYPE) return runLearnRule(job, ctx, options);
      const parsed = ReviewJobPayload.safeParse(job.payload);
      if (!parsed.success) throw new Error("invalid review.run payload");
      const payload = parsed.data;
      const { repository, baseSha, headSha, previousReview } = payload;
      const started = Date.now();
      const git = { env: ctx.env(), signal: ctx.signal };
      const log = ctx.logger.child({
        repo: `${repository.provider}/${repository.fullPath}`,
        prNumber: payload.prNumber,
        headSha,
      });

      await ctx.repos.sync(repository, { ...git, shas: [baseSha, headSha] });
      if (previousReview?.headSha) {
        // Gone after a force-push; the engine then reviews the full diff.
        await ctx.repos
          .sync(repository, { ...git, shas: [previousReview.headSha] })
          .catch((error: unknown) => {
            ctx.signal.throwIfAborted();
            log.info(
              { err: error, previousHeadSha: previousReview.headSha },
              "previous review head not available",
            );
          });
      }

      const result = await ctx.repos.withWorktree(
        repository,
        headSha,
        { ...git, jobId: job.id },
        (worktree) =>
          runReview(
            {
              cwd: worktree.path,
              baseSha,
              headSha,
              reviewConfig: payload.reviewConfig,
              changeRequest: payload.changeRequest,
              previousReview: previousReview ?? undefined,
              gitEnv: ctx.repos.gitEnv(ctx.env()),
            },
            { provider: options.provider, logger: log, signal: ctx.signal },
          ),
      );

      switch (result.stopReason) {
        case "rate_limited": {
          const seconds =
            result.retryAfterMs !== undefined
              ? Math.ceil(result.retryAfterMs / 1000)
              : (options.defaultRetryAfterSeconds ?? 300);
          throw new RetryableJobError(
            result.error ?? "Claude rate limit",
            Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
          );
        }
        case "error":
          throw new Error(result.error ?? "the review failed");
        case "completed":
        case "budget_exhausted":
          break;
      }
      log.info(
        {
          findings: result.findings.length,
          stopReason: result.stopReason,
          usage: result.usage,
          skipped: result.skipped.length,
        },
        "review finished",
      );
      if (result.findings.length > MAX_REVIEW_FINDINGS) {
        log.warn(
          { findings: result.findings.length, kept: MAX_REVIEW_FINDINGS },
          "too many findings; keeping the most severe",
        );
      }
      return {
        findings: capFindings(result.findings),
        usage: result.usage,
        skipped: result.skipped.slice(0, MAX_REVIEW_SKIPPED),
        stopReason: result.stopReason,
        scope: result.scope,
        discarded: result.discarded,
        durationMs: Date.now() - started,
      };
    },
  };
}

export const reviewCapability: Capability = createReviewCapability();
