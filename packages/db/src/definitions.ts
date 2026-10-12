/**
 * An organization's own agent and task definitions. Rows store the
 * definition as jsonb; the control panel validates it against the
 * `@omniralph/tasks` schemas when it resolves one. Every helper is scoped to
 * one organization: a row of another organization is never read or written.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { agentDefinitions, taskDefinitions } from "./schema.js";

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
