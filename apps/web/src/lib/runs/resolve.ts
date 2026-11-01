import "server-only";
import { getRepositoryWithConnection, type Database, type Job } from "@omniralph/db";
import {
  ReviewTaskContext,
  RunSpecJobPayload,
  poolForTaskType,
  type JobRepository,
  type JobToken,
  type PoolName,
  type RunSpec,
  type ReviewProfileConfig,
} from "@omniralph/shared";
import {
  playbookRunSpec,
  type RunSpecAgent,
  type TaskDefinition,
  type TaskType,
} from "@omniralph/tasks";
import type { TrackerCapability } from "@omniralph/tracker";
import { organizationPlaybooks, type PlaybookSource } from "@/lib/playbooks";
import { jobRepository } from "@/lib/scm/adapters";
import { trackerProviderCapabilities } from "@/lib/tracker/adapters";
import { DEFAULT_TRACKER_PROVIDER } from "@/lib/tracker/client";

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
 * Resolves a run-spec job (one with a `task_id`, which holds a playbook ID)
 * into the `RunSpec` the agent runs: its playbook (built-in or the job's
 * organization's own, `organizationPlaybooks`) as the run spec's agent and
 * task (`playbookRunSpec`), the trigger (which must be one the playbook's role
 * allows), the repository, the model, the token budget and the job's
 * `tokens`. The playbook's tools are its runs' tools, but for the tracker
 * tools the organization's tracker can't serve (`tracker_get_document`
 * without the documents capability, among `trackerCapabilities`).
 *
 * Model and budget come from one place per kind of run:
 * - a review run: its depth preset (from its trigger context: the
 *   repository's, or the one a mention or re-run asked for) sets the model,
 *   token cap, max files and exploration (`narrowByReviewDepth`);
 * - any other run: model = the playbook's `model` (null for the Claude Code
 *   default), fallback = its `fallbackModel`, budget = its fixed `tokens` or
 *   null ("No limit"). No review setting changes it.
 *
 * Throws `RunSpecError` for a job that can never be resolved.
 */
export async function resolveRunSpec(
  db: Database,
  job: Pick<Job, "id" | "organizationId" | "taskType" | "taskId" | "repositoryId" | "payload">,
  tokens: { lifecycle: JobToken; session: JobToken },
  playbooks: PlaybookSource = organizationPlaybooks(db, job.organizationId),
  trackerCapabilities: readonly TrackerCapability[] = trackerProviderCapabilities(
    DEFAULT_TRACKER_PROVIDER,
  ),
): Promise<RunSpec> {
  if (job.taskId === null) throw new RunSpecError("Not a run-spec job (no playbook)");
  const playbook = await playbooks.getPlaybook(job.taskId);
  if (!playbook) throw new RunSpecError(`Unknown playbook ${job.taskId}`);
  const { agent, task } = playbookRunSpec(playbook);
  if (job.taskType !== task.taskType) {
    throw new RunSpecError(
      `Job task type ${job.taskType} doesn't match playbook ${task.id} (${task.taskType})`,
    );
  }
  const pool = poolForTaskType(task.taskType);

  const parsed = RunSpecJobPayload.safeParse(job.payload);
  if (!parsed.success) throw new RunSpecError(`Invalid run payload: ${parsed.error.message}`);
  const payload = parsed.data;
  if (!task.triggers.includes(payload.trigger.kind)) {
    throw new RunSpecError(`Playbook ${task.id} can't be triggered by ${payload.trigger.kind}`);
  }

  const repositoryId = payload.repositoryId ?? job.repositoryId;
  let repository: JobRepository | null = null;
  if (repositoryId) {
    const found = await getRepositoryWithConnection(db, repositoryId, job.organizationId);
    if (!found) throw new RunSpecError(`Unknown repository ${repositoryId}`);
    repository = jobRepository(found.repository, found.connection);
  }

  const spec: RunSpec = {
    jobId: job.id,
    taskType: task.taskType,
    pool,
    agent: withTrackerToolsFor(withLegacyTaskTypes(agent, task.taskType), trackerCapabilities),
    task: withLegacyPool(task, pool),
    trigger: payload.trigger,
    repository,
    repositoryId: repositoryId || null,
    ref: payload.ref ?? null,
    requireCheckout: payload.requireCheckout ?? false,
    // A playbook's tools are its runs' tools; repositories no longer narrow them.
    tools: { allowedTools: [], disallowedTools: [] },
    model: playbook.model,
    fallbackModel: playbook.fallbackModel,
    tokenBudget: runTokenBudget(playbook),
    tokens,
  };
  if (task.taskType !== "review") return spec;
  const reviewConfig = ReviewTaskContext.shape.reviewConfig.safeParse(
    payload.trigger.context.reviewConfig,
  );
  if (!reviewConfig.success) {
    throw new RunSpecError(`Review run of playbook ${task.id} has no valid review configuration`);
  }
  return narrowByReviewDepth(spec, reviewConfig.data.profile);
}

/**
 * `agent` without the tracker tools a tracker with only `capabilities`
 * can't serve: `tracker_get_document` needs documents.
 */
export function withTrackerToolsFor(
  agent: RunSpecAgent,
  capabilities: readonly TrackerCapability[],
): RunSpecAgent {
  if (capabilities.includes("documents")) return agent;
  const tracker = agent.tools.tracker.filter((tool) => tool !== "tracker_get_document");
  return { ...agent, tools: { ...agent.tools, tracker } };
}

/**
 * `task` with its derived `pool`, which agents up to 0.13 still require in
 * a run spec's task (newer ones drop it): a task's pool follows from its type.
 */
function withLegacyPool(task: TaskDefinition, pool: PoolName): TaskDefinition {
  return { ...task, pool } as TaskDefinition;
}

/**
 * `agent` with the one task type of its run as `taskTypes`, which agents
 * up to 0.13 still require of a run spec's agent (newer ones ignore it): an
 * agent's task types went with agent definitions.
 */
function withLegacyTaskTypes(agent: RunSpecAgent, taskType: TaskType): RunSpecAgent {
  return { ...agent, taskTypes: [taskType] };
}

/** Read-only file tools a review uses to read beyond the diff (the engine's `EXPLORATION_TOOLS`). */
const EXPLORATION_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

/**
 * A review run as its depth's preset (`reviewConfig.profile`) sets it: the
 * preset's `model` (null for the Claude Code default), `maxTokensPerReview` as
 * the budget and `maxFiles`, and without `allowRepoExploration`, no
 * exploration tools (the review sees only the diff). The playbook's model and
 * fallback never apply (no fallback: the depth names one model); review
 * playbooks can't set a model, fallback or budget.
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
    fallbackModel: null,
    tokenBudget: profile.maxTokensPerReview,
    maxFiles: profile.maxFiles,
  };
}

/**
 * A non-review run's token cap: its playbook's fixed `tokens`, or null for "No
 * limit". Never depends on a review setting.
 */
export function runTokenBudget(playbook: {
  tokenBudget: TaskDefinition["tokenBudget"];
}): number | null {
  return playbook.tokenBudget?.tokens ?? null;
}
