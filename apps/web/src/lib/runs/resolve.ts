import "server-only";
import { getRepositoryWithConnection, type Database, type Job } from "@omniralph/db";
import {
  ReviewTaskContext,
  RunSpecJobPayload,
  parseRalphSettings,
  poolForTaskType,
  ruleTool,
  type JobRepository,
  type JobToken,
  type PoolName,
  type RunSpec,
  type RunToolRestrictions,
  type ReviewProfileConfig,
} from "@omniralph/shared";
import type { TaskDefinition } from "@omniralph/tasks";
import { organizationDefinitions, type DefinitionSource } from "@/lib/definitions";
import { jobRepository } from "@/lib/scm/adapters";

/**
 * A run spec that can't be resolved however often it is tried (unknown task,
 * a trigger the task doesn't allow, a bad payload): the claim fails the job
 * with `message` instead of rolling back.
 */
export class RunSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunSpecError";
  }
}

/**
 * Resolves a run-spec job (one with a `task_id`) into the `RunSpec` the
 * harness runs: its task and the task's agent (built-in or the job's
 * organization's own, `organizationDefinitions`), the trigger (which must be one
 * the task allows), the repository with its tool settings, the model, the
 * token budget and the job's `tokens`. The agent's tools are narrowed by the
 * repository's tool settings, never widened.
 *
 * Model and budget come from one place per kind of run:
 * - a review run: its depth preset (from its trigger context: the
 *   repository's, or the one a mention or re-run asked for) sets the model,
 *   token cap, max files and exploration (`narrowByReviewDepth`);
 * - any other run: model = task `model` ?? agent `model` ?? null (the Claude
 *   Code default), fallback = agent `fallbackModel`, budget = the task's fixed
 *   `tokens` or null ("No limit"). No review setting changes it.
 *
 * Throws `RunSpecError` for a job that can never be resolved.
 */
export async function resolveRunSpec(
  db: Database,
  job: Pick<Job, "id" | "organizationId" | "taskType" | "taskId" | "repositoryId" | "payload">,
  tokens: { lifecycle: JobToken; session: JobToken },
  definitions: DefinitionSource = organizationDefinitions(db, job.organizationId),
): Promise<RunSpec> {
  if (job.taskId === null) throw new RunSpecError("Not a run-spec job (no task)");
  const task = await definitions.getTask(job.taskId);
  if (!task) throw new RunSpecError(`Unknown task ${job.taskId}`);
  const agent = await definitions.getAgent(task.agentId);
  if (!agent) throw new RunSpecError(`Unknown agent ${task.agentId} of task ${task.id}`);
  if (job.taskType !== task.taskType) {
    throw new RunSpecError(
      `Job task type ${job.taskType} doesn't match task ${task.id} (${task.taskType})`,
    );
  }
  const pool = poolForTaskType(task.taskType);

  const parsed = RunSpecJobPayload.safeParse(job.payload);
  if (!parsed.success) throw new RunSpecError(`Invalid run payload: ${parsed.error.message}`);
  const payload = parsed.data;
  if (!task.triggers.includes(payload.trigger.kind)) {
    throw new RunSpecError(`Task ${task.id} can't be triggered by ${payload.trigger.kind}`);
  }

  const repositoryId = payload.repositoryId ?? job.repositoryId;
  let repository: JobRepository | null = null;
  let tools: RunToolRestrictions = { allowedTools: [], disallowedTools: [] };
  if (repositoryId) {
    const found = await getRepositoryWithConnection(db, repositoryId, job.organizationId);
    if (!found) throw new RunSpecError(`Unknown repository ${repositoryId}`);
    repository = jobRepository(found.repository, found.connection);
    const ralph = parseRalphSettings(found.repository.ralphSettings);
    tools = {
      allowedTools: ralph.allowedTools ?? [],
      disallowedTools: ralph.disallowedTools ?? [],
    };
  }

  const spec: RunSpec = {
    jobId: job.id,
    taskType: task.taskType,
    pool,
    agent: {
      ...agent,
      tools: { ...agent.tools, builtin: narrowTools(agent.tools.builtin, tools) },
    },
    task: withLegacyPool(task, pool),
    trigger: payload.trigger,
    repository,
    repositoryId: repositoryId || null,
    ref: payload.ref ?? null,
    requireCheckout: payload.requireCheckout ?? false,
    tools,
    model: task.model ?? agent.model,
    fallbackModel: agent.fallbackModel,
    tokenBudget: runTokenBudget(task),
    tokens,
  };
  if (task.taskType !== "review") return spec;
  const reviewConfig = ReviewTaskContext.shape.reviewConfig.safeParse(
    payload.trigger.context.reviewConfig,
  );
  if (!reviewConfig.success) {
    throw new RunSpecError(`Review run of task ${task.id} has no valid review configuration`);
  }
  return narrowByReviewDepth(spec, reviewConfig.data.profile);
}

/**
 * `task` with its derived `pool`, which harnesses up to 0.13 still require in
 * a run spec's task (newer ones drop it): a task's pool follows from its type.
 */
function withLegacyPool(task: TaskDefinition, pool: PoolName): TaskDefinition {
  return { ...task, pool } as TaskDefinition;
}

/** Read-only file tools a review uses to read beyond the diff (the engine's `EXPLORATION_TOOLS`). */
const EXPLORATION_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/**
 * A review run as its depth's preset (`reviewConfig.profile`) sets it: the
 * preset's `model` (null for the Claude Code default), `maxTokensPerReview` as
 * the budget and `maxFiles`, and without `allowRepoExploration`, no
 * exploration tools (the review sees only the diff). The task's and agent's
 * models never apply; review tasks can't set a model or budget.
 */
export function narrowByReviewDepth(
  spec: RunSpec,
  profile: Pick<
    ReviewProfileConfig,
    "model" | "maxTokensPerReview" | "maxFiles" | "allowRepoExploration"
  >,
): RunSpec {
  const builtin = spec.agent.tools.builtin;
  return {
    ...spec,
    agent: {
      ...spec.agent,
      tools: {
        ...spec.agent.tools,
        builtin: profile.allowRepoExploration
          ? builtin
          : builtin.filter((tool) => !EXPLORATION_TOOLS.includes(tool)),
      },
    },
    model: profile.model,
    tokenBudget: profile.maxTokensPerReview,
    maxFiles: profile.maxFiles,
  };
}

/**
 * The agent's built-in tools a repository's tool settings leave: with
 * `allowedTools`, only the tools they name; never a tool `disallowedTools`
 * denies outright (a rule like `Bash(rm:*)` only narrows calls, so the tool
 * stays). Never adds a tool.
 */
export function narrowTools(builtin: readonly string[], tools: RunToolRestrictions): string[] {
  const allowed = new Set(tools.allowedTools.map(ruleTool));
  const denied = new Set(tools.disallowedTools.filter((rule) => ruleTool(rule) === rule));
  return builtin.filter((tool) => (allowed.size === 0 || allowed.has(tool)) && !denied.has(tool));
}

/**
 * A non-review run's token cap: the task's fixed `tokens`, or null for "No
 * limit". Never depends on a review setting.
 */
export function runTokenBudget(task: Pick<TaskDefinition, "tokenBudget">): number | null {
  return task.tokenBudget?.tokens ?? null;
}
