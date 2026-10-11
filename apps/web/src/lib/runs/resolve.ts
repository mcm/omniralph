import "server-only";
import {
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  type Database,
  type Job,
} from "@omniralph/db";
import {
  RunSpecJobPayload,
  parseRalphSettings,
  ruleTool,
  type JobRepository,
  type JobToken,
  type RunSpec,
  type RunToolRestrictions,
} from "@omniralph/shared";
import {
  getBuiltinAgent,
  getBuiltinTask,
  type AgentDefinition,
  type TaskDefinition,
} from "@omniralph/tasks";
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

/** Where definitions come from: the built-in registry (user-defined ones come later). */
export interface DefinitionSource {
  getTask(id: string): TaskDefinition | null;
  getAgent(id: string): AgentDefinition | null;
}

export const BUILTIN_DEFINITIONS: DefinitionSource = {
  getTask: getBuiltinTask,
  getAgent: getBuiltinAgent,
};

/**
 * Resolves a run-spec job (one with a `task_id`) into the `RunSpec` the
 * harness runs: its task and the task's agent, the trigger (which must be one
 * the task allows), the repository with its tool settings, the model (task →
 * repository profile → agent), the token budget (a `profileFraction` of the
 * repository profile's budget) and the job's `tokens`. The agent's tools are
 * narrowed by the repository's tool settings, never widened. Throws
 * `RunSpecError` for a job that can never be resolved.
 */
export async function resolveRunSpec(
  db: Database,
  job: Pick<
    Job,
    "id" | "organizationId" | "taskType" | "pool" | "taskId" | "repositoryId" | "payload"
  >,
  tokens: { lifecycle: JobToken; session: JobToken },
  definitions: DefinitionSource = BUILTIN_DEFINITIONS,
): Promise<RunSpec> {
  if (job.taskId === null) throw new RunSpecError("Not a run-spec job (no task)");
  const task = definitions.getTask(job.taskId);
  if (!task) throw new RunSpecError(`Unknown task ${job.taskId}`);
  const agent = definitions.getAgent(task.agentId);
  if (!agent) throw new RunSpecError(`Unknown agent ${task.agentId} of task ${task.id}`);
  if (job.taskType !== task.taskType || job.pool !== task.pool) {
    throw new RunSpecError(
      `Job routing (${job.taskType}/${job.pool ?? "no pool"}) doesn't match task ${task.id} (${task.taskType}/${task.pool})`,
    );
  }

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
  }

  return {
    jobId: job.id,
    taskType: task.taskType,
    pool: task.pool,
    agent: {
      ...agent,
      tools: { ...agent.tools, builtin: narrowTools(agent.tools.builtin, tools) },
    },
    task,
    trigger: payload.trigger,
    repository,
    ref: payload.ref ?? null,
    requireCheckout: payload.requireCheckout ?? false,
    tools,
    model: task.model ?? profile?.model ?? agent.model,
    fallbackModel: agent.fallbackModel,
    tokenBudget: runTokenBudget(task, profile),
    tokens,
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
