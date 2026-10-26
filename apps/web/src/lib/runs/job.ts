import {
  CODING_TASKS_MIN_HARNESS_VERSION,
  harnessVersionAtLeast,
  QUERY_TASKS_MIN_HARNESS_VERSION,
  REVIEW_TASKS_MIN_HARNESS_VERSION,
  RunSpecJobPayload,
  SETUP_COMMANDS_MIN_HARNESS_VERSION,
} from "@omniralph/shared";
import type { TaskDefinition, TaskRequirements } from "@omniralph/tasks";

/**
 * The routing and payload of a run-spec job for `task` (spread into
 * `insertJob`/`createAndPublish` input next to `organizationId`, `type` and
 * `dedupeKey`): the task's type (its pool follows), its ID in `task_id` and the stored
 * `RunSpecJobPayload`, which `resolveRunSpec` turns into a run spec at claim time.
 * Query, review and coding tasks need a harness with their lifecycle
 * (`QUERY_TASKS_MIN_HARNESS_VERSION`, `REVIEW_TASKS_MIN_HARNESS_VERSION`,
 * `CODING_TASKS_MIN_HARNESS_VERSION`),
 * tasks with setup or teardown commands one that runs them
 * (`SETUP_COMMANDS_MIN_HARNESS_VERSION`), and a custom task the
 * `minHarnessVersion` of the `requirements` stored with it: the highest that
 * applies. Only harnesses with every installable and host tool in
 * `requirements` (`deriveAgentRequirements` of the task and its agent)
 * claim the job.
 */
export function runSpecJobInput(
  task: Pick<TaskDefinition, "id" | "taskType"> &
    Partial<Pick<TaskDefinition, "setupCommands" | "teardownCommands">>,
  payload: RunSpecJobPayload,
  requirements?: Partial<TaskRequirements> | null,
): {
  taskType: TaskDefinition["taskType"];
  taskId: string;
  payload: RunSpecJobPayload;
  repositoryId: string | null;
  minHarnessVersion: string | null;
  requiredInstallables: string[];
  requiredHostTools: string[];
} {
  const parsed = RunSpecJobPayload.parse(payload);
  return {
    taskType: task.taskType,
    taskId: task.id,
    payload: parsed,
    repositoryId: parsed.repositoryId ?? null,
    minHarnessVersion: runSpecMinHarnessVersion(task, requirements?.minHarnessVersion ?? null),
    requiredInstallables: [...new Set(requirements?.installables ?? [])].sort(),
    requiredHostTools: [...new Set(requirements?.hostTools ?? [])].sort(),
  };
}

/** The `min_harness_version` of a run of `task` (see `runSpecJobInput`); `stored` is a custom task's. */
export function runSpecMinHarnessVersion(
  task: Pick<TaskDefinition, "taskType"> &
    Partial<Pick<TaskDefinition, "setupCommands" | "teardownCommands">>,
  stored: string | null,
): string | null {
  const commands =
    (task.setupCommands?.length ?? 0) > 0 || (task.teardownCommands?.length ?? 0) > 0;
  const needed = [
    task.taskType === "query" ? QUERY_TASKS_MIN_HARNESS_VERSION : null,
    task.taskType === "review" ? REVIEW_TASKS_MIN_HARNESS_VERSION : null,
    task.taskType === "coding" ? CODING_TASKS_MIN_HARNESS_VERSION : null,
    commands ? SETUP_COMMANDS_MIN_HARNESS_VERSION : null,
    stored,
  ].filter((version) => version !== null);
  return needed.reduce<string | null>(
    (highest, version) =>
      highest === null || !harnessVersionAtLeast(highest, version) ? version : highest,
    null,
  );
}
