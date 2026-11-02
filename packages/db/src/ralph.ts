/**
 * Ralph runs (a delegated tracker epic or issue built story by story) and their
 * stories, plus the repositories' ralph settings and tracker routing. The
 * control panel's orchestrator owns this state: every state change goes through
 * `lockRun`, because tracker webhooks and job outcomes race.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { ChatPlatform } from "./chat.js";
import { currentChangeCollector, recordChange } from "./changes.js";
import { recordWorkItemChange } from "./work-items.js";
import type { Database } from "./client.js";
import type { Job } from "./jobs.js";
import {
  codingMayBeOn,
  recordRepositorySettingsChange,
  WorkItemMatchRequiredError,
  type Repository,
  type ScmProvider,
} from "./repositories.js";
import {
  agents,
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
} from "./schema.js";

export type RalphRun = typeof ralphRuns.$inferSelect;
export type RalphLane = typeof ralphLanes.$inferSelect;
export type PullRequestReviewState = RalphLane["prReviewState"];
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

/** A run's tracker fields, all set when it came from a tracker (`ralph_runs_origin_check`). */
type RunTrackerFields = Pick<
  RalphRun,
  "origin" | "trackerIssueId" | "trackerIdentifier" | "trackerSessionId"
>;

/** A run that came from a tracker, with its issue and agent session. */
export type TrackerRun<T extends RunTrackerFields = RalphRun> = T & {
  origin: "tracker";
  trackerIssueId: string;
  trackerIdentifier: string;
  trackerSessionId: string;
};

/** Whether a run came from a tracker (and so has its issue and agent session). */
export function isTrackerRun<T extends RunTrackerFields>(run: T): run is TrackerRun<T> {
  return (
    run.origin === "tracker" &&
    run.trackerIssueId !== null &&
    run.trackerIdentifier !== null &&
    run.trackerSessionId !== null
  );
}

/**
 * How a run is referred to in job payloads, branch names and messages: its
 * tracker issue's identifier, or `chat-` and the start of its ID for a chat run.
 */
export function runReference(run: RunTrackerFields & Pick<RalphRun, "id">): string {
  return isTrackerRun(run) ? run.trackerIdentifier : `chat-${run.id.slice(0, 8)}`;
}

/** The agent session of a run that came from a tracker; null for a chat run. */
export function trackerSessionOf(run: RunTrackerFields): string | null {
  return isTrackerRun(run) ? run.trackerSessionId : null;
}

/** Runs that haven't finished; at most one per delegated issue. */
export const ACTIVE_RALPH_RUN_STATUSES = [
  "pending",
  "running",
  "waiting",
] as const satisfies RalphRunStatus[];

// ── Repositories ─────────────────────────────────────────────────────────────

/**
 * A repo's coding policy (`repositories` columns; the work item match is saved on its own).
 * Each field left out is unchanged.
 */
export interface RepositoryCodingUpdate {
  /** The Coding switch: turning it on needs a work item match (`setRepositorySwitches`). */
  codingEnabled?: boolean;
  /** Appended to every story and request prompt; null (or blank) for none. */
  codingInstructions?: string | null;
  openPullRequestEarly?: boolean;
  historyRewrite?: RepositoryHistoryRewrite;
  respondToReviewsAndCi?: boolean;
  /** The commands that must pass after every story and request, in order. */
  checks?: string[];
}

export type RepositoryHistoryRewrite = Repository["historyRewrite"];

/**
 * Saves a connected repository's coding policy. Returns null if the repository is unknown or
 * disconnected. Turning Coding on for a repository without a work item match throws
 * `WorkItemMatchRequiredError` (nothing is saved).
 */
export async function updateRepositoryCoding(
  db: Executor,
  id: string,
  input: RepositoryCodingUpdate,
): Promise<Repository | null> {
  const [row] = await db
    .update(repositories)
    .set({
      ...(input.codingEnabled !== undefined && { codingEnabled: input.codingEnabled }),
      ...(input.codingInstructions !== undefined && {
        codingInstructions: input.codingInstructions?.trim() || null,
      }),
      ...(input.openPullRequestEarly !== undefined && {
        openPullRequestEarly: input.openPullRequestEarly,
      }),
      ...(input.historyRewrite !== undefined && { historyRewrite: input.historyRewrite }),
      ...(input.respondToReviewsAndCi !== undefined && {
        respondToReviewsAndCi: input.respondToReviewsAndCi,
      }),
      ...(input.checks !== undefined && { checks: input.checks }),
      // Always set, so a save that changes nothing still returns the row.
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositories.id, id),
        isNull(repositories.disconnectedAt),
        input.codingEnabled === true ? codingMayBeOn() : undefined,
      ),
    )
    .returning();
  if (!row) {
    if (input.codingEnabled === true) {
      const [found] = await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.id, id), isNull(repositories.disconnectedAt)));
      if (found) throw new WorkItemMatchRequiredError("turn_on_coding", id);
    }
    return null;
  }
  recordRepositorySettingsChange(db, row, "repository.coding");
  return row;
}

/**
 * The organization's connected repositories with Coding on (the routing candidates), by path.
 */
export async function listRalphRepositories(
  db: Executor,
  organizationId: string,
): Promise<Repository[]> {
  return db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.organizationId, organizationId),
        eq(repositories.codingEnabled, true),
        isNull(repositories.disconnectedAt),
      ),
    )
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
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

/** A run delegated or mentioned in a tracker (`origin` defaults to `tracker`). */
export interface NewTrackerRalphRunInput extends NewRalphRunBase {
  origin?: "tracker";
  /** The tracker of the issue (default: the only provider). */
  trackerProvider?: RalphRun["trackerProvider"];
  trackerIssueId: string;
  trackerIdentifier: string;
  trackerTitle?: string | null;
  trackerUrl?: string | null;
  trackerSessionId: string;
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

export type NewRalphRunInput = NewTrackerRalphRunInput | NewChatRalphRunInput;

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
      : { ...input, origin: "tracker", focusStoryId: input.focusStoryId ?? null };
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
      recordRunChange(tx, row);
      // The issue leaves the Backlog: it has a run now.
      if (row.trackerIssueId) {
        recordWorkItemChange(tx, {
          organizationId: row.organizationId,
          tracker: row.trackerProvider,
          externalIds: [row.trackerIssueId],
        });
      }
      return row;
    });
    if (row) return { run: row, created: true };

    const existing =
      input.origin === "chat"
        ? await getActiveRunByChatThread(db, input.chatThreadId)
        : ((await getRunBySession(db, input.trackerSessionId)) ??
          (await getRunByIssue(db, input.organizationId, input.trackerIssueId, {
            activeOnly: true,
          })));
    if (existing) return { run: existing, created: false };
  }
  throw new Error(
    input.origin === "chat"
      ? `Failed to create a ralph run for chat thread ${input.chatThreadId}`
      : `Failed to create a ralph run for ${input.trackerIdentifier}`,
  );
}

export async function getRun(db: Executor, id: string): Promise<RalphRun | null> {
  const [row] = await db.select().from(ralphRuns).where(eq(ralphRuns.id, id)).limit(1);
  return row ?? null;
}

/** The run of a tracker agent session, or null. */
export async function getRunBySession(
  db: Executor,
  trackerSessionId: string,
): Promise<RalphRun | null> {
  const [row] = await db
    .select()
    .from(ralphRuns)
    .where(eq(ralphRuns.trackerSessionId, trackerSessionId))
    .limit(1);
  return row ?? null;
}

/**
 * The organization's latest run of a delegated tracker issue (only an
 * unfinished one with `activeOnly`), or null.
 */
export async function getRunByIssue(
  db: Executor,
  organizationId: string,
  trackerIssueId: string,
  options: { activeOnly?: boolean } = {},
): Promise<RalphRun | null> {
  const [row] = await db
    .select()
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        eq(ralphRuns.trackerIssueId, trackerIssueId),
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
 * The unfinished run of what the run belongs to (its tracker issue, or its chat
 * thread), or null: at most one can be unfinished, so a finished run can only
 * start again when this is null or itself.
 */
export async function getActiveRunOfSameOrigin(
  db: Executor,
  run: RunTrackerFields & Pick<RalphRun, "organizationId" | "chatThreadId">,
): Promise<RalphRun | null> {
  if (isTrackerRun(run)) {
    return getRunByIssue(db, run.organizationId, run.trackerIssueId, { activeOnly: true });
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

/** Run columns the orchestrator changes (identity and tracker IDs are fixed). */
export type RalphRunUpdate = Partial<
  Omit<
    typeof ralphRuns.$inferInsert,
    "id" | "trackerIssueId" | "trackerIdentifier" | "trackerSessionId" | "createdAt" | "updatedAt"
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
  if (row) recordRunChange(db, row);
  return row ?? null;
}

/** Records a live `run` change for a ralph run (epic or request). */
function recordRunChange(db: Executor, run: { id: string; organizationId: string }): void {
  recordChange(db, {
    resource: "run",
    ids: [run.id],
    runId: run.id,
    organizationId: run.organizationId,
  });
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
  if (row) recordRunChange(db, row);
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
  if (row) recordRunChange(db, row);
  return row ?? null;
}

/** Runs per page of the Ralph runs list. */
export const RALPH_RUN_PAGE_SIZE = 25;

export interface RalphRunListFilter {
  status?: RalphRunStatus | readonly RalphRunStatus[];
  repositoryId?: string;
  /** Only runs of this tracker issue (e.g. `ENG-42`). */
  trackerIdentifier?: string;
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
  trackerIssueId: string | null;
  trackerIdentifier: string | null;
  trackerTitle: string | null;
  trackerUrl: string | null;
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
  /** A chat run's thread (null for tracker runs, or once the thread is gone). */
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

/** The organization's runs, newest first, optionally filtered by status, repository and tracker issue. */
export async function listRuns(
  db: Executor,
  organizationId: string,
  filter: RalphRunListFilter = {},
): Promise<RalphRunListPage> {
  const pageSize = Math.max(1, Math.floor(filter.pageSize ?? RALPH_RUN_PAGE_SIZE));
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const conditions: SQL[] = [eq(ralphRuns.organizationId, organizationId)];
  if (filter.repositoryId) conditions.push(eq(ralphRuns.repositoryId, filter.repositoryId));
  if (filter.trackerIdentifier) {
    conditions.push(eq(ralphRuns.trackerIdentifier, filter.trackerIdentifier));
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
        trackerIssueId: ralphRuns.trackerIssueId,
        trackerIdentifier: ralphRuns.trackerIdentifier,
        trackerTitle: ralphRuns.trackerTitle,
        trackerUrl: ralphRuns.trackerUrl,
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
        chatThread: chatThreadColumns,
      })
      .from(ralphRuns)
      .leftJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
      .leftJoin(agents, eq(agents.id, ralphRuns.agentId))
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
  /** A chat run's thread (null for tracker runs, or once the thread is gone). */
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
  /**
   * The repository's coding playbooks (the round caps of its request playbook) and whether it
   * responds to reviews and CI.
   */
  coding: Pick<Repository, "storyPlaybookId" | "requestPlaybookId" | "respondToReviewsAndCi">;
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
      agentId: agents.id,
      agentName: agents.name,
      chatThread: chatThreadColumns,
    })
    .from(ralphRuns)
    .leftJoin(repositories, eq(repositories.id, ralphRuns.repositoryId))
    .leftJoin(agents, eq(agents.id, ralphRuns.agentId))
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
        coding: {
          storyPlaybookId: repositories.storyPlaybookId,
          requestPlaybookId: repositories.requestPlaybookId,
          respondToReviewsAndCi: repositories.respondToReviewsAndCi,
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
    agent: row.agentId && row.agentName !== null ? { id: row.agentId, name: row.agentName } : null,
    chatThread: row.chatThread,
    lanes: lanes
      .map((l) => ({ ...l, main: l.lane.repositoryId === row.run.repositoryId }))
      .sort((a, b) => Number(b.main) - Number(a.main)),
    stories,
    jobs: jobRows.map(({ agentId, agentName, ...job }) => ({
      ...job,
      agent: agentId && agentName !== null ? { id: agentId, name: agentName } : null,
    })),
    pendingRequests,
    messages: messageRows.map(({ message, job }) => ({ ...message, job })),
  };
}

/**
 * The organization's repositories the Ralph runs list can be filtered by:
 * those with Coding on or with runs, by full path.
 */
export async function listRalphRunRepositories(
  db: Executor,
  organizationId: string,
): Promise<{ id: string; provider: ScmProvider; fullPath: string }[]> {
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
          eq(repositories.codingEnabled, true),
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
 * The organization's unfinished runs an `Issue` webhook for `trackerIssueId`
 * may move: waiting runs whose `waiting_on` lists it, and runs that have it as
 * a story. Oldest first.
 */
export async function listRunsAffectedByIssue(
  db: Executor,
  organizationId: string,
  trackerIssueId: string,
): Promise<RalphRun[]> {
  const ref = JSON.stringify([{ id: trackerIssueId }]);
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
                  eq(ralphStories.trackerIssueId, trackerIssueId),
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
  /** Its sticky agent (none until one of its jobs starts). */
  agentId?: string | null;
}

/** The run's lane in `repositoryId`, created with `input`'s branches if it has none yet. */
export async function ensureLane(db: Executor, input: NewRalphLaneInput): Promise<RalphLane> {
  const [row] = await db.insert(ralphLanes).values(input).onConflictDoNothing().returning();
  if (row) {
    await recordLaneChange(db, row, {});
    return row;
  }
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

/** A lane whose cleanup isn't through (see `listLanesToCleanUp`). */
function laneNeedsCleanup() {
  return or(
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
  );
}

/** Every unfinished run's ID, in any organization (rebuilding the reconcile cron's due set). */
export async function listUnfinishedRunIds(db: Executor): Promise<string[]> {
  const rows = await db
    .select({ id: ralphRuns.id })
    .from(ralphRuns)
    .where(inArray(ralphRuns.status, ["pending", "running", "waiting"]));
  return rows.map((row) => row.id);
}

/** The runs with these IDs (any organization); missing ones are left out. */
export async function listRunsByIds(db: Executor, ids: readonly string[]): Promise<RalphRun[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(ralphRuns)
    .where(inArray(ralphRuns.id, [...ids]))
    .orderBy(asc(ralphRuns.createdAt), asc(ralphRuns.id));
}

/** The lanes with these IDs (any organization), each with its run; missing ones are left out. */
export async function listLanesByIds(
  db: Executor,
  ids: readonly string[],
): Promise<Array<{ lane: RalphLane; run: RalphRun }>> {
  if (ids.length === 0) return [];
  return db
    .select({ lane: ralphLanes, run: ralphRuns })
    .from(ralphLanes)
    .innerJoin(ralphRuns, eq(ralphRuns.id, ralphLanes.runId))
    .where(inArray(ralphLanes.id, [...ids]))
    .orderBy(asc(ralphLanes.createdAt), asc(ralphLanes.id));
}

/**
 * Every lane (any organization) whose cleanup waits, failed or has open
 * questions, with its cleanup (rebuilding the reconcile cron's due set).
 */
export async function listLaneCleanups(
  db: Executor,
): Promise<Array<Pick<RalphLane, "id" | "cleanup">>> {
  return db
    .select({ id: ralphLanes.id, cleanup: ralphLanes.cleanup })
    .from(ralphLanes)
    .where(
      sql`(${ralphLanes.cleanup}->>'status' in ('pending', 'failed')
        or jsonb_array_length(coalesce(${ralphLanes.cleanup}->'questions', '[]'::jsonb)) > 0)`,
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
        laneNeedsCleanup(),
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
  const [updated] = await db
    .update(ralphLanes)
    .set({ ...update, updatedAt: new Date() })
    .from(ralphRuns)
    .where(and(eq(ralphLanes.id, id), eq(ralphRuns.id, ralphLanes.runId)))
    .returning({ lane: getTableColumns(ralphLanes), organizationId: ralphRuns.organizationId });
  if (!updated) return null;
  await recordLaneChange(db, updated.lane, update, updated.organizationId);
  return updated.lane;
}

/** Lane columns whose change is the pull or merge request's (a `pull_request` change too). */
const PULL_REQUEST_LANE_FIELDS = [
  "prNumber",
  "prUrl",
  "prClosed",
  "prMerged",
  "prDraft",
  "prReviewState",
] as const;

/**
 * A change to a PR/MR's draft or review state, as a code-host webhook reports
 * it. `reviewState.from` limits the move to lanes in one of those states (a
 * comment doesn't undo an approval, say); without it, any state moves.
 */
export interface PullRequestStateUpdate {
  draft?: boolean;
  reviewState?: { to: PullRequestReviewState; from?: readonly PullRequestReviewState[] };
  /**
   * When the code host says the change happened. A lane whose
   * `pr_state_updated_at` is later ignores it (an out-of-order delivery), and
   * a lane it changes is stamped with it. Without it, the change applies now.
   */
  occurredAt?: Date | null;
}

/**
 * Applies a PR/MR's draft or review state to every open lane of it in the
 * repository (a re-delegation carries a PR/MR forward to the new run's lane).
 * Lanes it doesn't change are left alone, `pr_state_updated_at` included, and
 * so are lanes whose state is newer than `occurredAt`. Returns the lanes it
 * changed.
 */
export async function updatePullRequestState(
  db: Executor,
  repositoryId: string,
  prNumber: number,
  update: PullRequestStateUpdate,
): Promise<RalphLane[]> {
  const { draft, reviewState, occurredAt } = update;
  const reviewMoves = reviewState
    ? and(
        sql`${ralphLanes.prReviewState} <> ${reviewState.to}`,
        reviewState.from ? inArray(ralphLanes.prReviewState, [...reviewState.from]) : undefined,
      )!
    : undefined;
  const draftMoves = draft === undefined ? undefined : sql`${ralphLanes.prDraft} <> ${draft}`;
  const changes = [draftMoves, reviewMoves].filter((c): c is SQL => c !== undefined);
  if (changes.length === 0) return [];
  const now = new Date();
  const stamp = occurredAt ?? now;
  const rows = await db
    .update(ralphLanes)
    .set({
      ...(draft === undefined ? {} : { prDraft: draft }),
      ...(reviewMoves
        ? {
            prReviewState: sql`case when ${reviewMoves} then ${reviewState!.to}::pr_review_state else ${ralphLanes.prReviewState} end`,
          }
        : {}),
      prStateUpdatedAt: stamp,
      updatedAt: now,
    })
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.id, ralphLanes.runId),
        eq(ralphLanes.repositoryId, repositoryId),
        eq(ralphLanes.prNumber, prNumber),
        eq(ralphLanes.prClosed, false),
        or(isNull(ralphLanes.prStateUpdatedAt), lte(ralphLanes.prStateUpdatedAt, stamp)),
        or(...changes),
      ),
    )
    .returning({ lane: getTableColumns(ralphLanes), organizationId: ralphRuns.organizationId });
  for (const row of rows) {
    await recordLaneChange(
      db,
      row.lane,
      { prReviewState: row.lane.prReviewState },
      row.organizationId,
    );
  }
  return rows.map((row) => row.lane);
}

/**
 * Records a lane's live changes: its run's, and its pull request's when `update`
 * touched one of its fields. Looks up the run's organization unless given.
 */
async function recordLaneChange(
  db: Executor,
  lane: { id: string; runId: string },
  update: RalphLaneUpdate,
  organizationId?: string,
): Promise<void> {
  if (!currentChangeCollector()) return;
  const orgId =
    organizationId ??
    (
      await db
        .select({ organizationId: ralphRuns.organizationId })
        .from(ralphRuns)
        .where(eq(ralphRuns.id, lane.runId))
    )[0]?.organizationId;
  if (!orgId) return;
  recordRunChange(db, { id: lane.runId, organizationId: orgId });
  if (PULL_REQUEST_LANE_FIELDS.some((field) => field in update)) {
    recordChange(db, {
      resource: "pull_request",
      ids: [lane.id],
      runId: lane.runId,
      organizationId: orgId,
    });
  }
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
    // A main lane created late sticks to the agent the run's jobs already started on.
    const lane = await ensureLane(db, { runId, repositoryId, ...fresh, agentId: run.agentId });
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
  trackerIssueId: string;
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
        target: [ralphStories.runId, ralphStories.trackerIssueId],
        set: {
          identifier: sql`excluded.identifier`,
          title: sql`excluded.title`,
          position: sql`excluded.position`,
          laneId: sql`excluded.lane_id`,
          elsewhere: sql`excluded.elsewhere`,
          updatedAt: new Date(),
        },
      });
    const run = currentChangeCollector() ? await getRun(db, runId) : null;
    if (run) recordRunChange(db, run);
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
    | "verifications"
    | "lastFeedback"
    | "commitSha"
    | "lastJobId"
    | "title"
  >
>;

/** Links a `ralph.story` job to the story it works on. */
export async function setJobRalphStory(
  db: Executor,
  jobId: string,
  ralphStoryId: string,
): Promise<void> {
  await db.update(jobs).set({ ralphStoryId }).where(eq(jobs.id, jobId));
}

/** Updates a story (e.g. its status after an attempt). Returns null if it's gone. */
export async function updateStory(
  db: Executor,
  id: string,
  update: RalphStoryUpdate,
): Promise<RalphStory | null> {
  const [updated] = await db
    .update(ralphStories)
    .set({ ...update, updatedAt: new Date() })
    .from(ralphRuns)
    .where(and(eq(ralphStories.id, id), eq(ralphRuns.id, ralphStories.runId)))
    .returning({ story: getTableColumns(ralphStories), organizationId: ralphRuns.organizationId });
  if (!updated) return null;
  recordRunChange(db, { id: updated.story.runId, organizationId: updated.organizationId });
  return updated.story;
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
  /** Where it came from (a tracker reply or mention, chat, a review, CI, a fix command). */
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
  await recordMessageChanges(db, [row!.runId]);
  return row!;
}

/**
 * Records a live `run` change for each run whose messages changed (its Session shows
 * them). Reads the runs' organizations only while changes are collected.
 */
async function recordMessageChanges(db: Executor, runIds: readonly string[]): Promise<void> {
  if (runIds.length === 0 || !currentChangeCollector()) return;
  const runs = await db
    .select({ id: ralphRuns.id, organizationId: ralphRuns.organizationId })
    .from(ralphRuns)
    .where(inArray(ralphRuns.id, [...new Set(runIds)]));
  for (const run of runs) recordRunChange(db, run);
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
  if (row) await recordMessageChanges(db, [row.runId]);
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
  const consumed = await db
    .update(ralphMessages)
    .set({ consumedAt: now })
    .where(and(inArray(ralphMessages.id, [...ids]), isNull(ralphMessages.consumedAt)))
    .returning({ runId: ralphMessages.runId });
  await recordMessageChanges(
    db,
    consumed.map((m) => m.runId),
  );
}
