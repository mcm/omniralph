"use server";

import { randomUUID } from "node:crypto";
import {
  countActiveTaskJobs,
  deleteTaskDefinition as deleteTaskDefinitionRow,
  getStoredTaskDefinition,
  insertTaskDefinition,
  updateTaskDefinition as updateTaskDefinitionRow,
} from "@omniralph/db";
import { isBuiltinId, type TaskDefinition, type TaskDefinitionInput } from "@omniralph/tasks";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getTaskDefinition } from "@/lib/definitions";
import { findTaskReferrers, hasNoReferrers, type TaskReferrers } from "@/lib/definitions/referrers";
import { validateOrganizationTask } from "@/lib/definitions/validation";
import { repositoryTaskRoles } from "./repository-roles";

/** What the task form submits: a definition without its ID (the row's). */
export type TaskDefinitionFields = Omit<TaskDefinitionInput, "id">;

/** A created or cloned task's ID, for navigating to it. */
export type SavedTaskResult = ActionResult | { ok: true; id: string };

const MAX_NAME_LENGTH = 200;
const INVALID: ActionResult = { ok: false, error: "Fix the highlighted fields." };
const BUILTIN_READ_ONLY = "Built-in tasks can't be changed; clone one to make your own.";
const NOT_FOUND = "That task doesn't exist.";

const CHAT_TASK_NAMES: Record<TaskReferrers["chatTasks"][number], string> = {
  askAboutCode: "ask about code",
  startWork: "start work",
};

/** What a row stores: the definition without the ID and name its columns hold. */
function storedDefinition(task: TaskDefinition): Record<string, unknown> {
  const { id: _id, name: _name, ...definition } = task;
  return definition;
}

function revalidateTasks() {
  revalidatePath("/settings/tasks", "layout");
}

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

/**
 * Creates one of the admin's organization's tasks after validating it against
 * the organization's agents and tasks and the real sinks; stores the
 * requirements its runs need with it. Returns its new ID.
 */
export async function createTaskDefinition(input: TaskDefinitionFields): Promise<SavedTaskResult> {
  return runAdminAction<SavedTaskResult>(async (admin) => {
    const db = getDb();
    const organizationId = admin.organization.id;
    const id = randomUUID();
    const validation = await validateOrganizationTask(db, organizationId, { ...input, id });
    if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
    const task = validation.definition;
    await insertTaskDefinition(db, organizationId, {
      id,
      name: task.name,
      definition: storedDefinition(task),
      requirements: validation.requirements,
      createdBy: admin.id,
    });
    revalidateTasks();
    return { ok: true, id };
  });
}

/**
 * Replaces one of the organization's tasks and its requirements. Refused for
 * built-ins, for definitions that don't validate, and for a change of task
 * type while settings or definitions use the task (the error names them).
 */
export async function updateTaskDefinition(
  id: string,
  input: TaskDefinitionFields,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (isBuiltinId(id)) return { ok: false, error: BUILTIN_READ_ONLY };
    const db = getDb();
    const organizationId = admin.organization.id;
    const current = await getStoredTaskDefinition(db, organizationId, id);
    if (!current) return { ok: false, error: NOT_FOUND };
    const validation = await validateOrganizationTask(db, organizationId, { ...input, id });
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
    if (!row) return { ok: false, error: NOT_FOUND };
    revalidateTasks();
  });
}

/**
 * Copies a task (a built-in or one of the organization's) into a new row of
 * the organization, named as a copy, on the same agent; its requirements are
 * derived again. Returns the new ID.
 */
export async function cloneTaskDefinition(id: string): Promise<SavedTaskResult> {
  return runAdminAction<SavedTaskResult>(async (admin) => {
    const db = getDb();
    const organizationId = admin.organization.id;
    const source = await getTaskDefinition(db, organizationId, id);
    if (!source) return { ok: false, error: NOT_FOUND };
    const suffix = " (copy)";
    const name = `${source.definition.name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
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
    revalidateTasks();
    return { ok: true, id: cloneId };
  });
}

/**
 * Deletes one of the organization's tasks. Refused for built-ins, while
 * repository or chat settings or coding tasks use it (the error names each),
 * and while one of its jobs is queued or running.
 */
export async function deleteTaskDefinition(id: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (isBuiltinId(id)) return { ok: false, error: BUILTIN_READ_ONLY };
    const db = getDb();
    const organizationId = admin.organization.id;
    const task = await getStoredTaskDefinition(db, organizationId, id);
    if (!task) return { ok: false, error: NOT_FOUND };
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
      return { ok: false, error: NOT_FOUND };
    }
    revalidateTasks();
  });
}
