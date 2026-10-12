"use server";

import { randomUUID } from "node:crypto";
import {
  deleteAgentDefinition as deleteAgentDefinitionRow,
  getStoredAgentDefinition,
  insertAgentDefinition,
  listStoredTaskDefinitions,
  updateAgentDefinition as updateAgentDefinitionRow,
} from "@omniralph/db";
import {
  HARNESS_TOOLS_BY_TASK_TYPE,
  isBuiltinId,
  validateAgentDefinition,
  type AgentDefinition,
  type AgentDefinitionInput,
} from "@omniralph/tasks";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getAgentDefinition, listTaskDefinitions } from "@/lib/definitions";

/** What the agent form submits: a definition without its ID (the row's). */
export type AgentDefinitionFields = Omit<AgentDefinitionInput, "id">;

/** A created or cloned agent's ID, for navigating to it. */
export type SavedAgentResult = ActionResult | { ok: true; id: string };

const MAX_NAME_LENGTH = 200;
const INVALID: ActionResult = { ok: false, error: "Fix the highlighted fields." };
const BUILTIN_READ_ONLY = "Built-in agents can't be changed; clone one to make your own.";
const NOT_FOUND = "That agent doesn't exist.";

/** What a row stores: the definition without the ID and name its columns hold. */
function storedDefinition(agent: AgentDefinition): Record<string, unknown> {
  const { id: _id, name: _name, ...definition } = agent;
  return definition;
}

function revalidateAgents() {
  revalidatePath("/settings/agents", "layout");
}

/** Comma-joined names, for error messages. */
function names(list: readonly string[]): string {
  return list.join(", ");
}

/**
 * Creates one of the admin's organization's agents after validating it
 * (`validateAgentDefinition`); returns its new ID.
 */
export async function createAgentDefinition(
  input: AgentDefinitionFields,
): Promise<SavedAgentResult> {
  return runAdminAction<SavedAgentResult>(async (admin) => {
    const id = randomUUID();
    const validation = validateAgentDefinition({ ...input, id });
    if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
    const agent = validation.definition;
    await insertAgentDefinition(getDb(), admin.organization.id, {
      id,
      name: agent.name,
      definition: storedDefinition(agent),
      createdBy: admin.id,
    });
    revalidateAgents();
    return { ok: true, id };
  });
}

/**
 * Replaces one of the organization's agents. Refused for built-ins, for
 * definitions that don't validate, and for changes that would no longer suit a
 * task running on the agent (a task type it drops, a harness tool the task's
 * type doesn't allow); the error names each such task.
 */
export async function updateAgentDefinition(
  id: string,
  input: AgentDefinitionFields,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (isBuiltinId(id)) return { ok: false, error: BUILTIN_READ_ONLY };
    const db = getDb();
    const organizationId = admin.organization.id;
    if (!(await getStoredAgentDefinition(db, organizationId, id))) {
      return { ok: false, error: NOT_FOUND };
    }
    const validation = validateAgentDefinition({ ...input, id });
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
    if (!row) return { ok: false, error: NOT_FOUND };
    revalidateAgents();
  });
}

/**
 * Copies an agent (a built-in or one of the organization's) into a new row of
 * the organization, named as a copy; returns the new ID.
 */
export async function cloneAgentDefinition(id: string): Promise<SavedAgentResult> {
  return runAdminAction<SavedAgentResult>(async (admin) => {
    const source = await getAgentDefinition(getDb(), admin.organization.id, id);
    if (!source) return { ok: false, error: NOT_FOUND };
    const suffix = " (copy)";
    const name = `${source.definition.name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    const cloneId = randomUUID();
    await insertAgentDefinition(getDb(), admin.organization.id, {
      id: cloneId,
      name,
      definition: storedDefinition(source.definition),
      createdBy: admin.id,
    });
    revalidateAgents();
    return { ok: true, id: cloneId };
  });
}

/**
 * Deletes one of the organization's agents. Refused for built-ins and while
 * any of the organization's tasks runs on it (the error lists them).
 */
export async function deleteAgentDefinition(id: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (isBuiltinId(id)) return { ok: false, error: BUILTIN_READ_ONLY };
    const db = getDb();
    const organizationId = admin.organization.id;
    const agent = await getStoredAgentDefinition(db, organizationId, id);
    if (!agent) return { ok: false, error: NOT_FOUND };
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
      return { ok: false, error: NOT_FOUND };
    }
    revalidateAgents();
  });
}
