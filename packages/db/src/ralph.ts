/**
 * Ralph runs (a delegated Linear epic or issue built story by story) and their
 * stories, plus the repositories' ralph settings and Linear routing. The
 * control panel's orchestrator owns this state: every state change goes through
 * `lockRun`, because Linear webhooks and job outcomes race.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Database } from "./client.js";
import type { Repository, ScmProvider } from "./repositories.js";
import {
  agents,
  jobs,
  ralphRuns,
  ralphStories,
  repositories,
  type RalphGuidance,
  type RalphSettings,
} from "./schema.js";

export type RalphRun = typeof ralphRuns.$inferSelect;
export type RalphStory = typeof ralphStories.$inferSelect;
export type RalphRunKind = RalphRun["kind"];
export type RalphRunStatus = RalphRun["status"];
export type RalphStoryStatus = RalphStory["status"];

/** A transaction, as handed to `lockRun`'s callback. */
export type RalphTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** The queries below run on the pool or inside a `lockRun` transaction. */
type Executor = Database | RalphTransaction;

/** Runs that haven't finished; at most one per delegated issue. */
export const ACTIVE_RALPH_RUN_STATUSES = [
  "pending",
  "running",
  "waiting",
] as const satisfies RalphRunStatus[];

// ── Repositories ─────────────────────────────────────────────────────────────

export interface RepositoryRalphSettingsUpdate {
  ralphEnabled: boolean;
  linearTeamKeys: string[];
  linearProjectNames: string[];
  linearLabels: string[];
  ralphSettings: RalphSettings;
}

/**
 * Saves a connected repository's ralph settings and Linear routing. Returns
 * null if the repository is unknown or disconnected.
 */
export async function updateRepositoryRalphSettings(
  db: Executor,
  id: string,
  input: RepositoryRalphSettingsUpdate,
): Promise<Repository | null> {
  const [row] = await db
    .update(repositories)
    .set({
      ralphEnabled: input.ralphEnabled,
      linearTeamKeys: input.linearTeamKeys,
      linearProjectNames: input.linearProjectNames,
      linearLabels: input.linearLabels,
      ralphSettings: input.ralphSettings,
    })
    .where(and(eq(repositories.id, id), isNull(repositories.disconnectedAt)))
    .returning();
  return row ?? null;
}

/** Connected repositories with ralph enabled (the routing candidates), by path. */
export async function listRalphRepositories(db: Executor): Promise<Repository[]> {
  return db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ralphEnabled, true), isNull(repositories.disconnectedAt)))
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface NewRalphRunInput {
  linearIssueId: string;
  linearIdentifier: string;
  linearTitle?: string | null;
  linearUrl?: string | null;
  linearAgentSessionId: string;
  kind: RalphRunKind;
  focusStoryId?: string | null;
  repositoryId: string;
  branch: string;
  baseBranch: string;
}

/**
 * Creates a `pending` run, unless the agent session already has a run or the
 * issue already has an unfinished one: then that run is returned with
 * `created: false`.
 */
export async function createRun(
  db: Executor,
  input: NewRalphRunInput,
): Promise<{ run: RalphRun; created: boolean }> {
  // A conflicting run can finish between the insert and the lookup; then insert again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .insert(ralphRuns)
      .values({ ...input, focusStoryId: input.focusStoryId ?? null })
      .onConflictDoNothing()
      .returning();
    if (row) return { run: row, created: true };

    const existing =
      (await getRunBySession(db, input.linearAgentSessionId)) ??
      (await getRunByIssue(db, input.linearIssueId, { activeOnly: true }));
    if (existing) return { run: existing, created: false };
  }
  throw new Error(`Failed to create a ralph run for ${input.linearIdentifier}`);
}

export async function getRun(db: Executor, id: string): Promise<RalphRun | null> {
  const [row] = await db.select().from(ralphRuns).where(eq(ralphRuns.id, id)).limit(1);
  return row ?? null;
}

/** The run of a Linear agent session, or null. */
export async function getRunBySession(
  db: Executor,
  linearAgentSessionId: string,
): Promise<RalphRun | null> {
  const [row] = await db
    .select()
    .from(ralphRuns)
    .where(eq(ralphRuns.linearAgentSessionId, linearAgentSessionId))
    .limit(1);
  return row ?? null;
}

/** The latest run of a delegated Linear issue (only an unfinished one with `activeOnly`), or null. */
export async function getRunByIssue(
  db: Executor,
  linearIssueId: string,
  options: { activeOnly?: boolean } = {},
): Promise<RalphRun | null> {
  const [row] = await db
    .select()
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.linearIssueId, linearIssueId),
        options.activeOnly ? inArray(ralphRuns.status, ACTIVE_RALPH_RUN_STATUSES) : undefined,
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id))
    .limit(1);
  return row ?? null;
}

/**
 * Runs `fn` in a transaction holding the run's row lock (`SELECT … FOR NO KEY UPDATE`),
 * so concurrent webhooks and job outcomes change a run one at a time. `fn`
 * gets the transaction (pass it to the queries here) and the locked run; its
 * result is returned. Returns null without calling `fn` if the run is gone.
 */
export async function lockRun<T>(
  db: Database,
  runId: string,
  fn: (tx: RalphTransaction, run: RalphRun) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    // `NO KEY UPDATE` serializes `lockRun` callers like `FOR UPDATE`, but lets
    // other connections insert rows referencing the run (e.g. the jobs `fn`
    // enqueues through the dispatcher's own connection) without deadlocking.
    const [run] = await tx
      .select()
      .from(ralphRuns)
      .where(eq(ralphRuns.id, runId))
      .for("no key update");
    if (!run) return null;
    return fn(tx, run);
  });
}

/** Run columns the orchestrator changes (identity, Linear IDs and repository are fixed). */
export type RalphRunUpdate = Partial<
  Omit<
    typeof ralphRuns.$inferInsert,
    | "id"
    | "linearIssueId"
    | "linearIdentifier"
    | "linearAgentSessionId"
    | "repositoryId"
    | "createdAt"
    | "updatedAt"
  >
>;

/** Updates a run (e.g. its status and `waitingOn`). Returns null if it's gone. */
export async function updateRun(
  db: Executor,
  runId: string,
  update: RalphRunUpdate,
): Promise<RalphRun | null> {
  const [row] = await db
    .update(ralphRuns)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(ralphRuns.id, runId))
    .returning();
  return row ?? null;
}

/** Replies kept as a run's guidance (the latest). */
export const MAX_RUN_GUIDANCE = 10;

/**
 * Appends a reply from the agent session to the run's guidance, keeping the
 * latest `MAX_RUN_GUIDANCE`. Returns null if the run is gone.
 */
export async function appendGuidance(
  db: Executor,
  runId: string,
  text: string,
  at = new Date(),
): Promise<RalphRun | null> {
  const entry: RalphGuidance = { text, at: at.toISOString() };
  const appended = sql`(${ralphRuns.guidance} || ${JSON.stringify([entry])}::jsonb)`;
  const [row] = await db
    .update(ralphRuns)
    .set({
      guidance: sql`(select coalesce(jsonb_agg(t.e order by t.i), '[]'::jsonb)
        from jsonb_array_elements(${appended}) with ordinality as t(e, i)
        where t.i > jsonb_array_length(${appended}) - ${MAX_RUN_GUIDANCE}::int)`,
      updatedAt: new Date(),
    })
    .where(eq(ralphRuns.id, runId))
    .returning();
  return row ?? null;
}

/**
 * Appends an entry to the run's progress log, on a new line. Returns null if
 * the run is gone.
 */
export async function appendProgress(
  db: Executor,
  runId: string,
  entry: string,
): Promise<RalphRun | null> {
  const [row] = await db
    .update(ralphRuns)
    .set({
      progress: sql`case when ${ralphRuns.progress} = '' or right(${ralphRuns.progress}, 1) = E'\\n'
        then ${ralphRuns.progress} || ${entry}
        else ${ralphRuns.progress} || E'\\n' || ${entry} end`,
      updatedAt: new Date(),
    })
    .where(eq(ralphRuns.id, runId))
    .returning();
  return row ?? null;
}

/** Runs per page of the Ralph runs list. */
export const RALPH_RUN_PAGE_SIZE = 25;

export interface RalphRunListFilter {
  status?: RalphRunStatus | readonly RalphRunStatus[];
  repositoryId?: string;
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface RalphRunListEntry {
  id: string;
  linearIssueId: string;
  linearIdentifier: string;
  linearTitle: string | null;
  linearUrl: string | null;
  kind: RalphRunKind;
  status: RalphRunStatus;
  branch: string;
  baseBranch: string;
  prNumber: number | null;
  prUrl: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  repository: { id: string; provider: ScmProvider; fullPath: string };
  agent: { id: string; name: string } | null;
  stories: { total: number; completed: number };
}

export interface RalphRunListPage {
  runs: RalphRunListEntry[];
  /** Matching runs across all pages. */
  total: number;
  page: number;
  pageSize: number;
}

/** Runs, newest first, optionally filtered by status and repository. */
export async function listRuns(
  db: Executor,
  filter: RalphRunListFilter = {},
): Promise<RalphRunListPage> {
  const pageSize = Math.max(1, Math.floor(filter.pageSize ?? RALPH_RUN_PAGE_SIZE));
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const conditions: SQL[] = [];
  if (filter.repositoryId) conditions.push(eq(ralphRuns.repositoryId, filter.repositoryId));
  if (typeof filter.status === "string") conditions.push(eq(ralphRuns.status, filter.status));
  else if (filter.status) conditions.push(inArray(ralphRuns.status, [...filter.status]));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [[totalRow], rows] = await Promise.all([
    db.select({ total: count() }).from(ralphRuns).where(where),
    db
      .select({
        id: ralphRuns.id,
        linearIssueId: ralphRuns.linearIssueId,
        linearIdentifier: ralphRuns.linearIdentifier,
        linearTitle: ralphRuns.linearTitle,
        linearUrl: ralphRuns.linearUrl,
        kind: ralphRuns.kind,
        status: ralphRuns.status,
        branch: ralphRuns.branch,
        baseBranch: ralphRuns.baseBranch,
        prNumber: ralphRuns.prNumber,
        prUrl: ralphRuns.prUrl,
        error: ralphRuns.error,
        createdAt: ralphRuns.createdAt,
        updatedAt: ralphRuns.updatedAt,
        repository: {
          id: repositories.id,
          provider: repositories.provider,
          fullPath: repositories.fullPath,
        },
        agentId: agents.id,
        agentName: agents.name,
      })
      .from(ralphRuns)
      .innerJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
      .leftJoin(agents, eq(agents.id, ralphRuns.agentId))
      .where(where)
      .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  const storyCounts = new Map<string, { total: number; completed: number }>();
  if (rows.length > 0) {
    const grouped = await db
      .select({ runId: ralphStories.runId, status: ralphStories.status, n: count() })
      .from(ralphStories)
      .where(
        inArray(
          ralphStories.runId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(ralphStories.runId, ralphStories.status);
    for (const { runId, status, n } of grouped) {
      const counts = storyCounts.get(runId) ?? { total: 0, completed: 0 };
      counts.total += n;
      if (status === "completed") counts.completed += n;
      storyCounts.set(runId, counts);
    }
  }

  return {
    runs: rows.map(({ agentId, agentName, ...row }) => ({
      ...row,
      agent: agentId && agentName !== null ? { id: agentId, name: agentName } : null,
      stories: storyCounts.get(row.id) ?? { total: 0, completed: 0 },
    })),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  };
}

export interface RalphRunDetail {
  run: RalphRun;
  repository: { id: string; provider: ScmProvider; fullPath: string };
  agent: { id: string; name: string } | null;
  /** In sub-issue order. */
  stories: RalphStory[];
  /** Every job of the run, newest first. */
  jobs: RalphRunJob[];
}

export type RalphRunJob = Pick<
  typeof jobs.$inferSelect,
  | "id"
  | "type"
  | "status"
  | "cancelRequested"
  | "deliveryCount"
  | "error"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
> & { agent: { id: string; name: string } | null };

/** A run with its repository, sticky agent, stories and jobs; null if it doesn't exist. */
export async function getRunDetail(db: Executor, runId: string): Promise<RalphRunDetail | null> {
  const [row] = await db
    .select({
      run: ralphRuns,
      repository: {
        id: repositories.id,
        provider: repositories.provider,
        fullPath: repositories.fullPath,
      },
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(ralphRuns)
    .innerJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
    .leftJoin(agents, eq(agents.id, ralphRuns.agentId))
    .where(eq(ralphRuns.id, runId))
    .limit(1);
  if (!row) return null;
  const [stories, jobRows] = await Promise.all([
    listStories(db, runId),
    db
      .select({
        id: jobs.id,
        type: jobs.type,
        status: jobs.status,
        cancelRequested: jobs.cancelRequested,
        deliveryCount: jobs.deliveryCount,
        error: jobs.error,
        createdAt: jobs.createdAt,
        startedAt: jobs.startedAt,
        finishedAt: jobs.finishedAt,
        agentId: agents.id,
        agentName: agents.name,
      })
      .from(jobs)
      .leftJoin(agents, eq(agents.id, jobs.agentId))
      .where(eq(jobs.ralphRunId, runId))
      .orderBy(desc(jobs.createdAt), desc(jobs.id)),
  ]);
  return {
    run: row.run,
    repository: row.repository,
    agent: row.agentId && row.agentName !== null ? { id: row.agentId, name: row.agentName } : null,
    stories,
    jobs: jobRows.map(({ agentId, agentName, ...job }) => ({
      ...job,
      agent: agentId && agentName !== null ? { id: agentId, name: agentName } : null,
    })),
  };
}

/**
 * Repositories the Ralph runs list can be filtered by: those with ralph
 * enabled or with runs, by full path.
 */
export async function listRalphRunRepositories(
  db: Executor,
): Promise<{ id: string; provider: ScmProvider; fullPath: string }[]> {
  return db
    .select({
      id: repositories.id,
      provider: repositories.provider,
      fullPath: repositories.fullPath,
    })
    .from(repositories)
    .where(
      or(
        eq(repositories.ralphEnabled, true),
        exists(
          db
            .select({ one: sql`1` })
            .from(ralphRuns)
            .where(eq(ralphRuns.repositoryId, repositories.id)),
        ),
      ),
    )
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
}

/** IDs of the run's jobs that are still queued or running (oldest first). */
export async function listActiveRunJobIds(db: Executor, runId: string): Promise<string[]> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.ralphRunId, runId), inArray(jobs.status, ["queued", "running"])))
    .orderBy(asc(jobs.createdAt), asc(jobs.id));
  return rows.map((r) => r.id);
}

/**
 * Unfinished runs an `Issue` webhook for `linearIssueId` may move: waiting runs
 * whose `waiting_on` lists it, and runs that have it as a story. Oldest first.
 */
export async function listRunsAffectedByIssue(
  db: Executor,
  linearIssueId: string,
): Promise<RalphRun[]> {
  const ref = JSON.stringify([{ id: linearIssueId }]);
  return db
    .select()
    .from(ralphRuns)
    .where(
      and(
        inArray(ralphRuns.status, ACTIVE_RALPH_RUN_STATUSES),
        or(
          and(
            eq(ralphRuns.status, "waiting"),
            or(
              sql`${ralphRuns.waitingOn} -> 'blockers' @> ${ref}::jsonb`,
              sql`${ralphRuns.waitingOn} -> 'manual' @> ${ref}::jsonb`,
            ),
          ),
          exists(
            db
              .select({ one: sql`1` })
              .from(ralphStories)
              .where(
                and(
                  eq(ralphStories.runId, ralphRuns.id),
                  eq(ralphStories.linearIssueId, linearIssueId),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(ralphRuns.createdAt), asc(ralphRuns.id));
}

/**
 * Unfinished runs for the reconcile cron: every waiting run (its blockers are
 * re-checked), and pending or running runs without a queued or running job
 * that haven't changed since `staleBefore` (an outcome that was never applied).
 */
export async function listRunsToReconcile(db: Executor, staleBefore: Date): Promise<RalphRun[]> {
  return db
    .select()
    .from(ralphRuns)
    .where(
      or(
        eq(ralphRuns.status, "waiting"),
        and(
          inArray(ralphRuns.status, ["pending", "running"]),
          lt(ralphRuns.updatedAt, staleBefore),
          notExists(
            db
              .select({ one: sql`1` })
              .from(jobs)
              .where(
                and(eq(jobs.ralphRunId, ralphRuns.id), inArray(jobs.status, ["queued", "running"])),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(ralphRuns.updatedAt), asc(ralphRuns.id));
}

// ── Stories ──────────────────────────────────────────────────────────────────

export interface RalphStoryInput {
  linearIssueId: string;
  identifier: string;
  title: string;
}

/**
 * Inserts the run's stories, or refreshes the identifier, title and order of
 * known ones (status, attempts and the rest are kept). `stories` is in sub-issue
 * order. Returns all of the run's stories in order.
 */
export async function upsertStories(
  db: Executor,
  runId: string,
  stories: RalphStoryInput[],
): Promise<RalphStory[]> {
  if (stories.length > 0) {
    await db
      .insert(ralphStories)
      .values(stories.map((story, position) => ({ ...story, runId, position })))
      .onConflictDoUpdate({
        target: [ralphStories.runId, ralphStories.linearIssueId],
        set: {
          identifier: sql`excluded.identifier`,
          title: sql`excluded.title`,
          position: sql`excluded.position`,
          updatedAt: new Date(),
        },
      });
  }
  return listStories(db, runId);
}

/** The run's stories in sub-issue order. */
export async function listStories(db: Executor, runId: string): Promise<RalphStory[]> {
  return db
    .select()
    .from(ralphStories)
    .where(eq(ralphStories.runId, runId))
    .orderBy(asc(ralphStories.position), asc(ralphStories.createdAt), asc(ralphStories.id));
}

export async function getStory(db: Executor, id: string): Promise<RalphStory | null> {
  const [row] = await db.select().from(ralphStories).where(eq(ralphStories.id, id)).limit(1);
  return row ?? null;
}

/** Story columns the orchestrator changes. */
export type RalphStoryUpdate = Partial<
  Pick<RalphStory, "status" | "attempts" | "lastFeedback" | "commitSha" | "lastJobId" | "title">
>;

/** Updates a story (e.g. its status after an attempt). Returns null if it's gone. */
export async function updateStory(
  db: Executor,
  id: string,
  update: RalphStoryUpdate,
): Promise<RalphStory | null> {
  const [row] = await db
    .update(ralphStories)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(ralphStories.id, id))
    .returning();
  return row ?? null;
}
