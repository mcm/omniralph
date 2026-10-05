import {
  DISALLOWED_TOOLS,
  EXPLORATION_TOOLS,
  runReview,
  type ReviewProvider,
} from "@omniralph/engine";
import {
  MAX_LEASE_SECONDS,
  REVIEW_CAPABILITY,
  REVIEW_JOB_TYPE,
  ReviewJobPayload,
  type ReviewJobResult,
} from "@omniralph/shared";
import { RetryableJobError, type Capability, type ToolPolicy } from "./index.js";

/** Review sessions only read the job's worktree (the engine's Claude provider enforces the same lists). */
export const REVIEW_TOOL_POLICY: ToolPolicy = {
  allowedTools: EXPLORATION_TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  fileScope: "worktree",
  permissionMode: "dontAsk",
  loadProjectSettings: false,
};

export interface ReviewCapabilityOptions {
  /** Defaults to the engine's Claude Agent SDK provider (host `claude` login). */
  provider?: ReviewProvider;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
}

/**
 * Code review (`review.run`). Makes sure the repo cache has the PR's base and
 * head (and the previous review's head, for incremental reviews), runs the
 * engine in a fresh worktree at head and returns the `ReviewJobResult`. It
 * calls no code-host API and holds no write credential: git authenticates
 * through the broker with the job token, and the control panel posts the
 * result.
 */
export function createReviewCapability(options: ReviewCapabilityOptions = {}): Capability {
  return {
    name: REVIEW_CAPABILITY,
    jobTypes: [REVIEW_JOB_TYPE],
    toolPolicy: REVIEW_TOOL_POLICY,
    async run(job, ctx): Promise<ReviewJobResult> {
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
      if (previousReview) {
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
      return {
        findings: result.findings,
        usage: result.usage,
        skipped: result.skipped,
        stopReason: result.stopReason,
        scope: result.scope,
        discarded: result.discarded,
        durationMs: Date.now() - started,
      };
    },
  };
}

export const reviewCapability: Capability = createReviewCapability();
