/**
 * An organization's own playbooks. Rows store the playbook (all but its ID,
 * name and role) as jsonb; the control panel validates it against the
 * `@omniralph/tasks` schema when it resolves one. Every helper is scoped to one
 * organization: a row of another organization is never read or written.
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import {
  chatChannelTaskSettings,
  chatConnections,
  jobs,
  playbooks,
  repositories,
} from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export type StoredPlaybook = typeof playbooks.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` can be a stored playbook's ID (built-in `builtin:<name>` IDs can't). */
function isStoredId(id: string): boolean {
  return UUID.test(id);
}

/** Records a saved or deleted playbook (the `playbooks` settings section, the playbook its subject). */
function recordPlaybookChange(db: Queryable, organizationId: string, id: string) {
  recordChange(db, {
    resource: "settings",
    section: "playbooks",
    ids: [id],
    subjectId: id,
    organizationId,
  });
}

export interface NewPlaybookInput {
  /** Defaults to a random UUID. */
  id?: string;
  name: string;
  role: string;
  definition: Record<string, unknown>;
  /** The run requirements derived from the playbook. */
  requirements: Record<string, unknown>;
  /** User who saved it (also its first `updatedBy`). */
  createdBy: string | null;
}

export interface PlaybookUpdate {
  name: string;
  role: string;
  definition: Record<string, unknown>;
  requirements: Record<string, unknown>;
  updatedBy: string | null;
}

export async function insertPlaybook(
  db: Queryable,
  organizationId: string,
  input: NewPlaybookInput,
): Promise<StoredPlaybook> {
  const [row] = await db
    .insert(playbooks)
    .values({
      ...(input.id && { id: input.id }),
      organizationId,
      name: input.name,
      role: input.role,
      definition: input.definition,
      requirements: input.requirements,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  recordPlaybookChange(db, organizationId, row!.id);
  return row!;
}

/** Replaces a playbook and its requirements. Null when the organization has no such playbook. */
export async function updatePlaybook(
  db: Queryable,
  organizationId: string,
  id: string,
  input: PlaybookUpdate,
): Promise<StoredPlaybook | null> {
  if (!isStoredId(id)) return null;
  const [row] = await db
    .update(playbooks)
    .set({
      name: input.name,
      role: input.role,
      definition: input.definition,
      requirements: input.requirements,
      updatedBy: input.updatedBy,
    })
    .where(and(eq(playbooks.organizationId, organizationId), eq(playbooks.id, id)))
    .returning();
  if (row) recordPlaybookChange(db, organizationId, id);
  return row ?? null;
}

/** The organization's playbook `id`, or null. */
export async function getStoredPlaybook(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<StoredPlaybook | null> {
  if (!isStoredId(id)) return null;
  const [row] = await db
    .select()
    .from(playbooks)
    .where(and(eq(playbooks.organizationId, organizationId), eq(playbooks.id, id)));
  return row ?? null;
}

/** The organization's playbooks, by name. */
export async function listStoredPlaybooks(
  db: Queryable,
  organizationId: string,
): Promise<StoredPlaybook[]> {
  return db
    .select()
    .from(playbooks)
    .where(eq(playbooks.organizationId, organizationId))
    .orderBy(asc(playbooks.name), asc(playbooks.createdAt));
}

/** Deletes a playbook. False when the organization has no such playbook. */
export async function deletePlaybook(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<boolean> {
  if (!isStoredId(id)) return false;
  const rows = await db
    .delete(playbooks)
    .where(and(eq(playbooks.organizationId, organizationId), eq(playbooks.id, id)))
    .returning({ id: playbooks.id });
  if (rows.length === 0) return false;
  recordPlaybookChange(db, organizationId, id);
  return true;
}

/** A repository of the organization and the playbooks its roles are bound to. */
export interface RepositoryPlaybookBindings {
  id: string;
  fullPath: string;
  /** Its code host. */
  provider: "github" | "gitlab";
  reviewPlaybookIds: string[];
  correlationPlaybookId: string;
  storyPlaybookId: string;
  requestPlaybookId: string;
}

/** Every repository of the organization (disconnected ones too) with its playbook bindings, by path. */
export async function listRepositoryPlaybookBindings(
  db: Queryable,
  organizationId: string,
): Promise<RepositoryPlaybookBindings[]> {
  return db
    .select({
      id: repositories.id,
      fullPath: repositories.fullPath,
      provider: repositories.provider,
      reviewPlaybookIds: repositories.reviewPlaybookIds,
      correlationPlaybookId: repositories.correlationPlaybookId,
      storyPlaybookId: repositories.storyPlaybookId,
      requestPlaybookId: repositories.requestPlaybookId,
    })
    .from(repositories)
    .where(eq(repositories.organizationId, organizationId))
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
}

/** A chat channel override (`chat_channel_task_settings`) of the organization and its playbooks. */
export interface ChatChannelPlaybookBindings {
  connectionId: string;
  connectionName: string;
  channelId: string;
  /** The channel's "ask about code" playbook; null follows the organization's. */
  askPlaybookId: string | null;
  /** The channel's "start work" playbook; null follows the organization's. */
  startWorkPlaybookId: string | null;
}

/** The organization's chat channel overrides, by connection name then channel. */
export async function listChatChannelPlaybookBindings(
  db: Queryable,
  organizationId: string,
): Promise<ChatChannelPlaybookBindings[]> {
  return db
    .select({
      connectionId: chatChannelTaskSettings.connectionId,
      connectionName: chatConnections.name,
      channelId: chatChannelTaskSettings.channelId,
      askPlaybookId: chatChannelTaskSettings.askPlaybookId,
      startWorkPlaybookId: chatChannelTaskSettings.startWorkPlaybookId,
    })
    .from(chatChannelTaskSettings)
    .innerJoin(chatConnections, eq(chatConnections.id, chatChannelTaskSettings.connectionId))
    .where(eq(chatChannelTaskSettings.organizationId, organizationId))
    .orderBy(asc(chatConnections.name), asc(chatChannelTaskSettings.channelId));
}

/** How many of the organization's jobs running playbook `playbookId` are queued or running. */
export async function countActivePlaybookJobs(
  db: Queryable,
  organizationId: string,
  playbookId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.taskId, playbookId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    );
  return row?.count ?? 0;
}
