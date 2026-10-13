import "server-only";
import { listHostTools, listPoolNames, type Database } from "@omniralph/db";
import { POOLS, type PoolName } from "@omniralph/tasks";
import { listAgentDefinitions, listTaskChoices, PR_DESCRIPTION_TASKS } from "@/lib/definitions";
import { loadHarnessChoices } from "@/lib/harnesses/editor-choices";
import { allSinks } from "@/lib/sinks";
import type { TaskFormProps } from "./task-form";

/**
 * What the task form picks from: the organization's agents, pools, PR description tasks and
 * host tools, what its harnesses report, and the implemented sinks.
 */
export async function taskFormOptions(
  db: Database,
  organizationId: string,
): Promise<
  Pick<TaskFormProps, "agents" | "sinks" | "pools" | "prDescriptionTasks" | "choices" | "hostTools">
> {
  const [agents, poolNames, prDescriptionTasks, choices, hostTools] = await Promise.all([
    listAgentDefinitions(db, organizationId),
    listPoolNames(db, organizationId),
    listTaskChoices(db, organizationId, PR_DESCRIPTION_TASKS),
    loadHarnessChoices(db, organizationId),
    listHostTools(db, organizationId),
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
    choices,
    hostTools: hostTools.map((tool) => ({ name: tool.name, description: tool.description })),
  };
}
