/**
 * The definition resolver: an organization's agents and tasks are the
 * built-ins (in code, `@omniralph/tasks`, IDs `builtin:<name>`) plus its own
 * rows (`agent_definitions`/`task_definitions`, UUIDs). A `builtin:` ID is
 * only ever resolved from code and a UUID only from the organization's rows;
 * a stored definition that no longer parses is unresolvable. Everything that
 * resolves, enqueues or claims runs goes through here, so built-in and custom
 * definitions share one path.
 */
import {
  getStoredAgentDefinition,
  getStoredTaskDefinition,
  listStoredAgentDefinitions,
  listStoredTaskDefinitions,
  type StoredAgentDefinition,
  type StoredTaskDefinition,
} from "@omniralph/db";
import {
  AgentDefinition,
  BUILTIN_AGENTS,
  BUILTIN_TASKS,
  getBuiltinAgent,
  getBuiltinTask,
  isBuiltinId,
  prDescriptionProblem,
  TaskDefinition,
  TaskRequirements,
  type TaskType,
  type TriggerKind,
} from "@omniralph/tasks";
import type { RunSpecJobPayload } from "@omniralph/shared";
import { runSpecJobInput } from "@/lib/runs/job";

type Queryable = Parameters<typeof getStoredTaskDefinition>[0];
type MaybePromise<T> = T | Promise<T>;

/** An agent definition and where it comes from. */
export interface ResolvedAgent {
  definition: AgentDefinition;
  /** Defined in code (read-only); otherwise one of the organization's rows. */
  builtin: boolean;
}

/** A task definition, where it comes from and what its runs need. */
export interface ResolvedTask {
  definition: TaskDefinition;
  builtin: boolean;
  /** The requirements stored with a custom task when it was saved; null for a built-in. */
  requirements: TaskRequirements | null;
}

function parseStoredAgent(row: StoredAgentDefinition): ResolvedAgent | null {
  const parsed = AgentDefinition.safeParse({ ...row.definition, id: row.id, name: row.name });
  if (!parsed.success) {
    console.warn("unresolvable stored agent definition", {
      organizationId: row.organizationId,
      agentId: row.id,
      error: parsed.error.message,
    });
    return null;
  }
  return { definition: parsed.data, builtin: false };
}

function parseStoredTask(row: StoredTaskDefinition): ResolvedTask | null {
  const parsed = TaskDefinition.safeParse({ ...row.definition, id: row.id, name: row.name });
  const requirements = TaskRequirements.safeParse(row.requirements);
  if (!parsed.success || !requirements.success) {
    console.warn("unresolvable stored task definition", {
      organizationId: row.organizationId,
      taskId: row.id,
      error: (parsed.error ?? requirements.error)?.message,
    });
    return null;
  }
  return { definition: parsed.data, builtin: false, requirements: requirements.data };
}

/** Agent `id` of the organization (a built-in, or one of its rows); null when unknown or unresolvable. */
export async function getAgentDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<ResolvedAgent | null> {
  if (isBuiltinId(id)) {
    const agent = getBuiltinAgent(id);
    return agent && { definition: agent, builtin: true };
  }
  const row = await getStoredAgentDefinition(db, organizationId, id);
  return row && parseStoredAgent(row);
}

/** Task `id` of the organization (a built-in, or one of its rows); null when unknown or unresolvable. */
export async function getTaskDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<ResolvedTask | null> {
  if (isBuiltinId(id)) {
    const task = getBuiltinTask(id);
    return task && { definition: task, builtin: true, requirements: null };
  }
  const row = await getStoredTaskDefinition(db, organizationId, id);
  return row && parseStoredTask(row);
}

/** The organization's agents: the built-ins, then its own by name (unresolvable ones left out). */
export async function listAgentDefinitions(
  db: Queryable,
  organizationId: string,
): Promise<ResolvedAgent[]> {
  const rows = await listStoredAgentDefinitions(db, organizationId);
  return [
    ...BUILTIN_AGENTS.map((definition) => ({ definition, builtin: true })),
    ...rows.map(parseStoredAgent).filter((agent) => agent !== null),
  ];
}

export interface TaskDefinitionFilter {
  /** Only tasks of this type (or of one of these types). */
  taskType?: TaskType | readonly TaskType[];
  /** Only tasks accepting this trigger kind. */
  trigger?: TriggerKind;
  /** Only tasks this accepts (e.g. by their output). */
  accepts?: (task: TaskDefinition) => boolean;
}

/** Whether `task` passes `filter`. */
export function matchesTaskFilter(task: TaskDefinition, filter: TaskDefinitionFilter): boolean {
  const types = filter.taskType === undefined ? null : [filter.taskType].flat();
  if (types && !types.includes(task.taskType)) return false;
  if (filter.trigger !== undefined && !task.triggers.includes(filter.trigger)) return false;
  return filter.accepts === undefined || filter.accepts(task);
}

/**
 * The organization's tasks passing `filter`: the built-ins, then its own by
 * name (unresolvable ones left out).
 */
export async function listTaskDefinitions(
  db: Queryable,
  organizationId: string,
  filter: TaskDefinitionFilter = {},
): Promise<ResolvedTask[]> {
  const rows = await listStoredTaskDefinitions(db, organizationId);
  return [
    ...BUILTIN_TASKS.map((definition) => ({ definition, builtin: true, requirements: null })),
    ...rows.map(parseStoredTask).filter((task) => task !== null),
  ].filter((task) => matchesTaskFilter(task.definition, filter));
}

/** A task a settings picker offers. */
export interface TaskChoice {
  id: string;
  name: string;
  builtin: boolean;
}

/** What a picker of the organization's tasks passing `filter` offers (built-ins first). */
export async function listTaskChoices(
  db: Queryable,
  organizationId: string,
  filter: TaskDefinitionFilter,
): Promise<TaskChoice[]> {
  const tasks = await listTaskDefinitions(db, organizationId, filter);
  return tasks.map(({ definition, builtin }) => ({
    id: definition.id,
    name: definition.name,
    builtin,
  }));
}

/**
 * The tasks a coding run can invoke for its PR description: query tasks
 * accepting `run.invoked` whose output is `{ title, body }` (`prDescriptionProblem`).
 */
export const PR_DESCRIPTION_TASKS: TaskDefinitionFilter = {
  taskType: "query",
  trigger: "run.invoked",
  accepts: (task) => prDescriptionProblem(task) === null,
};

/**
 * Where the run plumbing (run specs, sinks, ralph's coding runs) looks
 * definitions up by ID. `organizationDefinitions` is the one real source;
 * tests pass their own.
 */
export interface DefinitionSource {
  getTask(id: string): MaybePromise<TaskDefinition | null>;
  getAgent(id: string): MaybePromise<AgentDefinition | null>;
  /** The requirements stored with a custom task; null (or absent) for a built-in. */
  getTaskRequirements?(id: string): MaybePromise<TaskRequirements | null>;
}

/**
 * The definitions of an organization (`getTaskDefinition`/`getAgentDefinition`),
 * each looked up at most once per source.
 */
export function organizationDefinitions(db: Queryable, organizationId: string): DefinitionSource {
  const tasks = new Map<string, Promise<ResolvedTask | null>>();
  const agents = new Map<string, Promise<ResolvedAgent | null>>();
  const task = (id: string) => {
    let found = tasks.get(id);
    if (!found) tasks.set(id, (found = getTaskDefinition(db, organizationId, id)));
    return found;
  };
  const agent = (id: string) => {
    let found = agents.get(id);
    if (!found) agents.set(id, (found = getAgentDefinition(db, organizationId, id)));
    return found;
  };
  return {
    getTask: async (id) => (await task(id))?.definition ?? null,
    getAgent: async (id) => (await agent(id))?.definition ?? null,
    getTaskRequirements: async (id) => (await task(id))?.requirements ?? null,
  };
}

/** The built-ins alone, for tests (real code resolves through `organizationDefinitions`). */
export const BUILTIN_DEFINITIONS: DefinitionSource = {
  getTask: (id) => getBuiltinTask(id),
  getAgent: (id) => getBuiltinAgent(id),
  getTaskRequirements: () => null,
};

/**
 * `runSpecJobInput` for `task` as `definitions` resolved it: a custom task's
 * job needs at least the harness version stored in its requirements.
 */
export async function taskJobInput(
  definitions: DefinitionSource,
  task: TaskDefinition,
  payload: RunSpecJobPayload,
): Promise<ReturnType<typeof runSpecJobInput>> {
  return runSpecJobInput(task, payload, await definitions.getTaskRequirements?.(task.id));
}
