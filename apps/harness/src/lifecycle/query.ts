import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_LEASE_SECONDS,
  MAX_QUERY_ANSWER_LENGTH,
  MAX_QUERY_REFERENCES,
  type JobRepository,
  type QueryRunResult,
  type RunSpec,
} from "@omniralph/shared";
import { renderTemplate } from "@omniralph/tasks";
import { z } from "zod";
import { RetryableJobError, type JobContext } from "../capabilities/index.js";
import type { Logger } from "../logger.js";
import {
  createSessionRunner,
  type SessionRequest,
  type SessionResult,
  type SessionRunner,
} from "../session/session.js";
import {
  createOmniralphServer,
  offeredHarnessTools,
  offeredLinearTools,
  type OmniralphServerOptions,
} from "../tools/omniralph-server.js";
import { existingReferences } from "./references.js";
import { queryToolPolicy } from "./tool-policy.js";
import {
  conventionsVariable,
  hunkVariable,
  questionVariable,
  type VariableGitOptions,
} from "./variables.js";

export interface QueryTaskOptions {
  /** Runs the session (default: the Agent SDK's `query()`). */
  runner?: SessionRunner;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
  /** Where empty working directories are created (default: the OS temp directory). */
  tmpDir?: string;
  /** Options of the `omniralph` harness tools (tests). */
  harnessTools?: Pick<OmniralphServerOptions, "fetch" | "permissionTimeoutMs" | "pollIntervalMs">;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Where a query session runs: a worktree of the run's ref, or an empty directory. */
interface Workspace {
  cwd: string;
  /** The checkout (worktree path and commit); null in an empty directory. */
  checkout: { path: string; sha: string } | null;
  /** Whether the file tools (and the shell) are available. */
  files: boolean;
}

/**
 * The session's system prompt: with the agent's `systemPromptMode` `append`,
 * Claude Code's preset + the agent's system prompt + the task's
 * `systemAppend`; with `replace`, the agent's system prompt + the task's
 * `systemAppend` as a plain string, without the preset.
 */
export function querySystemPrompt(
  spec: Pick<RunSpec, "agent" | "task">,
): Pick<SessionRequest, "systemAppend" | "systemPrompt"> {
  const text = [spec.agent.systemPrompt, spec.task.systemAppend ?? ""]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  return spec.agent.systemPromptMode === "replace"
    ? { systemAppend: "", systemPrompt: text }
    : { systemAppend: text };
}

/**
 * The commit to check out for `ref` (a commit SHA, or a branch of the
 * remote), after syncing the repository; null when it can't be fetched or
 * doesn't exist.
 */
async function checkoutSha(
  ctx: JobContext,
  repository: JobRepository,
  ref: string,
  git: VariableGitOptions,
  log: Logger,
): Promise<string | null> {
  try {
    if (SHA.test(ref)) {
      await ctx.repos.sync(repository, { ...git, shas: [ref] });
      return ref;
    }
    return await ctx.repos.branchHead(repository, ref, git);
  } catch (error) {
    ctx.signal.throwIfAborted();
    log.info({ err: error, ref }, "the run's ref can't be checked out");
    return null;
  }
}

/** The answer text, trimmed and capped at `MAX_QUERY_ANSWER_LENGTH`; null when empty. */
function normalizeAnswer(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_QUERY_ANSWER_LENGTH) return trimmed;
  const marker = "\n\n_…truncated_";
  return `${trimmed.slice(0, MAX_QUERY_ANSWER_LENGTH - marker.length).trimEnd()}${marker}`;
}

/** The structured result, validated against the task's output schema; throws when it doesn't match. */
function validateOutput(schema: Record<string, unknown>, structured: unknown): unknown {
  const parsed = z
    .fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
    .safeParse(structured);
  if (!parsed.success) {
    throw new Error(
      `the output doesn't match the task's output schema: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Runs a `query` task through the fixed lifecycle, with no per-task code:
 *
 * 1. Prepare: without a `ref`, an empty temp directory; with one, the
 *    repository is synced and a disposable worktree of the ref checked out.
 *    A ref that can't be fetched leaves an empty directory without file
 *    tools, or, with `requireCheckout`, finishes with `no_checkout` and no
 *    session.
 * 2. Render the task's prompt template over the trigger context and the
 *    query variables (`question`, `hunk`, `conventions`); untrusted values are
 *    fenced by `renderTemplate`.
 * 3. One session: the agent's system prompt, its tools ∩ the task's tool
 *    settings ∩ the repository's narrowing, the run's model, token budget
 *    and turn cap, and `sessionEnv()` (the session token, never the
 *    lifecycle token). The agent's harness tools (`tools.harness`, capped by
 *    the task type) and its read-only Linear tools (`tools.linear`, when the
 *    task turns on `linearRead`) come from the in-process `omniralph` MCP
 *    server, which calls the control panel with the session token too; with
 *    none, no server is attached.
 * 4. Finish: a structured result is validated against the task's output
 *    schema; otherwise the answer is the final Markdown text, with the files
 *    of the checkout it cites. A rate limit throws `RetryableJobError`.
 * 5. Teardown: the worktree or temp directory is removed, whatever happened.
 */
export async function runQueryTask(
  spec: RunSpec,
  ctx: JobContext,
  options: QueryTaskOptions = {},
): Promise<QueryRunResult> {
  const started = Date.now();
  const runner = options.runner ?? createSessionRunner();
  const log = ctx.logger.child({ taskId: spec.task.id, agentId: spec.agent.id });
  const git: VariableGitOptions = { env: ctx.env(), signal: ctx.signal };
  const noSession = (outcome: "no_checkout"): QueryRunResult => ({
    outcome,
    answer: null,
    structured: null,
    references: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: Date.now() - started,
  });

  const run = async (workspace: Workspace): Promise<QueryRunResult> => {
    const context = spec.trigger.context;
    const variables = {
      question: questionVariable(context),
      hunk: await hunkVariable(ctx.repos, spec.repository, context, git),
      conventions: await conventionsVariable(workspace.checkout, ctx.repos.gitEnv(ctx.env())),
    };
    const prompt = renderTemplate(spec.task.promptTemplate, { ...context, ...variables });
    // `get_attachment` saves to the run's temp directory: the empty working directory, or one of its own next to a checkout.
    const offered = offeredHarnessTools(spec.agent.tools.harness, spec.taskType);
    const downloads =
      offered.includes("get_attachment") && workspace.checkout
        ? await mkdtemp(path.join(options.tmpDir ?? tmpdir(), "omniralph-run-"))
        : null;
    try {
      return await session(prompt, workspace, downloads ?? workspace.cwd);
    } finally {
      if (downloads) await rm(downloads, { recursive: true, force: true });
    }
  };

  const session = async (
    prompt: string,
    workspace: Workspace,
    runTmpDir: string,
  ): Promise<QueryRunResult> => {
    const harness = createOmniralphServer({
      server: ctx.server,
      jobId: spec.jobId,
      sessionToken: ctx.sessionToken,
      tools: spec.agent.tools.harness,
      linearTools: offeredLinearTools(spec.agent.tools, spec.task.toolSettings),
      taskType: spec.taskType,
      tmpDir: runTmpDir,
      signal: ctx.signal,
      logger: log,
      ...options.harnessTools,
    });
    const result = await runner({
      prompt,
      cwd: workspace.cwd,
      policy: queryToolPolicy(spec.agent, spec.task.toolSettings, { files: workspace.files }),
      tools: spec.tools,
      ...querySystemPrompt(spec),
      ...(spec.task.outputSchema && { outputSchema: spec.task.outputSchema }),
      ...(spec.task.maxTurns !== undefined && { maxTurns: spec.task.maxTurns }),
      ...(spec.tokenBudget !== null && { tokenBudget: spec.tokenBudget }),
      ...(spec.model !== null && { model: spec.model }),
      ...(spec.fallbackModel !== null && { fallbackModel: spec.fallbackModel }),
      ...(spec.task.idleTimeoutMs !== undefined && { idleTimeoutMs: spec.task.idleTimeoutMs }),
      ...(harness && {
        mcpServers: { servers: { omniralph: harness.config }, allowedTools: harness.allowedTools },
      }),
      ...(runTmpDir !== workspace.cwd && { additionalDirectories: [runTmpDir] }),
      env: ctx.sessionEnv(),
      signal: ctx.signal,
    });
    log.info({ stop: result.stop, usage: result.usage }, "query session finished");
    return finish(result, workspace);
  };

  const finish = async (session: SessionResult, workspace: Workspace): Promise<QueryRunResult> => {
    const base = { usage: session.usage, durationMs: Date.now() - started };
    switch (session.stop) {
      case "rate_limited": {
        const seconds =
          session.retryAfterMs !== undefined
            ? Math.ceil(session.retryAfterMs / 1000)
            : (options.defaultRetryAfterSeconds ?? 300);
        throw new RetryableJobError(
          session.error ?? "Claude rate limit",
          Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
        );
      }
      case "aborted": {
        const reason: unknown = ctx.signal.reason;
        throw reason instanceof Error ? reason : new Error("the run was aborted");
      }
      case "error":
      case "idle":
        throw new Error(session.error ?? "the query session failed");
      case "budget_exhausted":
        return {
          ...base,
          outcome: "budget_exhausted",
          answer: null,
          structured: null,
          references: [],
        };
      case "completed": {
        const schema = spec.task.outputSchema;
        if (schema) {
          const structured = validateOutput(schema, session.structured);
          return { ...base, outcome: "answered", answer: null, structured, references: [] };
        }
        const answer = normalizeAnswer(session.output);
        if (answer === null) throw new Error("the answer was empty");
        const references = workspace.checkout
          ? await existingReferences(answer, workspace.cwd, MAX_QUERY_REFERENCES)
          : [];
        return { ...base, outcome: "answered", answer, structured: null, references };
      }
    }
  };

  const sha =
    spec.repository && spec.ref !== null
      ? await checkoutSha(ctx, spec.repository, spec.ref, git, log)
      : null;
  if (sha === null && spec.requireCheckout) {
    log.info({ ref: spec.ref }, "nothing to check out; finishing without a session");
    return noSession("no_checkout");
  }
  if (spec.repository && sha !== null) {
    return ctx.repos.withWorktree(spec.repository, sha, { ...git, jobId: spec.jobId }, (worktree) =>
      run({ cwd: worktree.path, checkout: { path: worktree.path, sha }, files: true }),
    );
  }
  const cwd = await mkdtemp(path.join(options.tmpDir ?? tmpdir(), "omniralph-query-"));
  try {
    // Without a ref there's nothing to read anyway; a ref that couldn't be checked out turns the file tools off.
    return await run({ cwd, checkout: null, files: spec.ref === null });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
