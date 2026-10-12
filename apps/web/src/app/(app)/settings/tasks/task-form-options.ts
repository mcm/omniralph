import "server-only";
import { listPoolNames, type Database } from "@omniralph/db";
import { POOLS, type PoolName } from "@omniralph/tasks";
import { listAgentDefinitions } from "@/lib/definitions";
import { allSinks } from "@/lib/sinks";
import type { TaskFormProps } from "./task-form";

/** What the task form picks from: the organization's agents and pools, and the implemented sinks. */
export async function taskFormOptions(
  db: Database,
  organizationId: string,
): Promise<Pick<TaskFormProps, "agents" | "sinks" | "pools">> {
  const [agents, poolNames] = await Promise.all([
    listAgentDefinitions(db, organizationId),
    listPoolNames(db, organizationId),
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
  };
}
