import {
  AgentDefinition,
  PoolNameSchema,
  SinkKindSchema,
  TaskDefinition,
  TaskRequirements,
  TaskTypeSchema,
} from "@omniralph/tasks";
import { z } from "zod";
import type { TaskReferrers } from "@/lib/definitions/referrers";
import type { HarnessChoices } from "@/lib/harnesses/editor-choices";

/**
 * Settings › Agents and Settings › Tasks (`/api/ui/agents/**`, `/api/ui/tasks/**`). IDs are
 * `builtin:<name>` or UUIDs; paths carry them URI-encoded (`definitionPath`).
 */

/** The API path of a definition (`builtin:` IDs have a colon). */
export function definitionPath(kind: "agents" | "tasks", id: string, ...rest: string[]): string {
  return [`/api/ui/${kind}/${encodeURIComponent(id)}`, ...rest].join("/");
}

/** The route segment as an ID (links encode the colon of `builtin:` IDs); malformed escapes match nothing. */
export function decodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** What the agent, task and profile editors pick models and installables from. */
export const harnessChoicesSchema = z.object({
  models: z.array(
    z.object({ value: z.string(), displayName: z.string(), harnessIds: z.array(z.string()) }),
  ),
  installables: z.array(
    z.object({
      name: z.string(),
      harnessIds: z.array(z.string()),
      mcpServers: z.array(z.string()),
    }),
  ),
  harnessCount: z.number(),
}) satisfies z.ZodType<HarnessChoices>;

/** A created or cloned definition, to navigate to. */
export const savedDefinitionSchema = z.object({ ok: z.literal(true), id: z.string() });
export type SavedDefinition = z.infer<typeof savedDefinitionSchema>;

/** One row of the agents list. */
export const agentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  taskTypes: z.array(TaskTypeSchema),
  model: z.string().nullable(),
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

/** `GET /api/ui/agents`: built-ins first, then the organization's own by name. */
export const agentListSchema = z.object({ agents: z.array(agentSummarySchema) });
export type AgentList = z.infer<typeof agentListSchema>;

/** A task running on an agent. */
export const agentTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  taskType: TaskTypeSchema,
  builtin: z.boolean(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

/** `GET /api/ui/agents/{id}`: the agent and the tasks running on it. */
export const agentDetailSchema = z.object({
  agent: AgentDefinition,
  builtin: z.boolean(),
  tasks: z.array(agentTaskSchema),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

/** One row of the tasks list. */
export const taskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  builtin: z.boolean(),
  taskType: TaskTypeSchema,
  agentId: z.string(),
  /** Null when the agent doesn't resolve. */
  agentName: z.string().nullable(),
  triggers: z.array(z.string()),
  sink: SinkKindSchema,
  pool: PoolNameSchema,
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

/** `GET /api/ui/tasks`: built-ins first, then the organization's own by name. */
export const taskListSchema = z.object({ tasks: z.array(taskSummarySchema) });
export type TaskList = z.infer<typeof taskListSchema>;

const taskReferrersSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.string(),
      fullPath: z.string(),
      reviewTask: z.boolean(),
      correlationTask: z.boolean(),
      storyTask: z.boolean(),
      requestTask: z.boolean(),
    }),
  ),
  chatTasks: z.array(z.enum(["askAboutCode", "startWork"])),
  chatChannels: z.array(
    z.object({
      connectionId: z.string(),
      connectionName: z.string(),
      channelId: z.string(),
      askAboutCode: z.boolean(),
      startWork: z.boolean(),
    }),
  ),
  codingTasks: z.array(z.object({ id: z.string(), name: z.string(), builtin: z.boolean() })),
}) satisfies z.ZodType<TaskReferrers>;

/** `GET /api/ui/tasks/{id}`: the task, what its runs need and what uses it. */
export const taskDetailSchema = z.object({
  task: TaskDefinition,
  builtin: z.boolean(),
  /** Null when the agent doesn't resolve. */
  agentName: z.string().nullable(),
  /** Null when the task has no PR description task or it doesn't resolve. */
  prDescriptionTaskName: z.string().nullable(),
  requirements: TaskRequirements,
  referrers: taskReferrersSchema,
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/** `GET /api/ui/tasks/form-options` (admins): what the task form picks from. */
export const taskFormOptionsSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      taskTypes: z.array(TaskTypeSchema),
      builtin: z.boolean(),
    }),
  ),
  sinks: z.array(z.object({ kind: SinkKindSchema, taskType: TaskTypeSchema })),
  pools: z.array(PoolNameSchema),
  prDescriptionTasks: z.array(z.object({ id: z.string(), name: z.string(), builtin: z.boolean() })),
  choices: harnessChoicesSchema,
  hostTools: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
});
export type TaskFormOptions = z.infer<typeof taskFormOptionsSchema>;
