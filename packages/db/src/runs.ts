/**
 * What a run's session reported (`run_activities`) and the tool calls it asked
 * a person to approve (`run_permission_requests`), stored with the run's job.
 */
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  runActivities,
  runPermissionRequests,
  type RunActivityType,
  type RunPermissionAnswer,
} from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export type RunActivity = typeof runActivities.$inferSelect;
export type RunPermissionRequest = typeof runPermissionRequests.$inferSelect;

export interface NewRunActivityInput {
  jobId: string;
  organizationId: string;
  type: RunActivityType;
  body: string;
  /** An action's parameter; dropped for thoughts. */
  parameter?: string | null;
}

/** Stores an activity of a run's session. */
export async function insertRunActivity(
  db: Queryable,
  input: NewRunActivityInput,
): Promise<RunActivity> {
  const [row] = await db
    .insert(runActivities)
    .values({
      jobId: input.jobId,
      organizationId: input.organizationId,
      type: input.type,
      body: input.body,
      parameter: input.type === "action" ? (input.parameter ?? null) : null,
    })
    .returning();
  return row!;
}

/** A run's activities, oldest first. */
export async function listRunActivities(db: Queryable, jobId: string): Promise<RunActivity[]> {
  return db
    .select()
    .from(runActivities)
    .where(eq(runActivities.jobId, jobId))
    .orderBy(asc(runActivities.createdAt), asc(runActivities.id));
}

export interface NewRunPermissionRequestInput {
  jobId: string;
  requestId: string;
  tool: string;
  detail?: string;
  askedAt?: Date;
  expiresAt: Date;
}

/**
 * Stores a permission request of a run's session. Idempotent per job and
 * `requestId`: asking again returns the stored request (`created: false`).
 */
export async function createRunPermissionRequest(
  db: Queryable,
  input: NewRunPermissionRequestInput,
): Promise<{ request: RunPermissionRequest; created: boolean }> {
  const [created] = await db
    .insert(runPermissionRequests)
    .values({
      jobId: input.jobId,
      requestId: input.requestId,
      tool: input.tool,
      detail: input.detail ?? "",
      ...(input.askedAt && { askedAt: input.askedAt }),
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({
      target: [runPermissionRequests.jobId, runPermissionRequests.requestId],
    })
    .returning();
  if (created) return { request: created, created: true };
  const existing = await getRunPermissionRequest(db, input.jobId, input.requestId);
  return { request: existing!, created: false };
}

/** A job's permission request, or null when it never asked it. */
export async function getRunPermissionRequest(
  db: Queryable,
  jobId: string,
  requestId: string,
): Promise<RunPermissionRequest | null> {
  const [row] = await db
    .select()
    .from(runPermissionRequests)
    .where(
      and(eq(runPermissionRequests.jobId, jobId), eq(runPermissionRequests.requestId, requestId)),
    );
  return row ?? null;
}

export interface AnswerRunPermissionRequestInput {
  jobId: string;
  requestId: string;
  answer: RunPermissionAnswer;
  answeredBy?: string | null;
  answeredAt?: Date;
}

/**
 * Answers a pending permission request. The first answer wins: answering an
 * answered request changes nothing. Returns the request as stored afterwards
 * (null when it was never asked) and whether this call answered it.
 */
export async function answerRunPermissionRequest(
  db: Queryable,
  input: AnswerRunPermissionRequestInput,
): Promise<{ request: RunPermissionRequest | null; answered: boolean }> {
  const [updated] = await db
    .update(runPermissionRequests)
    .set({
      answer: input.answer,
      answeredAt: input.answeredAt ?? new Date(),
      answeredBy: input.answeredBy ?? null,
    })
    .where(
      and(
        eq(runPermissionRequests.jobId, input.jobId),
        eq(runPermissionRequests.requestId, input.requestId),
        isNull(runPermissionRequests.answer),
      ),
    )
    .returning();
  if (updated) return { request: updated, answered: true };
  return {
    request: await getRunPermissionRequest(db, input.jobId, input.requestId),
    answered: false,
  };
}

/**
 * The latest `limit` activities of the organization's jobs `jobIds` (a run's
 * jobs), oldest first.
 */
export async function listRecentRunActivities(
  db: Queryable,
  organizationId: string,
  jobIds: readonly string[],
  limit: number,
): Promise<RunActivity[]> {
  if (jobIds.length === 0 || limit <= 0) return [];
  const rows = await db
    .select()
    .from(runActivities)
    .where(
      and(
        eq(runActivities.organizationId, organizationId),
        inArray(runActivities.jobId, [...jobIds]),
      ),
    )
    .orderBy(desc(runActivities.createdAt), desc(runActivities.id))
    .limit(limit);
  return rows.reverse();
}

/** The unanswered, unexpired permission requests of jobs `jobIds` (a run's jobs), oldest first. */
export async function listOpenRunPermissionRequests(
  db: Queryable,
  jobIds: readonly string[],
  now: Date = new Date(),
): Promise<RunPermissionRequest[]> {
  if (jobIds.length === 0) return [];
  return db
    .select()
    .from(runPermissionRequests)
    .where(
      and(
        inArray(runPermissionRequests.jobId, [...jobIds]),
        isNull(runPermissionRequests.answer),
        gt(runPermissionRequests.expiresAt, now),
      ),
    )
    .orderBy(asc(runPermissionRequests.askedAt), asc(runPermissionRequests.id));
}
