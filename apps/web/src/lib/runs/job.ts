import { QUERY_TASKS_MIN_HARNESS_VERSION, RunSpecJobPayload } from "@omniralph/shared";
import type { TaskDefinition } from "@omniralph/tasks";

/**
 * The routing and payload of a run-spec job for `task` (spread into
 * `insertJob`/`createAndPublish` input next to `organizationId`, `type` and
 * `dedupeKey`): the task's type and pool, its ID in `task_id` and the stored
 * `RunSpecJobPayload`, which `resolveRunSpec` turns into a run spec at claim time.
 * Query tasks need a harness with the query lifecycle (`QUERY_TASKS_MIN_HARNESS_VERSION`).
 */
export function runSpecJobInput(
  task: Pick<TaskDefinition, "id" | "taskType" | "pool">,
  payload: RunSpecJobPayload,
): {
  taskType: TaskDefinition["taskType"];
  pool: TaskDefinition["pool"];
  taskId: string;
  payload: RunSpecJobPayload;
  repositoryId: string | null;
  minHarnessVersion: string | null;
} {
  const parsed = RunSpecJobPayload.parse(payload);
  return {
    taskType: task.taskType,
    pool: task.pool,
    taskId: task.id,
    payload: parsed,
    repositoryId: parsed.repositoryId ?? null,
    minHarnessVersion: task.taskType === "query" ? QUERY_TASKS_MIN_HARNESS_VERSION : null,
  };
}
