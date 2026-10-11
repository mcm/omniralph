import { RunSpecJobPayload } from "@omniralph/shared";
import type { TaskDefinition } from "@omniralph/tasks";

/**
 * The routing and payload of a run-spec job for `task` (spread into
 * `insertJob`/`createAndPublish` input next to `organizationId`, `type` and
 * `dedupeKey`): the task's type and pool, its ID in `task_id` and the stored
 * `RunSpecJobPayload`, which `resolveRunSpec` turns into a run spec at claim time.
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
} {
  const parsed = RunSpecJobPayload.parse(payload);
  return {
    taskType: task.taskType,
    pool: task.pool,
    taskId: task.id,
    payload: parsed,
    repositoryId: parsed.repositoryId ?? null,
  };
}
