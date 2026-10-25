/**
 * Settings change history (`settings_changes`): who changed a tracked settings section,
 * when, and which fields, written in the save's own transaction. Nothing here knows a
 * section: each save path passes its section's field map (labels, which fields are
 * secret) and the display values before and after (`recordSettingsChange`,
 * `withSettingsChanges`). A recorded entry publishes a `settings` change event with its
 * section and subject on the organization's channel once the save commits.
 */
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { runIndexSql, type RunKind, type RunOrigin } from "./run-index.js";
import { settingsChanges, type SettingsDisplayValue, type SettingsFieldChange } from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What a secret field (a token, a webhook secret) records instead of its values. */
export const SECRET_CHANGED = "changed";

/** A tracked field of a section: its label, and whether its values are secret. */
export interface SettingsField {
  label: string;
  secret?: boolean;
}

/** A section's tracked fields by key, in display order. */
export type SettingsFields = Record<string, SettingsField>;

/** A section's display values by field key; null (the whole map) when the subject doesn't exist. */
export type SettingsValues = Record<string, SettingsDisplayValue>;

/** Who saved: the user (null once deleted) and their name as shown then. */
export interface SettingsActor {
  userId: string | null;
  name: string;
}

export interface SettingsChangeInput {
  organizationId: string;
  section: string;
  /** The section's subject (a repository, a connection); null for organization-wide sections. */
  subjectId?: string | null;
  actor: SettingsActor;
  fields: SettingsFields;
  before: SettingsValues | null;
  after: SettingsValues | null;
}

export interface SettingsChange {
  id: string;
  organizationId: string;
  section: string;
  subjectId: string | null;
  actor: SettingsActor;
  changedAt: Date;
  changes: SettingsFieldChange[];
}

/** Lists are compared as sets of entries in order; everything else by value. */
function same(a: SettingsDisplayValue, b: SettingsDisplayValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The fields of `fields` whose values differ between `before` and `after` (a missing map or
 * key reads as null), in the map's order. Secret fields read `"changed"` on both sides.
 */
export function diffSettings(
  fields: SettingsFields,
  before: SettingsValues | null,
  after: SettingsValues | null,
): SettingsFieldChange[] {
  const changes: SettingsFieldChange[] = [];
  for (const [field, { label, secret }] of Object.entries(fields)) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (same(from, to)) continue;
    changes.push(
      secret
        ? { field, label, before: SECRET_CHANGED, after: SECRET_CHANGED }
        : { field, label, before: from, after: to },
    );
  }
  return changes;
}

/**
 * Records a save of a settings section on `db` (the save's transaction): one entry with the
 * fields that changed, or nothing (null) when none did. Publishes a `settings` change with
 * the section and subject after the transaction commits.
 */
export async function recordSettingsChange(
  db: Queryable,
  input: SettingsChangeInput,
): Promise<SettingsChange | null> {
  const changes = diffSettings(input.fields, input.before, input.after);
  if (changes.length === 0) return null;
  const subjectId = input.subjectId ?? null;
  const [row] = await db
    .insert(settingsChanges)
    .values({
      organizationId: input.organizationId,
      section: input.section,
      subjectId,
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      changes,
    })
    .returning();
  recordChange(db, {
    resource: "settings",
    section: input.section,
    subjectId,
    ids: [subjectId ?? input.organizationId],
    organizationId: input.organizationId,
  });
  return toChange(row!);
}

/** One section a save may change: its subject, field map and how to read its display values. */
export interface TrackedSettings {
  organizationId: string;
  section: string;
  subjectId?: string | null;
  /** The field map; a function for maps keyed by the values (one field per rule, per member). */
  fields:
    | SettingsFields
    | ((before: SettingsValues | null, after: SettingsValues | null) => SettingsFields);
  /** The section's display values as `db` sees them; null when the subject doesn't exist. */
  read: (db: Database) => Promise<SettingsValues | null>;
}

/**
 * Runs `save` in a transaction that records what it changed: each tracked section is read
 * before and after it on the same transaction, and `recordSettingsChange` records the
 * difference. A save that fails without writing records nothing; one that throws rolls back
 * with its entries. `save` gets the transaction typed as the client, so the existing write
 * functions take it as they are (a nested `transaction` becomes a savepoint).
 */
export async function withSettingsChanges<T>(
  db: Database,
  actor: SettingsActor,
  tracked: TrackedSettings | readonly TrackedSettings[],
  save: (tx: Database) => Promise<T>,
): Promise<T> {
  const sections = [tracked].flat();
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const before = await Promise.all(sections.map((s) => s.read(tx)));
    const result = await save(tx);
    for (const [index, section] of sections.entries()) {
      const after = await section.read(tx);
      const previous = before[index] ?? null;
      const fields =
        typeof section.fields === "function" ? section.fields(previous, after) : section.fields;
      await recordSettingsChange(tx, {
        organizationId: section.organizationId,
        section: section.section,
        subjectId: section.subjectId ?? null,
        actor,
        fields,
        before: previous,
        after,
      });
    }
    return result;
  });
}

function toChange(row: typeof settingsChanges.$inferSelect): SettingsChange {
  return {
    id: row.id,
    organizationId: row.organizationId,
    section: row.section,
    subjectId: row.subjectId,
    actor: { userId: row.actorUserId, name: row.actorName },
    changedAt: row.changedAt,
    changes: row.changes,
  };
}

/** The position after which a page starts: the last entry of the previous page. */
export interface SettingsChangeCursor {
  /** `changed_at` of the last entry, to the microsecond (UTC ISO). */
  changedAt: string;
  id: string;
}

export interface SettingsChangeFilter {
  organizationIds: readonly string[];
  section: string;
  /** The subject; null or absent for organization-wide sections. */
  subjectId?: string | null;
  cursor?: SettingsChangeCursor | null;
  /** Default 20. */
  limit?: number;
}

export interface SettingsChangePage {
  entries: (SettingsChange & { cursor: SettingsChangeCursor })[];
  next: SettingsChangeCursor | null;
}

/** A section's (and subject's) history, newest first (`changed_at`, then `id`). */
export async function listSettingsChanges(
  db: Queryable,
  filter: SettingsChangeFilter,
): Promise<SettingsChangePage> {
  if (filter.organizationIds.length === 0) return { entries: [], next: null };
  const limit = Math.max(1, Math.floor(filter.limit ?? 20));
  const conditions: SQL[] = [
    inArray(settingsChanges.organizationId, [...filter.organizationIds]),
    eq(settingsChanges.section, filter.section),
    filter.subjectId
      ? eq(settingsChanges.subjectId, filter.subjectId)
      : isNull(settingsChanges.subjectId),
  ];
  if (filter.cursor) {
    conditions.push(
      or(
        lt(settingsChanges.changedAt, sql`${filter.cursor.changedAt}::timestamptz`),
        and(
          eq(settingsChanges.changedAt, sql`${filter.cursor.changedAt}::timestamptz`),
          lt(settingsChanges.id, filter.cursor.id),
        ),
      )!,
    );
  }
  const rows = await db
    .select({
      row: settingsChanges,
      changedAtKey: sql<string>`to_char(${settingsChanges.changedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(settingsChanges)
    .where(and(...conditions))
    .orderBy(desc(settingsChanges.changedAt), desc(settingsChanges.id))
    .limit(limit + 1);
  const entries = rows.slice(0, limit).map(({ row, changedAtKey }) => ({
    ...toChange(row),
    cursor: { changedAt: changedAtKey, id: row.id },
  }));
  const last = entries.at(-1);
  return { entries, next: rows.length > limit && last ? last.cursor : null };
}

/** Which runs count as "since" a change of a section: by kind, origin and subject. */
export interface RunsSinceScope {
  kinds?: readonly RunKind[];
  origins?: readonly RunOrigin[];
  /** Only runs in this repository. */
  repositoryId?: string;
  /** Only runs whose trigger came through this connection (code host, tracker or chat). */
  connectionId?: string;
}

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** Origins of runs a tracker integration (Linear) triggers. */
const TRACKER_ORIGINS: readonly RunOrigin[] = [
  "linear",
  "linear_mention",
  "triage_label",
  "triage_mention",
];

/**
 * Runs whose trigger came through connection `id`: review runs of a code-host connection's
 * repositories, Linear-triggered runs of an integration's organization, and the asks and
 * coding runs of a chat connection's threads. Connection IDs are UUIDs of three tables, so
 * at most one branch matches.
 */
function throughConnection(id: string): SQL {
  return sql`(
    (runs.kind = 'review' and runs.repository_id in (
      select r.id from repositories r where r.connection_id = ${id}::uuid))
    or (runs.origin in (${list(TRACKER_ORIGINS)}) and exists (
      select 1 from integrations i
      where i.id = ${id}::uuid and i.organization_id = runs.organization_id))
    or runs.id in (
      select c.id from chat_thread_runs c
        join chat_threads t on t.id = c.chat_thread_id where t.connection_id = ${id}::uuid
      union all
      select rr.id from ralph_runs rr
        join chat_threads t on t.id = rr.chat_thread_id where t.connection_id = ${id}::uuid))`;
}

/** How many runs of `organizationId` in `scope` started after `since`. */
export async function countRunsSince(
  db: Queryable,
  organizationId: string,
  since: Date,
  scope: RunsSinceScope,
): Promise<number> {
  const conditions: SQL[] = [
    sql`runs.organization_id = ${organizationId}::uuid`,
    sql`runs.created_at > ${since.toISOString()}::timestamptz`,
  ];
  if (scope.kinds?.length) conditions.push(sql`runs.kind in (${list(scope.kinds)})`);
  if (scope.origins?.length) conditions.push(sql`runs.origin in (${list(scope.origins)})`);
  if (scope.repositoryId) conditions.push(sql`runs.repository_id = ${scope.repositoryId}::uuid`);
  if (scope.connectionId) conditions.push(throughConnection(scope.connectionId));
  const result = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from (${runIndexSql()}) runs
    where ${sql.join(conditions, sql` and `)}`);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * A digest of the stored (encrypted) credentials of tracker integration or chat connection
 * `id`, or null (none stored): tells whether a save changed them without keeping them.
 */
export async function storedCredentialsDigest(db: Queryable, id: string): Promise<string | null> {
  const result = await db.execute<{ digest: string | null }>(sql`
    select encode(sha256(convert_to(credentials, 'UTF8')), 'hex') as digest from (
      select encrypted_credentials as credentials from integrations where id = ${id}::uuid
      union all
      select encrypted_credentials from chat_connections where id = ${id}::uuid
    ) stored limit 1`);
  return result.rows[0]?.digest ?? null;
}
