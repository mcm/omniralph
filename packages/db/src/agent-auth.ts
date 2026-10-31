/**
 * Agent identity: one-time enrollment tokens, rotating refresh tokens with
 * reuse detection, revocation, the security audit log and fixed-window rate
 * limit counters. Enrollment and legacy refresh tokens are 256-bit random values
 * stored only as SHA-256 hashes (`hashToken()`); signed refresh tokens (TOOL-856)
 * are tracked by generation and the hash of their random ID (`agents.refresh_generation`).
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { hashToken } from "./crypto.js";
import { recordJobChanges, refreshHostToolWaits, type Job } from "./jobs.js";
import {
  agentAudit,
  agentEnrollments,
  agentRefreshTokens,
  agentRepoPins,
  agents,
  jobs,
  rateLimits,
} from "./schema.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Agent = typeof agents.$inferSelect;
export type AgentAuditEvent = (typeof agentAudit.$inferSelect)["event"];
export type AgentAuditEntry = typeof agentAudit.$inferSelect;

/** Enrollment tokens are valid for one hour and can be used once. */
export const ENROLLMENT_TOKEN_TTL_MS = 60 * 60 * 1000;

const ENROLLMENT_TOKEN_PREFIX = "ore_";
const LEGACY_REFRESH_TOKEN_PREFIX = "orr_";

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

/** A signed refresh token and what Postgres records of it. */
export interface IssuedRefreshToken {
  token: string;
  generation: number;
  /** `hashToken()` of the token's random ID. */
  tokenIdHash: string;
}

/** The generation of an agent's current signed refresh token and the hash of its random ID. */
export interface RefreshTokenState {
  generation: number;
  tokenIdHash: string;
}

export interface EnrollAgentInput {
  enrollmentToken: string;
  name: string;
  version: string;
  /**
   * Signs the new agent's first refresh token. Called inside the transaction, so a signing
   * failure leaves the enrollment token unused. Without it (tests), the agent gets none.
   */
  issueRefreshToken?: (agentId: string) => Promise<IssuedRefreshToken>;
  now?: Date;
}

/**
 * Consumes an unused, unexpired enrollment token, creates the agent (in the
 * enrollment's organization) and records its first signed refresh token. Returns
 * `null` if the token is unknown, expired or already used.
 */
export async function enrollAgent(
  db: Database,
  input: EnrollAgentInput,
): Promise<{ agentId: string; refreshToken: IssuedRefreshToken | null } | null> {
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

    const refreshToken = (await input.issueRefreshToken?.(agentId)) ?? null;
    if (refreshToken) {
      await tx
        .update(agents)
        .set({
          refreshGeneration: refreshToken.generation,
          refreshTokenIdHash: refreshToken.tokenIdHash,
        })
        .where(eq(agents.id, agentId));
    }
    recordChange(tx, {
      resource: "agent",
      ids: [agentId],
      organizationId: enrollment.organizationId,
    });
    return { agentId, refreshToken };
  });
}

/** Whether a refresh token is a legacy opaque one (from before TOOL-856). */
export function isLegacyRefreshToken(refreshToken: string): boolean {
  return refreshToken.startsWith(LEGACY_REFRESH_TOKEN_PREFIX);
}

/**
 * The agent a legacy refresh token belongs to (for per-agent rate limiting), without
 * consuming it.
 */
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
  | { status: "rotated"; agentId: string; familyId: string }
  /** The token was already used: its family and the agent have been revoked. */
  | { status: "reused"; agentId: string; familyId: string }
  | {
      status: "invalid";
      agentId: string | null;
      reason: "unknown" | "revoked" | "agent_revoked";
    };

/**
 * Revokes an agent for refresh-token reuse: its legacy refresh-token families and the agent
 * itself, then refreshes its organization's host tool waits.
 */
async function revokeForReuse(
  tx: Tx,
  agent: { id: string; organizationId: string },
  now: Date,
): Promise<void> {
  await tx
    .update(agentRefreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(agentRefreshTokens.agentId, agent.id), isNull(agentRefreshTokens.revokedAt)));
  await tx
    .update(agents)
    .set({ revokedAt: sql`coalesce(${agents.revokedAt}, ${now})` })
    .where(eq(agents.id, agent.id));
  // Its host tools no longer count for the organization's queued jobs.
  await refreshHostToolWaits({ db: tx, organizationId: agent.organizationId });
}

/**
 * Redeems a legacy refresh token: marks it used and records `next`, the agent's first
 * signed refresh token, in its place. Presenting an already-used token revokes the whole
 * family and the agent, then refreshes its organization's host tool waits. Rows are
 * locked, so concurrent presentations of one token resolve to exactly one rotation (the
 * other is treated as reuse).
 */
export async function rotateRefreshToken(
  db: Database,
  refreshToken: string,
  next: RefreshTokenState,
  now: Date = new Date(),
): Promise<RotateRefreshTokenResult> {
  return db.transaction(async (tx): Promise<RotateRefreshTokenResult> => {
    const [token] = await tx
      .select({
        id: agentRefreshTokens.id,
        agentId: agentRefreshTokens.agentId,
        organizationId: agents.organizationId,
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
      await revokeForReuse(tx, { id: agentId, organizationId: token.organizationId }, now);
      return { status: "reused", agentId, familyId };
    }
    if (token.revokedAt) return { status: "invalid", agentId, reason: "revoked" };

    await tx
      .update(agentRefreshTokens)
      .set({ usedAt: now })
      .where(eq(agentRefreshTokens.id, token.id));
    await tx
      .update(agents)
      .set({ refreshGeneration: next.generation, refreshTokenIdHash: next.tokenIdHash })
      .where(eq(agents.id, agentId));
    return { status: "rotated", agentId, familyId };
  });
}

/**
 * How a presented signed refresh token compares with the agent's current one: the same
 * generation and random ID rotates; a newer generation than recorded catches up (the
 * record is behind: Postgres before the daily flush, or Redis after it lost its state);
 * anything else (an older generation, or the same one with another random ID) is reuse.
 */
export function compareRefreshToken(
  current: RefreshTokenState | null,
  presented: RefreshTokenState,
): "rotated" | "caught_up" | "reused" {
  if (!current || presented.generation > current.generation) return "caught_up";
  if (
    presented.generation === current.generation &&
    presented.tokenIdHash === current.tokenIdHash
  ) {
    return "rotated";
  }
  return "reused";
}

export type RotateSignedRefreshTokenResult =
  | { status: "rotated" | "caught_up" | "reused"; agentId: string }
  | { status: "invalid"; agentId: string | null; reason: "unknown" | "agent_revoked" };

/**
 * Rotates a signed refresh token in Postgres (hot state off, or Redis unavailable):
 * compares the presented token with the agent's (`compareRefreshToken`) and records `next`
 * in its place, or revokes the agent on reuse. The agent row is locked, so concurrent
 * presentations of one token resolve to one rotation and one reuse.
 */
export async function rotateSignedRefreshToken(
  db: Database,
  input: { agentId: string; presented: RefreshTokenState; next: RefreshTokenState },
  now: Date = new Date(),
): Promise<RotateSignedRefreshTokenResult> {
  const { agentId } = input;
  return db.transaction(async (tx): Promise<RotateSignedRefreshTokenResult> => {
    const [agent] = await tx
      .select({
        organizationId: agents.organizationId,
        revokedAt: agents.revokedAt,
        generation: agents.refreshGeneration,
        tokenIdHash: agents.refreshTokenIdHash,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for("update");
    if (!agent) return { status: "invalid", agentId: null, reason: "unknown" };
    if (agent.revokedAt) return { status: "invalid", agentId, reason: "agent_revoked" };
    const current =
      agent.generation !== null && agent.tokenIdHash !== null
        ? { generation: agent.generation, tokenIdHash: agent.tokenIdHash }
        : null;
    const status = compareRefreshToken(current, input.presented);
    if (status === "reused") {
      await revokeForReuse(tx, { id: agentId, organizationId: agent.organizationId }, now);
      return { status, agentId };
    }
    await tx
      .update(agents)
      .set({
        refreshGeneration: input.next.generation,
        refreshTokenIdHash: input.next.tokenIdHash,
      })
      .where(eq(agents.id, agentId));
    return { status, agentId };
  });
}

/**
 * Revokes an agent whose signed refresh token was reused (detected in Redis). Returns
 * false for an unknown agent.
 */
export async function revokeAgentForRefreshReuse(
  db: Database,
  agentId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for("update");
    if (!agent) return false;
    await revokeForReuse(tx, { id: agentId, organizationId: agent.organizationId }, now);
    return true;
  });
}

/**
 * Agents' current signed refresh tokens as Postgres last recorded them (the hot-state
 * rebuild), for agents that aren't revoked.
 */
export async function listAgentRefreshTokenStates(
  db: Database,
): Promise<(RefreshTokenState & { agentId: string })[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      generation: agents.refreshGeneration,
      tokenIdHash: agents.refreshTokenIdHash,
    })
    .from(agents)
    .where(isNull(agents.revokedAt));
  return rows.flatMap((r) =>
    r.generation !== null && r.tokenIdHash !== null
      ? [{ agentId: r.agentId, generation: r.generation, tokenIdHash: r.tokenIdHash }]
      : [],
  );
}

/**
 * Records agents' current signed refresh tokens (the daily flush from Redis). Only moves a
 * generation forward: a refresh through Postgres since then may already have recorded a
 * newer one. Returns how many agents were updated.
 */
export async function saveAgentRefreshTokenStates(
  db: Database,
  states: (RefreshTokenState & { agentId: string })[],
): Promise<number> {
  let updated = 0;
  for (const state of states) {
    const rows = await db
      .update(agents)
      .set({ refreshGeneration: state.generation, refreshTokenIdHash: state.tokenIdHash })
      .where(
        and(
          eq(agents.id, state.agentId),
          or(isNull(agents.refreshGeneration), lt(agents.refreshGeneration, state.generation)),
        ),
      )
      .returning({ id: agents.id });
    updated += rows.length;
  }
  return updated;
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
 * like `failJob`), so other agents claim them again, and its repository pins are removed.
 * Then refreshes the organization's host tool waits (`refreshHostToolWaits`). Returns null
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
    // Its host tools no longer count, and its requeued jobs may wait for one.
    await refreshHostToolWaits({ db: tx, organizationId: agent.organizationId });
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
  /** When it happened, for rows written later (buffered); now by default. */
  createdAt?: Date;
}

export async function writeAgentAudit(db: Database, input: AgentAuditInput): Promise<void> {
  await writeAgentAudits(db, [input]);
}

/** Writes several audit rows in one insert (a buffered batch). */
export async function writeAgentAudits(db: Database, inputs: AgentAuditInput[]): Promise<void> {
  if (inputs.length === 0) return;
  // An agent deleted since a buffered row was written would fail the foreign key.
  const agentIds = [...new Set(inputs.flatMap((i) => (i.agentId ? [i.agentId] : [])))];
  const known =
    agentIds.length === 0
      ? new Set<string>()
      : new Set(
          (await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, agentIds))).map(
            (r) => r.id,
          ),
        );
  await db.insert(agentAudit).values(
    inputs.map((input) => ({
      agentId: input.agentId && known.has(input.agentId) ? input.agentId : null,
      event: input.event,
      ip: input.ip ?? null,
      detail: input.detail ?? {},
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })),
  );
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
