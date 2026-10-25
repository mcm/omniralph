import "server-only";
import {
  getChatChannelTaskSetting,
  getChatTaskDefaults,
  type ChatConnection,
  type ChatTasks,
  type Database,
} from "@omniralph/db";
import type { TaskDefinition, TaskType } from "@omniralph/tasks";
import type { PlaybookFilter } from "@/lib/playbooks";

/**
 * The tasks chat runs: "ask about code" (`askAboutCode`, a query task) and
 * "start work" (`startWork`, a coding task), each accepting the `chat.request`
 * trigger. An organization chooses them (`chat.tasks` in `app_settings`) and a
 * channel of one of its chat connections can override either
 * (`chat_channel_task_settings`); unchosen, they're the built-in
 * `builtin:ask-about-code` and `builtin:handle-request`.
 */

export type ChatTaskRole = keyof ChatTasks;

export const CHAT_TASK_ROLES: readonly ChatTaskRole[] = ["askAboutCode", "startWork"];

/** The task type each chat task must have. */
export const CHAT_TASK_TYPES: Record<ChatTaskRole, TaskType> = {
  askAboutCode: "query",
  startWork: "coding",
};

/**
 * What each chat task's pickers offer (`listPlaybookChoices`): the organization's
 * playbooks, built-in or its own, of the role's type accepting `chat.request`.
 */
export const CHAT_TASK_FILTERS: Record<ChatTaskRole, PlaybookFilter> = {
  askAboutCode: { taskType: CHAT_TASK_TYPES.askAboutCode, trigger: "chat.request" },
  startWork: { taskType: CHAT_TASK_TYPES.startWork, trigger: "chat.request" },
};

export const CHAT_TASK_LABELS: Record<ChatTaskRole, string> = {
  askAboutCode: "Ask about code",
  startWork: "Start work",
};

/** Looks a task definition up by ID (e.g. `organizationPlaybooks(…).getTask`). */
export type TaskLookup = (id: string) => TaskDefinition | null | Promise<TaskDefinition | null>;

export type ChatTaskChoiceResult =
  | { ok: true; task: TaskDefinition }
  | { ok: false; reason: "unknown_task" | "wrong_type" | "missing_trigger"; error: string };

/**
 * Whether `taskId` can be the chat task `role` runs: a known task of the
 * role's type (`CHAT_TASK_TYPES`) whose triggers include `chat.request`.
 * `getTask` resolves it, e.g. from the organization's definitions.
 */
export function validateChatTaskChoice(
  role: ChatTaskRole,
  taskId: string,
  getTask: (id: string) => TaskDefinition | null,
): ChatTaskChoiceResult {
  const task = getTask(taskId);
  const label = CHAT_TASK_LABELS[role];
  if (!task) return { ok: false, reason: "unknown_task", error: `There's no task ${taskId}.` };
  const type = CHAT_TASK_TYPES[role];
  if (task.taskType !== type) {
    return {
      ok: false,
      reason: "wrong_type",
      error: `${label} needs a ${type} task; ${task.name} is a ${task.taskType} task.`,
    };
  }
  if (!task.triggers.includes("chat.request")) {
    return {
      ok: false,
      reason: "missing_trigger",
      error: `${task.name} doesn't run on chat requests (the chat.request trigger).`,
    };
  }
  return { ok: true, task };
}

/**
 * The tasks chat runs in a channel of a connection: each from the channel's
 * override when set, else the organization's choice, else the built-in default.
 */
export async function chatTasksFor(
  db: Database,
  connection: Pick<ChatConnection, "id" | "organizationId">,
  channelId: string,
): Promise<ChatTasks> {
  const [defaults, override] = await Promise.all([
    getChatTaskDefaults(db, connection.organizationId),
    getChatChannelTaskSetting(db, connection.organizationId, connection.id, channelId),
  ]);
  return {
    askAboutCode: override?.askAboutCodeTaskId ?? defaults.askAboutCode,
    startWork: override?.startWorkTaskId ?? defaults.startWork,
  };
}

const PLATFORM_CHANNEL_ID: Record<ChatConnection["platform"], RegExp> = {
  slack: /^[CGD][A-Z0-9]{6,40}$/,
  discord: /^\d{1,30}$/,
};

/**
 * The Chat SDK channel ID (`chat_threads.channel_id`) of a channel of a
 * connection, from the ID the platform shows (a Slack channel ID like
 * `C0123ABCD`, or a Discord channel ID): `slack:{channel}` or
 * `discord:{guild}:{channel}`. Null when it isn't one.
 */
export function chatChannelId(
  connection: Pick<ChatConnection, "platform" | "externalId">,
  platformChannelId: string,
): string | null {
  const id = platformChannelId.trim();
  if (!PLATFORM_CHANNEL_ID[connection.platform].test(id)) return null;
  return connection.platform === "slack" ? `slack:${id}` : `discord:${connection.externalId}:${id}`;
}

/** The ID the platform shows for a Chat SDK channel ID (its last part). */
export function platformChannelId(channelId: string): string {
  return channelId.slice(channelId.lastIndexOf(":") + 1);
}
