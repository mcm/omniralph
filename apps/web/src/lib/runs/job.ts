import {
  CODING_TASKS_MIN_AGENT_VERSION,
  agentVersionAtLeast,
  QUERY_TASKS_MIN_AGENT_VERSION,
  REVIEW_TASKS_MIN_AGENT_VERSION,
  RunSpecJobPayload,
  SETUP_COMMANDS_MIN_AGENT_VERSION,
  TRACKER_PROTOCOL_MIN_AGENT_VERSION,
} from "@omniralph/shared";
import { usesTrackerProtocol, type TaskDefinition, type TaskRequirements } from "@omniralph/tasks";

/**
 * The routing and payload of a run-spec job for `task` (spread into
 * `insertJob`/`createAndPublish` input next to `organizationId`, `type` and
 * `dedupeKey`): the task's type (its pool follows), its ID in `task_id` and the stored
 * `RunSpecJobPayload`, which `resolveRunSpec` turns into a run spec at claim time.
 * Query, review and coding tasks need an agent with their lifecycle
 * (`QUERY_TASKS_MIN_AGENT_VERSION`, `REVIEW_TASKS_MIN_AGENT_VERSION`,
 * `CODING_TASKS_MIN_AGENT_VERSION`),
 * tasks with setup or teardown commands one that runs them
 * (`SETUP_COMMANDS_MIN_AGENT_VERSION`), tasks that use the tracker protocol
 * (coding tasks, and tasks with the tracker tools turned on) one that speaks it
 * (`TRACKER_PROTOCOL_MIN_AGENT_VERSION`), and a custom task the
 * `minAgentVersion` of the `requirements` stored with it: the highest that
 * applies. Only agents with every installable and host tool in
 * `requirements` (`deriveAgentRequirements` of the task and its agent)
 * claim the job.
 */
export function runSpecJobInput(
  task: Pick<TaskDefinition, "id" | "taskType"> &
    Partial<Pick<TaskDefinition, "setupCommands" | "teardownCommands" | "toolSettings">>,
  payload: RunSpecJobPayload,
  requirements?: Partial<TaskRequirements> | null,
): {
  taskType: TaskDefinition["taskType"];
  taskId: string;
  payload: RunSpecJobPayload;
  repositoryId: string | null;
  minAgentVersion: string | null;
  requiredInstallables: string[];
  requiredHostTools: string[];
} {
  const parsed = RunSpecJobPayload.parse(payload);
  return {
    taskType: task.taskType,
    taskId: task.id,
    payload: parsed,
    repositoryId: parsed.repositoryId ?? null,
    minAgentVersion: runSpecMinAgentVersion(task, requirements?.minAgentVersion ?? null),
    requiredInstallables: [...new Set(requirements?.installables ?? [])].sort(),
    requiredHostTools: [...new Set(requirements?.hostTools ?? [])].sort(),
  };
}

/** The `min_agent_version` of a run of `task` (see `runSpecJobInput`); `stored` is a custom task's. */
export function runSpecMinAgentVersion(
  task: Pick<TaskDefinition, "taskType"> &
    Partial<Pick<TaskDefinition, "setupCommands" | "teardownCommands" | "toolSettings">>,
  stored: string | null,
): string | null {
  const commands =
    (task.setupCommands?.length ?? 0) > 0 || (task.teardownCommands?.length ?? 0) > 0;
  const needed = [
    task.taskType === "query" ? QUERY_TASKS_MIN_AGENT_VERSION : null,
    task.taskType === "review" ? REVIEW_TASKS_MIN_AGENT_VERSION : null,
    task.taskType === "coding" ? CODING_TASKS_MIN_AGENT_VERSION : null,
    commands ? SETUP_COMMANDS_MIN_AGENT_VERSION : null,
    usesTrackerProtocol(task) ? TRACKER_PROTOCOL_MIN_AGENT_VERSION : null,
    stored,
  ].filter((version) => version !== null);
  return needed.reduce<string | null>(
    (highest, version) =>
      highest === null || !agentVersionAtLeast(highest, version) ? version : highest,
    null,
  );
}
