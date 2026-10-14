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
  isNotNull,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { ChatPlatform } from "./chat.js";
import type { Database } from "./client.js";
import type { Job } from "./jobs.js";
import { getAllowedTaskTypeDefaults } from "./app-settings.js";
import {
  effectiveRepositorySwitches,
  switchedOn,
  type Repository,
  type RepositoryCodingPath,
  type RepositoryWithSwitches,
  type ScmProvider,
} from "./repositories.js";
import {
  harnesses,
  chatThreadRuns,
  chatThreads,
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
export type RalphRunOrigin = RalphRun["origin"];
export type RalphStoryStatus = RalphStory["status"];

/** A transaction, as handed to `lockRun`'s callback. */
export type RalphTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** The queries below run on the pool or inside a `lockRun` transaction. */
type Executor = Database | RalphTransaction;

/** A run's Linear fields, all set when it came from Linear (`ralph_runs_origin_check`). */
type RunLinearFields = Pick<
  RalphRun,
  "origin" | "linearIssueId" | "linearIdentifier" | "linearAgentSessionId"
>;

/** A run that came from Linear, with its issue and agent session. */
export type LinearRun<T extends RunLinearFields = RalphRun> = T & {
  origin: "linear";
  linearIssueId: string;
  linearIdentifier: string;
  linearAgentSessionId: string;
};

/** Whether a run came from Linear (and so has its issue and agent session). */
export function isLinearRun<T extends RunLinearFields>(run: T): run is LinearRun<T> {
  return (
    run.origin === "linear" &&
    run.linearIssueId !== null &&
    run.linearIdentifier !== null &&
    run.linearAgentSessionId !== null
  );
}

/**
 * How a run is referred to in job payloads, branch names and messages: its
 * Linear issue's identifier, or `chat-` and the start of its ID for a chat run.
 */
export function runReference(run: RunLinearFields & Pick<RalphRun, "id">): string {
  return isLinearRun(run) ? run.linearIdentifier : `chat-${run.id.slice(0, 8)}`;
}

/** The Linear agent session of a run that came from Linear; null for a chat run. */
export function linearSessionOf(run: RunLinearFields): string | null {
  return isLinearRun(run) ? run.linearAgentSessionId : null;
}

/** Runs that haven't finished; at most one per delegated issue. */
export const ACTIVE_RALPH_RUN_STATUSES = [
  "pending",
  "running",
  "waiting",
] as const satisfies RalphRunStatus[];

// ── Repositories ─────────────────────────────────────────────────────────────

export interface RepositoryRalphSettingsUpdate {
  /** Null inherits the organization's allowed task types (`coding`); omitted: unchanged. */
  ralphEnabled?: boolean | null;
  linearTeamKeys: string[];
  linearProjectNames: string[];
  linearLabels: string[];
  ralphSettings: RalphSettings;
  /** Omitted: unchanged. */
  codingPath?: RepositoryCodingPath;
  /** The coding task of its story runs (`story_task_id`); omitted: unchanged. */
  storyTaskId?: string;
  /** The coding task of its request runs (`request_task_id`); omitted: unchanged. */
  requestTaskId?: string;
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
      ...(input.ralphEnabled !== undefined && { ralphEnabled: input.ralphEnabled }),
      linearTeamKeys: input.linearTeamKeys,
      linearProjectNames: input.linearProjectNames,
      linearLabels: input.linearLabels,
      ralphSettings: input.ralphSettings,
      ...(input.codingPath && { codingPath: input.codingPath }),
      ...(input.storyTaskId && { storyTaskId: input.storyTaskId }),
      ...(input.requestTaskId && { requestTaskId: input.requestTaskId }),
    })
    .where(and(eq(repositories.id, id), isNull(repositories.disconnectedAt)))
    .returning();
  return row ?? null;
}

/**
 * The organization's connected repositories with ralph (coding) effectively enabled (the
 * routing candidates), by path.
 */
export async function listRalphRepositories(
  db: Executor,
  organizationId: string,
): Promise<RepositoryWithSwitches[]> {
  const allowed = await getAllowedTaskTypeDefaults(db, organizationId);
  const rows = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.organizationId, organizationId),
        switchedOn(repositories.ralphEnabled, allowed.includes("coding")),
        isNull(repositories.disconnectedAt),
      ),
    )
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
  return rows.map((row) => ({ ...row, effective: effectiveRepositorySwitches(row, allowed) }));
}

// ── Runs ─────────────────────────────────────────────────────────────────────

interface NewRalphRunBase {
  /** The organization the run belongs to (and whose repositories it uses). */
  organizationId: string;
  /** Null while a person is asked to pick the repository. */
  repositoryId: string | null;
  routedBy?: string | null;
  /** The main lane's branch and base branch: given with a repository, the main lane is created. */
  branch?: string;
  baseBranch?: string;
  status?: RalphRunStatus;
  pendingElicitation?: RalphPendingElicitation | null;
}

/** A run delegated or mentioned in Linear (`origin` defaults to `linear`). */
export interface NewLinearRalphRunInput extends NewRalphRunBase {
  origin?: "linear";
  linearIssueId: string;
  linearIdentifier: string;
  linearTitle?: string | null;
  linearUrl?: string | null;
  linearAgentSessionId: string;
  kind: RalphRunKind;
  /** `request` for a mention (default `epic`). */
  mode?: RalphRunMode;
  focusStoryId?: string | null;
  /** The chat thread that delegated the issue: it gets the run's start/PR/finish notifications. */
  chatThreadId?: string | null;
}

/** A request-mode run started from a chat thread. */
export interface NewChatRalphRunInput extends NewRalphRunBase {
  origin: "chat";
  chatThreadId: string;
  /** The coding task its requests run (the chat "start work" task); null for the repository's. */
  codingTaskId?: string | null;
}

export type NewRalphRunInput = NewLinearRalphRunInput | NewChatRalphRunInput;

/**
 * Creates a `pending` run (and, given a repository and branch, its main lane),
 * unless the agent session already has a run or the issue already has an
 * unfinished one (for a chat run: the thread already has an unfinished one):
 * then that run is returned with `created: false`. A chat run is always a
 * `single` request-mode run.
 */
export async function createRun(
  db: Executor,
  newRun: NewRalphRunInput,
): Promise<{ run: RalphRun; created: boolean }> {
  const { branch, baseBranch, ...input } = newRun;
  const values: typeof ralphRuns.$inferInsert =
    input.origin === "chat"
      ? {
          organizationId: input.organizationId,
          origin: "chat",
          chatThreadId: input.chatThreadId,
          kind: "single",
          mode: "request",
          repositoryId: input.repositoryId,
          routedBy: input.routedBy,
          status: input.status,
          pendingElicitation: input.pendingElicitation,
          codingTaskId: input.codingTaskId ?? null,
        }
      : { ...input, origin: "linear", focusStoryId: input.focusStoryId ?? null };
  // A conflicting run can finish between the insert and the lookup; then insert again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.transaction(async (tx) => {
      const [row] = await tx.insert(ralphRuns).values(values).onConflictDoNothing().returning();
      if (!row) return null;
      if (input.origin === "chat") {
        await tx.insert(chatThreadRuns).values({
          organizationId: row.organizationId,
          chatThreadId: input.chatThreadId,
          kind: "coding",
          ralphRunId: row.id,
        });
      }
      if (row.repositoryId && branch !== undefined) {
        await ensureLane(tx, {
          runId: row.id,
          repositoryId: row.repositoryId,
          branch,
          baseBranch: baseBranch ?? "",
        });
      }
      return row;
    });
    if (row) return { run: row, created: true };

    const existing =
      input.origin === "chat"
        ? await getActiveRunByChatThread(db, input.chatThreadId)
        : ((await getRunBySession(db, input.linearAgentSessionId)) ??
          (await getRunByIssue(db, input.organizationId, input.linearIssueId, {
            activeOnly: true,
          })));
    if (existing) return { run: existing, created: false };
  }
  throw new Error(
    input.origin === "chat"
      ? `Failed to create a ralph run for chat thread ${input.chatThreadId}`
      : `Failed to create a ralph run for ${input.linearIdentifier}`,
  );
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

/**
 * The organization's latest run of a delegated Linear issue (only an
 * unfinished one with `activeOnly`), or null.
 */
export async function getRunByIssue(
  db: Executor,
  organizationId: string,
  linearIssueId: string,
  options: { activeOnly?: boolean } = {},
): Promise<RalphRun | null> {
  const [row] = await db
    .select()
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        eq(ralphRuns.linearIssueId, linearIssueId),
        options.activeOnly ? inArray(ralphRuns.status, ACTIVE_RALPH_RUN_STATUSES) : undefined,
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id))
    .limit(1);
  return row ?? null;
}

/**
 * A chat thread's latest coding run (only an unfinished one with
 * `activeOnly`), from `chat_thread_runs`, or null.
 */
export async function getRunByChatThread(
  db: Executor,
  chatThreadId: string,
  options: { activeOnly?: boolean } = {},
): Promise<RalphRun | null> {
  const [row] = await db
    .select({ run: ralphRuns })
    .from(chatThreadRuns)
    .innerJoin(ralphRuns, eq(ralphRuns.id, chatThreadRuns.ralphRunId))
    .where(
      and(
        eq(chatThreadRuns.chatThreadId, chatThreadId),
        eq(chatThreadRuns.kind, "coding"),
        options.activeOnly ? inArray(ralphRuns.status, ACTIVE_RALPH_RUN_STATUSES) : undefined,
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id))
    .limit(1);
  return row?.run ?? null;
}

/** A chat thread's unfinished run (at most one), or null. */
export async function getActiveRunByChatThread(
  db: Executor,
  chatThreadId: string,
): Promise<RalphRun | null> {
  return getRunByChatThread(db, chatThreadId, { activeOnly: true });
}

/**
 * The unfinished run of what the run belongs to (its Linear issue, or its chat
 * thread), or null: at most one can be unfinished, so a finished run can only
 * start again when this is null or itself.
 */
export async function getActiveRunOfSameOrigin(
  db: Executor,
  run: RunLinearFields & Pick<RalphRun, "organizationId" | "chatThreadId">,
): Promise<RalphRun | null> {
  if (isLinearRun(run)) {
    return getRunByIssue(db, run.organizationId, run.linearIssueId, { activeOnly: true });
  }
  return run.chatThreadId === null ? null : getActiveRunByChatThread(db, run.chatThreadId);
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
  /** Only runs of this Linear issue (e.g. `ENG-42`). */
  linearIdentifier?: string;
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

/** The chat thread a chat run belongs to (for display). */
export interface RalphRunChatThread {
  id: string;
  platform: ChatPlatform;
  channelId: string;
}

export interface RalphRunListEntry {
  id: string;
  origin: RalphRunOrigin;
  /** Null for chat runs. */
  linearIssueId: string | null;
  linearIdentifier: string | null;
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
  /** A chat run's thread (null for Linear runs, or once the thread is gone). */
  chatThread: RalphRunChatThread | null;
  stories: { total: number; completed: number };
}

export interface RalphRunListPage {
  runs: RalphRunListEntry[];
  /** Matching runs across all pages. */
  total: number;
  page: number;
  pageSize: number;
}

const chatThreadColumns = {
  id: chatThreads.id,
  platform: chatThreads.platform,
  channelId: chatThreads.channelId,
};

/** The organization's runs, newest first, optionally filtered by status, repository and Linear issue. */
export async function listRuns(
  db: Executor,
  organizationId: string,
  filter: RalphRunListFilter = {},
): Promise<RalphRunListPage> {
  const pageSize = Math.max(1, Math.floor(filter.pageSize ?? RALPH_RUN_PAGE_SIZE));
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const conditions: SQL[] = [eq(ralphRuns.organizationId, organizationId)];
  if (filter.repositoryId) conditions.push(eq(ralphRuns.repositoryId, filter.repositoryId));
  if (filter.linearIdentifier) {
    conditions.push(eq(ralphRuns.linearIdentifier, filter.linearIdentifier));
  }
  if (typeof filter.status === "string") conditions.push(eq(ralphRuns.status, filter.status));
  else if (filter.status) conditions.push(inArray(ralphRuns.status, [...filter.status]));
  const where = and(...conditions);

  const [[totalRow], rows] = await Promise.all([
    db.select({ total: count() }).from(ralphRuns).where(where),
    db
      .select({
        id: ralphRuns.id,
        origin: ralphRuns.origin,
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
        harnessId: harnesses.id,
        harnessName: harnesses.name,
        chatThread: chatThreadColumns,
      })
      .from(ralphRuns)
      .leftJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
      .leftJoin(harnesses, eq(harnesses.id, ralphRuns.harnessId))
      .leftJoin(chatThreads, eq(chatThreads.id, ralphRuns.chatThreadId))
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
    runs: rows.map(({ harnessId, harnessName, ...row }) => ({
      ...row,
      agent: harnessId && harnessName !== null ? { id: harnessId, name: harnessName } : null,
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
  /** A chat run's thread (null for Linear runs, or once the thread is gone). */
  chatThread: RalphRunChatThread | null;
  /** The main lane first, then the others in the order they were added. */
  lanes: RalphLaneDetail[];
  /** In sub-issue order. */
  stories: RalphStory[];
  /** Every job of the run, newest first. */
  jobs: RalphRunJob[];
  /** Requests not handled yet (`listPendingRequests`), oldest first. */
  pendingRequests: RalphMessage[];
  /** Messages for running jobs (live replies), newest first, at most `RUN_DETAIL_MESSAGE_LIMIT`. */
  messages: RalphJobMessage[];
}

/** Live messages shown on a run's page. */
export const RUN_DETAIL_MESSAGE_LIMIT = 50;

/** A message for a running job, with that job's type and status. */
export type RalphJobMessage = RalphMessage & {
  job: { id: string; type: string; status: Job["status"] };
};

export interface RalphLaneDetail {
  lane: RalphLane;
  repository: { id: string; provider: ScmProvider; fullPath: string };
  /** The repository's stored ralph settings (unparsed: old rows may lack newer fields). */
  ralphSettings: unknown;
  /** The repository's coding path and tasks (the round caps of its request task). */
  coding: Pick<Repository, "codingPath" | "storyTaskId" | "requestTaskId">;
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

/**
 * An organization's run with its repository, sticky agent, stories and jobs;
 * null if it doesn't exist or belongs to another organization.
 */
export async function getRunDetail(
  db: Executor,
  organizationId: string,
  runId: string,
): Promise<RalphRunDetail | null> {
  const [row] = await db
    .select({
      run: ralphRuns,
      repository: {
        id: repositories.id,
        provider: repositories.provider,
        fullPath: repositories.fullPath,
      },
      harnessId: harnesses.id,
      harnessName: harnesses.name,
      chatThread: chatThreadColumns,
    })
    .from(ralphRuns)
    .leftJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
    .leftJoin(harnesses, eq(harnesses.id, ralphRuns.harnessId))
    .leftJoin(chatThreads, eq(chatThreads.id, ralphRuns.chatThreadId))
    .where(and(eq(ralphRuns.id, runId), eq(ralphRuns.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  const [lanes, stories, jobRows, pendingRequests, messageRows] = await Promise.all([
    db
      .select({
        lane: ralphLanes,
        repository: {
          id: repositories.id,
          provider: repositories.provider,
          fullPath: repositories.fullPath,
        },
        ralphSettings: repositories.ralphSettings,
        coding: {
          codingPath: repositories.codingPath,
          storyTaskId: repositories.storyTaskId,
          requestTaskId: repositories.requestTaskId,
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
        harnessId: harnesses.id,
        harnessName: harnesses.name,
      })
      .from(jobs)
      .leftJoin(harnesses, eq(harnesses.id, jobs.harnessId))
      .where(eq(jobs.ralphRunId, runId))
      .orderBy(desc(jobs.createdAt), desc(jobs.id)),
    listPendingRequests(db, runId),
    db
      .select({
        message: ralphMessages,
        job: { id: jobs.id, type: jobs.type, status: jobs.status },
      })
      .from(ralphMessages)
      .innerJoin(jobs, eq(jobs.id, ralphMessages.jobId))
      .where(eq(ralphMessages.runId, runId))
      .orderBy(desc(ralphMessages.createdAt), desc(ralphMessages.id))
      .limit(RUN_DETAIL_MESSAGE_LIMIT),
  ]);
  return {
    run: row.run,
    repository: row.repository,
    agent:
      row.harnessId && row.harnessName !== null
        ? { id: row.harnessId, name: row.harnessName }
        : null,
    chatThread: row.chatThread,
    lanes: lanes
      .map((l) => ({ ...l, main: l.lane.repositoryId === row.run.repositoryId }))
      .sort((a, b) => Number(b.main) - Number(a.main)),
    stories,
    jobs: jobRows.map(({ harnessId, harnessName, ...job }) => ({
      ...job,
      agent: harnessId && harnessName !== null ? { id: harnessId, name: harnessName } : null,
    })),
    pendingRequests,
    messages: messageRows.map(({ message, job }) => ({ ...message, job })),
  };
}

/**
 * The organization's repositories the Ralph runs list can be filtered by:
 * those with ralph enabled or with runs, by full path.
 */
export async function listRalphRunRepositories(
  db: Executor,
  organizationId: string,
): Promise<{ id: string; provider: ScmProvider; fullPath: string }[]> {
  const allowed = await getAllowedTaskTypeDefaults(db, organizationId);
  return db
    .select({
      id: repositories.id,
      provider: repositories.provider,
      fullPath: repositories.fullPath,
    })
    .from(repositories)
    .where(
      and(
        eq(repositories.organizationId, organizationId),
        or(
          switchedOn(repositories.ralphEnabled, allowed.includes("coding")),
          exists(
            db
              .select({ one: sql`1` })
              .from(ralphRuns)
              .where(eq(ralphRuns.repositoryId, repositories.id)),
          ),
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
 * The organization's unfinished runs an `Issue` webhook for `linearIssueId`
 * may move: waiting runs whose `waiting_on` lists it, and runs that have it as
 * a story. Oldest first.
 */
export async function listRunsAffectedByIssue(
  db: Executor,
  organizationId: string,
  linearIssueId: string,
): Promise<RalphRun[]> {
  const ref = JSON.stringify([{ id: linearIssueId }]);
  return db
    .select()
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
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
 * An organization's unfinished runs for the reconcile cron: every waiting run
 * (its blockers are re-checked), and pending or running runs without a queued
 * or running job that haven't changed since `staleBefore` (an outcome that was
 * never applied). Only runs of `origin` when given.
 */
export async function listRunsToReconcile(
  db: Executor,
  organizationId: string,
  staleBefore: Date,
  origin?: RalphRunOrigin,
): Promise<RalphRun[]> {
  return db
    .select()
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        origin ? eq(ralphRuns.origin, origin) : undefined,
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
                  and(
                    eq(jobs.ralphRunId, ralphRuns.id),
                    inArray(jobs.status, ["queued", "running"]),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(ralphRuns.updatedAt), asc(ralphRuns.id));
}

/** Organizations with at least one chat-origin run, for the reconcile cron. */
export async function listChatRunOrganizationIds(db: Executor): Promise<string[]> {
  const rows = await db
    .selectDistinct({ organizationId: ralphRuns.organizationId })
    .from(ralphRuns)
    .where(eq(ralphRuns.origin, "chat"))
    .orderBy(asc(ralphRuns.organizationId));
  return rows.map((r) => r.organizationId);
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
  /** Its sticky harness (none until one of its jobs starts). */
  harnessId?: string | null;
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

/**
 * The ralph lane whose PR/MR is `prNumber` in `repositoryId`, with its run:
 * the newest run's, since a re-delegation copies the lanes (cyralph keeps the
 * newest session of a PR). Lanes whose PR/MR was seen closed are left out.
 */
export async function findLaneByPullRequest(
  db: Executor,
  repositoryId: string,
  prNumber: number,
): Promise<{ lane: RalphLane; run: RalphRun } | null> {
  const [row] = await db
    .select({ lane: ralphLanes, run: ralphRuns })
    .from(ralphLanes)
    .innerJoin(ralphRuns, eq(ralphRuns.id, ralphLanes.runId))
    .where(
      and(
        eq(ralphLanes.repositoryId, repositoryId),
        eq(ralphLanes.prNumber, prNumber),
        eq(ralphLanes.prClosed, false),
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id))
    .limit(1);
  return row ?? null;
}

/**
 * The open lane of the newest run whose PR/MR has this source branch in the
 * repository (CI events that name a branch, not a PR/MR), or null.
 */
export async function findLaneByBranch(
  db: Executor,
  repositoryId: string,
  branch: string,
): Promise<{ lane: RalphLane; run: RalphRun } | null> {
  const [row] = await db
    .select({ lane: ralphLanes, run: ralphRuns })
    .from(ralphLanes)
    .innerJoin(ralphRuns, eq(ralphRuns.id, ralphLanes.runId))
    .where(
      and(
        eq(ralphLanes.repositoryId, repositoryId),
        eq(ralphLanes.branch, branch),
        isNotNull(ralphLanes.prNumber),
        eq(ralphLanes.prClosed, false),
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id))
    .limit(1);
  return row ?? null;
}

/**
 * Every ralph PR/MR of the organization's runs not known to be closed, each
 * with the lane of its newest run (a re-delegation carries a PR/MR forward),
 * oldest lane first. Only runs of `origin` when given.
 */
export async function listOpenPullRequestLanes(
  db: Executor,
  organizationId: string,
  origin?: RalphRunOrigin,
): Promise<Array<{ lane: RalphLane; run: RalphRun }>> {
  const rows = await db
    .select({ lane: ralphLanes, run: ralphRuns })
    .from(ralphLanes)
    .innerJoin(ralphRuns, eq(ralphRuns.id, ralphLanes.runId))
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        origin ? eq(ralphRuns.origin, origin) : undefined,
        isNotNull(ralphLanes.prNumber),
        eq(ralphLanes.prClosed, false),
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id));
  const newest = new Map<string, { lane: RalphLane; run: RalphRun }>();
  for (const row of rows) {
    const key = `${row.lane.repositoryId}#${row.lane.prNumber}`;
    if (!newest.has(key)) newest.set(key, row);
  }
  return [...newest.values()].sort(
    (a, b) =>
      a.lane.createdAt.getTime() - b.lane.createdAt.getTime() || a.lane.id.localeCompare(b.lane.id),
  );
}

/**
 * Merged ralph PRs/MRs of the organization's runs whose cleanup isn't
 * through, each with the lane of its newest run: never cleaned up, waiting,
 * running or failed, or with an answer being carried out or questions still
 * open. Also every lane whose keep-branch cleanup (a PR/MR closed unmerged,
 * a stopped run) waits, runs or failed. Oldest lane first. Only runs of
 * `origin` when given.
 */
export async function listLanesToCleanUp(
  db: Executor,
  organizationId: string,
  origin?: RalphRunOrigin,
): Promise<Array<{ lane: RalphLane; run: RalphRun }>> {
  const rows = await db
    .select({ lane: ralphLanes, run: ralphRuns })
    .from(ralphLanes)
    .innerJoin(ralphRuns, eq(ralphRuns.id, ralphLanes.runId))
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        origin ? eq(ralphRuns.origin, origin) : undefined,
        or(
          and(
            isNotNull(ralphLanes.prNumber),
            eq(ralphLanes.prMerged, true),
            sql`(${ralphLanes.cleanup} is null
              or ${ralphLanes.cleanup}->>'status' <> 'done'
              or ${ralphLanes.cleanup}->>'jobId' is not null
              or jsonb_array_length(coalesce(${ralphLanes.cleanup}->'questions', '[]'::jsonb)) > 0)`,
          ),
          sql`(${ralphLanes.cleanup}->>'keepBranch' is not null
            and (${ralphLanes.cleanup}->>'status' <> 'done'
              or ${ralphLanes.cleanup}->>'jobId' is not null))`,
        ),
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id));
  const newest = new Map<string, { lane: RalphLane; run: RalphRun }>();
  for (const row of rows) {
    // A keep-branch cleanup is the lane's own; a merge's is the PR/MR's (its newest run).
    const key = row.lane.cleanup?.keepBranch
      ? row.lane.id
      : `${row.lane.repositoryId}#${row.lane.prNumber}`;
    if (!newest.has(key)) newest.set(key, row);
  }
  return [...newest.values()].sort(
    (a, b) =>
      a.lane.createdAt.getTime() - b.lane.createdAt.getTime() || a.lane.id.localeCompare(b.lane.id),
  );
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
        requestHarnessId: null,
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
    // A main lane created late sticks to the harness the run's jobs already started on.
    const lane = await ensureLane(db, { runId, repositoryId, ...fresh, harnessId: run.harnessId });
    return { lane, left: null };
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
  Pick<
    RalphStory,
    | "status"
    | "attempts"
    | "rounds"
    | "roundMetrics"
    | "recommendations"
    | "lastFeedback"
    | "commitSha"
    | "lastJobId"
    | "title"
  >
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
/** Where a request came from: the trigger kind of the request run that takes it. */
export type RalphMessageTrigger = NonNullable<RalphMessage["trigger"]>;

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

/** The run's newest queued or running job of one of `types`, or null. */
export async function getActiveRunJob(
  db: Executor,
  runId: string,
  types: readonly string[],
): Promise<Job | null> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.ralphRunId, runId),
        inArray(jobs.status, ["queued", "running"]),
        inArray(jobs.type, [...types]),
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
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
  /** `/ship` (requests only). */
  ship?: boolean;
  /** Where it came from (a Linear reply or mention, chat, a review, CI, a fix command). */
  trigger?: RalphMessageTrigger | null;
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
      ship: input.ship ?? false,
      trigger: input.trigger ?? null,
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
 * The messages among `ids` still waiting for delivery to a job `harnessId` runs
 * (or ran): what an agent may acknowledge. Others' are ignored.
 */
export async function listHarnessUndeliveredMessages(
  db: Executor,
  harnessId: string,
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
        eq(jobs.harnessId, harnessId),
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
