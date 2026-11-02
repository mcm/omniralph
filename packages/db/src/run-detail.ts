/**
 * A run's detail on top of the read model (`run-index.ts`): its attempts (the jobs that
 * link to it), its steps (an epic's stories, a review's passes and correlation), its lanes
 * and the transcript of one attempt (`run_activities`).
 */
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import type { RunIndexEntry } from "./run-index.js";
import type { IntegrationProvider } from "./integrations.js";
import type {
  JobWaitingReason,
  RalphEpicAudit,
  RalphTaskVerification,
  RalphWaitingOn,
} from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', ${ISO_US})`);
const date = (value: string | null) => (value ? new Date(value) : null);

/** The jobs (`j`) that are attempts of `run`: by its kind's link column. */
function attemptsOf(run: Pick<RunIndexEntry, "id" | "kind">): SQL {
  switch (run.kind) {
    case "epic":
    case "request":
      return sql`j.ralph_run_id = ${run.id}::uuid`;
    case "review":
      return sql`(j.review_run_id = ${run.id}::uuid or j.id =
        (select rr.correlation_job_id from review_runs rr where rr.id = ${run.id}::uuid))`;
    case "triage":
      return sql`j.triage_run_id = ${run.id}::uuid`;
    case "ask":
      return sql`(j.chat_thread_run_id = ${run.id}::uuid or j.id =
        (select c.job_id from chat_thread_runs c where c.id = ${run.id}::uuid))`;
  }
}

/**
 * The waiting reason (`jobs.waiting_reason`) of the newest attempt of each run in `runs`
 * (an alias of the run index with `id` and `kind`), as a correlated subquery: null when it
 * has none or no attempt.
 */
export function latestAttemptWaitingReasonSql(runs: string): SQL {
  const id = sql.raw(`${runs}.id`);
  const kind = sql.raw(`${runs}.kind`);
  return sql`(select j.waiting_reason from jobs j
    where (${kind} in ('epic', 'request') and j.ralph_run_id = ${id})
      or (${kind} = 'review' and (j.review_run_id = ${id} or j.id =
        (select rr.correlation_job_id from review_runs rr where rr.id = ${id})))
      or (${kind} = 'triage' and j.triage_run_id = ${id})
      or (${kind} = 'ask' and (j.chat_thread_run_id = ${id} or j.id =
        (select c.job_id from chat_thread_runs c where c.id = ${id})))
    order by j.created_at desc, j.id desc limit 1)`;
}

/** One attempt (job) of a run. */
export interface RunAttemptEntry {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled" | "expired" | "skipped";
  agent: { id: string; name: string } | null;
  /** How often it was handed to an agent. */
  deliveries: number;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Its session's token usage (`jobs.result.usage`). */
  tokens: { in: number; out: number };
  error: string | null;
  /** The ralph story it works on. */
  storyId: string | null;
  /** The review (pass) a review task (or legacy `review.run`) job ran. */
  reviewId: string | null;
  /** Its transcript's length (`run_activities`). */
  transcriptEvents: number;
  /** Why it waits while `queued` (`refreshHostToolWaits`); null when nothing holds it up. */
  waitingReason: JobWaitingReason | null;
}

/** The attempts of `run`, newest first. */
export async function listRunAttempts(
  db: Queryable,
  run: Pick<RunIndexEntry, "id" | "kind">,
): Promise<RunAttemptEntry[]> {
  const result = await db.execute<{
    id: string;
    type: string;
    status: RunAttemptEntry["status"];
    agent_id: string | null;
    agent_name: string | null;
    delivery_count: number;
    cancel_requested: boolean;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    tokens_in: string;
    tokens_out: string;
    error: string | null;
    ralph_story_id: string | null;
    review_id: string | null;
    activities: string;
    waiting_reason: JobWaitingReason | null;
  }>(sql`
    select j.id, j.type, j.status, j.agent_id, h.name as agent_name, j.delivery_count,
      j.cancel_requested, ${iso("j.created_at")} as created_at, ${iso("j.started_at")} as started_at,
      ${iso("j.finished_at")} as finished_at,
      coalesce((j.result -> 'usage' ->> 'inputTokens')::bigint, 0)::text as tokens_in,
      coalesce((j.result -> 'usage' ->> 'outputTokens')::bigint, 0)::text as tokens_out,
      j.error, j.ralph_story_id,
      -- Legacy review.run jobs carry the review ID at the payload's top level.
      (case when j.type in ('review.task', 'review.run')
        then coalesce(j.payload -> 'trigger' -> 'context' ->> 'reviewId', j.payload ->> 'reviewId')
        end) as review_id,
      (select count(*) from run_activities a where a.job_id = j.id)::text as activities,
      j.waiting_reason
    from jobs j
    left join agents h on h.id = j.agent_id
    where ${attemptsOf(run)}
    order by j.created_at desc, j.id desc`);
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    agent: row.agent_id && row.agent_name ? { id: row.agent_id, name: row.agent_name } : null,
    deliveries: Number(row.delivery_count),
    cancelRequested: row.cancel_requested,
    createdAt: new Date(row.created_at),
    startedAt: date(row.started_at),
    finishedAt: date(row.finished_at),
    tokens: { in: Number(row.tokens_in), out: Number(row.tokens_out) },
    error: row.error,
    storyId: row.ralph_story_id,
    reviewId: row.review_id,
    transcriptEvents: Number(row.activities),
    waitingReason: row.waiting_reason,
  }));
}

/** Whether the job `attemptId` is an attempt of `run`. */
export async function isRunAttempt(
  db: Queryable,
  run: Pick<RunIndexEntry, "id" | "kind">,
  attemptId: string,
): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    select j.id from jobs j where j.id = ${attemptId}::uuid and ${attemptsOf(run)} limit 1`);
  return result.rows.length > 0;
}

// ── Ralph runs: stories and lanes ────────────────────────────────────────────

/** A lane of a ralph run: one repository's branch and PR/MR. */
export interface RunLaneEntry {
  id: string;
  repository: { id: string; provider: "github" | "gitlab"; fullPath: string; baseUrl: string };
  branch: string;
  baseBranch: string;
  pullRequest: {
    number: number;
    url: string | null;
    merged: boolean;
    closed: boolean;
    draft: boolean;
    reviewState: "none" | "review_requested" | "commented" | "changes_requested" | "approved";
  } | null;
  /** Whether it is the lane of the run's own repository. */
  main: boolean;
}

/** An epic's story. */
export interface RunStoryEntry {
  id: string;
  identifier: string;
  title: string;
  status: "pending" | "running" | "completed" | "blocked" | "exhausted" | "manual" | "canceled";
  /** Finished attempts, as the run counts them. */
  attempts: number;
  /** Sum of its attempts' `started_at` → `finished_at`, in milliseconds. */
  durationMs: number;
  commitSha: string | null;
  lastFeedback: string | null;
  laneId: string | null;
  /** Why it is manual although it isn't labelled so (it routes elsewhere). */
  elsewhere: string | null;
  /** The task verifier's checks of its attempts, oldest first. */
  verifications: RalphTaskVerification[];
}

/** What only a ralph run's detail shows. */
export interface RalphRunDetailFacts {
  routedBy: string | null;
  error: string | null;
  waitingOn: RalphWaitingOn | null;
  /** The run's tracker. */
  trackerProvider: IntegrationProvider;
  trackerIssueUrl: string | null;
  /**
   * In execution order: the stories that have run by their first attempt, then the rest in
   * their stored (sub-issue) order.
   */
  stories: RunStoryEntry[];
  lanes: RunLaneEntry[];
  /** The epic's audits against its requirements, oldest first. */
  audits: RalphEpicAudit[];
}

export async function getRalphRunDetailFacts(
  db: Queryable,
  runId: string,
): Promise<RalphRunDetailFacts | null> {
  const [runs, stories, lanes] = await Promise.all([
    db.execute<{
      routed_by: string | null;
      error: string | null;
      waiting_on: RalphWaitingOn | null;
      tracker_provider: IntegrationProvider;
      tracker_url: string | null;
      audits: RalphEpicAudit[] | null;
    }>(sql`select r.routed_by, r.error, r.waiting_on, r.tracker_provider, r.tracker_url, r.audits
      from ralph_runs r
      where r.id = ${runId}::uuid`),
    db.execute<{
      id: string;
      identifier: string;
      title: string;
      status: RunStoryEntry["status"];
      attempts: number;
      duration_ms: string;
      commit_sha: string | null;
      last_feedback: string | null;
      lane_id: string | null;
      elsewhere: string | null;
      verifications: RalphTaskVerification[] | null;
    }>(sql`
      select s.id, s.identifier, s.title, s.status, s.attempts, s.commit_sha, s.last_feedback,
        s.lane_id, s.elsewhere, s.verifications,
        (select coalesce(sum(extract(epoch from (j.finished_at - j.started_at)) * 1000), 0)
          from jobs j where j.ralph_story_id = s.id
            and j.started_at is not null and j.finished_at is not null)::bigint::text as duration_ms
      from ralph_stories s where s.run_id = ${runId}::uuid
      order by
        (select min(j.created_at) from jobs j where j.ralph_story_id = s.id) asc nulls last,
        s.position, s.created_at, s.id`),
    db.execute<{
      id: string;
      repository_id: string;
      provider: "github" | "gitlab";
      full_path: string;
      base_url: string;
      branch: string;
      base_branch: string;
      pr_number: number | null;
      pr_url: string | null;
      pr_merged: boolean;
      pr_closed: boolean;
      pr_draft: boolean;
      pr_review_state: NonNullable<RunLaneEntry["pullRequest"]>["reviewState"];
      main: boolean;
    }>(sql`
      select l.id, l.repository_id, rp.provider, rp.full_path, c.base_url, l.branch,
        l.base_branch, l.pr_number, l.pr_url, l.pr_merged, l.pr_closed, l.pr_draft,
        l.pr_review_state, (l.repository_id = r.repository_id) as main
      from ralph_lanes l
      join ralph_runs r on r.id = l.run_id
      join repositories rp on rp.id = l.repository_id
      join scm_connections c on c.id = rp.connection_id
      where l.run_id = ${runId}::uuid
      order by (l.repository_id = r.repository_id) desc nulls last, l.created_at, l.id`),
  ]);
  const run = runs.rows[0];
  if (!run) return null;
  return {
    routedBy: run.routed_by,
    error: run.error,
    waitingOn: run.waiting_on,
    trackerProvider: run.tracker_provider,
    trackerIssueUrl: run.tracker_url,
    audits: run.audits ?? [],
    stories: stories.rows.map((s) => ({
      id: s.id,
      identifier: s.identifier,
      title: s.title,
      status: s.status,
      attempts: Number(s.attempts),
      durationMs: Number(s.duration_ms),
      commitSha: s.commit_sha,
      lastFeedback: s.last_feedback,
      laneId: s.lane_id,
      elsewhere: s.elsewhere,
      verifications: s.verifications ?? [],
    })),
    lanes: lanes.rows.map((l) => ({
      id: l.id,
      repository: {
        id: l.repository_id,
        provider: l.provider,
        fullPath: l.full_path,
        baseUrl: l.base_url,
      },
      branch: l.branch,
      baseBranch: l.base_branch,
      pullRequest:
        l.pr_number !== null
          ? {
              number: l.pr_number,
              url: l.pr_url,
              merged: l.pr_merged,
              closed: l.pr_closed,
              draft: l.pr_draft,
              reviewState: l.pr_review_state,
            }
          : null,
      main: Boolean(l.main),
    })),
  };
}

// ── Review runs: passes and correlation ──────────────────────────────────────

/** Open findings of a pass, by severity. */
export interface FindingSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

/** One pass (a `reviews` row: one review task) of a review run. */
export interface ReviewPassEntry {
  id: string;
  /** The review task (`builtin:review-pr` or a UUID); null for legacy reviews. */
  taskId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "budget_exhausted" | "skipped";
  tokens: { in: number; out: number };
  durationMs: number | null;
  openFindings: FindingSeverityCounts;
  error: string | null;
}

/** What only a review run's detail shows. */
export interface ReviewRunDetailFacts {
  mode: "incremental" | "full" | "fresh";
  headSha: string;
  baseSha: string;
  error: string | null;
  passes: ReviewPassEntry[];
  /** The job that merges the passes' results; null without one (yet). */
  correlationJobId: string | null;
  /** A ralph lane of the PR/MR: whether it was merged or closed. */
  lane: { merged: boolean; closed: boolean } | null;
}

export async function getReviewRunDetailFacts(
  db: Queryable,
  runId: string,
): Promise<ReviewRunDetailFacts | null> {
  const [runs, passes] = await Promise.all([
    db.execute<{
      mode: ReviewRunDetailFacts["mode"];
      head_sha: string;
      base_sha: string;
      error: string | null;
      correlation_job_id: string | null;
      lane_merged: boolean | null;
      lane_closed: boolean | null;
    }>(sql`
      select rr.mode, rr.head_sha, rr.base_sha, rr.error, rr.correlation_job_id,
        l.pr_merged as lane_merged, l.pr_closed as lane_closed
      from review_runs rr
      left join lateral (
        select l.pr_merged, l.pr_closed from ralph_lanes l
        where l.repository_id = rr.repository_id and l.pr_number = rr.pr_number
        order by l.created_at desc limit 1
      ) l on true
      where rr.id = ${runId}::uuid`),
    db.execute<{
      id: string;
      task_id: string | null;
      status: ReviewPassEntry["status"];
      tokens_in: number;
      tokens_out: number;
      duration_ms: number | null;
      error: string | null;
      critical: string;
      high: string;
      medium: string;
      low: string;
      info: string;
    }>(sql`
      select rv.id, rv.task_id, rv.status, rv.tokens_in, rv.tokens_out, rv.duration_ms, rv.error,
        count(f.id) filter (where f.severity = 'critical')::text as critical,
        count(f.id) filter (where f.severity = 'high')::text as high,
        count(f.id) filter (where f.severity = 'medium')::text as medium,
        count(f.id) filter (where f.severity = 'low')::text as low,
        count(f.id) filter (where f.severity = 'info')::text as info
      from reviews rv
      left join findings f on f.review_id = rv.id and f.status = 'open'
      where rv.review_run_id = ${runId}::uuid
      group by rv.id
      order by rv.created_at, rv.id`),
  ]);
  const run = runs.rows[0];
  if (!run) return null;
  return {
    mode: run.mode,
    headSha: run.head_sha,
    baseSha: run.base_sha,
    error: run.error,
    correlationJobId: run.correlation_job_id,
    lane:
      run.lane_merged !== null
        ? { merged: Boolean(run.lane_merged), closed: Boolean(run.lane_closed) }
        : null,
    passes: passes.rows.map((p) => ({
      id: p.id,
      taskId: p.task_id,
      status: p.status,
      tokens: { in: Number(p.tokens_in), out: Number(p.tokens_out) },
      durationMs: p.duration_ms === null ? null : Number(p.duration_ms),
      error: p.error,
      openFindings: {
        critical: Number(p.critical),
        high: Number(p.high),
        medium: Number(p.medium),
        low: Number(p.low),
        info: Number(p.info),
      },
    })),
  };
}

// ── Transcript ───────────────────────────────────────────────────────────────

/** The position after which a transcript page starts: its last event. */
export interface TranscriptCursor {
  /** `created_at` to the microsecond (UTC ISO). */
  at: string;
  id: string;
}

export interface TranscriptEvent {
  id: string;
  type: "thought" | "action";
  body: string;
  parameter: string | null;
  at: Date;
}

export interface TranscriptPage {
  events: TranscriptEvent[];
  next: TranscriptCursor | null;
}

/** A page of the transcript of the job `attemptId`, oldest first. */
export async function listAttemptTranscript(
  db: Queryable,
  attemptId: string,
  { cursor, limit = 200 }: { cursor?: TranscriptCursor | null; limit?: number } = {},
): Promise<TranscriptPage> {
  const size = Math.max(1, Math.floor(limit));
  const result = await db.execute<{
    id: string;
    type: TranscriptEvent["type"];
    body: string;
    parameter: string | null;
    at: string;
  }>(sql`
    select a.id, a.type, a.body, a.parameter, ${iso("a.created_at")} as at
    from run_activities a
    where a.job_id = ${attemptId}::uuid
      ${cursor ? sql`and (a.created_at, a.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
    order by a.created_at, a.id
    limit ${size + 1}`);
  const rows = result.rows.slice(0, size);
  const last = rows.at(-1);
  return {
    events: rows.map((row) => ({
      id: row.id,
      type: row.type,
      body: row.body,
      parameter: row.parameter,
      at: new Date(row.at),
    })),
    next: result.rows.length > size && last ? { at: last.at, id: last.id } : null,
  };
}
