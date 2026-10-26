/**
 * Agent identity: one-time enrollment tokens, rotating refresh tokens with
 * reuse detection, revocation, the security audit log and fixed-window rate
 * limit counters. Tokens are 256-bit random values stored only as SHA-256
 * hashes (`hashToken()`).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, gte, isNull, lt, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { hashToken } from "./crypto.js";
import { recordJobChanges, type Job } from "./jobs.js";
import {
  agentAudit,
  agentEnrollments,
  agentRefreshTokens,
  agentRepoPins,
  agents,
  jobs,
  rateLimits,
} from "./schema.js";

export type Agent = typeof agents.$inferSelect;
export type AgentAuditEvent = (typeof agentAudit.$inferSelect)["event"];
export type AgentAuditEntry = typeof agentAudit.$inferSelect;

/** Enrollment tokens are valid for one hour and can be used once. */
export const ENROLLMENT_TOKEN_TTL_MS = 60 * 60 * 1000;

const ENROLLMENT_TOKEN_PREFIX = "ore_";
const REFRESH_TOKEN_PREFIX = "orr_";

/** A 256-bit random token, base64url-encoded with a recognisable prefix. */
function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export interface CreatedEnrollment {
  id: string;
  /** Shown to the admin once; only its hash is stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Creates a one-time enrollment token (valid for `ENROLLMENT_TOKEN_TTL_MS`); the
 * agent redeeming it joins `organizationId`.
 */
export async function createAgentEnrollment(
  db: Database,
  input: {
    organizationId: string;
    name?: string | null;
    createdBy?: string | null;
    now?: Date;
  },
): Promise<CreatedEnrollment> {
  const token = generateToken(ENROLLMENT_TOKEN_PREFIX);
  const expiresAt = new Date((input.now ?? new Date()).getTime() + ENROLLMENT_TOKEN_TTL_MS);
  const [row] = await db
    .insert(agentEnrollments)
    .values({
      organizationId: input.organizationId,
      tokenHash: hashToken(token),
      name: input.name ?? null,
      expiresAt,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: agentEnrollments.id });
  return { id: row!.id, token, expiresAt };
}

export interface AgentEnrollmentStatus {
  id: string;
  expiresAt: Date;
  /** The agent that redeemed the token (null while unused, or once that agent is deleted). */
  agent: { id: string; name: string } | null;
}

/**
 * An enrollment of `organizationId` and the agent that redeemed it, if any: what the
 * enrollment dialog polls to show the agent connecting. Null for another organization's
 * enrollment.
 */
export async function getAgentEnrollmentStatus(
  db: Database,
  organizationId: string,
  enrollmentId: string,
): Promise<AgentEnrollmentStatus | null> {
  const [row] = await db
    .select({
      id: agentEnrollments.id,
      expiresAt: agentEnrollments.expiresAt,
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(agentEnrollments)
    .leftJoin(
      agents,
      and(
        eq(agents.id, agentEnrollments.agentId),
        eq(agents.organizationId, organizationId),
        isNull(agents.deletedAt),
      ),
    )
    .where(
      and(
        eq(agentEnrollments.id, enrollmentId),
        eq(agentEnrollments.organizationId, organizationId),
      ),
    );
  if (!row) return null;
  return {
    id: row.id,
    expiresAt: row.expiresAt,
    agent: row.agentId && row.agentName !== null ? { id: row.agentId, name: row.agentName } : null,
  };
}

export interface EnrollAgentInput {
  enrollmentToken: string;
  name: string;
  version: string;
  now?: Date;
}

/**
 * Consumes an unused, unexpired enrollment token, creates the agent (in the
 * enrollment's organization) and its
 * first refresh token (a new family). Returns `null` if the token is unknown,
 * expired or already used.
 */
export async function enrollAgent(
  db: Database,
  input: EnrollAgentInput,
): Promise<{ agentId: string; refreshToken: string } | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [enrollment] = await tx
      .update(agentEnrollments)
      .set({ usedAt: now })
      .where(
        and(
          eq(agentEnrollments.tokenHash, hashToken(input.enrollmentToken)),
          isNull(agentEnrollments.usedAt),
          gt(agentEnrollments.expiresAt, now),
        ),
      )
      .returning();
    if (!enrollment) return null;

    const [agent] = await tx
      .insert(agents)
      .values({
        organizationId: enrollment.organizationId,
        // The admin's name for the enrollment wins over the host's self-reported one.
        name: enrollment.name ?? input.name,
        reportedVersion: input.version,
        enrolledBy: enrollment.createdBy,
      })
      .returning({ id: agents.id });
    const agentId = agent!.id;
    await tx
      .update(agentEnrollments)
      .set({ agentId })
      .where(eq(agentEnrollments.id, enrollment.id));

    const refreshToken = generateToken(REFRESH_TOKEN_PREFIX);
    await tx.insert(agentRefreshTokens).values({
      agentId,
      familyId: randomUUID(),
      tokenHash: hashToken(refreshToken),
      createdAt: now,
    });
    recordChange(tx, {
      resource: "agent",
      ids: [agentId],
      organizationId: enrollment.organizationId,
    });
    return { agentId, refreshToken };
  });
}

/** The agent a refresh token belongs to (for per-agent rate limiting), without consuming it. */
export async function findRefreshTokenAgent(
  db: Database,
  refreshToken: string,
): Promise<string | null> {
  const [row] = await db
    .select({ agentId: agentRefreshTokens.agentId })
    .from(agentRefreshTokens)
    .where(eq(agentRefreshTokens.tokenHash, hashToken(refreshToken)));
  return row?.agentId ?? null;
}

export type RotateRefreshTokenResult =
  | { status: "rotated"; agentId: string; familyId: string; refreshToken: string }
  /** The token was already used: its family and the agent have been revoked. */
  | { status: "reused"; agentId: string; familyId: string }
  | {
      status: "invalid";
      agentId: string | null;
      reason: "unknown" | "revoked" | "agent_revoked";
    };

/**
 * Rotates a refresh token: marks it used and issues a new one in the same
 * family. Presenting an already-used token revokes the whole family and the
 * agent. Rows are locked, so concurrent presentations of one token resolve to
 * exactly one rotation (the other is treated as reuse).
 */
export async function rotateRefreshToken(
  db: Database,
  refreshToken: string,
  now: Date = new Date(),
): Promise<RotateRefreshTokenResult> {
  return db.transaction(async (tx) => {
    const [token] = await tx
      .select({
        id: agentRefreshTokens.id,
        agentId: agentRefreshTokens.agentId,
        familyId: agentRefreshTokens.familyId,
        usedAt: agentRefreshTokens.usedAt,
        revokedAt: agentRefreshTokens.revokedAt,
        agentRevokedAt: agents.revokedAt,
      })
      .from(agentRefreshTokens)
      .innerJoin(agents, eq(agents.id, agentRefreshTokens.agentId))
      .where(eq(agentRefreshTokens.tokenHash, hashToken(refreshToken)))
      .for("update");
    if (!token) return { status: "invalid", agentId: null, reason: "unknown" };
    const { agentId, familyId } = token;
    if (token.agentRevokedAt) return { status: "invalid", agentId, reason: "agent_revoked" };

    if (token.usedAt) {
      await tx
        .update(agentRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(eq(agentRefreshTokens.familyId, familyId), isNull(agentRefreshTokens.revokedAt)),
        );
      await tx.update(agents).set({ revokedAt: now }).where(eq(agents.id, agentId));
      return { status: "reused", agentId, familyId };
    }
    if (token.revokedAt) return { status: "invalid", agentId, reason: "revoked" };

    await tx
      .update(agentRefreshTokens)
      .set({ usedAt: now })
      .where(eq(agentRefreshTokens.id, token.id));
    const next = generateToken(REFRESH_TOKEN_PREFIX);
    await tx
      .insert(agentRefreshTokens)
      .values({ agentId, familyId, tokenHash: hashToken(next), createdAt: now });
    return { status: "rotated", agentId, familyId, refreshToken: next };
  });
}

export interface RevokeAgentResult {
  /** Running jobs put back to `queued` (failed-retryable): other agents claim them again. */
  requeuedJobs: Job[];
  /** Running jobs that had used up their deliveries and are now `failed`. */
  failedJobs: Job[];
  /** Running jobs with a cancel request, now `canceled`. */
  canceledJobs: Job[];
  /** Repositories that were pinned to the agent (the pins are removed). */
  unpinnedRepositoryIds: string[];
}

/**
 * Revokes an agent: sets `revoked_at` and revokes every refresh-token family.
 * Outstanding access and job tokens stop working immediately because every
 * authenticated request checks `revoked_at`. Its running jobs are failed as
 * retryable (back to `queued`, or `failed` once `maxDeliveries` is reached,
 * like `failJob`), so other agents claim them again, and its repository pins are removed. Returns null
 * for unknown agents (with `organizationId`, also for agents of another
 * organization).
 */
export async function revokeAgent(
  db: Database,
  agentId: string,
  options: { now?: Date; maxDeliveries?: number; organizationId?: string } = {},
): Promise<RevokeAgentResult | null> {
  const now = options.now ?? new Date();
  const maxDeliveries = options.maxDeliveries ?? 3;
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .update(agents)
      .set({ revokedAt: sql`coalesce(${agents.revokedAt}, ${now})` })
      .where(
        and(
          eq(agents.id, agentId),
          options.organizationId ? eq(agents.organizationId, options.organizationId) : undefined,
        ),
      )
      .returning({ id: agents.id, organizationId: agents.organizationId });
    if (!agent) return null;
    recordChange(tx, { resource: "agent", ids: [agent.id], organizationId: agent.organizationId });
    await tx
      .update(agentRefreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(agentRefreshTokens.agentId, agentId), isNull(agentRefreshTokens.revokedAt)));

    const error = "Agent revoked";
    const running = and(eq(jobs.agentId, agentId), eq(jobs.status, "running"));
    const canceledJobs = await tx
      .update(jobs)
      .set({ status: "canceled", error, finishedAt: now })
      .where(and(running, eq(jobs.cancelRequested, true)))
      .returning();
    const failedJobs = await tx
      .update(jobs)
      .set({ status: "failed", error, finishedAt: now })
      .where(and(running, gte(jobs.deliveryCount, maxDeliveries)))
      .returning();
    const requeuedJobs = await tx
      .update(jobs)
      .set({ status: "queued", agentId: null, error })
      .where(running)
      .returning();
    const unpinned = await tx
      .delete(agentRepoPins)
      .where(eq(agentRepoPins.agentId, agentId))
      .returning({ repositoryId: agentRepoPins.repositoryId });
    recordJobChanges(tx, [...canceledJobs, ...failedJobs, ...requeuedJobs]);
    for (const repositoryId of unpinned.map((p) => p.repositoryId)) {
      recordChange(tx, {
        resource: "settings",
        section: "repository.agents",
        ids: [repositoryId],
        subjectId: repositoryId,
        organizationId: agent.organizationId,
      });
    }
    return {
      requeuedJobs,
      failedJobs,
      canceledJobs,
      unpinnedRepositoryIds: unpinned.map((p) => p.repositoryId),
    };
  });
}

/** Whether the agent is active, revoked, or doesn't exist. */
export async function getAgentAuthState(
  db: Database,
  agentId: string,
): Promise<"active" | "revoked" | "unknown"> {
  const [row] = await db
    .select({ revokedAt: agents.revokedAt })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row) return "unknown";
  return row.revokedAt ? "revoked" : "active";
}

/** Whether the job is `running` on the given (non-revoked) agent, which belongs to its organization. */
export async function isJobRunningOnAgent(
  db: Database,
  jobId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.agentId, agentId),
        eq(jobs.organizationId, agents.organizationId),
        eq(jobs.status, "running"),
        isNull(agents.revokedAt),
      ),
    );
  return row !== undefined;
}

export interface AgentAuditInput {
  agentId?: string | null;
  event: AgentAuditEvent;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export async function writeAgentAudit(db: Database, input: AgentAuditInput): Promise<void> {
  await db.insert(agentAudit).values({
    agentId: input.agentId ?? null,
    event: input.event,
    ip: input.ip ?? null,
    detail: input.detail ?? {},
  });
}

export async function listAgentAudit(
  db: Database,
  filter: { agentId?: string; event?: AgentAuditEvent } = {},
): Promise<AgentAuditEntry[]> {
  return db
    .select()
    .from(agentAudit)
    .where(
      and(
        filter.agentId ? eq(agentAudit.agentId, filter.agentId) : undefined,
        filter.event ? eq(agentAudit.event, filter.event) : undefined,
      ),
    )
    .orderBy(agentAudit.createdAt);
}

/**
 * Increments the fixed-window counter for `key` and returns the new count.
 * `windowStart` identifies the window (callers align it to the window size).
 */
export async function incrementRateLimit(
  db: Database,
  key: string,
  windowStart: Date,
): Promise<number> {
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  return row!.count;
}

/** The latest window start recorded for `key` after `since`, if any. */
export async function latestRateLimitWindow(
  db: Database,
  key: string,
  since: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({
      windowStart: sql<Date>`max(${rateLimits.windowStart})`.mapWith(rateLimits.windowStart),
    })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), gt(rateLimits.windowStart, since)));
  return row?.windowStart ?? null;
}

/** Deletes counters whose window started before `before` (for a periodic sweep). */
export async function pruneRateLimits(db: Database, before: Date): Promise<number> {
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, before))
    .returning({ key: rateLimits.key });
  return deleted.length;
}
