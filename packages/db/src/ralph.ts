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
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Database } from "./client.js";
import type { Job } from "./jobs.js";
import type { Repository, ScmProvider } from "./repositories.js";
import {
  agents,
  jobs,
  ralphLanes,
  ralphMessages,
  ralphRuns,
  ralphStories,
  repositories,
  type RalphGuidance,
  type RalphPendingElicitation,
  type RalphSettings,
} from "./schema.js";

export type RalphRun = typeof ralphRuns.$inferSelect;
export type RalphLane = typeof ralphLanes.$inferSelect;
export type RalphStory = typeof ralphStories.$inferSelect;
export type RalphRunKind = RalphRun["kind"];
export type RalphRunStatus = RalphRun["status"];
export type RalphRunMode = RalphRun["mode"];
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
  /** `request` for a mention (default `epic`). */
  mode?: RalphRunMode;
  focusStoryId?: string | null;
  /** Null while a person is asked to pick the repository. */
  repositoryId: string | null;
  routedBy?: string | null;
  /** The main lane's branch and base branch: given with a repository, the main lane is created. */
  branch?: string;
  baseBranch?: string;
  status?: RalphRunStatus;
  pendingElicitation?: RalphPendingElicitation | null;
}

/**
 * Creates a `pending` run (and, given a repository and branch, its main lane),
 * unless the agent session already has a run or the issue already has an
 * unfinished one: then that run is returned with `created: false`.
 */
export async function createRun(
  db: Executor,
  input: NewRalphRunInput,
): Promise<{ run: RalphRun; created: boolean }> {
  // A conflicting run can finish between the insert and the lookup; then insert again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { branch, baseBranch, ...values } = input;
    const [row] = await db
      .insert(ralphRuns)
      .values({ ...values, focusStoryId: input.focusStoryId ?? null })
      .onConflictDoNothing()
      .returning();
    if (row) {
      if (row.repositoryId && branch !== undefined) {
        await ensureLane(db, {
          runId: row.id,
          repositoryId: row.repositoryId,
          branch,
          baseBranch: baseBranch ?? "",
        });
      }
      return { run: row, created: true };
    }

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

/** Run columns the orchestrator changes (identity and Linear IDs are fixed). */
export type RalphRunUpdate = Partial<
  Omit<
    typeof ralphRuns.$inferInsert,
    "id" | "linearIssueId" | "linearIdentifier" | "linearAgentSessionId" | "createdAt" | "updatedAt"
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
  /** The main lane's branch and PR/MR (null while the run has no repository). */
  branch: string | null;
  baseBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Null while a person is asked to pick it. */
  repository: { id: string; provider: ScmProvider; fullPath: string } | null;
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
        branch: ralphLanes.branch,
        baseBranch: ralphLanes.baseBranch,
        prNumber: ralphLanes.prNumber,
        prUrl: ralphLanes.prUrl,
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
      .leftJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
      .leftJoin(agents, eq(agents.id, ralphRuns.agentId))
      .leftJoin(ralphLanes, mainLaneOf(ralphRuns))
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
  /** Null while a person is asked to pick it. */
  repository: { id: string; provider: ScmProvider; fullPath: string } | null;
  agent: { id: string; name: string } | null;
  /** The main lane first, then the others in the order they were added. */
  lanes: RalphLaneDetail[];
  /** In sub-issue order. */
  stories: RalphStory[];
  /** Every job of the run, newest first. */
  jobs: RalphRunJob[];
}

export interface RalphLaneDetail {
  lane: RalphLane;
  repository: { id: string; provider: ScmProvider; fullPath: string };
  /** The lane of the run's own repository. */
  main: boolean;
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
    .leftJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
    .leftJoin(agents, eq(agents.id, ralphRuns.agentId))
    .where(eq(ralphRuns.id, runId))
    .limit(1);
  if (!row) return null;
  const [lanes, stories, jobRows] = await Promise.all([
    db
      .select({
        lane: ralphLanes,
        repository: {
          id: repositories.id,
          provider: repositories.provider,
          fullPath: repositories.fullPath,
        },
      })
      .from(ralphLanes)
      .innerJoin(repositories, eq(repositories.id, ralphLanes.repositoryId))
      .where(eq(ralphLanes.runId, runId))
      .orderBy(asc(ralphLanes.createdAt), asc(ralphLanes.id)),
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
    lanes: lanes
      .map((l) => ({ ...l, main: l.lane.repositoryId === row.run.repositoryId }))
      .sort((a, b) => Number(b.main) - Number(a.main)),
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

// ── Lanes ────────────────────────────────────────────────────────────────────

/** Joins a run (`ralph_runs` or an alias) to its main lane: the lane of its repository. */
function mainLaneOf(runs: typeof ralphRuns) {
  return and(eq(ralphLanes.runId, runs.id), eq(ralphLanes.repositoryId, runs.repositoryId));
}

export interface NewRalphLaneInput {
  runId: string;
  repositoryId: string;
  branch: string;
  baseBranch: string;
}

/** The run's lane in `repositoryId`, created with `input`'s branches if it has none yet. */
export async function ensureLane(db: Executor, input: NewRalphLaneInput): Promise<RalphLane> {
  const [row] = await db.insert(ralphLanes).values(input).onConflictDoNothing().returning();
  if (row) return row;
  const existing = await getLaneByRepository(db, input.runId, input.repositoryId);
  if (!existing) throw new Error(`Failed to create a lane of ralph run ${input.runId}`);
  return existing;
}

export async function getLane(db: Executor, id: string): Promise<RalphLane | null> {
  const [row] = await db.select().from(ralphLanes).where(eq(ralphLanes.id, id)).limit(1);
  return row ?? null;
}

/** The run's lane in a repository, or null. */
export async function getLaneByRepository(
  db: Executor,
  runId: string,
  repositoryId: string,
): Promise<RalphLane | null> {
  const [row] = await db
    .select()
    .from(ralphLanes)
    .where(and(eq(ralphLanes.runId, runId), eq(ralphLanes.repositoryId, repositoryId)))
    .limit(1);
  return row ?? null;
}

/** The run's main lane (of its repository); null while it has no repository. */
export async function getMainLane(
  db: Executor,
  run: Pick<RalphRun, "id" | "repositoryId">,
): Promise<RalphLane | null> {
  return run.repositoryId ? getLaneByRepository(db, run.id, run.repositoryId) : null;
}

/** The run's lanes in the order they were added. */
export async function listLanes(db: Executor, runId: string): Promise<RalphLane[]> {
  return db
    .select()
    .from(ralphLanes)
    .where(eq(ralphLanes.runId, runId))
    .orderBy(asc(ralphLanes.createdAt), asc(ralphLanes.id));
}

/** Lane columns the orchestrator changes (the run and repository are fixed). */
export type RalphLaneUpdate = Partial<
  Omit<typeof ralphLanes.$inferInsert, "id" | "runId" | "repositoryId" | "createdAt" | "updatedAt">
>;

/** Updates a lane (e.g. its PR/MR once opened). Returns null if it's gone. */
export async function updateLane(
  db: Executor,
  id: string,
  update: RalphLaneUpdate,
): Promise<RalphLane | null> {
  const [row] = await db
    .update(ralphLanes)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(ralphLanes.id, id))
    .returning();
  return row ?? null;
}

/**
 * Copies a run's lanes to another run (a re-delegation picking up where the
 * previous session left off), except the one in `exceptRepositoryId`.
 */
export async function copyLanes(
  db: Executor,
  fromRunId: string,
  toRunId: string,
  options: { exceptRepositoryId?: string | null } = {},
): Promise<RalphLane[]> {
  const lanes = (await listLanes(db, fromRunId)).filter(
    (l) => l.repositoryId !== options.exceptRepositoryId,
  );
  if (lanes.length === 0) return [];
  return db
    .insert(ralphLanes)
    .values(
      lanes.map(({ id: _id, runId: _runId, createdAt: _c, updatedAt: _u, ...lane }) => ({
        ...lane,
        runId: toRunId,
        // The new run publishes its lanes itself.
        publish: null,
        // Its requests start a new Claude conversation (cyralph keeps it per session).
        requestClaudeSessionId: null,
        requestAgentId: null,
      })),
    )
    .onConflictDoNothing()
    .returning();
}

/**
 * Re-routing moved a run to `repositoryId` (cyralph's `moveToRepository`):
 * the old main lane is dropped (its branch, PR/MR and follow-up state stay
 * behind, and are returned for the note saying so; its pending requests
 * (messages without a lane) come along), the run's lane in the new repository becomes the main lane, or a
 * fresh one is started with `fresh`'s branches. The same repository changes
 * nothing (a missing main lane is created). Call it under the run's lock.
 */
export async function moveToRepository(
  db: Executor,
  runId: string,
  repositoryId: string,
  fresh: { branch: string; baseBranch: string },
): Promise<{ lane: RalphLane; left: RalphLane | null } | null> {
  const run = await getRun(db, runId);
  if (!run) return null;
  if (run.repositoryId === repositoryId) {
    return { lane: await ensureLane(db, { runId, repositoryId, ...fresh }), left: null };
  }
  const old = await getMainLane(db, run);
  if (old) await db.delete(ralphLanes).where(eq(ralphLanes.id, old.id));
  const existing = await getLaneByRepository(db, runId, repositoryId);
  let lane: RalphLane;
  if (existing) {
    lane = existing;
    // Its messages (pending requests) now belong to the main lane, like the old main lane's.
    await db
      .update(ralphMessages)
      .set({ laneId: null })
      .where(eq(ralphMessages.laneId, existing.id));
  } else {
    lane = await ensureLane(db, { runId, repositoryId, ...fresh });
  }
  await updateRun(db, runId, { repositoryId });
  return { lane, left: old };
}

// ── Stories ──────────────────────────────────────────────────────────────────

export interface RalphStoryInput {
  linearIssueId: string;
  identifier: string;
  title: string;
  /** The lane the story runs in (null: none yet). */
  laneId?: string | null;
  /** Why it's treated as manual: it belongs in a repository Omniralph doesn't have. */
  elsewhere?: string | null;
}

/**
 * Inserts the run's stories, or refreshes the identifier, title, order, lane
 * and `elsewhere` of known ones (status, attempts and the rest are kept). `stories` is in sub-issue
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
      .values(
        stories.map((story, position) => ({
          ...story,
          laneId: story.laneId ?? null,
          elsewhere: story.elsewhere ?? null,
          runId,
          position,
        })),
      )
      .onConflictDoUpdate({
        target: [ralphStories.runId, ralphStories.linearIssueId],
        set: {
          identifier: sql`excluded.identifier`,
          title: sql`excluded.title`,
          position: sql`excluded.position`,
          laneId: sql`excluded.lane_id`,
          elsewhere: sql`excluded.elsewhere`,
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

// ── Live messages ────────────────────────────────────────────────────────────

export type RalphMessage = typeof ralphMessages.$inferSelect;
export type RalphMessageKind = RalphMessage["kind"];

/** The run's job of one of `types` that an agent is running right now (the newest), if any. */
export async function getRunningRunJob(
  db: Executor,
  runId: string,
  types: readonly string[],
): Promise<Job | null> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.ralphRunId, runId), eq(jobs.status, "running"), inArray(jobs.type, [...types])),
    )
    .orderBy(desc(jobs.startedAt), desc(jobs.createdAt))
    .limit(1);
  return row ?? null;
}

export interface NewRalphMessageInput {
  runId: string;
  kind: RalphMessageKind;
  text: string;
  /** The running job to deliver it to; omitted: a pending request (or guidance) as is. */
  jobId?: string | null;
  /** The lane it's for; omitted: the run's main lane. */
  laneId?: string | null;
  author?: string | null;
}

export async function insertMessage(
  db: Executor,
  input: NewRalphMessageInput,
): Promise<RalphMessage> {
  const [row] = await db
    .insert(ralphMessages)
    .values({
      runId: input.runId,
      kind: input.kind,
      text: input.text,
      jobId: input.jobId ?? null,
      laneId: input.laneId ?? null,
      author: input.author ?? null,
    })
    .returning();
  return row!;
}

/** Message columns the orchestrator changes. */
export type RalphMessageUpdate = Partial<
  Pick<RalphMessage, "jobId" | "deliveredAt" | "consumedAt">
>;

export async function updateMessage(
  db: Executor,
  id: string,
  update: RalphMessageUpdate,
): Promise<RalphMessage | null> {
  const [row] = await db
    .update(ralphMessages)
    .set(update)
    .where(eq(ralphMessages.id, id))
    .returning();
  return row ?? null;
}

/** The run's messages, oldest first. */
export async function listMessages(db: Executor, runId: string): Promise<RalphMessage[]> {
  return db
    .select()
    .from(ralphMessages)
    .where(eq(ralphMessages.runId, runId))
    .orderBy(asc(ralphMessages.createdAt), asc(ralphMessages.id));
}

/** Messages still to deliver to the jobs `jobIds` (oldest first). */
export async function listUndeliveredJobMessages(
  db: Executor,
  jobIds: readonly string[],
): Promise<RalphMessage[]> {
  if (jobIds.length === 0) return [];
  return db
    .select()
    .from(ralphMessages)
    .where(
      and(
        inArray(ralphMessages.jobId, [...jobIds]),
        isNull(ralphMessages.deliveredAt),
        isNull(ralphMessages.consumedAt),
      ),
    )
    .orderBy(asc(ralphMessages.createdAt), asc(ralphMessages.id));
}

/**
 * The messages among `ids` still waiting for delivery to a job `agentId` runs
 * (or ran): what an agent may acknowledge. Others' are ignored.
 */
export async function listAgentUndeliveredMessages(
  db: Executor,
  agentId: string,
  ids: readonly string[],
): Promise<RalphMessage[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ message: ralphMessages })
    .from(ralphMessages)
    .innerJoin(jobs, eq(jobs.id, ralphMessages.jobId))
    .where(
      and(
        inArray(ralphMessages.id, [...ids]),
        eq(jobs.agentId, agentId),
        isNull(ralphMessages.deliveredAt),
        isNull(ralphMessages.consumedAt),
      ),
    )
    .orderBy(asc(ralphMessages.createdAt), asc(ralphMessages.id));
  return rows.map((r) => r.message);
}

/**
 * The run's messages that were meant for a job but can no longer reach it:
 * undelivered, and the job finished (or is gone). Oldest first.
 */
export async function listStrandedMessages(db: Executor, runId: string): Promise<RalphMessage[]> {
  const rows = await db
    .select({ message: ralphMessages })
    .from(ralphMessages)
    .leftJoin(jobs, eq(jobs.id, ralphMessages.jobId))
    .where(
      and(
        eq(ralphMessages.runId, runId),
        isNull(ralphMessages.deliveredAt),
        isNull(ralphMessages.consumedAt),
        or(
          and(eq(ralphMessages.kind, "guidance"), isNull(ralphMessages.jobId)),
          and(
            sql`${ralphMessages.jobId} is not null`,
            or(isNull(jobs.id), notInArray(jobs.status, ["queued", "running"])),
          ),
        ),
      ),
    )
    .orderBy(asc(ralphMessages.createdAt), asc(ralphMessages.id));
  return rows.map((r) => r.message);
}

/** The run's pending requests (not handled yet, not waiting for a live session), oldest first. */
export async function listPendingRequests(db: Executor, runId: string): Promise<RalphMessage[]> {
  return db
    .select()
    .from(ralphMessages)
    .where(
      and(
        eq(ralphMessages.runId, runId),
        eq(ralphMessages.kind, "request"),
        isNull(ralphMessages.jobId),
        isNull(ralphMessages.consumedAt),
      ),
    )
    .orderBy(asc(ralphMessages.createdAt), asc(ralphMessages.id));
}

/** Marks messages applied (e.g. the requests a `ralph.request` job handled). */
export async function consumeMessages(
  db: Executor,
  ids: readonly string[],
  now = new Date(),
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(ralphMessages)
    .set({ consumedAt: now })
    .where(and(inArray(ralphMessages.id, [...ids]), isNull(ralphMessages.consumedAt)));
}
