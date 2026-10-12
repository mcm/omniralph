import { requestTemplateContext, storyTemplateContext } from "@omniralph/ralph";
import {
  MAX_ATTEMPTS_PER_STORY,
  ralphHiddenRef,
  RalphPushPayload,
  RalphRequestPayload,
  RalphStoryPayload,
  type RalphPushResult,
  type RalphRequestResult,
  type RalphStoryResult,
  type RunSpec,
} from "@omniralph/shared";
import { renderTemplate, taskCatalog } from "@omniralph/tasks";
import type { JobContext } from "../capabilities/index.js";
import { jobGitAccess } from "../capabilities/ralph/git-access.js";
import { RALPH_TOOL_POLICY } from "../capabilities/ralph/policy.js";
import {
  createOmniralphServer,
  offeredHarnessTools,
  type OmniralphServer,
  type OmniralphServerOptions,
} from "../tools/omniralph-server.js";
import { PermissionRelay } from "../tools/permissions.js";
import { withoutJobEnv } from "../job-env.js";
import { runSetupCommands, runTeardownCommands } from "./commands.js";
import { resolveRunExecutables, sessionMcpServers, type RunExecutables } from "./executables.js";
import { querySystemPrompt } from "./query.js";
import { requestEpic, runRequestAttempt, type RequestAttemptPrepared } from "./request-attempt.js";
import {
  DEFAULT_STORY_MODEL,
  promptEpic,
  runStoryAttempt,
  type StoryAttemptPrepared,
  type StoryOptions,
} from "./story-attempt.js";

export interface CodingTaskOptions extends StoryOptions {
  /** Options of the `omniralph` harness tools (tests). */
  harnessTools?: Pick<OmniralphServerOptions, "fetch" | "permissionTimeoutMs" | "pollIntervalMs">;
}

/**
 * The prompt of a story run: the task's template rendered over the trigger
 * context (the run's `RalphStoryPayload`, as `storyTemplateContext` lays it
 * out for `builtin:implement-story`) and the task-type variables (`progress`,
 * `stashes`, `feedback`, `attempt`, …) of what the attempt prepared, plus
 * the task's `setup.<name>` variables (`setup`, from `taskCommands`).
 */
export function storyRunPrompt(
  spec: Pick<RunSpec, "task">,
  payload: RalphStoryPayload,
  prepared: Pick<StoryAttemptPrepared, "offered" | "attachments" | "progressFile">,
  now?: Date,
  setup: Record<string, string> = {},
): string {
  const { epic, story } = promptEpic(payload);
  const context = storyTemplateContext({
    epic,
    story,
    progressFile: prepared.progressFile,
    progress: payload.progress,
    ...(payload.lastFeedback && { previousAttemptFeedback: payload.lastFeedback }),
    guidance: payload.guidance.slice(-10),
    attempt: payload.attempt,
    maxAttempts: spec.task.maxAttemptsPerStory ?? MAX_ATTEMPTS_PER_STORY,
    followUps: payload.epic.kind !== "single",
    verifyCommands: payload.qualityGates,
    ...(payload.settings.appendInstruction && {
      appendInstruction: payload.settings.appendInstruction,
    }),
    stashes: prepared.offered,
    ...(prepared.attachments && { attachments: prepared.attachments }),
    ...(now && { now }),
  });
  return renderTemplate(
    spec.task.promptTemplate,
    { ...context, setup },
    taskCatalog(spec.task),
    spec.task.variableLimits,
  );
}

/**
 * The prompt of a request run: the task's template rendered over the trigger
 * context (the run's `RalphRequestPayload`, as `requestTemplateContext` lays
 * it out for `builtin:handle-request`) and what the attempt prepared (the
 * progress file, attachments and `/ship`'s stashes), plus the task's
 * `setup.<name>` variables (`setup`, from `taskCommands`).
 */
export function requestRunPrompt(
  spec: Pick<RunSpec, "task">,
  payload: RalphRequestPayload,
  prepared: Pick<RequestAttemptPrepared, "attachments" | "progressFile" | "shipStashes">,
  setup: Record<string, string> = {},
): string {
  const context = requestTemplateContext({
    epic: requestEpic(payload),
    requests: payload.requests.map((r) => r.text),
    source: payload.source,
    branch: payload.branch,
    baseBranch: payload.baseBranch,
    remoteUrl: payload.repository.cloneUrl,
    ...(payload.prUrl && { prUrl: payload.prUrl }),
    progressFile: prepared.progressFile,
    qualityGates: payload.qualityGates,
    prTerm: payload.repository.provider === "gitlab" ? "merge request" : "pull request",
    historyRewrite: payload.historyRewrite,
    ...(prepared.attachments && { attachments: prepared.attachments }),
    ...(payload.settings.appendInstruction && {
      appendInstruction: payload.settings.appendInstruction,
    }),
    ...(payload.ship && { ship: { stashes: prepared.shipStashes } }),
  });
  return renderTemplate(
    spec.task.promptTemplate,
    { ...context, setup },
    taskCatalog(spec.task),
    spec.task.variableLimits,
  );
}

/**
 * A coding run's own setup and teardown commands (the task's
 * `setupCommands`/`teardownCommands`, not the repository's setup command,
 * which runs when the branch worktree is created). Both run in the branch
 * worktree without either job token or the git credential helper in their
 * environment. `setup` runs before the prompt is rendered and returns the
 * `setup.<name>` variables (a failing required one fails the run, see
 * `runSetupCommands`); `teardown` runs after the attempt, whatever happened,
 * and only logs failures. A first word naming one of the run's `executables`
 * (its host tools and installable commands) runs that absolute path.
 */
export function taskCommands(
  spec: Pick<RunSpec, "task">,
  ctx: JobContext,
  log: JobContext["logger"],
  executables?: RunExecutables,
) {
  const commandOptions = (cwd: string) => ({
    cwd,
    env: withoutJobEnv(ctx.env()),
    logger: log,
    ...(executables && {
      executables: executables.commands,
      executableEnv: executables.commandEnv,
    }),
  });
  return {
    setup: (cwd: string) =>
      runSetupCommands(spec.task.setupCommands, { ...commandOptions(cwd), signal: ctx.signal }),
    teardown: (cwd: string) => runTeardownCommands(spec.task.teardownCommands, commandOptions(cwd)),
  };
}

/**
 * Runs a `coding` task through the fixed coding lifecycle: a story run
 * (`runStoryRun`), a request run (`runRequestRun`) or a push run
 * (`runPushRun`), told apart by the trigger context (`RalphStoryPayload`,
 * `RalphRequestPayload` or `RalphPushPayload`).
 */
export async function runCodingTask(
  spec: RunSpec,
  ctx: JobContext,
  options: CodingTaskOptions = {},
): Promise<RalphStoryResult | RalphRequestResult | RalphPushResult> {
  const story = RalphStoryPayload.safeParse(spec.trigger.context);
  if (story.success) return runStoryRun(spec, story.data, ctx, options);
  const request = RalphRequestPayload.safeParse(spec.trigger.context);
  if (request.success) return runRequestRun(spec, request.data, ctx, options);
  const push = RalphPushPayload.safeParse(spec.trigger.context);
  if (push.success) return runPushRun(push.data, ctx, options);
  throw new Error("the coding run's trigger context is neither a story, a request nor a push");
}

/**
 * A push run (its trigger context parses as `RalphPushPayload`): a coding run
 * with no session that pushes a lane's branch once, before its PR/MR is
 * described, for a story task that pushes only at the end (`pushTiming:
 * end`). The lifecycle prepares the lane's branch worktree as a story run
 * does (the repository's setup command when it creates it, the `pre-push`
 * guard), starting from or fast-forwarding to the run's hidden ref when
 * `origin` has it, then pushes the branch with `-u` with the lifecycle token.
 * Uncommitted changes are left alone, and the task's own setup and teardown
 * commands don't run (there is no prompt). The result is a `RalphPushResult`.
 */
export async function runPushRun(
  payload: RalphPushPayload,
  ctx: JobContext,
  options: Pick<CodingTaskOptions, "tokenRefreshMs"> = {},
): Promise<RalphPushResult> {
  const started = Date.now();
  const git = await jobGitAccess(ctx, { refreshMs: options.tokenRefreshMs });
  try {
    return await ctx.repos.withBranchWorktree(
      payload.repository,
      {
        branch: payload.branch,
        baseBranch: payload.baseBranch,
        ...(payload.settings.setupCommand && { setupCommand: payload.settings.setupCommand }),
        hiddenRef: payload.hiddenRef,
        env: git.env,
        signal: ctx.signal,
      },
      async (worktree) => {
        await worktree.git(["push", "--quiet", "-u", "origin", payload.branch]);
        const sha = (await worktree.git(["rev-parse", "HEAD"])).trim();
        ctx.logger.info({ branch: payload.branch, sha }, "pushed the branch");
        return { pushed: { branch: payload.branch, sha }, durationMs: Date.now() - started };
      },
    );
  } finally {
    await git.close();
  }
}

/**
 * A story run (its
 * trigger context parses as `RalphStoryPayload`, e.g. `builtin:implement-story`)
 * is one attempt at one story, as a `ralph.story` job (`runStoryAttempt`):
 * the lane's branch worktree with the repository's setup command and the
 * `pre-push` guard, the run's stashes, attachments and progress file, and the
 * task's setup commands (`taskCommands`); then a
 * session with the task's rendered prompt (`storyRunPrompt`), the agent's
 * system prompt, ralph's tool policy narrowed by the repository's tool
 * settings, the story outcome schema and `sessionEnv()` (the session token
 * only, also for its git credential helper); then the quality gates, the
 * commit and the push with `-u`, with the lifecycle token (with the task's
 * `pushTiming: end`, a force-push of HEAD to the run's hidden ref
 * `refs/omniralph/runs/<runId>` instead, the branch left alone). The result
 * is a `RalphStoryResult`. The task's teardown commands run after the
 * attempt, whatever happened.
 */
export async function runStoryRun(
  spec: RunSpec,
  payload: RalphStoryPayload,
  ctx: JobContext,
  options: CodingTaskOptions = {},
): Promise<RalphStoryResult> {
  const log = ctx.logger.child({ taskId: spec.task.id, agentId: spec.agent.id });
  const executables = await resolveRunExecutables(spec, ctx);
  const commands = taskCommands(spec, ctx, log, executables);
  return runStoryAttempt({
    payload,
    jobId: spec.jobId,
    ctx,
    options,
    // Pushing only at the end keeps the story commits on the run's hidden ref meanwhile.
    ...(spec.task.pushTiming === "end" && { hiddenRef: ralphHiddenRef(payload.runId) }),
    teardown: commands.teardown,
    session: async (prepared) => {
      const setup = await commands.setup(prepared.cwd);
      // `get_attachment` saves next to the progress log, a directory the session may use.
      const harness = createOmniralphServer({
        server: ctx.server,
        jobId: spec.jobId,
        sessionToken: ctx.sessionToken,
        tools: spec.agent.tools.harness,
        taskType: spec.taskType,
        tmpDir: prepared.progressDir,
        signal: ctx.signal,
        logger: log,
        ...options.harnessTools,
      });
      const mcpServers = sessionMcpServers(harness, executables);
      const model = payload.settings.model ?? spec.model ?? DEFAULT_STORY_MODEL;
      const fallbackModel = payload.settings.fallbackModel ?? spec.fallbackModel;
      const idleTimeoutMs = options.idleTimeoutMs ?? spec.task.idleTimeoutMs;
      return {
        prompt: storyRunPrompt(spec, payload, prepared, options.now?.(), setup),
        policy: RALPH_TOOL_POLICY,
        ...querySystemPrompt(spec),
        model,
        ...(fallbackModel && { fallbackModel }),
        tools: spec.tools,
        ...(spec.task.maxTurns !== undefined && { maxTurns: spec.task.maxTurns }),
        ...(spec.tokenBudget !== null && { tokenBudget: spec.tokenBudget }),
        ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
        ...(mcpServers && { mcpServers }),
        // The session token only: the session's git credential helper reads it from its token file.
        env: ctx.repos.gitEnv(ctx.sessionEnv()),
      };
    },
  });
}

/**
 * A request run (its trigger context parses as `RalphRequestPayload`, e.g.
 * `builtin:handle-request`) is one request session, as a `ralph.request` job
 * (`runRequestAttempt`): the lane's branch worktree and the task's setup
 * commands (`taskCommands`; its teardown commands run after the attempt,
 * whatever happened), resuming the lane's last
 * request session when set (fresh when that fails), with the task's rendered
 * prompt (`requestRunPrompt`), the agent's system prompt, ralph's tool policy
 * narrowed by the repository's tool settings, follow-up messages delivered to
 * the live session, and `sessionEnv()`: the session's git credential helper
 * presents the session token, which only gets read credentials. The session
 * pushes through the `ship` harness tool, which commits and pushes with the
 * lifecycle token (not offered to `/ship` sessions: the lifecycle ships after
 * them). Calls the repository's Claude Code settings `ask` about go to a
 * person when the agent has `ask_permission`, and are denied otherwise. The
 * result is a `RalphRequestResult`.
 */
export async function runRequestRun(
  spec: RunSpec,
  payload: RalphRequestPayload,
  ctx: JobContext,
  options: CodingTaskOptions = {},
): Promise<RalphRequestResult> {
  const log = ctx.logger.child({ taskId: spec.task.id, agentId: spec.agent.id });
  const permissions = offeredHarnessTools(spec.agent.tools.harness, spec.taskType).includes(
    "ask_permission",
  )
    ? new PermissionRelay({
        server: ctx.server,
        jobId: spec.jobId,
        jobToken: ctx.sessionToken,
        logger: log,
        ...(options.fetch && { fetch: options.fetch }),
        ...(options.permissionTimeoutMs !== undefined && {
          timeoutMs: options.permissionTimeoutMs,
        }),
        ...(options.permissionPollIntervalMs !== undefined && {
          pollIntervalMs: options.permissionPollIntervalMs,
        }),
      })
    : null;
  const executables = await resolveRunExecutables(spec, ctx);
  const commands = taskCommands(spec, ctx, log, executables);
  // The lifecycle's own git commands (fetches, `ship`'s pushes) read the lifecycle token from a file.
  const git = await jobGitAccess(ctx, { refreshMs: options.tokenRefreshMs });
  try {
    return await runRequestAttempt({
      payload,
      jobId: spec.jobId,
      ctx,
      options,
      gitEnv: git.env,
      teardown: commands.teardown,
      session: async (prepared) => {
        const setup = await commands.setup(prepared.cwd);
        const harness: OmniralphServer | null = createOmniralphServer({
          server: ctx.server,
          jobId: spec.jobId,
          sessionToken: ctx.sessionToken,
          tools: spec.agent.tools.harness,
          taskType: spec.taskType,
          // `/ship` sessions leave committing and pushing to the lifecycle.
          ...(!payload.ship && { ship: prepared.ship }),
          tmpDir: prepared.progressDir,
          signal: ctx.signal,
          logger: log,
          ...options.harnessTools,
        });
        const mcpServers = sessionMcpServers(harness, executables);
        const model = payload.settings.model ?? spec.model ?? DEFAULT_STORY_MODEL;
        const fallbackModel = payload.settings.fallbackModel ?? spec.fallbackModel;
        const idleTimeoutMs = options.idleTimeoutMs ?? spec.task.idleTimeoutMs;
        return {
          prompt: requestRunPrompt(spec, payload, prepared, setup),
          policy: RALPH_TOOL_POLICY,
          ...querySystemPrompt(spec),
          model,
          ...(fallbackModel && { fallbackModel }),
          tools: spec.tools,
          ...(spec.task.maxTurns !== undefined && { maxTurns: spec.task.maxTurns }),
          ...(spec.tokenBudget !== null && { tokenBudget: spec.tokenBudget }),
          ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
          ...(mcpServers && { mcpServers }),
          // The session token only: its git credential helper gets a read-only credential with it.
          env: ctx.repos.gitEnv(ctx.sessionEnv()),
          // The repository's Claude Code settings may `ask` about calls (e.g. `git commit`).
          askPermission: (call, signal) =>
            permissions ? permissions.ask(call, signal) : Promise.resolve(false),
        };
      },
    });
  } finally {
    await git.close();
  }
}
