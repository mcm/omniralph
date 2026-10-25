import "server-only";
import {
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  type Database,
  type Job,
} from "@omniralph/db";
import {
  ReviewTaskContext,
  RunSpecJobPayload,
  parseRalphSettings,
  poolForTaskType,
  RalphRunInvoker,
  RalphSettings,
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
 * the task allows), the repository with its tool settings, the model (task →
 * repository profile → agent; for a query run a ralph run invokes, the
 * repository's ralph `model` and `fallbackModel` first, like the legacy
 * `ralph.describe-pr` job), the token budget (a `profileFraction` of the
 * repository profile's budget) and the job's `tokens`. The agent's tools are
 * narrowed by the repository's tool settings, never widened. A review run's
 * review profile (from its trigger context: the repository's, or the one a
 * mention asked for) narrows it further (`narrowByReviewProfile`). Throws
 * `RunSpecError` for a job that can never be resolved.
 */
export async function resolveRunSpec(
  db: Database,
  job: Pick<
    Job,
    "id" | "organizationId" | "taskType" | "taskId" | "repositoryId" | "payload"
  >,
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
  let profile: { model: string; maxTokensPerReview: number } | null = null;
  // The repository's ralph models, for a query run a ralph run invokes (its PR description).
  let ralphModels: { model: string | null; fallbackModel: string | null } | null = null;
  if (repositoryId) {
    const found = await getRepositoryWithConnection(db, repositoryId, job.organizationId);
    const settings = found && (await getRepositoryReviewSettings(db, repositoryId));
    if (!found || !settings) throw new RunSpecError(`Unknown repository ${repositoryId}`);
    repository = jobRepository(found.repository, found.connection);
    const ralph = parseRalphSettings(found.repository.ralphSettings);
    tools = {
      allowedTools: ralph.allowedTools ?? [],
      disallowedTools: ralph.disallowedTools ?? [],
    };
    profile = settings.profile;
    if (RalphRunInvoker.safeParse(payload.trigger.context.invoker).success) {
      ralphModels = {
        model: storedRalphModel(found.repository.ralphSettings) ? ralph.model : null,
        fallbackModel: ralph.fallbackModel,
      };
    }
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
    model: ralphModels?.model ?? task.model ?? profile?.model ?? agent.model,
    fallbackModel: ralphModels?.fallbackModel ?? agent.fallbackModel,
    tokenBudget: runTokenBudget(task, profile),
    tokens,
  };
  if (task.taskType !== "review") return spec;
  const reviewConfig = ReviewTaskContext.shape.reviewConfig.safeParse(
    payload.trigger.context.reviewConfig,
  );
  if (!reviewConfig.success) {
    throw new RunSpecError(`Review run of task ${task.id} has no valid review configuration`);
  }
  return narrowByReviewProfile(spec, reviewConfig.data.profile);
}

/**
 * `task` with its derived `pool`, which harnesses up to 0.13 still require in
 * a run spec's task (newer ones drop it): a task's pool follows from its type.
 */
function withLegacyPool(task: TaskDefinition, pool: PoolName): TaskDefinition {
  return { ...task, pool } as TaskDefinition;
}

/**
 * Whether the repository's stored ralph settings set a valid `model` (parsing
 * them fills in the default model when they don't).
 */
function storedRalphModel(stored: unknown): boolean {
  if (!stored || typeof stored !== "object" || !("model" in stored)) return false;
  return RalphSettings.shape.model.safeParse(stored.model).success;
}

/** Read-only file tools a review uses to read beyond the diff (the engine's `EXPLORATION_TOOLS`). */
const EXPLORATION_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/**
 * A review run as its review profile narrows it: the profile's `model`, when
 * it sets one, over the task's and the agent's; the profile's
 * `maxTokensPerReview` as the budget, capped by the task's own budget when it
 * has one; the profile's `maxFiles`; and without `allowRepoExploration`, no
 * exploration tools (the review sees only the diff).
 */
export function narrowByReviewProfile(
  spec: RunSpec,
  profile: Pick<
    ReviewProfileConfig,
    "model" | "maxTokensPerReview" | "maxFiles" | "allowRepoExploration"
  >,
): RunSpec {
  const taskBudget = runTokenBudget(spec.task, profile);
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
    model: profile.model ?? spec.task.model ?? spec.agent.model,
    tokenBudget: Math.min(profile.maxTokensPerReview, taskBudget ?? Infinity),
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
 * A run's token cap: the task's fixed `tokens`, or its `profileFraction` of
 * the repository profile's budget (at least 1); null for none. Throws
 * `RunSpecError` for a relative budget without a profile.
 */
export function runTokenBudget(
  task: Pick<TaskDefinition, "id" | "tokenBudget">,
  profile: { maxTokensPerReview: number } | null,
): number | null {
  const budget = task.tokenBudget;
  if (budget === null) return null;
  if ("tokens" in budget) return budget.tokens;
  if (!profile) {
    throw new RunSpecError(
      `Task ${task.id} has a budget relative to the repository profile, but the run has no repository`,
    );
  }
  return Math.max(1, Math.floor(profile.maxTokensPerReview * budget.profileFraction));
}
