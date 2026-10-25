/**
 * The playbook resolver: an organization's playbooks are the built-ins (in
 * code, `@omniralph/tasks`, IDs `builtin:<name>`) plus its own, which are still
 * stored as a task row and the agent row it runs on (`task_definitions`/
 * `agent_definitions`, UUIDs) and read as one playbook (`customPlaybook`). A
 * `builtin:` ID is only ever resolved from code and a UUID only from the
 * organization's rows; a stored definition that no longer parses, or doesn't
 * fit a playbook role, is unresolvable. Everything that resolves, enqueues or
 * claims runs goes through `PlaybookSource`, so built-in and custom playbooks
 * share one path.
 *
 * The agent and task lists below serve the old Settings › Agents and Tasks
 * pages: a built-in playbook shows there as a task on an agent of its own ID.
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
  BUILTIN_PLAYBOOKS,
  BUILTIN_TASKS,
  correlationProblem,
  deriveHarnessRequirements,
  getBuiltinPlaybook,
  getBuiltinRunSpec,
  getBuiltinTask,
  isBuiltinId,
  playbookRunSpec,
  prDescriptionProblem,
  REQUEST_TRIGGERS,
  TaskDefinition,
  TaskRequirements,
  type Playbook,
  type TaskType,
  type TriggerKind,
} from "@omniralph/tasks";
import type { RunSpecJobPayload } from "@omniralph/shared";
import { CustomAgent, type CustomAgentInput } from "@/lib/api/definitions";
import { runSpecJobInput } from "@/lib/runs/job";
import { customPlaybook } from "./custom-playbooks";

type Queryable = Parameters<typeof getStoredTaskDefinition>[0];
type MaybePromise<T> = T | Promise<T>;

/** An agent definition and where it comes from. */
export interface ResolvedAgent {
  definition: CustomAgent;
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
  const parsed = CustomAgent.safeParse({ ...row.definition, id: row.id, name: row.name });
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

/** The persona of a built-in playbook, as the old pages show it: an agent of the playbook's ID. */
function builtinAgent(agent: CustomAgentInput): ResolvedAgent {
  return { definition: CustomAgent.parse(agent), builtin: true };
}

/**
 * Agent `id` of the organization (a built-in playbook's persona, or one of its
 * rows); null when unknown or unresolvable.
 */
export async function getAgentDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<ResolvedAgent | null> {
  if (isBuiltinId(id)) {
    const spec = getBuiltinRunSpec(id);
    return spec && builtinAgent(spec.agent);
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

/**
 * The organization's agents: the built-in playbooks' personas, then its own by
 * name (unresolvable ones left out).
 */
export async function listAgentDefinitions(
  db: Queryable,
  organizationId: string,
): Promise<ResolvedAgent[]> {
  const rows = await listStoredAgentDefinitions(db, organizationId);
  return [
    ...BUILTIN_PLAYBOOKS.map((playbook) => builtinAgent(playbookRunSpec(playbook).agent)),
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

/** A repository's review tasks: review tasks accepting `pr.updated`. */
export const REVIEW_TASKS: TaskDefinitionFilter = { taskType: "review", trigger: "pr.updated" };

/**
 * A repository's correlation task: query tasks accepting `run.invoked` whose
 * output is the fixed correlation output (`correlationProblem`).
 */
export const CORRELATION_TASKS: TaskDefinitionFilter = {
  taskType: "query",
  trigger: "run.invoked",
  accepts: (task) => correlationProblem(task) === null,
};

/** A repository's story task: coding tasks accepting `linear.delegated`. */
export const STORY_TASKS: TaskDefinitionFilter = {
  taskType: "coding",
  trigger: "linear.delegated",
};

/** A repository's request task: coding tasks accepting every request trigger (`REQUEST_TRIGGERS`). */
export const REQUEST_TASKS: TaskDefinitionFilter = {
  taskType: "coding",
  accepts: (task) => REQUEST_TRIGGERS.every((trigger) => task.triggers.includes(trigger)),
};

/**
 * Task `id` of the organization when it passes `filter`; null when it is
 * unknown, unresolvable or doesn't pass (a settings picker's server check).
 */
export async function getTaskChoice(
  db: Queryable,
  organizationId: string,
  id: string,
  filter: TaskDefinitionFilter,
): Promise<ResolvedTask | null> {
  const task = await getTaskDefinition(db, organizationId, id);
  return task && matchesTaskFilter(task.definition, filter) ? task : null;
}

/**
 * Where the run plumbing (run specs, sinks, ralph's coding runs) looks
 * playbooks up by ID. `organizationPlaybooks` is the one real source; tests
 * pass their own.
 */
export interface PlaybookSource {
  getPlaybook(id: string): MaybePromise<Playbook | null>;
  /** The requirements stored with a custom playbook; null (or absent) for a built-in. */
  getPlaybookRequirements?(id: string): MaybePromise<TaskRequirements | null>;
}

/**
 * Custom playbook `id` of the organization: its task row on the agent row it
 * names (or a built-in playbook's persona), read as one playbook. Null when
 * either is unknown or unresolvable, or they don't fit a playbook.
 */
async function getCustomPlaybook(
  db: Queryable,
  organizationId: string,
  task: ResolvedTask | null,
): Promise<Playbook | null> {
  if (!task) return null;
  const agent = await getAgentDefinition(db, organizationId, task.definition.agentId);
  if (!agent) return null;
  const playbook = customPlaybook(task.definition, agent.definition);
  if (!playbook) {
    console.warn("unresolvable custom playbook", { organizationId, taskId: task.definition.id });
  }
  return playbook;
}

/**
 * The playbooks of an organization (built-ins from code, its own from its
 * rows), each looked up at most once per source.
 */
export function organizationPlaybooks(db: Queryable, organizationId: string): PlaybookSource {
  const tasks = new Map<string, Promise<ResolvedTask | null>>();
  const playbooks = new Map<string, Promise<Playbook | null>>();
  const task = (id: string) => {
    let found = tasks.get(id);
    if (!found) tasks.set(id, (found = getTaskDefinition(db, organizationId, id)));
    return found;
  };
  const playbook = (id: string) => {
    let found = playbooks.get(id);
    if (!found) {
      found = isBuiltinId(id)
        ? Promise.resolve(getBuiltinPlaybook(id))
        : task(id).then((resolved) => getCustomPlaybook(db, organizationId, resolved));
      playbooks.set(id, found);
    }
    return found;
  };
  return {
    getPlaybook: playbook,
    getPlaybookRequirements: async (id) =>
      isBuiltinId(id) ? null : ((await task(id))?.requirements ?? null),
  };
}

/** The built-ins alone, for tests (real code resolves through `organizationPlaybooks`). */
export const BUILTIN_PLAYBOOK_SOURCE: PlaybookSource = {
  getPlaybook: (id) => getBuiltinPlaybook(id),
  getPlaybookRequirements: () => null,
};

/**
 * The run spec task of playbook `id` (`playbookRunSpec`: its role's task type,
 * triggers and sink, its prompt and settings), for code that reads those; null
 * when `playbooks` doesn't resolve it.
 */
export async function getPlaybookTask(
  playbooks: PlaybookSource,
  id: string,
): Promise<TaskDefinition | null> {
  const playbook = await playbooks.getPlaybook(id);
  return playbook && playbookRunSpec(playbook).task;
}

/**
 * What runs of `task` (a playbook's run spec task) need from a harness as
 * `playbooks` resolve it (the `requirements` of `runSpecJobInput`): a custom
 * playbook's at least the harness version stored with it, and every
 * playbook's installables and host tools derived from it as it is now
 * (`deriveHarnessRequirements` of its run spec: an agent edited since the
 * task was saved counts as edited).
 */
export async function taskRunRequirements(
  playbooks: PlaybookSource,
  task: TaskDefinition,
): Promise<TaskRequirements> {
  const [stored, playbook] = await Promise.all([
    playbooks.getPlaybookRequirements?.(task.id),
    playbooks.getPlaybook(task.id),
  ]);
  return {
    minHarnessVersion: stored?.minHarnessVersion ?? null,
    ...deriveHarnessRequirements(task, playbook && playbookRunSpec(playbook).agent),
  };
}

/** `runSpecJobInput` for `task` with the `taskRunRequirements` `playbooks` resolve. */
export async function taskJobInput(
  playbooks: PlaybookSource,
  task: TaskDefinition,
  payload: RunSpecJobPayload,
): Promise<ReturnType<typeof runSpecJobInput>> {
  return runSpecJobInput(task, payload, await taskRunRequirements(playbooks, task));
}
