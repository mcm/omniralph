/**
 * The Inbox: what needs a person (Needs you), what's broken (Problems) and what's running
 * (Running), derived on read from run, lane, job and agent state. Nothing is stored but each
 * user's Done and Snooze (`inbox_item_states`), by the item's `key`. A key encodes what
 * makes an item new (a run's last failed attempt, a PR's review state), so a new failure of
 * a run marked Done shows up again. Runs and attempts older than `INBOX_WINDOW_DAYS` are
 * left out.
 *
 * Every item kind is one query over all of the organizations, so a feed and the counts take
 * a fixed number of queries whatever the number of runs.
 */
import { INSTALL_JOB_TYPE, REPO_SYNC_JOB_TYPE, WORKTREE_CLEANUP_JOB_TYPE } from "@omniralph/shared";
import { and, eq, gt, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import type { FindingSeverityCounts } from "./run-detail.js";
import {
  indexColumns,
  indexEntry,
  runIndexSql,
  type RunIndexRow,
  type RunRepository,
  type RunKind,
  type RunStatus,
} from "./run-index.js";
import { DESIRED_HARNESS_VERSION_KEY } from "./app-settings.js";
import { inboxItemStates, type RalphIssueRef } from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Runs and attempts older than this many days are left out of the Inbox. */
export const INBOX_WINDOW_DAYS = 14;

export const INBOX_TABS = ["needs_you", "problems", "running"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const INBOX_ITEM_KINDS = {
  needs_you: [
    "manual_story",
    "blocked_epic",
    "question",
    "stopped_epic",
    "prd_ready",
    "pr_waiting",
  ],
  problems: ["failed_run", "failed_system", "agent_offline", "agent_update_failed"],
  running: ["run"],
} as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[InboxTab][number];

/** Job types of system work a failed attempt of shows under Problems. */
export const INBOX_SYSTEM_JOB_TYPES = [
  REPO_SYNC_JOB_TYPE,
  INSTALL_JOB_TYPE,
  WORKTREE_CLEANUP_JOB_TYPE,
] as const;

export type InboxQuestionKind = "repository" | "preparation" | "cleanup" | "permission";
export type InboxReviewState =
  "none" | "review_requested" | "commented" | "changes_requested" | "approved";

/** What each kind of item knows beyond its run. */
export type InboxFacts =
  | {
      kind: "manual_story";
      story: { id: string; linearIssueId: string; identifier: string; title: string };
      /** Why it is manual although it isn't labelled so (it routes to a repo with coding off). */
      elsewhere: string | null;
    }
  | { kind: "blocked_epic"; blockers: RalphIssueRef[] }
  | {
      kind: "question";
      question: {
        kind: InboxQuestionKind;
        askedAt: string;
        expiresAt: string | null;
        /** The tool a permission asks about. */
        tool: string | null;
        /** The manual story a preparation question is about. */
        story: string | null;
      };
    }
  | { kind: "stopped_epic"; error: string | null }
  | { kind: "prd_ready"; jobId: string; outcome: "prd" | "reformat" }
  | {
      kind: "pr_waiting";
      lane: {
        id: string;
        repositoryId: string;
        prNumber: number;
        prUrl: string | null;
        reviewState: InboxReviewState;
      };
      /** The newest AI review run of the PR (its head as Omniralph last saw it); null: none. */
      review: { runId: string; status: RunStatus; openFindings: FindingSeverityCounts } | null;
    }
  | { kind: "failed_run"; lastAttemptId: string | null; error: string | null }
  | {
      kind: "failed_system";
      job: {
        id: string;
        type: string;
        status: "failed";
        payload: Record<string, unknown>;
        error: string | null;
        repositoryId: string | null;
        harnessId: string | null;
      };
    }
  | { kind: "agent_offline"; agent: { id: string; name: string }; lastHeartbeatAt: string }
  | {
      kind: "agent_update_failed";
      agent: { id: string; name: string };
      version: string;
      error: string | null;
    }
  | { kind: "run"; status: RunStatus };

/** One Inbox item as derived: its key, tab, organization and run, and its kind's facts. */
export interface InboxCandidate {
  key: string;
  tab: InboxTab;
  organizationId: string;
  /** When what the item is about happened (a failure, a question, a stop). */
  since: Date;
  /** The run it is about; null for an agent, or system work outside a run. */
  run: { id: string; kind: RunKind } | null;
  facts: InboxFacts;
}

export interface InboxQuery {
  organizationIds: readonly string[];
  /** Whose Done and Snooze apply. */
  userId: string;
  /** Only this tab's items; all tabs when unset. */
  tab?: InboxTab;
  /** An agent whose last heartbeat is older than this is offline. */
  onlineWindowMs: number;
  now?: Date;
}

const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', ${ISO_US})`);

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

interface Scope {
  orgs: SQL;
  cutoff: string;
  now: string;
}

function ralphKind(mode: string): RunKind {
  return mode === "epic" ? "epic" : "request";
}

// ── Needs you ────────────────────────────────────────────────────────────────

async function manualStories(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    run_id: string;
    organization_id: string;
    story_id: string;
    linear_issue_id: string;
    identifier: string;
    title: string;
    elsewhere: string | null;
    since: string;
  }>(sql`
    select r.id as run_id, r.organization_id, s.id as story_id, s.linear_issue_id,
      s.identifier, s.title, s.elsewhere, ${iso("s.updated_at")} as since
    from ralph_stories s join ralph_runs r on r.id = s.run_id
    where r.organization_id in (${scope.orgs}) and r.mode = 'epic' and r.status = 'waiting'
      and s.status = 'manual' and s.updated_at >= ${scope.cutoff}::timestamptz`);
  return result.rows.map((row) => ({
    key: `manual_story:${row.story_id}`,
    tab: "needs_you",
    organizationId: row.organization_id,
    since: new Date(row.since),
    run: { id: row.run_id, kind: "epic" },
    facts: {
      kind: "manual_story",
      story: {
        id: row.story_id,
        linearIssueId: row.linear_issue_id,
        identifier: row.identifier,
        title: row.title,
      },
      elsewhere: row.elsewhere,
    },
  }));
}

interface RalphQuestionRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  mode: string;
  status: string;
  ignore_blockers: boolean;
  repository_id: string | null;
  waiting_on: { blockers?: RalphIssueRef[] } | null;
  pending_elicitation: { kind?: string } | null;
  preparation: {
    request?: { identifier?: string; askedAt?: string; answer?: string; jobId?: string } | null;
  } | null;
  permission: {
    tool?: string;
    askedAt?: string;
    expiresAt?: string;
    answer?: string;
  } | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Blocked and stopped epics, and runs' open repository, preparation and permission
 * questions: one query over the ralph runs that may have one.
 */
async function ralphRunItems(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<RalphQuestionRow>(sql`
    select r.id, r.organization_id, r.mode, r.status, r.ignore_blockers, r.repository_id,
      r.waiting_on, r.pending_elicitation, r.preparation, r.permission, r.error,
      ${iso("r.created_at")} as created_at, ${iso("r.updated_at")} as updated_at
    from ralph_runs r
    where r.organization_id in (${scope.orgs})
      and (r.status in ('waiting', 'stopped')
        or r.pending_elicitation is not null
        or jsonb_typeof(r.preparation -> 'request') = 'object'
        or (r.permission is not null and r.permission ->> 'answer' is null))
      and r.status <> 'failed'`);
  const items: InboxCandidate[] = [];
  const now = Date.parse(scope.now);
  const cutoff = Date.parse(scope.cutoff);
  const recent = (at: string | undefined) => !!at && Date.parse(at) >= cutoff;
  for (const row of result.rows) {
    const run = { id: row.id, kind: ralphKind(row.mode) };
    const base = { tab: "needs_you" as const, organizationId: row.organization_id, run };
    const blockers = row.waiting_on?.blockers ?? [];
    if (
      row.mode === "epic" &&
      row.status === "waiting" &&
      !row.ignore_blockers &&
      blockers.length > 0 &&
      recent(row.updated_at)
    ) {
      const ids = blockers.map((b) => b.id).sort();
      items.push({
        ...base,
        key: `blocked:${row.id}:${ids.join(",")}`,
        since: new Date(row.updated_at),
        facts: { kind: "blocked_epic", blockers },
      });
    }
    if (row.status === "stopped" && recent(row.updated_at)) {
      items.push({
        ...base,
        key: `stopped:${row.id}:${row.updated_at}`,
        since: new Date(row.updated_at),
        facts: { kind: "stopped_epic", error: row.error },
      });
    }
    if (row.status === "stopped") continue;
    // Repository and preparation questions are open only while the run is.
    const open = row.status !== "completed";
    const question = (
      kind: InboxQuestionKind,
      askedAt: string,
      extra: { expiresAt?: string | null; tool?: string | null; story?: string | null } = {},
    ) =>
      items.push({
        ...base,
        key: `question:${row.id}:${kind}:${askedAt}`,
        since: new Date(askedAt),
        facts: {
          kind: "question",
          question: {
            kind,
            askedAt,
            expiresAt: extra.expiresAt ?? null,
            tool: extra.tool ?? null,
            story: extra.story ?? null,
          },
        },
      });
    // The repository question is asked when the run starts (routing found no repo).
    if (
      open &&
      row.pending_elicitation?.kind === "repository" &&
      !row.repository_id &&
      recent(row.created_at)
    ) {
      question("repository", row.created_at);
    }
    const request = row.preparation?.request;
    if (open && request && !request.jobId && request.answer !== "run" && recent(request.askedAt)) {
      question("preparation", request.askedAt!, { story: request.identifier ?? null });
    }
    const permission = row.permission;
    if (
      permission &&
      !permission.answer &&
      recent(permission.askedAt) &&
      (!permission.expiresAt || Date.parse(permission.expiresAt) > now)
    ) {
      question("permission", permission.askedAt!, {
        expiresAt: permission.expiresAt ?? null,
        tool: permission.tool ?? null,
      });
    }
  }
  return items;
}

/** Open questions about a merged lane's leftovers: one item per run (its oldest question). */
async function cleanupQuestions(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    run_id: string;
    organization_id: string;
    mode: string;
    asked_at: string;
    expires_at: string | null;
  }>(sql`
    select r.id as run_id, r.organization_id, r.mode,
      min(q ->> 'askedAt') as asked_at, min(q ->> 'deadline') as expires_at
    from ralph_lanes l
    join ralph_runs r on r.id = l.run_id
    cross join lateral jsonb_array_elements(coalesce(l.cleanup -> 'questions', '[]'::jsonb)) q
    where r.organization_id in (${scope.orgs}) and r.status <> 'failed'
      and jsonb_typeof(l.cleanup -> 'questions') = 'array'
    group by r.id, r.organization_id, r.mode`);
  const cutoff = Date.parse(scope.cutoff);
  return result.rows
    .filter((row) => Date.parse(row.asked_at) >= cutoff)
    .map((row) => ({
      key: `question:${row.run_id}:cleanup:${row.asked_at}`,
      tab: "needs_you",
      organizationId: row.organization_id,
      since: new Date(row.asked_at),
      run: { id: row.run_id, kind: ralphKind(row.mode) },
      facts: {
        kind: "question",
        question: {
          kind: "cleanup",
          askedAt: row.asked_at,
          expiresAt: row.expires_at,
          tool: null,
          story: null,
        },
      },
    }));
}

/**
 * Pending tool permissions of runs other than ralph runs (a ralph run's question is its
 * `ralph_runs.permission`, which the stored request only copies later): the newest per run.
 */
async function permissionRequests(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    run_id: string;
    kind: RunKind;
    organization_id: string;
    tool: string;
    asked_at: string;
    expires_at: string;
  }>(sql`
    select distinct on (run_id) run_id, kind, organization_id, tool, asked_at, expires_at from (
      select coalesce(j.review_run_id, j.triage_run_id, j.chat_thread_run_id) as run_id,
        (case when j.review_run_id is not null then 'review'
          when j.triage_run_id is not null then 'triage' else 'ask' end) as kind,
        j.organization_id, p.tool, ${iso("p.asked_at")} as asked_at,
        ${iso("p.expires_at")} as expires_at, p.asked_at as asked
      from run_permission_requests p join jobs j on j.id = p.job_id
      where j.organization_id in (${scope.orgs}) and j.ralph_run_id is null
        and (j.review_run_id is not null or j.triage_run_id is not null
          or j.chat_thread_run_id is not null)
        and j.status in ('queued', 'running')
        and p.answer is null and p.expires_at > ${scope.now}::timestamptz
        and p.asked_at >= ${scope.cutoff}::timestamptz
    ) pending
    order by run_id, asked desc`);
  return result.rows.map((row) => ({
    key: `question:${row.run_id}:permission:${row.asked_at}`,
    tab: "needs_you",
    organizationId: row.organization_id,
    since: new Date(row.asked_at),
    run: { id: row.run_id, kind: row.kind },
    facts: {
      kind: "question",
      question: {
        kind: "permission",
        askedAt: row.asked_at,
        expiresAt: row.expires_at,
        tool: row.tool,
        story: null,
      },
    },
  }));
}

/** Triage runs that wrote (or reformatted) a PRD nobody has started a run of since. */
async function readyPrds(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    id: string;
    organization_id: string;
    job_id: string | null;
    outcome: "prd" | "reformat";
    since: string;
  }>(sql`
    select t.id, t.organization_id, tj.id as job_id,
      t.last_result -> 'outcome' ->> 'outcome' as outcome,
      ${iso("coalesce(tj.finished_at, t.updated_at)")} as since
    from triage_runs t
    left join lateral (
      select j.id, j.finished_at from jobs j where j.triage_run_id = t.id
      order by j.created_at desc, j.id desc limit 1
    ) tj on true
    where t.organization_id in (${scope.orgs}) and t.status = 'completed'
      and t.last_result -> 'outcome' ->> 'outcome' in ('prd', 'reformat')
      and coalesce(tj.finished_at, t.updated_at) >= ${scope.cutoff}::timestamptz
      and not exists (
        select 1 from ralph_runs r
        where r.organization_id = t.organization_id and r.linear_issue_id = t.linear_issue_id
          and r.created_at >= t.created_at)`);
  return result.rows.map((row) => ({
    key: `prd_ready:${row.id}:${row.job_id ?? row.id}`,
    tab: "needs_you",
    organizationId: row.organization_id,
    since: new Date(row.since),
    run: { id: row.id, kind: "triage" },
    facts: { kind: "prd_ready", jobId: row.job_id ?? row.id, outcome: row.outcome },
  }));
}

/**
 * PRs/MRs Om opened that wait for a person: the lane's PR is open and not a draft, its run
 * completed and nothing of the run is queued or running. Each carries the newest AI review.
 */
async function waitingPullRequests(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    lane_id: string;
    run_id: string;
    mode: string;
    organization_id: string;
    repository_id: string;
    pr_number: number;
    pr_url: string | null;
    review_state: InboxReviewState;
    since: string;
    review_run_id: string | null;
    review_status: string | null;
    critical: string | null;
    high: string | null;
    medium: string | null;
    low: string | null;
    info: string | null;
  }>(sql`
    select l.id as lane_id, r.id as run_id, r.mode, r.organization_id, l.repository_id,
      l.pr_number, l.pr_url, l.pr_review_state as review_state,
      ${iso("greatest(r.updated_at, coalesce(l.pr_state_updated_at, r.updated_at))")} as since,
      rv.id as review_run_id, rv.status as review_status,
      fc.critical, fc.high, fc.medium, fc.low, fc.info
    from ralph_lanes l
    join ralph_runs r on r.id = l.run_id
    left join lateral (
      select rr.id, rr.status::text as status from review_runs rr
      where rr.repository_id = l.repository_id and rr.pr_number = l.pr_number
      order by rr.created_at desc, rr.id desc limit 1
    ) rv on true
    left join lateral (
      select count(*) filter (where f.severity = 'critical')::text as critical,
        count(*) filter (where f.severity = 'high')::text as high,
        count(*) filter (where f.severity = 'medium')::text as medium,
        count(*) filter (where f.severity = 'low')::text as low,
        count(*) filter (where f.severity = 'info')::text as info
      from findings f join reviews v on v.id = f.review_id
      where v.review_run_id = rv.id and f.status = 'open'
    ) fc on rv.id is not null
    where r.organization_id in (${scope.orgs}) and r.status = 'completed'
      and l.pr_number is not null and not l.pr_closed and not l.pr_draft
      and greatest(r.updated_at, coalesce(l.pr_state_updated_at, r.updated_at))
        >= ${scope.cutoff}::timestamptz
      and not exists (
        select 1 from jobs j where j.ralph_run_id = r.id and j.status in ('queued', 'running'))`);
  return result.rows.map((row) => ({
    key: `pr:${row.lane_id}:${row.review_state}`,
    tab: "needs_you",
    organizationId: row.organization_id,
    since: new Date(row.since),
    run: { id: row.run_id, kind: ralphKind(row.mode) },
    facts: {
      kind: "pr_waiting",
      lane: {
        id: row.lane_id,
        repositoryId: row.repository_id,
        prNumber: row.pr_number,
        prUrl: row.pr_url,
        reviewState: row.review_state,
      },
      review:
        row.review_run_id && row.review_status
          ? {
              runId: row.review_run_id,
              status: REVIEW_RUN_STATUS[row.review_status] ?? "running",
              openFindings: {
                critical: Number(row.critical ?? 0),
                high: Number(row.high ?? 0),
                medium: Number(row.medium ?? 0),
                low: Number(row.low ?? 0),
                info: Number(row.info ?? 0),
              },
            }
          : null,
    },
  }));
}

const REVIEW_RUN_STATUS: Record<string, RunStatus> = {
  queued: "queued",
  running: "running",
  correlating: "running",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
};

// ── Problems ─────────────────────────────────────────────────────────────────

/** Runs of every kind whose unified status is `failed`, keyed by their last attempt. */
async function failedRuns(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    id: string;
    kind: RunKind;
    organization_id: string;
    updated_at: string;
    last_attempt_id: string | null;
    error: string | null;
  }>(sql`
    select runs.id, runs.kind, runs.organization_id, ${iso("runs.updated_at")} as updated_at,
      la.id as last_attempt_id,
      coalesce(
        (select rr.error from ralph_runs rr where rr.id = runs.id),
        (select vr.error from review_runs vr where vr.id = runs.id),
        (select t.last_result ->> 'error' from triage_runs t where t.id = runs.id),
        la.error) as error
    from (${runIndexSql()}) runs
    left join lateral (
      select j.id, j.error from jobs j
      where (runs.kind in ('epic', 'request') and j.ralph_run_id = runs.id)
        or (runs.kind = 'review' and j.review_run_id = runs.id)
        or (runs.kind = 'triage' and j.triage_run_id = runs.id)
        or (runs.kind = 'ask' and j.chat_thread_run_id = runs.id)
      order by j.created_at desc, j.id desc limit 1
    ) la on true
    where runs.organization_id in (${scope.orgs}) and runs.status = 'failed'
      and runs.updated_at >= ${scope.cutoff}::timestamptz`);
  return result.rows.map((row) => ({
    key: `failed:${row.id}:${row.last_attempt_id ?? "none"}`,
    tab: "problems",
    organizationId: row.organization_id,
    since: new Date(row.updated_at),
    run: { id: row.id, kind: row.kind },
    facts: { kind: "failed_run", lastAttemptId: row.last_attempt_id, error: row.error },
  }));
}

/** Failed system work: repo syncs, installs and worktree cleanups. */
async function failedSystemAttempts(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    id: string;
    type: string;
    organization_id: string;
    payload: Record<string, unknown>;
    error: string | null;
    repository_id: string | null;
    harness_id: string | null;
    run_id: string | null;
    mode: string | null;
    since: string;
  }>(sql`
    select j.id, j.type, j.organization_id, j.payload, j.error, j.repository_id,
      coalesce(j.harness_id, j.target_harness_id) as harness_id, r.id as run_id, r.mode,
      ${iso("coalesce(j.finished_at, j.created_at)")} as since
    from jobs j left join ralph_runs r on r.id = j.ralph_run_id
    where j.organization_id in (${scope.orgs}) and j.status = 'failed'
      and j.type in (${list(INBOX_SYSTEM_JOB_TYPES)})
      and coalesce(j.finished_at, j.created_at) >= ${scope.cutoff}::timestamptz`);
  return result.rows.map((row) => ({
    key: `failed_attempt:${row.id}`,
    tab: "problems",
    organizationId: row.organization_id,
    since: new Date(row.since),
    run: row.run_id && row.mode ? { id: row.run_id, kind: ralphKind(row.mode) } : null,
    facts: {
      kind: "failed_system",
      job: {
        id: row.id,
        type: row.type,
        status: "failed",
        payload: row.payload ?? {},
        error: row.error,
        repositoryId: row.repository_id,
        harnessId: row.harness_id,
      },
    },
  }));
}

/** Agents that stopped checking in, and agents whose update failed. */
async function agentProblems(
  db: Queryable,
  scope: Scope,
  onlineWindowMs: number,
): Promise<InboxCandidate[]> {
  const result = await db.execute<{
    id: string;
    name: string;
    organization_id: string;
    last_heartbeat_at: string | null;
    offline: boolean;
    update_error: string | null;
    update_version: string | null;
    desired_failed: string | null;
    updated_at: string;
  }>(sql`
    select h.id, h.name, h.organization_id, ${iso("h.last_heartbeat_at")} as last_heartbeat_at,
      (h.last_heartbeat_at < ${scope.now}::timestamptz - make_interval(secs => ${onlineWindowMs / 1000}))
        as offline,
      h.update_state ->> 'error' as update_error, h.update_state ->> 'version' as update_version,
      (case when d.version = any(h.failed_versions) then d.version end) as desired_failed,
      ${iso("h.updated_at")} as updated_at
    from harnesses h
    left join lateral (
      select coalesce(h.desired_version,
        (select s.value #>> '{}' from app_settings s
          where s.organization_id = h.organization_id
            and s.key = ${DESIRED_HARNESS_VERSION_KEY} and jsonb_typeof(s.value) = 'string'))
        as version
    ) d on true
    where h.organization_id in (${scope.orgs}) and h.revoked_at is null and h.deleted_at is null
      and h.last_heartbeat_at is not null`);
  const items: InboxCandidate[] = [];
  for (const row of result.rows) {
    const agent = { id: row.id, name: row.name };
    const base = { tab: "problems" as const, organizationId: row.organization_id, run: null };
    if (row.offline && row.last_heartbeat_at) {
      items.push({
        ...base,
        key: `agent_offline:${row.id}:${row.last_heartbeat_at}`,
        since: new Date(row.last_heartbeat_at),
        facts: { kind: "agent_offline", agent, lastHeartbeatAt: row.last_heartbeat_at },
      });
    }
    const version = row.update_error
      ? (row.update_version ?? row.desired_failed ?? "unknown")
      : row.desired_failed;
    if (version) {
      items.push({
        ...base,
        key: `agent_update:${row.id}:${version}`,
        since: new Date(row.updated_at),
        facts: { kind: "agent_update_failed", agent, version, error: row.update_error },
      });
    }
  }
  return items;
}

// ── Running ──────────────────────────────────────────────────────────────────

async function runningRuns(db: Queryable, scope: Scope): Promise<InboxCandidate[]> {
  const result = await db.execute<RunIndexRow>(sql`
    select ${indexColumns} from (${runIndexSql()}) runs
    where runs.organization_id in (${scope.orgs}) and runs.status in ('queued', 'running')
      and runs.created_at >= ${scope.cutoff}::timestamptz`);
  return result.rows.map((row) => {
    const entry = indexEntry(row);
    return {
      key: `running:${entry.id}`,
      tab: "running",
      organizationId: entry.organizationId,
      since: entry.createdAt,
      run: { id: entry.id, kind: entry.kind },
      facts: { kind: "run", status: entry.status },
    };
  });
}

// ── Feed ─────────────────────────────────────────────────────────────────────

/** The queries of each tab, each one query whatever the number of runs. */
function tabQueries(
  db: Queryable,
  scope: Scope,
  onlineWindowMs: number,
): Record<InboxTab, (() => Promise<InboxCandidate[]>)[]> {
  return {
    needs_you: [
      () => manualStories(db, scope),
      () => ralphRunItems(db, scope),
      () => cleanupQuestions(db, scope),
      () => permissionRequests(db, scope),
      () => readyPrds(db, scope),
      () => waitingPullRequests(db, scope),
    ],
    problems: [
      () => failedRuns(db, scope),
      () => failedSystemAttempts(db, scope),
      () => agentProblems(db, scope, onlineWindowMs),
    ],
    running: [() => runningRuns(db, scope)],
  };
}

/** The keys of `keys` the user marked Done, or snoozed until after `now`. */
async function hiddenKeys(
  db: Queryable,
  userId: string,
  keys: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ key: inboxItemStates.itemKey })
    .from(inboxItemStates)
    .where(
      and(
        eq(inboxItemStates.userId, userId),
        inArray(inboxItemStates.itemKey, [...keys]),
        or(
          eq(inboxItemStates.state, "done"),
          and(eq(inboxItemStates.state, "snoozed"), gt(inboxItemStates.snoozedUntil, now)),
        ),
      ),
    );
  return new Set(rows.map((r) => r.key));
}

/** Every item of the organizations' tabs, one per key, whatever the user's Done and Snooze. */
async function deriveInboxItems(
  db: Queryable,
  query: Omit<InboxQuery, "userId" | "tab">,
  tabs: readonly InboxTab[],
  now: Date,
): Promise<Map<string, InboxCandidate>> {
  const scope: Scope = {
    orgs: list(query.organizationIds),
    now: now.toISOString(),
    cutoff: new Date(now.getTime() - INBOX_WINDOW_DAYS * 86_400_000).toISOString(),
  };
  const queries = tabQueries(db, scope, query.onlineWindowMs);
  const found = (await Promise.all(tabs.flatMap((tab) => queries[tab]).map((q) => q()))).flat();
  // One item per key (a key is what the user marks).
  return new Map(found.map((item) => [item.key, item]));
}

/**
 * The user's Inbox items of the organizations (one tab, or all), newest first, without the
 * ones they marked Done or snoozed into the future.
 */
export async function listInboxItems(db: Queryable, query: InboxQuery): Promise<InboxCandidate[]> {
  if (query.organizationIds.length === 0) return [];
  const now = query.now ?? new Date();
  const byKey = await deriveInboxItems(db, query, query.tab ? [query.tab] : INBOX_TABS, now);
  const hidden = await hiddenKeys(db, query.userId, [...byKey.keys()], now);
  return [...byKey.values()]
    .filter((item) => !hidden.has(item.key))
    .sort((a, b) => b.since.getTime() - a.since.getTime() || a.key.localeCompare(b.key));
}

/** The tab of each key prefix (`manual_story:{storyId}` → Needs you, …). */
const TAB_OF_KEY_PREFIX: Record<string, InboxTab> = {
  manual_story: "needs_you",
  blocked: "needs_you",
  question: "needs_you",
  stopped: "needs_you",
  prd_ready: "needs_you",
  pr: "needs_you",
  failed: "problems",
  failed_attempt: "problems",
  agent_offline: "problems",
  agent_update: "problems",
  running: "running",
};

/**
 * The item `key` derives in the organizations today, whether or not the user marked it Done
 * or snoozed it; null when it derives none (it was handled, or what made it new changed).
 * Queries only the key's tab.
 */
export async function findInboxItem(
  db: Queryable,
  query: Omit<InboxQuery, "userId" | "tab"> & { key: string },
): Promise<InboxCandidate | null> {
  const prefix = query.key.slice(0, query.key.indexOf(":"));
  const tab = Object.hasOwn(TAB_OF_KEY_PREFIX, prefix) ? TAB_OF_KEY_PREFIX[prefix] : undefined;
  if (!tab || query.organizationIds.length === 0) return null;
  const byKey = await deriveInboxItems(db, query, [tab], query.now ?? new Date());
  return byKey.get(query.key) ?? null;
}

export interface InboxItemStateKey {
  userId: string;
  organizationId: string;
  key: string;
}

/**
 * Marks an item Done (`snoozedUntil` null) or snoozed until `snoozedUntil`, for the user only
 * (an `inbox_state` change on their channel).
 */
export async function setInboxItemState(
  db: Queryable,
  item: InboxItemStateKey & { state: "done" | "snoozed"; snoozedUntil: Date | null },
): Promise<void> {
  const snoozedUntil = item.state === "snoozed" ? item.snoozedUntil : null;
  await db
    .insert(inboxItemStates)
    .values({
      userId: item.userId,
      organizationId: item.organizationId,
      itemKey: item.key,
      state: item.state,
      snoozedUntil,
    })
    .onConflictDoUpdate({
      target: [inboxItemStates.userId, inboxItemStates.itemKey],
      set: {
        organizationId: item.organizationId,
        state: item.state,
        snoozedUntil,
        updatedAt: sql`now()`,
      },
    });
  recordChange(db, {
    resource: "inbox_state",
    ids: [item.key],
    organizationId: item.organizationId,
    userId: item.userId,
  });
}

/** Restores an item the user marked Done or snoozed (an `inbox_state` change on their channel). */
export async function clearInboxItemState(db: Queryable, item: InboxItemStateKey): Promise<void> {
  await db
    .delete(inboxItemStates)
    .where(and(eq(inboxItemStates.userId, item.userId), eq(inboxItemStates.itemKey, item.key)));
  recordChange(db, {
    resource: "inbox_state",
    ids: [item.key],
    organizationId: item.organizationId,
    userId: item.userId,
  });
}

/** Days after its last update an item's Done or Snooze is pruned. */
export const INBOX_ITEM_STATE_RETENTION_DAYS = 60;

/** Deletes Done and Snooze states not updated for `INBOX_ITEM_STATE_RETENTION_DAYS`; their count. */
export async function pruneInboxItemStates(db: Queryable, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INBOX_ITEM_STATE_RETENTION_DAYS * 86_400_000);
  const deleted = await db
    .delete(inboxItemStates)
    .where(lt(inboxItemStates.updatedAt, cutoff))
    .returning({ key: inboxItemStates.itemKey });
  return deleted.length;
}

export type InboxCounts = Record<InboxTab, number>;

/** How many items each tab has for the user (`listInboxItems` of all tabs, counted). */
export async function countInboxItems(
  db: Queryable,
  query: Omit<InboxQuery, "tab">,
): Promise<InboxCounts> {
  const items = await listInboxItems(db, query);
  const counts: InboxCounts = { needs_you: 0, problems: 0, running: 0 };
  for (const item of items) counts[item.tab] += 1;
  return counts;
}

/** What the items refer to beyond their runs: repos of lanes and system work, and agents. */
export interface InboxReferences {
  repositories: Map<string, RunRepository>;
  agents: Map<string, { id: string; name: string }>;
}

/** The repositories and agents the items name (two queries at most). */
export async function loadInboxReferences(
  db: Queryable,
  items: readonly InboxCandidate[],
): Promise<InboxReferences> {
  const repositoryIds = new Set<string>();
  const harnessIds = new Set<string>();
  for (const { facts } of items) {
    if (facts.kind === "pr_waiting") repositoryIds.add(facts.lane.repositoryId);
    if (facts.kind === "failed_system") {
      if (facts.job.repositoryId) repositoryIds.add(facts.job.repositoryId);
      if (facts.job.harnessId) harnessIds.add(facts.job.harnessId);
    }
  }
  const [repos, agents] = await Promise.all([
    repositoryIds.size
      ? db.execute<{
          id: string;
          provider: "github" | "gitlab";
          full_path: string;
          base_url: string;
        }>(
          sql`select r.id, r.provider, r.full_path, c.base_url from repositories r
            join scm_connections c on c.id = r.connection_id where r.id in (${list([...repositoryIds])})`,
        )
      : null,
    harnessIds.size
      ? db.execute<{ id: string; name: string }>(
          sql`select h.id, h.name from harnesses h
            where h.id in (${list([...harnessIds])}) and h.deleted_at is null`,
        )
      : null,
  ]);
  return {
    repositories: new Map(
      (repos?.rows ?? []).map((r) => [
        r.id,
        { id: r.id, provider: r.provider, fullPath: r.full_path, baseUrl: r.base_url },
      ]),
    ),
    agents: new Map((agents?.rows ?? []).map((h) => [h.id, { id: h.id, name: h.name }])),
  };
}
