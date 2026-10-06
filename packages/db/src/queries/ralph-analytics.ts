/**
 * Ralph analytics (the Analytics page's Ralph section): token usage of
 * `ralph.*` jobs, runs started per day by their status, and the outcomes of
 * those runs' stories, over the same windows as `getAnalytics`.
 *
 * Tokens are the `usage` ralph jobs record in their results, attributed to the
 * day the job was created. Runs are attributed to the day they started, and
 * their stories to their run, so the story outcomes describe the runs started
 * in the window.
 */
import { and, eq, gte, like, lt, sql, type SQL } from "drizzle-orm";
import type { Database } from "../client.js";
import { jobs, ralphRuns, ralphStories } from "../schema.js";
import { analyticsWindow, type AnalyticsFilter } from "./analytics.js";

/**
 * How a run started in the window stands: its final status, or `running` for
 * one that is still pending or running.
 */
export const RALPH_RUN_OUTCOMES = ["completed", "waiting", "stopped", "failed", "running"] as const;
export type RalphRunOutcome = (typeof RALPH_RUN_OUTCOMES)[number];

export interface RalphDailyUsage {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  /** Tokens of the `ralph.*` jobs created that day. */
  tokensIn: number;
  tokensOut: number;
  /** Runs started that day, by how they stand now. */
  runs: Record<RalphRunOutcome, number>;
}

export interface RalphStoryOutcomes {
  /** Completed by their first attempt. */
  firstAttempt: number;
  /** Completed after one or more failed attempts. */
  afterRetries: number;
  /** Out of attempts (not counting blocked ones). */
  exhausted: number;
  /** Set aside because their session reported them blocked. */
  blocked: number;
}

export interface RalphAnalytics {
  /** First instant of the window (UTC midnight). */
  from: Date;
  /** End of the window, exclusive (UTC midnight after the last day). */
  to: Date;
  totals: { runs: number; jobs: number; tokensIn: number; tokensOut: number };
  /** One entry per UTC day in the window, oldest first, zero-filled. */
  daily: RalphDailyUsage[];
  runsByOutcome: Record<RalphRunOutcome, number>;
  storyOutcomes: RalphStoryOutcomes;
  /** Mean attempts of the completed stories (0 when there are none). */
  averageAttempts: number;
}

const DAY_MS = 86_400_000;

/** Postgres aggregates come back as strings (bigint/numeric) or null. */
const num = (value: unknown): number => (value == null ? 0 : Number(value));

const emptyRuns = (): Record<RalphRunOutcome, number> =>
  Object.fromEntries(RALPH_RUN_OUTCOMES.map((o) => [o, 0])) as Record<RalphRunOutcome, number>;

function runOutcome(status: (typeof ralphRuns.$inferSelect)["status"]): RalphRunOutcome {
  return status === "pending" ? "running" : status;
}

export async function getRalphAnalytics(
  db: Database,
  filter: AnalyticsFilter,
): Promise<RalphAnalytics> {
  const { from, to } = analyticsWindow(filter.days, filter.now);
  const runWhere: SQL = and(
    gte(ralphRuns.createdAt, from),
    lt(ralphRuns.createdAt, to),
    filter.repositoryId ? eq(ralphRuns.repositoryId, filter.repositoryId) : undefined,
  )!;
  const jobWhere: SQL = and(
    like(jobs.type, "ralph.%"),
    gte(jobs.createdAt, from),
    lt(jobs.createdAt, to),
    filter.repositoryId ? eq(jobs.repositoryId, filter.repositoryId) : undefined,
  )!;

  const jobDay = sql<string>`to_char(${jobs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const runDay = sql<string>`to_char(${ralphRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const tokens = (field: "inputTokens" | "outputTokens") =>
    sql<string>`sum(coalesce((${jobs.result} -> 'usage' ->> ${sql.raw(`'${field}'`)})::bigint, 0))`;
  // The story's last job is the attempt that set it aside: blocked if its session said so.
  const lastJob = sql`(select ${jobs.result} ->> 'status' from ${jobs} where ${jobs.id} = ${ralphStories.lastJobId})`;
  const blocked = sql`(${ralphStories.status} = 'blocked' or (${ralphStories.status} = 'exhausted' and coalesce(${lastJob}, '') = 'blocked'))`;
  const completed = sql`${ralphStories.status} = 'completed'`;

  const [tokenRows, runRows, [storyRow]] = await Promise.all([
    db
      .select({
        day: jobDay,
        jobs: sql<string>`count(*)`,
        tokensIn: tokens("inputTokens"),
        tokensOut: tokens("outputTokens"),
      })
      .from(jobs)
      .where(jobWhere)
      .groupBy(jobDay),
    db
      .select({ day: runDay, status: ralphRuns.status, count: sql<string>`count(*)` })
      .from(ralphRuns)
      .where(runWhere)
      .groupBy(runDay, ralphRuns.status),
    db
      .select({
        firstAttempt: sql<string>`count(*) filter (where ${completed} and ${ralphStories.attempts} <= 1)`,
        afterRetries: sql<string>`count(*) filter (where ${completed} and ${ralphStories.attempts} > 1)`,
        exhausted: sql<string>`count(*) filter (where ${ralphStories.status} = 'exhausted' and not ${blocked})`,
        blocked: sql<string>`count(*) filter (where ${blocked})`,
        averageAttempts: sql<string>`avg(greatest(${ralphStories.attempts}, 1)) filter (where ${completed})`,
      })
      .from(ralphStories)
      .innerJoin(ralphRuns, eq(ralphRuns.id, ralphStories.runId))
      .where(runWhere),
  ]);

  const tokensByDay = new Map(tokenRows.map((row) => [row.day, row]));
  const runsByDay = new Map<string, Record<RalphRunOutcome, number>>();
  const runsByOutcome = emptyRuns();
  for (const row of runRows) {
    const outcome = runOutcome(row.status);
    const runs = runsByDay.get(row.day) ?? emptyRuns();
    runs[outcome] += num(row.count);
    runsByDay.set(row.day, runs);
    runsByOutcome[outcome] += num(row.count);
  }

  const daily: RalphDailyUsage[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = tokensByDay.get(date);
    daily.push({
      date,
      tokensIn: num(row?.tokensIn),
      tokensOut: num(row?.tokensOut),
      runs: runsByDay.get(date) ?? emptyRuns(),
    });
  }

  return {
    from,
    to,
    totals: {
      runs: Object.values(runsByOutcome).reduce((a, b) => a + b, 0),
      jobs: tokenRows.reduce((sum, row) => sum + num(row.jobs), 0),
      tokensIn: daily.reduce((sum, d) => sum + d.tokensIn, 0),
      tokensOut: daily.reduce((sum, d) => sum + d.tokensOut, 0),
    },
    daily,
    runsByOutcome,
    storyOutcomes: {
      firstAttempt: num(storyRow?.firstAttempt),
      afterRetries: num(storyRow?.afterRetries),
      exhausted: num(storyRow?.exhausted),
      blocked: num(storyRow?.blocked),
    },
    averageAttempts: Math.round(num(storyRow?.averageAttempts) * 10) / 10,
  };
}
