/**
 * The unified run read model: every piece of user-visible work (epic and request runs,
 * PR/MR review runs, triage runs and chat questions) as one row shape, a `UNION ALL` over
 * the four source tables. A run's ID is its source row's UUID (UUIDs don't collide across
 * tables), and its attempts are the jobs that link to it (`jobs.ralph_run_id`,
 * `review_run_id`, `triage_run_id`, `chat_thread_run_id`).
 */
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import type {
  jobStatus,
  ralphRunMode,
  ralphRunOrigin,
  ralphRunStatus,
  reviewRunStatus,
  reviewTrigger,
  triageRunStatus,
  triageRunTrigger,
} from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type EnumValue<E extends { enumValues: readonly string[] }> = E["enumValues"][number];

export const RUN_KINDS = ["epic", "request", "review", "triage", "ask"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
  "skipped",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_ORIGINS = [
  "linear",
  "linear_mention",
  "chat",
  "pr_webhook",
  "pr_mention",
  "manual",
  "triage_label",
  "triage_mention",
] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

/** Unified statuses that are final: the run has finished. */
export const FINISHED_RUN_STATUSES = [
  "completed",
  "failed",
  "stopped",
  "skipped",
] as const satisfies readonly RunStatus[];

const RALPH_RUN_STATUS = {
  pending: "queued",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
} as const satisfies Record<EnumValue<typeof ralphRunStatus>, RunStatus>;

/**
 * Each kind's source status (an ask's: its latest attempt's job status) to the unified
 * status. The one table both `unifiedRunStatus` and the read model's SQL use.
 */
export const RUN_STATUS_MAP = {
  epic: RALPH_RUN_STATUS,
  request: RALPH_RUN_STATUS,
  review: {
    queued: "queued",
    running: "running",
    correlating: "running",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
  } satisfies Record<EnumValue<typeof reviewRunStatus>, RunStatus>,
  triage: {
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed",
    stopped: "stopped",
  } satisfies Record<EnumValue<typeof triageRunStatus>, RunStatus>,
  ask: {
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed",
    canceled: "stopped",
    expired: "failed",
    skipped: "skipped",
  } satisfies Record<EnumValue<typeof jobStatus>, RunStatus>,
} as const;

/** The unified status of a run of `kind` whose source status is `sourceStatus`. */
export function unifiedRunStatus(kind: RunKind, sourceStatus: string): RunStatus {
  const map: Record<string, RunStatus> = RUN_STATUS_MAP[kind];
  const status = map[sourceStatus];
  if (!status) throw new Error(`Unknown ${kind} run status: ${sourceStatus}`);
  return status;
}

/**
 * Where a run came from, by source: a ralph run by `origin:mode` (a delegation builds the
 * epic, a mention does what it asks), a review run and a triage run by their trigger.
 * Asks always come from chat.
 */
export const RUN_ORIGIN_MAP = {
  ralph: {
    "linear:epic": "linear",
    "linear:request": "linear_mention",
    "chat:epic": "chat",
    "chat:request": "chat",
  } satisfies Record<
    `${EnumValue<typeof ralphRunOrigin>}:${EnumValue<typeof ralphRunMode>}`,
    RunOrigin
  >,
  review: {
    webhook: "pr_webhook",
    mention: "pr_mention",
    manual: "manual",
  } satisfies Record<EnumValue<typeof reviewTrigger>, RunOrigin>,
  triage: {
    label: "triage_label",
    mention: "triage_mention",
  } satisfies Record<EnumValue<typeof triageRunTrigger>, RunOrigin>,
} as const;

/** A SQL literal of one of the mapping tables' keys or values (known identifiers only). */
function literal(value: string): SQL {
  if (!/^[a-z_:]+$/.test(value)) throw new Error(`Not a mapping value: ${value}`);
  return sql.raw(`'${value}'`);
}

/** `case <column> when <key> then <value> … end` over a mapping table. */
function caseOf(column: SQL, map: Record<string, string>): SQL {
  const branches = Object.entries(map).map(
    ([from, to]) => sql`when ${literal(from)} then ${literal(to)}`,
  );
  return sql`(case ${column} ${sql.join(branches, sql` `)} end)`;
}

/** The SQL expression of `unifiedRunStatus(kind, column)`. */
export function runStatusSql(kind: RunKind, column: SQL): SQL {
  return caseOf(column, RUN_STATUS_MAP[kind]);
}

/** A run's index facts: what the list filters and orders by. */
export interface RunIndexEntry {
  id: string;
  kind: RunKind;
  organizationId: string;
  status: RunStatus;
  origin: RunOrigin;
  repositoryId: string | null;
  /** The agent (agent) that ran (or runs) it. */
  agentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** `created_at` to the microsecond (UTC ISO), for the cursor. */
  createdAtKey: string;
}

const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', ${ISO_US})`);

/**
 * The read model: one row per run with the columns of `RunIndexEntry` (snake_case).
 * Statuses and origins are mapped by `RUN_STATUS_MAP` and `RUN_ORIGIN_MAP`.
 */
export function runIndexSql(): SQL {
  const ralphKind = sql.raw(`(case r.mode when 'epic' then 'epic' else 'request' end)`);
  const ralphStatus = sql.raw(`r.status::text`);
  return sql`
    select r.id, ${ralphKind} as kind, r.organization_id,
      (case r.mode when 'epic' then ${runStatusSql("epic", ralphStatus)}
        else ${runStatusSql("request", ralphStatus)} end) as status,
      ${caseOf(sql.raw(`(r.origin::text || ':' || r.mode::text)`), RUN_ORIGIN_MAP.ralph)} as origin,
      r.repository_id, r.agent_id, r.created_at, r.updated_at
    from ralph_runs r
    union all
    select rr.id, 'review', rr.organization_id,
      ${runStatusSql("review", sql.raw(`rr.status::text`))},
      ${caseOf(sql.raw(`rr.trigger::text`), RUN_ORIGIN_MAP.review)},
      rr.repository_id,
      (select rv.agent_id from reviews rv
        where rv.review_run_id = rr.id and rv.agent_id is not null
        order by rv.created_at limit 1),
      rr.created_at, rr.updated_at
    from review_runs rr
    union all
    select t.id, 'triage', t.organization_id,
      ${runStatusSql("triage", sql.raw(`t.status::text`))},
      ${caseOf(sql.raw(`t.trigger::text`), RUN_ORIGIN_MAP.triage)},
      tj.repository_id, tj.agent_id, t.created_at, t.updated_at
    from triage_runs t
    left join lateral (
      select j.repository_id, j.agent_id from jobs j
      where j.triage_run_id = t.id order by j.created_at desc, j.id desc limit 1
    ) tj on true
    union all
    select c.id, 'ask', c.organization_id,
      coalesce(${runStatusSql("ask", sql.raw(`aj.status::text`))}, 'queued'),
      'chat', aj.repository_id, aj.agent_id, c.created_at,
      coalesce(aj.finished_at, aj.started_at, aj.created_at, c.created_at)
    from chat_thread_runs c
    left join lateral (
      select j.status, j.repository_id, j.agent_id, j.created_at, j.started_at, j.finished_at
      from jobs j where j.chat_thread_run_id = c.id or j.id = c.job_id
      order by j.created_at desc, j.id desc limit 1
    ) aj on true
    where c.kind = 'query'`;
}

export interface RunIndexRow extends Record<string, unknown> {
  id: string;
  kind: RunKind;
  organization_id: string;
  status: RunStatus;
  origin: RunOrigin;
  repository_id: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  created_key: string;
}

export const indexColumns = sql`runs.id, runs.kind, runs.organization_id, runs.status, runs.origin,
  runs.repository_id, runs.agent_id, ${iso("runs.created_at")} as created_at,
  ${iso("runs.updated_at")} as updated_at, ${iso("runs.created_at")} as created_key`;

export function indexEntry(row: RunIndexRow): RunIndexEntry {
  return {
    id: row.id,
    kind: row.kind,
    organizationId: row.organization_id,
    status: row.status,
    origin: row.origin,
    repositoryId: row.repository_id,
    agentId: row.agent_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    createdAtKey: row.created_key,
  };
}

/** The position after which a page starts: the last row of the previous page. */
export interface RunCursor {
  /** `createdAtKey` of the last row. */
  createdAt: string;
  id: string;
}

export interface RunIndexFilter {
  /** Required: the organizations whose runs to list (none: an empty list). */
  organizationIds: readonly string[];
  kinds?: readonly RunKind[];
  statuses?: readonly RunStatus[];
  origins?: readonly RunOrigin[];
  /** One repository (kept for callers filtering by one); combines with `repositoryIds`. */
  repositoryId?: string;
  /** Runs of any of these repositories. */
  repositoryIds?: readonly string[];
  agentId?: string;
  cursor?: RunCursor | null;
  /** Default 50. */
  limit?: number;
}

export interface RunIndexPage {
  runs: RunIndexEntry[];
  /** The cursor of the next page, or null on the last page. */
  next: RunCursor | null;
}

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** A page of runs of the given organizations, newest first (`created_at`, then `id`). */
export async function listRunIndex(db: Queryable, filter: RunIndexFilter): Promise<RunIndexPage> {
  if (filter.organizationIds.length === 0) return { runs: [], next: null };
  const limit = Math.max(1, Math.floor(filter.limit ?? 50));
  const conditions: SQL[] = [sql`runs.organization_id in (${list(filter.organizationIds)})`];
  if (filter.kinds?.length) conditions.push(sql`runs.kind in (${list(filter.kinds)})`);
  if (filter.statuses?.length) conditions.push(sql`runs.status in (${list(filter.statuses)})`);
  if (filter.origins?.length) conditions.push(sql`runs.origin in (${list(filter.origins)})`);
  if (filter.repositoryId) conditions.push(sql`runs.repository_id = ${filter.repositoryId}`);
  if (filter.repositoryIds?.length) {
    conditions.push(sql`runs.repository_id in (${list(filter.repositoryIds)})`);
  }
  if (filter.agentId) conditions.push(sql`runs.agent_id = ${filter.agentId}`);
  if (filter.cursor) {
    conditions.push(
      sql`(runs.created_at, runs.id) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
    );
  }
  const result = await db.execute<RunIndexRow>(sql`
    select ${indexColumns} from (${runIndexSql()}) runs
    where ${sql.join(conditions, sql` and `)}
    order by runs.created_at desc, runs.id desc
    limit ${limit + 1}`);
  const rows = result.rows.map(indexEntry);
  const runs = rows.slice(0, limit);
  const last = runs.at(-1);
  return {
    runs,
    next: rows.length > limit && last ? { createdAt: last.createdAtKey, id: last.id } : null,
  };
}

/** The run with this ID, whichever organization it belongs to, or null. */
export async function getRunIndexEntry(db: Queryable, id: string): Promise<RunIndexEntry | null> {
  const result = await db.execute<RunIndexRow>(sql`
    select ${indexColumns} from (${runIndexSql()}) runs where runs.id = ${id}::uuid limit 1`);
  const row = result.rows[0];
  return row ? indexEntry(row) : null;
}

/** The runs with these IDs (any organization), in no particular order. */
export async function getRunIndexEntries(
  db: Queryable,
  ids: readonly string[],
): Promise<RunIndexEntry[]> {
  if (ids.length === 0) return [];
  const result = await db.execute<RunIndexRow>(sql`
    select ${indexColumns} from (${runIndexSql()}) runs
    where runs.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  return result.rows.map(indexEntry);
}

// ── List rows ────────────────────────────────────────────────────────────────

export interface RunRepository {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
  /** The connection's base URL (for browser links). */
  baseUrl: string;
}

/** A run as the unified list shows it: its index facts and references. */
export interface RunListEntry extends RunIndexEntry {
  /** The work item's title, a PR/MR title, or an ask's question; null without one. */
  title: string | null;
  /** The work item: its Linear issue ID (null where the run didn't keep it), key, title and URL. */
  workItem: {
    issueId: string | null;
    identifier: string;
    title: string | null;
    url: string | null;
  } | null;
  repository: RunRepository | null;
  branch: string | null;
  pullRequest: { number: number; url: string | null } | null;
  agent: { id: string; name: string } | null;
  /** Steps done of all (an epic's stories, a multi-pass review's passes); null for single-step runs. */
  progress: { done: number; total: number } | null;
  tokens: { in: number; out: number };
  /** When its first attempt started. */
  startedAt: Date | null;
  /** When it finished (its last update once finished); null while it isn't. */
  finishedAt: Date | null;
}

const date = (value: string | null) => (value ? new Date(value) : null);

/** `jobs.result` token usage, summed (`ralph-analytics.ts`). */
const usage = (field: "inputTokens" | "outputTokens") =>
  sql.raw(`coalesce(sum((j.result -> 'usage' ->> '${field}')::bigint), 0)::text`);

interface AttemptStats {
  tokensIn: number;
  tokensOut: number;
  startedAt: Date | null;
}

/** Token usage and first start of the attempts of the runs `ids`, by the link `column`. */
async function attemptStats(
  db: Queryable,
  column: "ralph_run_id" | "review_run_id" | "triage_run_id" | "chat_thread_run_id",
  ids: readonly string[],
  /** Only jobs not of these types (review tasks' tokens come from their reviews). */
  excludeTypes: readonly string[] = [],
): Promise<Map<string, AttemptStats>> {
  const stats = new Map<string, AttemptStats>();
  if (ids.length === 0) return stats;
  const link = sql.raw(`j.${column}`);
  const result = await db.execute<{
    run_id: string;
    tokens_in: string;
    tokens_out: string;
    started_at: string | null;
  }>(sql`
    select ${link} as run_id, ${usage("inputTokens")} as tokens_in,
      ${usage("outputTokens")} as tokens_out, ${iso("min(j.started_at)")} as started_at
    from jobs j
    where ${link} in (${list(ids)})
      ${excludeTypes.length ? sql`and j.type not in (${list(excludeTypes)})` : sql``}
    group by ${link}`);
  for (const row of result.rows) {
    stats.set(row.run_id, {
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      startedAt: date(row.started_at),
    });
  }
  return stats;
}

interface Facts {
  title: string | null;
  workItem: RunListEntry["workItem"];
  branch: string | null;
  pullRequest: RunListEntry["pullRequest"];
  progress: RunListEntry["progress"];
  tokens: RunListEntry["tokens"];
  startedAt: Date | null;
}

async function ralphFacts(db: Queryable, ids: string[]): Promise<Map<string, Facts>> {
  const facts = new Map<string, Facts>();
  if (ids.length === 0) return facts;
  const [result, stats] = await Promise.all([
    db.execute<{
      id: string;
      mode: "epic" | "request";
      linear_issue_id: string | null;
      linear_identifier: string | null;
      linear_title: string | null;
      linear_url: string | null;
      branch: string | null;
      pr_number: number | null;
      pr_url: string | null;
      stories_total: string;
      stories_done: string;
      first_request: string | null;
    }>(sql`
      select r.id, r.mode, r.linear_issue_id, r.linear_identifier, r.linear_title, r.linear_url,
        l.branch, l.pr_number, l.pr_url,
        (select m.text from ralph_messages m where m.run_id = r.id and m.kind = 'request'
          order by m.created_at, m.id limit 1) as first_request,
        (select count(*) from ralph_stories s where s.run_id = r.id)::text as stories_total,
        (select count(*) from ralph_stories s
          where s.run_id = r.id and s.status in ('completed', 'canceled'))::text as stories_done
      from ralph_runs r
      left join ralph_lanes l on l.run_id = r.id and l.repository_id = r.repository_id
      where r.id in (${list(ids)})`),
    attemptStats(db, "ralph_run_id", ids),
  ]);
  for (const row of result.rows) {
    const stat = stats.get(row.id);
    facts.set(row.id, {
      // A chat run has no issue: what it was asked to do.
      title: row.linear_title ?? row.first_request ?? row.linear_identifier,
      workItem: row.linear_identifier
        ? {
            issueId: row.linear_issue_id,
            identifier: row.linear_identifier,
            title: row.linear_title,
            url: row.linear_url,
          }
        : null,
      branch: row.branch,
      pullRequest: row.pr_number !== null ? { number: row.pr_number, url: row.pr_url } : null,
      // A request does what it was asked in one step; an epic builds its stories.
      progress:
        row.mode === "epic"
          ? { done: Number(row.stories_done), total: Number(row.stories_total) }
          : null,
      tokens: { in: stat?.tokensIn ?? 0, out: stat?.tokensOut ?? 0 },
      startedAt: stat?.startedAt ?? null,
    });
  }
  return facts;
}

/** Job types whose tokens a review run counts from its `reviews` rows instead. */
const REVIEW_PASS_JOB_TYPES = ["review.task", "review.run"];

async function reviewFacts(db: Queryable, ids: string[]): Promise<Map<string, Facts>> {
  const facts = new Map<string, Facts>();
  if (ids.length === 0) return facts;
  const [result, stats, times] = await Promise.all([
    db.execute<{
      id: string;
      pr_number: number;
      title: string | null;
      passes: string;
      passes_done: string;
      correlation_status: string | null;
      tokens_in: string;
      tokens_out: string;
    }>(sql`
      select rr.id, rr.pr_number,
        (select rv.pr_title from reviews rv where rv.review_run_id = rr.id and rv.pr_title is not null
          order by rv.created_at desc limit 1) as title,
        (select count(*) from reviews rv where rv.review_run_id = rr.id)::text as passes,
        (select count(*) from reviews rv where rv.review_run_id = rr.id
          and rv.status not in ('queued', 'running'))::text as passes_done,
        (select cj.status::text from jobs cj where cj.id = rr.correlation_job_id) as correlation_status,
        (select coalesce(sum(rv.tokens_in), 0) from reviews rv where rv.review_run_id = rr.id)::text as tokens_in,
        (select coalesce(sum(rv.tokens_out), 0) from reviews rv where rv.review_run_id = rr.id)::text as tokens_out
      from review_runs rr where rr.id in (${list(ids)})`),
    attemptStats(db, "review_run_id", ids, REVIEW_PASS_JOB_TYPES),
    // The first start over every attempt (passes too).
    attemptStats(db, "review_run_id", ids),
  ]);
  for (const row of result.rows) {
    const correlation = row.correlation_status !== null;
    const total = Number(row.passes) + (correlation ? 1 : 0);
    const done =
      Number(row.passes_done) +
      (correlation && !["queued", "running"].includes(row.correlation_status!) ? 1 : 0);
    const stat = stats.get(row.id);
    const time = times.get(row.id);
    facts.set(row.id, {
      title: row.title,
      workItem: null,
      branch: null,
      pullRequest: { number: row.pr_number, url: null },
      progress: total > 1 ? { done, total } : null,
      tokens: {
        in: Number(row.tokens_in) + (stat?.tokensIn ?? 0),
        out: Number(row.tokens_out) + (stat?.tokensOut ?? 0),
      },
      startedAt: time?.startedAt ?? null,
    });
  }
  return facts;
}

async function triageFacts(db: Queryable, ids: string[]): Promise<Map<string, Facts>> {
  const facts = new Map<string, Facts>();
  if (ids.length === 0) return facts;
  const [result, stats] = await Promise.all([
    // The issue as the newest attempt that read it saw it (the run keeps only Linear's ID).
    db.execute<{
      id: string;
      linear_issue_id: string;
      identifier: string | null;
      title: string | null;
      url: string | null;
      branch: string | null;
    }>(sql`
      select t.id, t.linear_issue_id, i.issue ->> 'identifier' as identifier, i.issue ->> 'title' as title,
        i.issue ->> 'url' as url, i.branch
      from triage_runs t
      left join lateral (
        select j.payload -> 'trigger' -> 'context' -> 'issue' as issue,
          j.payload -> 'trigger' -> 'context' ->> 'branch' as branch
        from jobs j
        where j.triage_run_id = t.id
          and jsonb_typeof(j.payload -> 'trigger' -> 'context' -> 'issue') = 'object'
        order by j.created_at desc, j.id desc limit 1
      ) i on true
      where t.id in (${list(ids)})`),
    attemptStats(db, "triage_run_id", ids),
  ]);
  for (const row of result.rows) {
    const stat = stats.get(row.id);
    facts.set(row.id, {
      title: row.title || row.identifier,
      workItem: row.identifier
        ? {
            issueId: row.linear_issue_id,
            identifier: row.identifier,
            title: row.title || null,
            url: row.url || null,
          }
        : null,
      branch: row.branch || null,
      pullRequest: null,
      progress: null,
      tokens: { in: stat?.tokensIn ?? 0, out: stat?.tokensOut ?? 0 },
      startedAt: stat?.startedAt ?? null,
    });
  }
  return facts;
}

async function askFacts(db: Queryable, ids: string[]): Promise<Map<string, Facts>> {
  const facts = new Map<string, Facts>();
  if (ids.length === 0) return facts;
  const result = await db.execute<{
    id: string;
    question: string | null;
    tokens_in: string;
    tokens_out: string;
    started_at: string | null;
  }>(sql`
    select c.id, aj.payload -> 'trigger' -> 'context' ->> 'question' as question,
      coalesce((aj.result -> 'usage' ->> 'inputTokens')::bigint, 0)::text as tokens_in,
      coalesce((aj.result -> 'usage' ->> 'outputTokens')::bigint, 0)::text as tokens_out,
      ${iso("aj.started_at")} as started_at
    from chat_thread_runs c
    left join lateral (
      select j.payload, j.result, j.started_at from jobs j
      where j.chat_thread_run_id = c.id or j.id = c.job_id
      order by j.created_at desc, j.id desc limit 1
    ) aj on true
    where c.id in (${list(ids)})`);
  for (const row of result.rows) {
    facts.set(row.id, {
      title: row.question,
      workItem: null,
      branch: null,
      pullRequest: null,
      progress: null,
      tokens: { in: Number(row.tokens_in), out: Number(row.tokens_out) },
      startedAt: date(row.started_at),
    });
  }
  return facts;
}

/** The runs' list rows: their titles, references, progress, tokens and times, in order. */
export async function loadRunListEntries(
  db: Queryable,
  entries: readonly RunIndexEntry[],
): Promise<RunListEntry[]> {
  if (entries.length === 0) return [];
  const idsOf = (...kinds: RunKind[]) =>
    entries.filter((e) => kinds.includes(e.kind)).map((e) => e.id);
  const repositoryIds = [...new Set(entries.flatMap((e) => e.repositoryId ?? []))];
  const agentIds = [...new Set(entries.flatMap((e) => e.agentId ?? []))];
  const [ralph, review, triage, ask, repos, agents] = await Promise.all([
    ralphFacts(db, idsOf("epic", "request")),
    reviewFacts(db, idsOf("review")),
    triageFacts(db, idsOf("triage")),
    askFacts(db, idsOf("ask")),
    repositoryIds.length
      ? db.execute<{
          id: string;
          provider: "github" | "gitlab";
          full_path: string;
          base_url: string;
        }>(
          sql`select r.id, r.provider, r.full_path, c.base_url from repositories r
            join scm_connections c on c.id = r.connection_id where r.id in (${list(repositoryIds)})`,
        )
      : null,
    agentIds.length
      ? db.execute<{ id: string; name: string }>(
          sql`select h.id, h.name from agents h where h.id in (${list(agentIds)})`,
        )
      : null,
  ]);
  const repositoryById = new Map(
    (repos?.rows ?? []).map((r) => [
      r.id,
      { id: r.id, provider: r.provider, fullPath: r.full_path, baseUrl: r.base_url },
    ]),
  );
  const agentById = new Map((agents?.rows ?? []).map((h) => [h.id, { id: h.id, name: h.name }]));
  const factsOf = { epic: ralph, request: ralph, review, triage, ask } as const;
  return entries.map((entry) => {
    const facts = factsOf[entry.kind].get(entry.id);
    const finished = (FINISHED_RUN_STATUSES as readonly RunStatus[]).includes(entry.status);
    return {
      ...entry,
      title: facts?.title ?? null,
      workItem: facts?.workItem ?? null,
      repository: (entry.repositoryId && repositoryById.get(entry.repositoryId)) || null,
      branch: facts?.branch ?? null,
      pullRequest: facts?.pullRequest ?? null,
      agent: (entry.agentId && agentById.get(entry.agentId)) || null,
      progress: facts?.progress ?? null,
      tokens: facts?.tokens ?? { in: 0, out: 0 },
      startedAt: facts?.startedAt ?? null,
      finishedAt: finished ? entry.updatedAt : null,
    };
  });
}

/** A repository the Runs screen's Repo filter offers. */
export interface RunFilterRepository {
  id: string;
  organizationId: string;
  provider: "github" | "gitlab";
  fullPath: string;
}

/**
 * The repositories of the given organizations for the Runs screen's Repo filter, by full
 * path (then ID): disconnected ones too, since their runs stay in the list.
 */
export async function listRunFilterRepositories(
  db: Queryable,
  organizationIds: readonly string[],
): Promise<RunFilterRepository[]> {
  if (organizationIds.length === 0) return [];
  const result = await db.execute<{
    id: string;
    organization_id: string;
    provider: "github" | "gitlab";
    full_path: string;
  }>(sql`
    select id, organization_id, provider, full_path from repositories
    where organization_id in (${list(organizationIds)})
    order by full_path, id`);
  return result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    fullPath: row.full_path,
  }));
}
