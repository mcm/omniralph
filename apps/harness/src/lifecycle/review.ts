import {
  addTaskResult,
  capFindings,
  ClaudeAgentProvider,
  emptyReviewSessions,
  EXPLORATION_TOOLS,
  filterToDiff,
  finishReview,
  prepareReview,
  reviewVariables,
  type ReviewLogger,
  type ReviewProvider,
  type RunReviewInput,
} from "@omniralph/engine";
import {
  MAX_LEASE_SECONDS,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_SKIPPED,
  MAX_REVIEW_SUMMARY_LENGTH,
  ReviewTaskContext,
  type RunSpec,
  type ReviewTaskResult,
} from "@omniralph/shared";
import { renderTemplate, taskCatalog } from "@omniralph/tasks";
import { RetryableJobError, type JobContext } from "../capabilities/index.js";
import { narrowPermissions, sdkPermissions } from "../capabilities/tool-policy.js";
import { withoutJobEnv } from "../job-env.js";
import { runSetupCommands, runTeardownCommands } from "./commands.js";
import { NO_EXECUTABLES, resolveRunExecutables, type RunExecutables } from "./executables.js";
import { queryToolPolicy } from "./tool-policy.js";
import { withInstallableSkills } from "../installable-skills.js";

export interface ReviewTaskOptions {
  /**
   * Builds the session's provider (default: the engine's Claude Agent SDK
   * provider with the run's tool policy and `sessionEnv()`).
   */
  provider?: (
    spec: RunSpec,
    ctx: JobContext,
    logger: ReviewLogger,
    executables: RunExecutables,
  ) => ReviewProvider;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
}

/**
 * The Claude provider of a review task's session: the agent's read-only
 * tools ∩ the task's tool settings (as a query session's), narrowed by the
 * repository's tool settings, with the session token only. A session with
 * tools also gets the installable MCP servers the agent lists and the skills
 * of the run's required installables.
 */
export function reviewTaskProvider(
  spec: RunSpec,
  ctx: JobContext,
  logger: ReviewLogger,
  executables: RunExecutables = NO_EXECUTABLES,
): ClaudeAgentProvider {
  const permissions = sdkPermissions(queryToolPolicy(spec.agent, spec.task.toolSettings));
  const mcp = executables.mcpServers;
  return new ClaudeAgentProvider({
    logger,
    permissions: (scope) => {
      const narrowed = withInstallableSkills(
        narrowPermissions(permissions(scope), spec.tools),
        scope.allowExploration ? executables.skills : null,
      );
      if (!mcp || !scope.allowExploration) return narrowed;
      return {
        ...narrowed,
        allowedTools: [...(narrowed.allowedTools ?? []), ...mcp.allowedTools],
        mcpServers: { ...narrowed.mcpServers, ...mcp.servers },
      };
    },
    env: ctx.sessionEnv(),
  });
}

/**
 * A review session's system prompt: the agent's system prompt and the task's
 * `systemAppend` (for `builtin:review-pr`, the review output contract
 * `REVIEW_SYSTEM_PROMPT`). Review sessions never use the Claude Code preset.
 */
export function reviewSystemPrompt(spec: Pick<RunSpec, "agent" | "task">): string {
  return [spec.agent.systemPrompt, spec.task.systemAppend ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}

/** `summary` capped at `MAX_REVIEW_SUMMARY_LENGTH`; undefined when there's none. */
function capSummary(summaries: readonly string[]): string | undefined {
  const summary = summaries.join("\n\n").trim();
  if (!summary) return undefined;
  if (summary.length <= MAX_REVIEW_SUMMARY_LENGTH) return summary;
  const marker = "\n\n_…truncated_";
  return `${summary.slice(0, MAX_REVIEW_SUMMARY_LENGTH - marker.length).trimEnd()}${marker}`;
}

/**
 * Runs a `review` task through the fixed lifecycle, with no per-task code:
 *
 * 1. Prepare: the repository is synced with the base and head commits, and
 *    best-effort with the previous review's head (gone after a force-push:
 *    the review then covers the full diff); a disposable worktree is checked
 *    out at head and the task's setup commands run there (see
 *    `runQueryTask`). The engine's `prepareReview` resolves the scope, diffs
 *    it, plans the review with the repository's path excludes and reads
 *    `CLAUDE.md` from the base commit, which become the task-type variables
 *    `diff`, `plan`, `risk`, `conventions` and `previousFindings`.
 *    The run spec's `maxFiles` (the review depth's, resolved at claim
 *    time) caps the plan. With the depth's guidance (`depth`), the rubric for
 *    the diff's languages from the agent's reference docs (`rubric`) and the
 *    repository's rules (`repositoryRules`), a template has what
 *    `buildPrompt` assembles.
 * 2. Render the task's prompt template over the trigger context, those
 *    variables and the `setup` variables.
 * 3. One session (`planReview` plans one task): `ClaudeAgentProvider.review`
 *    with the agent's system prompt and the task's `systemAppend` (which
 *    holds the output contract: findings, the re-check answers and an
 *    optional `summary`) and one repair turn, the run's model (else the
 *    profile's) and the profile's token budget, capped by the run's. The
 *    session explores the checkout only when the profile allows it and the
 *    run's agent kept an exploration tool. Nothing is left to review: no session.
 * 4. Finish: the findings are filtered to the diff, made self-contained and
 *    deduplicated against the open previous findings, the fixed-vote rule
 *    picks the fixed ones, and the most severe `MAX_REVIEW_FINDINGS` are
 *    kept. A rate limit throws `RetryableJobError`; an error fails the run.
 * 5. Teardown: the teardown commands run, then the worktree is removed.
 */
export async function runReviewTask(
  spec: RunSpec,
  ctx: JobContext,
  options: ReviewTaskOptions = {},
): Promise<ReviewTaskResult> {
  const started = Date.now();
  const parsed = ReviewTaskContext.safeParse(spec.trigger.context);
  if (!parsed.success) throw new Error("the review run's trigger context is invalid");
  if (!spec.repository) throw new Error("a review run needs a repository");
  const repository = spec.repository;
  const { baseSha, headSha, previousReview, reviewConfig, changeRequest } = parsed.data;
  const git = { env: ctx.env(), signal: ctx.signal };
  const log = ctx.logger.child({
    taskId: spec.task.id,
    agentId: spec.agent.id,
    repo: `${repository.provider}/${repository.fullPath}`,
    headSha,
  });

  const executables = await resolveRunExecutables(spec, ctx);
  await ctx.repos.sync(repository, { ...git, shas: [baseSha, headSha] });
  if (previousReview?.headSha) {
    await ctx.repos
      .sync(repository, { ...git, shas: [previousReview.headSha] })
      .catch((error: unknown) => {
        ctx.signal.throwIfAborted();
        log.info(
          { err: error, previousHeadSha: previousReview.headSha },
          "previous review head not available; reviewing the full diff",
        );
      });
  }

  const reviewed = async (cwd: string): Promise<ReviewTaskResult> => {
    const setup = await runSetupCommands(spec.task.setupCommands, {
      cwd,
      env: withoutJobEnv(ctx.env()),
      logger: log,
      executables: executables.commands,
      executableEnv: executables.commandEnv,
      signal: ctx.signal,
    });
    const input: RunReviewInput = {
      cwd,
      baseSha,
      headSha,
      // The plan covers at most the run's `maxFiles` (its review depth's).
      reviewConfig: {
        ...reviewConfig,
        profile: {
          ...reviewConfig.profile,
          maxFiles: spec.maxFiles ?? reviewConfig.profile.maxFiles,
        },
      },
      changeRequest,
      previousReview: previousReview ?? undefined,
      gitEnv: ctx.repos.gitEnv(ctx.env()),
    };
    const openFindings = previousReview?.openFindings ?? [];
    const context = await prepareReview(input, log);
    const variables = reviewVariables(context, {
      baseSha,
      config: reviewConfig,
      referenceDocs: spec.agent.referenceDocs,
      previousFindings: openFindings,
    });
    const prompt = renderTemplate(
      spec.task.promptTemplate,
      { ...spec.trigger.context, ...variables, setup },
      taskCatalog(spec.task),
      spec.task.variableLimits,
    );

    const { profile } = reviewConfig;
    const sessions = emptyReviewSessions();
    const [task] = context.plan.tasks;
    if (task && task.files.length > 0) {
      const provider = (options.provider ?? reviewTaskProvider)(spec, ctx, log, executables);
      const budget = Math.min(task.budget, spec.tokenBudget ?? Infinity);
      const systemPrompt = reviewSystemPrompt(spec);
      const result = await provider.review({
        task: { ...task, budget },
        prompt,
        cwd,
        model: spec.model ?? profile.model ?? undefined,
        allowExploration:
          profile.allowRepoExploration &&
          EXPLORATION_TOOLS.some((tool) => spec.agent.tools.builtin.includes(tool)),
        ...(systemPrompt && { systemPrompt }),
        signal: ctx.signal,
      });
      addTaskResult(sessions, result, openFindings.length);
    }

    switch (sessions.stopReason) {
      case "rate_limited": {
        const seconds =
          sessions.retryAfterMs !== undefined
            ? Math.ceil(sessions.retryAfterMs / 1000)
            : (options.defaultRetryAfterSeconds ?? 300);
        throw new RetryableJobError(
          sessions.error ?? "Claude rate limit",
          Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
        );
      }
      case "error":
        throw new Error(sessions.error ?? "the review failed");
      case "completed":
      case "budget_exhausted":
        break;
    }

    const { inside, outside } = filterToDiff(sessions.findings, context.files);
    if (outside.length > 0) {
      log.info(
        {
          findings: outside.map((f) => ({
            path: f.path,
            startLine: f.startLine,
            endLine: f.endLine,
          })),
        },
        "Discarded findings outside the diff",
      );
    }
    sessions.findings = inside;
    sessions.discarded.outsideDiff += outside.length;
    const finished = await finishReview(input, context, sessions, log);
    log.info(
      {
        findings: finished.findings.length,
        stopReason: sessions.stopReason,
        usage: sessions.usage,
        skipped: context.plan.skipped.length,
      },
      "review finished",
    );
    if (finished.findings.length > MAX_REVIEW_FINDINGS) {
      log.warn(
        { findings: finished.findings.length, kept: MAX_REVIEW_FINDINGS },
        "too many findings; keeping the most severe",
      );
    }
    const summary = capSummary(sessions.summaries);
    return {
      findings: capFindings(finished.findings),
      usage: sessions.usage,
      skipped: context.plan.skipped.slice(0, MAX_REVIEW_SKIPPED),
      stopReason: sessions.stopReason,
      scope: context.scope,
      discarded: { ...sessions.discarded, duplicate: finished.duplicate },
      fixedOpenFindings: finished.fixedOpenFindings,
      ...(summary !== undefined && { summary }),
      durationMs: Date.now() - started,
    };
  };

  return ctx.repos.withWorktree(
    repository,
    headSha,
    { ...git, jobId: spec.jobId },
    async (worktree) => {
      try {
        return await reviewed(worktree.path);
      } finally {
        await runTeardownCommands(spec.task.teardownCommands, {
          cwd: worktree.path,
          env: withoutJobEnv(ctx.env()),
          logger: log,
          executables: executables.commands,
          executableEnv: executables.commandEnv,
        });
      }
    },
  );
}
