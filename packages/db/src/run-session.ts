/**
 * An epic's or request's Session (`GET /api/ui/runs/{id}/session`): what was said to Om
 * while the run worked. Its pending requests, the messages for its attempts' live
 * sessions (newest first, a page at a time), its guidance, its stories'
 * recommendations and its progress log.
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import type { ScmProvider } from "./repositories.js";
import {
  agents,
  jobs,
  ralphLanes,
  ralphMessages,
  ralphRuns,
  ralphStories,
  repositories,
  type RalphGuidance,
} from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Messages per page of a run's Session. */
export const RUN_SESSION_MESSAGE_LIMIT = 50;

const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** The position after which a page of messages starts: its last (oldest) message. */
export interface RunSessionCursor {
  /** `created_at` to the microsecond (UTC ISO). */
  at: string;
  id: string;
}

export interface RunSessionRepository {
  id: string;
  provider: ScmProvider;
  fullPath: string;
}

/** A request waiting to be handled (`listPendingRequests`'s), with the repo it is for. */
export interface RunSessionRequest {
  id: string;
  text: string;
  author: string | null;
  createdAt: Date;
  /** Its lane's repo (the main lane's when it names none); null while the run has none. */
  repository: RunSessionRepository | null;
}

/** A message for one of the run's attempts (a job's live session). */
export interface RunSessionMessage {
  id: string;
  kind: "guidance" | "request";
  text: string;
  author: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  consumedAt: Date | null;
  /** The attempt it was for, with what its label mentions. */
  attempt: {
    id: string;
    type: string;
    status: "queued" | "running" | "completed" | "failed" | "canceled" | "expired" | "skipped";
    /** The story the attempt worked on (its work item identifier). */
    story: string | null;
    agent: string | null;
  };
}

export interface RunSessionMessagePage {
  messages: RunSessionMessage[];
  next: RunSessionCursor | null;
}

/** Advice a story's sessions gave for another project or repository. */
export interface RunSessionRecommendation {
  story: { id: string; identifier: string; title: string };
  title: string;
  description: string;
  /** ISO timestamp of the result that last gave it. */
  at: string;
}

export interface RunSessionFacts extends RunSessionMessagePage {
  pendingRequests: RunSessionRequest[];
  /** Newest first. */
  guidance: RalphGuidance[];
  /** In story (sub-issue) order. */
  recommendations: RunSessionRecommendation[];
  progressLog: string;
}

/**
 * A page of the run's messages for its attempts, newest first: `limit` (default
 * `RUN_SESSION_MESSAGE_LIMIT`) after `cursor`. A message whose attempt is gone isn't one.
 */
export async function listRunSessionMessages(
  db: Queryable,
  runId: string,
  {
    cursor,
    limit = RUN_SESSION_MESSAGE_LIMIT,
  }: { cursor?: RunSessionCursor | null; limit?: number } = {},
): Promise<RunSessionMessagePage> {
  const size = Math.max(1, Math.floor(limit));
  const rows = await db
    .select({
      message: ralphMessages,
      createdAtKey: sql<string>`to_char(${ralphMessages.createdAt} at time zone 'UTC', ${sql.raw(ISO_US)})`,
      attempt: {
        id: jobs.id,
        type: jobs.type,
        status: jobs.status,
      },
      story: ralphStories.identifier,
      agent: agents.name,
    })
    .from(ralphMessages)
    .innerJoin(jobs, eq(jobs.id, ralphMessages.jobId))
    .leftJoin(ralphStories, eq(ralphStories.id, jobs.ralphStoryId))
    .leftJoin(agents, eq(agents.id, jobs.agentId))
    .where(
      and(
        eq(ralphMessages.runId, runId),
        cursor
          ? sql`(${ralphMessages.createdAt}, ${ralphMessages.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(ralphMessages.createdAt), desc(ralphMessages.id))
    .limit(size + 1);
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    messages: page.map(({ message, attempt, story, agent }) => ({
      id: message.id,
      kind: message.kind,
      text: message.text,
      author: message.author,
      createdAt: message.createdAt,
      deliveredAt: message.deliveredAt,
      consumedAt: message.consumedAt,
      attempt: { ...attempt, story, agent },
    })),
    next: rows.length > size && last ? { at: last.createdAtKey, id: last.message.id } : null,
  };
}

/**
 * The Session of the epic or request `runId`: its pending requests (oldest first), the
 * first page of its messages (or the page after `cursor`), its guidance (newest first),
 * its stories' recommendations and its progress log. Null when the run doesn't exist.
 */
export async function getRunSession(
  db: Queryable,
  runId: string,
  options: { cursor?: RunSessionCursor | null; limit?: number } = {},
): Promise<RunSessionFacts | null> {
  const [run] = await db
    .select({
      repositoryId: ralphRuns.repositoryId,
      guidance: ralphRuns.guidance,
      progress: ralphRuns.progress,
    })
    .from(ralphRuns)
    .where(eq(ralphRuns.id, runId))
    .limit(1);
  if (!run) return null;
  const [requests, page, stories] = await Promise.all([
    db
      .select({
        message: ralphMessages,
        repository: {
          id: repositories.id,
          provider: repositories.provider,
          fullPath: repositories.fullPath,
        },
      })
      .from(ralphMessages)
      .leftJoin(ralphLanes, eq(ralphLanes.id, ralphMessages.laneId))
      .leftJoin(
        repositories,
        eq(repositories.id, sql`coalesce(${ralphLanes.repositoryId}, ${run.repositoryId}::uuid)`),
      )
      // Today's pending requests (`listPendingRequests`): not handled, not waiting for a session.
      .where(
        and(
          eq(ralphMessages.runId, runId),
          eq(ralphMessages.kind, "request"),
          isNull(ralphMessages.jobId),
          isNull(ralphMessages.consumedAt),
        ),
      )
      .orderBy(asc(ralphMessages.createdAt), asc(ralphMessages.id)),
    listRunSessionMessages(db, runId, options),
    db
      .select({
        id: ralphStories.id,
        identifier: ralphStories.identifier,
        title: ralphStories.title,
        recommendations: ralphStories.recommendations,
      })
      .from(ralphStories)
      .where(eq(ralphStories.runId, runId))
      .orderBy(asc(ralphStories.position), asc(ralphStories.createdAt), asc(ralphStories.id)),
  ]);
  return {
    pendingRequests: requests.map(({ message, repository }) => ({
      id: message.id,
      text: message.text,
      author: message.author,
      createdAt: message.createdAt,
      repository,
    })),
    ...page,
    guidance: [...run.guidance].reverse(),
    recommendations: stories.flatMap(({ recommendations, ...story }) =>
      recommendations.map(({ title, description, at }) => ({ story, title, description, at })),
    ),
    progressLog: run.progress,
  };
}
