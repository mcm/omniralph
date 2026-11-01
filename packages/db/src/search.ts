/**
 * Search and jump: finding runs, repos and agents by name or identifier, ranked by how well
 * they match (`tier`: 0 exact, 1 prefix, 2 substring; case-insensitive), then most recently
 * updated; and the items each user last opened from the search palette (`user_recent_items`).
 * The tables are small (hundreds of runs, tens of repos and agents), so the matches are
 * `ILIKE` scans of the organizations' rows.
 */
import { and, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  indexColumns,
  indexEntry,
  runIndexSql,
  type RunIndexEntry,
  type RunIndexRow,
} from "./run-index.js";
import { recentItemKind, userRecentItems } from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** How well a result matches: 0 exact, 1 prefix, 2 substring. */
export type SearchTier = 0 | 1 | 2;

export interface SearchFilter {
  /** Required: the organizations to search (none: no results). */
  organizationIds: readonly string[];
  /** What was typed; matched case-insensitively. */
  query: string;
  /** Most results; default 5. */
  limit?: number;
}

/** `value` with `LIKE`'s wildcards and escape character escaped. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The SQL tier of `column` against the query: 0 equal, 1 starts with it, 2 contains it, else
 * null (no match). Null columns don't match.
 */
function tierOf(column: SQL, query: string): SQL {
  const escaped = escapeLike(query);
  return sql`(case when lower(${column}) = lower(${query}) then 0
    when ${column} ilike ${`${escaped}%`} then 1
    when ${column} ilike ${`%${escaped}%`} then 2 end)`;
}

/** Only a substring tier (2) for a looser field, e.g. a run's repo. */
function containsTier(column: SQL, query: string): SQL {
  return sql`(case when ${column} ilike ${`%${escapeLike(query)}%`} then 2 end)`;
}

/** A PR/MR number the query names (`12`, `#12`, `!12`), else null. */
export function changeNumberOf(query: string): number | null {
  const match = /^[#!]?(\d{1,9})$/.exec(query.trim());
  return match ? Number(match[1]) : null;
}

const limitOf = (filter: SearchFilter) => Math.max(1, Math.min(50, Math.floor(filter.limit ?? 5)));

const idList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/**
 * Each run's searchable text: its work item's identifier and title (or a PR/MR's title, or
 * an ask's question) and its PR/MR number, by run ID.
 */
function runSearchFactsSql(): SQL {
  return sql`
    select r.id, r.tracker_identifier as identifier,
      coalesce(r.tracker_title, (select m.text from ralph_messages m
        where m.run_id = r.id and m.kind = 'request' order by m.created_at, m.id limit 1)) as title,
      l.pr_number
    from ralph_runs r
    left join ralph_lanes l on l.run_id = r.id and l.repository_id = r.repository_id
    union all
    select rr.id, null, (select rv.pr_title from reviews rv
        where rv.review_run_id = rr.id and rv.pr_title is not null
        order by rv.created_at desc limit 1), rr.pr_number
    from review_runs rr
    union all
    select t.id, i.issue ->> 'identifier', i.issue ->> 'title', null
    from triage_runs t
    left join lateral (
      select j.payload -> 'trigger' -> 'context' -> 'issue' as issue from jobs j
      where j.triage_run_id = t.id
        and jsonb_typeof(j.payload -> 'trigger' -> 'context' -> 'issue') = 'object'
      order by j.created_at desc, j.id desc limit 1
    ) i on true
    union all
    select c.id, null, aj.question, null
    from chat_thread_runs c
    left join lateral (
      select j.payload -> 'trigger' -> 'context' ->> 'question' as question from jobs j
      where j.chat_thread_run_id = c.id or j.id = c.job_id
      order by j.created_at desc, j.id desc limit 1
    ) aj on true
    where c.kind = 'query'`;
}

/** A matching run: its index facts and how well it matched. */
export interface RunSearchHit {
  entry: RunIndexEntry;
  tier: SearchTier;
}

/**
 * The runs of the organizations whose work item identifier, title or PR/MR number matches
 * (exact, prefix, substring), or whose repo's path contains the query (substring), best
 * match first, then most recently updated.
 */
export async function searchRuns(db: Queryable, filter: SearchFilter): Promise<RunSearchHit[]> {
  const query = filter.query.trim();
  if (filter.organizationIds.length === 0 || !query) return [];
  const change = changeNumberOf(query);
  const tier = sql`least(
    ${tierOf(sql`f.identifier`, query)},
    ${tierOf(sql`f.title`, query)},
    ${change === null ? sql`null` : sql`(case when f.pr_number = ${change} then 0 end)`},
    ${containsTier(sql`repo.full_path`, query)})`;
  const result = await db.execute<RunIndexRow & { tier: number }>(sql`
    select * from (
      select ${indexColumns}, ${tier} as tier, runs.updated_at as updated_sort
      from (${runIndexSql()}) runs
      join (${runSearchFactsSql()}) f on f.id = runs.id
      left join repositories repo on repo.id = runs.repository_id
      where runs.organization_id in (${idList(filter.organizationIds)})
    ) matched
    where matched.tier is not null
    order by matched.tier, matched.updated_sort desc, matched.id desc
    limit ${limitOf(filter)}`);
  return result.rows.map((row) => ({ entry: indexEntry(row), tier: row.tier as SearchTier }));
}

/** A matching repository. */
export interface RepositorySearchHit {
  id: string;
  organizationId: string;
  provider: "github" | "gitlab";
  fullPath: string;
  updatedAt: Date;
  tier: SearchTier;
}

const REPOSITORY_COLUMNS = sql`r.id, r.organization_id, r.provider, r.full_path, r.updated_at`;

interface RepositoryRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  provider: "github" | "gitlab";
  full_path: string;
  updated_at: string | Date;
}

const repositoryHit = (row: RepositoryRow, tier: SearchTier): RepositorySearchHit => ({
  id: row.id,
  organizationId: row.organization_id,
  provider: row.provider,
  fullPath: row.full_path,
  updatedAt: new Date(row.updated_at),
  tier,
});

/**
 * The connected repositories of the organizations whose name (the path's last segment) or
 * full path matches, best match first, then most recently updated.
 */
export async function searchRepositories(
  db: Queryable,
  filter: SearchFilter,
): Promise<RepositorySearchHit[]> {
  const query = filter.query.trim();
  if (filter.organizationIds.length === 0 || !query) return [];
  const name = sql`regexp_replace(r.full_path, '^.*/', '')`;
  const result = await db.execute<RepositoryRow & { tier: number }>(sql`
    select * from (
      select ${REPOSITORY_COLUMNS},
        least(${tierOf(name, query)}, ${tierOf(sql`r.full_path`, query)}) as tier
      from repositories r
      where r.organization_id in (${idList(filter.organizationIds)}) and r.disconnected_at is null
    ) matched
    where matched.tier is not null
    order by matched.tier, matched.updated_at desc, matched.id
    limit ${limitOf(filter)}`);
  return result.rows.map((row) => repositoryHit(row, row.tier as SearchTier));
}

/** A matching agent. */
export interface AgentSearchHit {
  id: string;
  organizationId: string;
  name: string;
  revoked: boolean;
  /** `agents.live_online`. */
  online: boolean;
  lastHeartbeatAt: Date | null;
  updatedAt: Date;
  tier: SearchTier;
}

interface AgentRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  name: string;
  revoked_at: string | Date | null;
  live_online: boolean;
  last_heartbeat_at: string | Date | null;
  updated_at: string | Date;
}

const AGENT_COLUMNS = sql`a.id, a.organization_id, a.name, a.revoked_at, a.live_online,
  a.last_heartbeat_at, a.updated_at`;

const agentHit = (row: AgentRow, tier: SearchTier): AgentSearchHit => ({
  id: row.id,
  organizationId: row.organization_id,
  name: row.name,
  revoked: row.revoked_at !== null,
  online: row.revoked_at === null && row.live_online,
  lastHeartbeatAt: row.last_heartbeat_at === null ? null : new Date(row.last_heartbeat_at),
  updatedAt: new Date(row.updated_at),
  tier,
});

/** The organizations' agents (not deleted) whose name matches, best match first, then most recently updated. */
export async function searchAgents(db: Queryable, filter: SearchFilter): Promise<AgentSearchHit[]> {
  const query = filter.query.trim();
  if (filter.organizationIds.length === 0 || !query) return [];
  const result = await db.execute<AgentRow & { tier: number }>(sql`
    select * from (
      select ${AGENT_COLUMNS}, ${tierOf(sql`a.name`, query)} as tier
      from agents a
      where a.organization_id in (${idList(filter.organizationIds)}) and a.deleted_at is null
    ) matched
    where matched.tier is not null
    order by matched.tier, matched.updated_at desc, matched.id
    limit ${limitOf(filter)}`);
  return result.rows.map((row) => agentHit(row, row.tier as SearchTier));
}

/** The organizations' connected repositories with these IDs (for recent items), in no particular order. */
export async function getSearchRepositories(
  db: Queryable,
  organizationIds: readonly string[],
  ids: readonly string[],
): Promise<RepositorySearchHit[]> {
  if (organizationIds.length === 0 || ids.length === 0) return [];
  const result = await db.execute<RepositoryRow>(sql`
    select ${REPOSITORY_COLUMNS} from repositories r
    where r.organization_id in (${idList(organizationIds)}) and r.disconnected_at is null
      and r.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
  return result.rows.map((row) => repositoryHit(row, 0));
}

/** The organizations' agents (not deleted) with these IDs (for recent items), in no particular order. */
export async function getSearchAgents(
  db: Queryable,
  organizationIds: readonly string[],
  ids: readonly string[],
): Promise<AgentSearchHit[]> {
  if (organizationIds.length === 0 || ids.length === 0) return [];
  const result = await db.execute<AgentRow>(sql`
    select ${AGENT_COLUMNS} from agents a
    where a.organization_id in (${idList(organizationIds)}) and a.deleted_at is null
      and a.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
  return result.rows.map((row) => agentHit(row, 0));
}

// ── Recently opened ──────────────────────────────────────────────────────────

export type RecentItemKind = (typeof recentItemKind.enumValues)[number];
export const RECENT_ITEM_KINDS = recentItemKind.enumValues;

/** Most recent items kept per user; older ones are dropped as new ones are recorded. */
export const RECENT_ITEMS_CAP = 20;

export interface RecentItem {
  kind: RecentItemKind;
  /** The item's ID: a run's, repo's or agent's UUID, a work item's URL ID, a settings page's path. */
  refId: string;
  /** The item's organization; null for a settings page. */
  organizationId: string | null;
  openedAt: Date;
}

/**
 * Records that the user opened an item (again): it becomes their newest recent item, and
 * only their newest `RECENT_ITEMS_CAP` are kept.
 */
export async function recordRecentItem(
  db: Database,
  input: { userId: string; kind: RecentItemKind; refId: string; organizationId: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(userRecentItems)
      .values({ ...input, openedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [userRecentItems.userId, userRecentItems.kind, userRecentItems.refId],
        set: { organizationId: input.organizationId, openedAt: sql`now()` },
      });
    const keep = tx
      .select({ refId: sql`${userRecentItems.kind}::text || ':' || ${userRecentItems.refId}` })
      .from(userRecentItems)
      .where(eq(userRecentItems.userId, input.userId))
      .orderBy(desc(userRecentItems.openedAt))
      .limit(RECENT_ITEMS_CAP);
    await tx
      .delete(userRecentItems)
      .where(
        and(
          eq(userRecentItems.userId, input.userId),
          notInArray(sql`${userRecentItems.kind}::text || ':' || ${userRecentItems.refId}`, keep),
        ),
      );
  });
}

/**
 * The user's recent items, newest first: those of `organizationIds` and the settings pages
 * (no organization).
 */
export async function listRecentItems(
  db: Queryable,
  userId: string,
  organizationIds: readonly string[],
): Promise<RecentItem[]> {
  const rows = await db
    .select()
    .from(userRecentItems)
    .where(
      and(
        eq(userRecentItems.userId, userId),
        organizationIds.length
          ? sql`(${userRecentItems.organizationId} is null or ${inArray(
              userRecentItems.organizationId,
              [...organizationIds],
            )})`
          : sql`${userRecentItems.organizationId} is null`,
      ),
    )
    .orderBy(desc(userRecentItems.openedAt))
    .limit(RECENT_ITEMS_CAP);
  return rows.map((row) => ({
    kind: row.kind,
    refId: row.refId,
    organizationId: row.organizationId,
    openedAt: row.openedAt,
  }));
}
