import "server-only";
import { randomUUID } from "node:crypto";
import {
  countActiveTaskJobs,
  deleteAgentDefinition as deleteAgentDefinitionRow,
  deleteTaskDefinition as deleteTaskDefinitionRow,
  getStoredAgentDefinition,
  getStoredTaskDefinition,
  insertAgentDefinition,
  insertTaskDefinition,
  listHostTools,
  listPoolNames,
  listStoredTaskDefinitions,
  updateAgentDefinition as updateAgentDefinitionRow,
  updateTaskDefinition as updateTaskDefinitionRow,
  type Database,
} from "@omniralph/db";
import {
  deriveHarnessRequirements,
  deriveTaskRequirements,
  HARNESS_TOOLS_BY_TASK_TYPE,
  isBuiltinId,
  POOLS,
  validateAgentDefinition,
  type AgentDefinition,
  type PoolName,
  type TaskDefinition,
} from "@omniralph/tasks";
import type { ActionResult } from "@/lib/action-result";
import type {
  AgentDetail,
  AgentList,
  SavedDefinition,
  TaskDetail,
  TaskFormOptions,
  TaskList,
} from "@/lib/api/definitions";
import type { OrgUser } from "@/lib/auth/session";
import {
  getAgentDefinition,
  getTaskDefinition,
  listAgentDefinitions,
  listTaskChoices,
  listTaskDefinitions,
  PR_DESCRIPTION_TASKS,
} from "@/lib/definitions";
import { findTaskReferrers, hasNoReferrers, type TaskReferrers } from "@/lib/definitions/referrers";
import { validateOrganizationTask } from "@/lib/definitions/validation";
import { loadHarnessChoices } from "@/lib/harnesses/editor-choices";
import { allSinks } from "@/lib/sinks";
import { repositoryTaskRoles } from "./repository-roles";

/**
 * Settings › Agents and Settings › Tasks: what the `/api/ui/agents/**` and
 * `/api/ui/tasks/**` handlers load and change. Every function is scoped to the
 * user's active organization; the handlers check the role.
 */

/** A created or cloned definition's ID, for navigating to it. */
export type SavedDefinitionResult = ActionResult | SavedDefinition;

const MAX_NAME_LENGTH = 200;
const INVALID = { ok: false, error: "Fix the highlighted fields." } as const;
const AGENT_BUILTIN_READ_ONLY = "Built-in agents can't be changed; clone one to make your own.";
const AGENT_NOT_FOUND = "That agent doesn't exist.";
const TASK_BUILTIN_READ_ONLY = "Built-in tasks can't be changed; clone one to make your own.";
const TASK_NOT_FOUND = "That task doesn't exist.";

const CHAT_TASK_NAMES: Record<TaskReferrers["chatTasks"][number], string> = {
  askAboutCode: "ask about code",
  startWork: "start work",
};

/** What a row stores: the definition without the ID and name its columns hold. */
function storedDefinition(definition: AgentDefinition | TaskDefinition): Record<string, unknown> {
  const { id: _id, name: _name, ...stored } = definition;
  return stored;
}

/** A submitted definition (the body: any JSON) with the row's ID; non-objects fail validation. */
function withId(input: unknown, id: string): Record<string, unknown> {
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  return { ...fields, id };
}

/** Comma-joined names, for error messages. */
function names(list: readonly string[]): string {
  return list.join(", ");
}

/** `name` as a copy's name, within the name limit. */
function copyName(name: string): string {
  const suffix = " (copy)";
  return `${name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

// --- Agents ---------------------------------------------------------------------------------

/** The organization's agents: built-ins first, then its own. */
export async function loadAgentList(db: Database, user: OrgUser): Promise<AgentList> {
  const agents = await listAgentDefinitions(db, user.organization.id);
  return {
    agents: agents.map(({ definition, builtin }) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      builtin,
      taskTypes: definition.taskTypes,
      model: definition.model,
    })),
  };
}

/** Agent `id` of the organization and the tasks running on it; null when unknown. */
export async function loadAgentDetail(
  db: Database,
  user: OrgUser,
  id: string,
): Promise<AgentDetail | null> {
  const [agent, tasks] = await Promise.all([
    getAgentDefinition(db, user.organization.id, id),
    listTaskDefinitions(db, user.organization.id),
  ]);
  if (!agent) return null;
  return {
    agent: agent.definition,
    builtin: agent.builtin,
    tasks: tasks
      .filter((task) => task.definition.agentId === agent.definition.id)
      .map(({ definition, builtin }) => ({
        id: definition.id,
        name: definition.name,
        taskType: definition.taskType,
        builtin,
      })),
  };
}

/**
 * Creates one of the admin's organization's agents after validating it
 * (`validateAgentDefinition`); returns its new ID.
 */
export async function createAgent(
  db: Database,
  admin: OrgUser,
  input: unknown,
): Promise<SavedDefinitionResult> {
  const id = randomUUID();
  const validation = validateAgentDefinition(withId(input, id));
  if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
  const agent = validation.definition;
  await insertAgentDefinition(db, admin.organization.id, {
    id,
    name: agent.name,
    definition: storedDefinition(agent),
    createdBy: admin.id,
  });
  return { ok: true, id };
}

/**
 * Replaces one of the organization's agents. Refused for built-ins, for
 * definitions that don't validate, and for changes that would no longer suit a
 * task running on the agent (a task type it drops, a harness tool the task's
 * type doesn't allow); the error names each such task.
 */
export async function updateAgent(
  db: Database,
  admin: OrgUser,
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (isBuiltinId(id)) return { ok: false, error: AGENT_BUILTIN_READ_ONLY };
  const organizationId = admin.organization.id;
  if (!(await getStoredAgentDefinition(db, organizationId, id))) {
    return { ok: false, error: AGENT_NOT_FOUND };
  }
  const validation = validateAgentDefinition(withId(input, id));
  if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
  const agent = validation.definition;

  const tasks = (await listTaskDefinitions(db, organizationId)).filter(
    (task) => task.definition.agentId === id,
  );
  const unsuited = tasks.filter((task) => !agent.taskTypes.includes(task.definition.taskType));
  const disallowed = tasks.filter((task) =>
    agent.tools.harness.some(
      (tool) => !HARNESS_TOOLS_BY_TASK_TYPE[task.definition.taskType].includes(tool),
    ),
  );
  if (unsuited.length > 0 || disallowed.length > 0) {
    const fieldErrors: Record<string, string> = {};
    if (unsuited.length > 0) {
      fieldErrors.taskTypes = `Still used by ${names(
        unsuited.map((task) => `${task.definition.name} (${task.definition.taskType})`),
      )}.`;
    }
    if (disallowed.length > 0) {
      fieldErrors["tools.harness"] = `Not allowed for ${names(
        disallowed.map((task) => `${task.definition.name} (${task.definition.taskType})`),
      )}.`;
    }
    const broken = [...new Set([...unsuited, ...disallowed].map((task) => task.definition.name))];
    return {
      ok: false,
      error: `This change would make tasks using the agent invalid: ${names(broken)}.`,
      fieldErrors,
    };
  }

  const row = await updateAgentDefinitionRow(db, organizationId, id, {
    name: agent.name,
    definition: storedDefinition(agent),
    updatedBy: admin.id,
  });
  return row ? { ok: true } : { ok: false, error: AGENT_NOT_FOUND };
}

/**
 * Copies an agent (a built-in or one of the organization's) into a new row of
 * the organization, named as a copy; returns the new ID.
 */
export async function cloneAgent(
  db: Database,
  admin: OrgUser,
  id: string,
): Promise<SavedDefinitionResult> {
  const source = await getAgentDefinition(db, admin.organization.id, id);
  if (!source) return { ok: false, error: AGENT_NOT_FOUND };
  const cloneId = randomUUID();
  await insertAgentDefinition(db, admin.organization.id, {
    id: cloneId,
    name: copyName(source.definition.name),
    definition: storedDefinition(source.definition),
    createdBy: admin.id,
  });
  return { ok: true, id: cloneId };
}

/**
 * Deletes one of the organization's agents. Refused for built-ins and while
 * any of the organization's tasks runs on it (the error lists them).
 */
export async function deleteAgent(db: Database, admin: OrgUser, id: string): Promise<ActionResult> {
  if (isBuiltinId(id)) return { ok: false, error: AGENT_BUILTIN_READ_ONLY };
  const organizationId = admin.organization.id;
  const agent = await getStoredAgentDefinition(db, organizationId, id);
  if (!agent) return { ok: false, error: AGENT_NOT_FOUND };
  // The raw rows: a task that no longer resolves still names the agent.
  const users = (await listStoredTaskDefinitions(db, organizationId)).filter(
    (task) => task.definition.agentId === id,
  );
  if (users.length > 0) {
    return {
      ok: false,
      error: `${agent.name} can't be deleted while tasks use it: ${names(users.map((task) => task.name))}.`,
    };
  }
  if (!(await deleteAgentDefinitionRow(db, organizationId, id))) {
    return { ok: false, error: AGENT_NOT_FOUND };
  }
  return { ok: true };
}

// --- Tasks ----------------------------------------------------------------------------------

/** Each setting or definition using a task, for error messages. */
function referrerNames(referrers: TaskReferrers): string[] {
  return [
    ...referrers.repositories.map(
      (repo) => `repository ${repo.fullPath} (${repositoryTaskRoles(repo)})`,
    ),
    ...referrers.chatTasks.map((role) => `the chat ${CHAT_TASK_NAMES[role]} task`),
    ...referrers.chatChannels.map((channel) => {
      const roles = [
        channel.askAboutCode && CHAT_TASK_NAMES.askAboutCode,
        channel.startWork && CHAT_TASK_NAMES.startWork,
      ];
      return `chat channel ${channel.connectionName} › ${channel.channelId} (${roles.filter(Boolean).join(", ")})`;
    }),
    ...referrers.codingTasks.map((task) => `coding task ${task.name} (PR description)`),
  ];
}

/** The organization's tasks (built-ins first, then its own) with their agents' names. */
export async function loadTaskList(db: Database, user: OrgUser): Promise<TaskList> {
  const [tasks, agents] = await Promise.all([
    listTaskDefinitions(db, user.organization.id),
    listAgentDefinitions(db, user.organization.id),
  ]);
  const agentNames = new Map(agents.map(({ definition }) => [definition.id, definition.name]));
  return {
    tasks: tasks.map(({ definition, builtin }) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      builtin,
      taskType: definition.taskType,
      agentId: definition.agentId,
      agentName: agentNames.get(definition.agentId) ?? null,
      triggers: definition.triggers,
      sink: definition.sink,
      pool: definition.pool,
    })),
  };
}

/**
 * Task `id` of the organization, what its runs need and what uses it; null when unknown.
 * The version is stored with a custom task when it was saved (a built-in's is derived from
 * the code); installables and host tools follow the agent as it is now, as its runs' jobs do.
 */
export async function loadTaskDetail(
  db: Database,
  user: OrgUser,
  id: string,
): Promise<TaskDetail | null> {
  const organizationId = user.organization.id;
  const task = await getTaskDefinition(db, organizationId, id);
  if (!task) return null;
  const { definition } = task;
  const [agent, prDescriptionTask, referrers] = await Promise.all([
    getAgentDefinition(db, organizationId, definition.agentId),
    definition.prDescriptionTaskId
      ? getTaskDefinition(db, organizationId, definition.prDescriptionTaskId)
      : null,
    findTaskReferrers(db, organizationId, definition.id),
  ]);
  return {
    task: definition,
    builtin: task.builtin,
    agentName: agent?.definition.name ?? null,
    prDescriptionTaskName: prDescriptionTask?.definition.name ?? null,
    requirements: {
      ...(task.requirements ?? deriveTaskRequirements(definition)),
      ...deriveHarnessRequirements(definition, agent?.definition),
    },
    referrers,
  };
}

/**
 * What the task form picks from: the organization's agents, pools, PR description tasks and
 * host tools, what its harnesses report, and the implemented sinks.
 */
export async function loadTaskFormOptions(db: Database, user: OrgUser): Promise<TaskFormOptions> {
  const organizationId = user.organization.id;
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

/**
 * Creates one of the admin's organization's tasks after validating it against
 * the organization's agents and tasks and the real sinks; stores the
 * requirements its runs need with it. Returns its new ID.
 */
export async function createTask(
  db: Database,
  admin: OrgUser,
  input: unknown,
): Promise<SavedDefinitionResult> {
  const organizationId = admin.organization.id;
  const id = randomUUID();
  const validation = await validateOrganizationTask(db, organizationId, withId(input, id));
  if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
  const task = validation.definition;
  await insertTaskDefinition(db, organizationId, {
    id,
    name: task.name,
    definition: storedDefinition(task),
    requirements: validation.requirements,
    createdBy: admin.id,
  });
  return { ok: true, id };
}

/**
 * Replaces one of the organization's tasks and its requirements. Refused for
 * built-ins, for definitions that don't validate, and for a change of task
 * type while settings or definitions use the task (the error names them).
 */
export async function updateTask(
  db: Database,
  admin: OrgUser,
  id: string,
  input: unknown,
): Promise<ActionResult> {
  if (isBuiltinId(id)) return { ok: false, error: TASK_BUILTIN_READ_ONLY };
  const organizationId = admin.organization.id;
  const current = await getStoredTaskDefinition(db, organizationId, id);
  if (!current) return { ok: false, error: TASK_NOT_FOUND };
  const validation = await validateOrganizationTask(db, organizationId, withId(input, id));
  if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
  const task = validation.definition;

  // Whatever uses the task picked it for its type.
  if (current.definition.taskType !== task.taskType) {
    const users = referrerNames(await findTaskReferrers(db, organizationId, id));
    if (users.length > 0) {
      const error = `The task type can't change while it's used by ${users.join(", ")}.`;
      return { ok: false, error, fieldErrors: { taskType: error } };
    }
  }

  const row = await updateTaskDefinitionRow(db, organizationId, id, {
    name: task.name,
    definition: storedDefinition(task),
    requirements: validation.requirements,
    updatedBy: admin.id,
  });
  return row ? { ok: true } : { ok: false, error: TASK_NOT_FOUND };
}

/**
 * Copies a task (a built-in or one of the organization's) into a new row of
 * the organization, named as a copy, on the same agent; its requirements are
 * derived again. Returns the new ID.
 */
export async function cloneTask(
  db: Database,
  admin: OrgUser,
  id: string,
): Promise<SavedDefinitionResult> {
  const organizationId = admin.organization.id;
  const source = await getTaskDefinition(db, organizationId, id);
  if (!source) return { ok: false, error: TASK_NOT_FOUND };
  const name = copyName(source.definition.name);
  const cloneId = randomUUID();
  const validation = await validateOrganizationTask(db, organizationId, {
    ...source.definition,
    id: cloneId,
    name,
  });
  if (!validation.ok) {
    const problems = [...new Set(Object.values(validation.fieldErrors))];
    return {
      ok: false,
      error: `${source.definition.name} can't be cloned until it's fixed: ${problems.join(" ")}`,
    };
  }
  await insertTaskDefinition(db, organizationId, {
    id: cloneId,
    name,
    definition: storedDefinition(validation.definition),
    requirements: validation.requirements,
    createdBy: admin.id,
  });
  return { ok: true, id: cloneId };
}

/**
 * Deletes one of the organization's tasks. Refused for built-ins, while
 * repository or chat settings or coding tasks use it (the error names each),
 * and while one of its jobs is queued or running.
 */
export async function deleteTask(db: Database, admin: OrgUser, id: string): Promise<ActionResult> {
  if (isBuiltinId(id)) return { ok: false, error: TASK_BUILTIN_READ_ONLY };
  const organizationId = admin.organization.id;
  const task = await getStoredTaskDefinition(db, organizationId, id);
  if (!task) return { ok: false, error: TASK_NOT_FOUND };
  const referrers = await findTaskReferrers(db, organizationId, id);
  if (!hasNoReferrers(referrers)) {
    return {
      ok: false,
      error: `${task.name} can't be deleted while it's used by ${referrerNames(referrers).join(", ")}.`,
    };
  }
  const activeJobs = await countActiveTaskJobs(db, organizationId, id);
  if (activeJobs > 0) {
    return {
      ok: false,
      error: `${task.name} can't be deleted while ${activeJobs === 1 ? "a run of it is" : `${activeJobs} runs of it are`} queued or running.`,
    };
  }
  if (!(await deleteTaskDefinitionRow(db, organizationId, id))) {
    return { ok: false, error: TASK_NOT_FOUND };
  }
  return { ok: true };
}
