/**
 * An organization's own agent and task definitions. Rows store the
 * definition as jsonb; the control panel validates it against the
 * `@omniralph/tasks` schemas when it resolves one. Every helper is scoped to
 * one organization: a row of another organization is never read or written.
 */
import { and, arrayContains, asc, count, eq, inArray, or } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  agentDefinitions,
  chatChannelTaskSettings,
  chatConnections,
  jobs,
  repositories,
  taskDefinitions,
} from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export type StoredAgentDefinition = typeof agentDefinitions.$inferSelect;
export type StoredTaskDefinition = typeof taskDefinitions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` can be a stored definition's ID (built-in `builtin:<name>` IDs can't). */
function isStoredId(id: string): boolean {
  return UUID.test(id);
}

export interface NewAgentDefinitionInput {
  /** Defaults to a random UUID. */
  id?: string;
  name: string;
  definition: Record<string, unknown>;
  /** User who saved it (also its first `updatedBy`). */
  createdBy: string | null;
}

export interface AgentDefinitionUpdate {
  name: string;
  definition: Record<string, unknown>;
  updatedBy: string | null;
}

export interface NewTaskDefinitionInput extends NewAgentDefinitionInput {
  /** The run requirements derived from the definition. */
  requirements: Record<string, unknown>;
}

export interface TaskDefinitionUpdate extends AgentDefinitionUpdate {
  requirements: Record<string, unknown>;
}

export async function insertAgentDefinition(
  db: Queryable,
  organizationId: string,
  input: NewAgentDefinitionInput,
): Promise<StoredAgentDefinition> {
  const [row] = await db
    .insert(agentDefinitions)
    .values({
      ...(input.id && { id: input.id }),
      organizationId,
      name: input.name,
      definition: input.definition,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return row!;
}

/** Replaces an agent definition. Null when the organization has no such agent. */
export async function updateAgentDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
  input: AgentDefinitionUpdate,
): Promise<StoredAgentDefinition | null> {
  if (!isStoredId(id)) return null;
  const [row] = await db
    .update(agentDefinitions)
    .set({ name: input.name, definition: input.definition, updatedBy: input.updatedBy })
    .where(and(eq(agentDefinitions.organizationId, organizationId), eq(agentDefinitions.id, id)))
    .returning();
  return row ?? null;
}

/** The organization's agent definition `id`, or null. */
export async function getStoredAgentDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<StoredAgentDefinition | null> {
  if (!isStoredId(id)) return null;
  const [row] = await db
    .select()
    .from(agentDefinitions)
    .where(and(eq(agentDefinitions.organizationId, organizationId), eq(agentDefinitions.id, id)));
  return row ?? null;
}

/** The organization's agent definitions, by name. */
export async function listStoredAgentDefinitions(
  db: Queryable,
  organizationId: string,
): Promise<StoredAgentDefinition[]> {
  return db
    .select()
    .from(agentDefinitions)
    .where(eq(agentDefinitions.organizationId, organizationId))
    .orderBy(asc(agentDefinitions.name), asc(agentDefinitions.createdAt));
}

/** Deletes an agent definition. False when the organization has no such agent. */
export async function deleteAgentDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<boolean> {
  if (!isStoredId(id)) return false;
  const rows = await db
    .delete(agentDefinitions)
    .where(and(eq(agentDefinitions.organizationId, organizationId), eq(agentDefinitions.id, id)))
    .returning({ id: agentDefinitions.id });
  return rows.length > 0;
}

export async function insertTaskDefinition(
  db: Queryable,
  organizationId: string,
  input: NewTaskDefinitionInput,
): Promise<StoredTaskDefinition> {
  const [row] = await db
    .insert(taskDefinitions)
    .values({
      ...(input.id && { id: input.id }),
      organizationId,
      name: input.name,
      definition: input.definition,
      requirements: input.requirements,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return row!;
}

/** Replaces a task definition and its requirements. Null when the organization has no such task. */
export async function updateTaskDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
  input: TaskDefinitionUpdate,
): Promise<StoredTaskDefinition | null> {
  if (!isStoredId(id)) return null;
  const [row] = await db
    .update(taskDefinitions)
    .set({
      name: input.name,
      definition: input.definition,
      requirements: input.requirements,
      updatedBy: input.updatedBy,
    })
    .where(and(eq(taskDefinitions.organizationId, organizationId), eq(taskDefinitions.id, id)))
    .returning();
  return row ?? null;
}

/** The organization's task definition `id`, or null. */
export async function getStoredTaskDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<StoredTaskDefinition | null> {
  if (!isStoredId(id)) return null;
  const [row] = await db
    .select()
    .from(taskDefinitions)
    .where(and(eq(taskDefinitions.organizationId, organizationId), eq(taskDefinitions.id, id)));
  return row ?? null;
}

/** The organization's task definitions, by name. */
export async function listStoredTaskDefinitions(
  db: Queryable,
  organizationId: string,
): Promise<StoredTaskDefinition[]> {
  return db
    .select()
    .from(taskDefinitions)
    .where(eq(taskDefinitions.organizationId, organizationId))
    .orderBy(asc(taskDefinitions.name), asc(taskDefinitions.createdAt));
}

/** Deletes a task definition. False when the organization has no such task. */
export async function deleteTaskDefinition(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<boolean> {
  if (!isStoredId(id)) return false;
  const rows = await db
    .delete(taskDefinitions)
    .where(and(eq(taskDefinitions.organizationId, organizationId), eq(taskDefinitions.id, id)))
    .returning({ id: taskDefinitions.id });
  return rows.length > 0;
}

/** A repository of the organization whose settings name a task. */
export interface RepositoryTaskReference {
  id: string;
  fullPath: string;
  /** The task is one of its review tasks. */
  reviewTask: boolean;
  /** The task is its correlation task. */
  correlationTask: boolean;
  /** The task is its story task (`story_task_id`). */
  storyTask: boolean;
  /** The task is its request task (`request_task_id`). */
  requestTask: boolean;
}

/**
 * The organization's repositories whose review tasks, correlation task, story
 * task or request task include task `taskId`, by path.
 */
export async function listRepositoryTaskReferences(
  db: Queryable,
  organizationId: string,
  taskId: string,
): Promise<RepositoryTaskReference[]> {
  const rows = await db
    .select({
      id: repositories.id,
      fullPath: repositories.fullPath,
      reviewTaskIds: repositories.reviewTaskIds,
      correlationTaskId: repositories.correlationTaskId,
      storyTaskId: repositories.storyTaskId,
      requestTaskId: repositories.requestTaskId,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.organizationId, organizationId),
        or(
          arrayContains(repositories.reviewTaskIds, [taskId]),
          eq(repositories.correlationTaskId, taskId),
          eq(repositories.storyTaskId, taskId),
          eq(repositories.requestTaskId, taskId),
        ),
      ),
    )
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
  return rows.map((row) => ({
    id: row.id,
    fullPath: row.fullPath,
    reviewTask: row.reviewTaskIds.includes(taskId),
    correlationTask: row.correlationTaskId === taskId,
    storyTask: row.storyTaskId === taskId,
    requestTask: row.requestTaskId === taskId,
  }));
}

/** A chat channel override (`chat_channel_task_settings`) of the organization naming a task. */
export interface ChatChannelTaskReference {
  connectionId: string;
  connectionName: string;
  channelId: string;
  /** The task is the channel's "ask about code" task. */
  askAboutCode: boolean;
  /** The task is the channel's "start work" task. */
  startWork: boolean;
}

/** The organization's chat channel overrides that run task `taskId`, by connection then channel. */
export async function listChatChannelTaskReferences(
  db: Queryable,
  organizationId: string,
  taskId: string,
): Promise<ChatChannelTaskReference[]> {
  const rows = await db
    .select({
      connectionId: chatChannelTaskSettings.connectionId,
      connectionName: chatConnections.name,
      channelId: chatChannelTaskSettings.channelId,
      askAboutCodeTaskId: chatChannelTaskSettings.askAboutCodeTaskId,
      startWorkTaskId: chatChannelTaskSettings.startWorkTaskId,
    })
    .from(chatChannelTaskSettings)
    .innerJoin(chatConnections, eq(chatConnections.id, chatChannelTaskSettings.connectionId))
    .where(
      and(
        eq(chatChannelTaskSettings.organizationId, organizationId),
        or(
          eq(chatChannelTaskSettings.askAboutCodeTaskId, taskId),
          eq(chatChannelTaskSettings.startWorkTaskId, taskId),
        ),
      ),
    )
    .orderBy(asc(chatConnections.name), asc(chatChannelTaskSettings.channelId));
  return rows.map((row) => ({
    connectionId: row.connectionId,
    connectionName: row.connectionName,
    channelId: row.channelId,
    askAboutCode: row.askAboutCodeTaskId === taskId,
    startWork: row.startWorkTaskId === taskId,
  }));
}

/** How many of the organization's jobs running task `taskId` are queued or running. */
export async function countActiveTaskJobs(
  db: Queryable,
  organizationId: string,
  taskId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.taskId, taskId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    );
  return row?.count ?? 0;
}
