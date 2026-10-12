import "server-only";
import { listPoolNames, type Database } from "@omniralph/db";
import { POOLS, type PoolName } from "@omniralph/tasks";
import { listAgentDefinitions, listTaskChoices, PR_DESCRIPTION_TASKS } from "@/lib/definitions";
import { allSinks } from "@/lib/sinks";
import type { TaskFormProps } from "./task-form";

/**
 * What the task form picks from: the organization's agents, pools and PR
 * description tasks, and the implemented sinks.
 */
export async function taskFormOptions(
  db: Database,
  organizationId: string,
): Promise<Pick<TaskFormProps, "agents" | "sinks" | "pools" | "prDescriptionTasks">> {
  const [agents, poolNames, prDescriptionTasks] = await Promise.all([
    listAgentDefinitions(db, organizationId),
    listPoolNames(db, organizationId),
    listTaskChoices(db, organizationId, PR_DESCRIPTION_TASKS),
  ]);
  // A task names one of the pools definitions know; an organization has them seeded.
  const pools = POOLS.filter((pool: PoolName) => poolNames.includes(pool));
  return {
    agents: agents.map(({ definition, builtin }) => ({
      id: definition.id,
      name: definition.name,
      taskTypes: definition.taskTypes,
      builtin,
    })),
    sinks: allSinks().map((sink) => ({ kind: sink.kind, taskType: sink.taskType })),
    pools: pools.length > 0 ? pools : [...POOLS],
    prDescriptionTasks,
  };
}
