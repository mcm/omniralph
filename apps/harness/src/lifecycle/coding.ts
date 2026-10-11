import { storyTemplateContext } from "@omniralph/ralph";
import {
  MAX_ATTEMPTS_PER_STORY,
  RalphStoryPayload,
  type RalphStoryResult,
  type RunSpec,
} from "@omniralph/shared";
import { renderTemplate, taskCatalog } from "@omniralph/tasks";
import type { JobContext } from "../capabilities/index.js";
import { RALPH_TOOL_POLICY } from "../capabilities/ralph/policy.js";
import { createOmniralphServer, type OmniralphServerOptions } from "../tools/omniralph-server.js";
import { querySystemPrompt } from "./query.js";
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
 * `stashes`, `feedback`, `attempt`, …) of what the attempt prepared.
 */
export function storyRunPrompt(
  spec: Pick<RunSpec, "task">,
  payload: RalphStoryPayload,
  prepared: Pick<StoryAttemptPrepared, "offered" | "attachments" | "progressFile">,
  now?: Date,
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
    { ...context },
    taskCatalog(spec.task),
    spec.task.variableLimits,
  );
}

/**
 * Runs a `coding` task through the fixed coding lifecycle. A story run (its
 * trigger context parses as `RalphStoryPayload`, e.g. `builtin:implement-story`)
 * is one attempt at one story, as a `ralph.story` job (`runStoryAttempt`):
 * the lane's branch worktree with the repository's setup command and the
 * `pre-push` guard, the run's stashes, attachments and progress file; then a
 * session with the task's rendered prompt (`storyRunPrompt`), the agent's
 * system prompt, ralph's tool policy narrowed by the repository's tool
 * settings, the story outcome schema and `sessionEnv()` (the session token
 * only, also for its git credential helper); then the quality gates, the
 * commit and the push with `-u`, with the lifecycle token. The result is a
 * `RalphStoryResult`.
 */
export async function runCodingTask(
  spec: RunSpec,
  ctx: JobContext,
  options: CodingTaskOptions = {},
): Promise<RalphStoryResult> {
  const parsed = RalphStoryPayload.safeParse(spec.trigger.context);
  if (!parsed.success) throw new Error("the coding run's trigger context is not a story");
  const payload = parsed.data;
  const log = ctx.logger.child({ taskId: spec.task.id, agentId: spec.agent.id });
  return runStoryAttempt({
    payload,
    jobId: spec.jobId,
    ctx,
    options,
    session: (prepared) => {
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
      const model = payload.settings.model ?? spec.model ?? DEFAULT_STORY_MODEL;
      const fallbackModel = payload.settings.fallbackModel ?? spec.fallbackModel;
      const idleTimeoutMs = options.idleTimeoutMs ?? spec.task.idleTimeoutMs;
      return {
        prompt: storyRunPrompt(spec, payload, prepared, options.now?.()),
        policy: RALPH_TOOL_POLICY,
        ...querySystemPrompt(spec),
        model,
        ...(fallbackModel && { fallbackModel }),
        tools: spec.tools,
        ...(spec.task.maxTurns !== undefined && { maxTurns: spec.task.maxTurns }),
        ...(spec.tokenBudget !== null && { tokenBudget: spec.tokenBudget }),
        ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
        ...(harness && {
          mcpServers: {
            servers: { omniralph: harness.config },
            allowedTools: harness.allowedTools,
          },
        }),
        // The session token only: the session's git credential helper reads it from its token file.
        env: ctx.repos.gitEnv(ctx.sessionEnv()),
      };
    },
  });
}
