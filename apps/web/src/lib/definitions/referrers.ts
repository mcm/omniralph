import {
  getChatTaskDefaults,
  listChatChannelTaskReferences,
  listRepositoryTaskReferences,
  listStoredTaskDefinitions,
  type ChatChannelTaskReference,
  type ChatTasks,
  type Database,
  type RepositoryTaskReference,
} from "@omniralph/db";
import { listTaskDefinitions } from "./index";

/** A coding task naming the task as its PR description task. */
export interface CodingTaskReference {
  id: string;
  name: string;
  builtin: boolean;
}

/** What runs a task: settings and other definitions of the organization naming it. */
export interface TaskReferrers {
  /** Repositories with it among their review tasks or as their correlation, story or request task. */
  repositories: RepositoryTaskReference[];
  /** The organization's chat tasks (`chat.tasks`, or the built-in defaults) it is. */
  chatTasks: (keyof ChatTasks)[];
  /** Chat channel overrides (`chat_channel_task_settings`) running it. */
  chatChannels: ChatChannelTaskReference[];
  /** Coding tasks with it as their PR description task. */
  codingTasks: CodingTaskReference[];
}

/** Whether nothing uses the task. */
export function hasNoReferrers(referrers: TaskReferrers): boolean {
  return (
    referrers.repositories.length === 0 &&
    referrers.chatTasks.length === 0 &&
    referrers.chatChannels.length === 0 &&
    referrers.codingTasks.length === 0
  );
}

/**
 * What uses task `taskId` in the organization: repository settings, chat task
 * settings and coding tasks naming it as their PR description task. Stored
 * coding tasks that no longer resolve still count when their raw definition
 * names it, so deleting it can't leave them pointing nowhere.
 */
export async function findTaskReferrers(
  db: Database,
  organizationId: string,
  taskId: string,
): Promise<TaskReferrers> {
  const [repositories, chatDefaults, chatChannels, codingTasks, storedRows] = await Promise.all([
    listRepositoryTaskReferences(db, organizationId, taskId),
    getChatTaskDefaults(db, organizationId),
    listChatChannelTaskReferences(db, organizationId, taskId),
    listTaskDefinitions(db, organizationId, { taskType: "coding" }),
    listStoredTaskDefinitions(db, organizationId),
  ]);

  const coding = new Map<string, CodingTaskReference>();
  for (const { definition, builtin } of codingTasks) {
    if (definition.prDescriptionTaskId !== taskId) continue;
    coding.set(definition.id, { id: definition.id, name: definition.name, builtin });
  }
  for (const row of storedRows) {
    if (coding.has(row.id) || row.definition.prDescriptionTaskId !== taskId) continue;
    coding.set(row.id, { id: row.id, name: row.name, builtin: false });
  }

  return {
    repositories,
    chatTasks: (Object.keys(chatDefaults) as (keyof ChatTasks)[]).filter(
      (role) => chatDefaults[role] === taskId,
    ),
    chatChannels,
    codingTasks: [...coding.values()],
  };
}
