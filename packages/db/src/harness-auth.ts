/**
 * Harness identity: one-time enrollment tokens, rotating refresh tokens with
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
  harnessAudit,
  harnessEnrollments,
  harnessRefreshTokens,
  harnessRepoPins,
  harnesses,
  jobs,
  rateLimits,
} from "./schema.js";

export type Harness = typeof harnesses.$inferSelect;
export type HarnessAuditEvent = (typeof harnessAudit.$inferSelect)["event"];
export type HarnessAuditEntry = typeof harnessAudit.$inferSelect;

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
 * harness redeeming it joins `organizationId`.
 */
export async function createHarnessEnrollment(
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
    .insert(harnessEnrollments)
    .values({
      organizationId: input.organizationId,
      tokenHash: hashToken(token),
      name: input.name ?? null,
      expiresAt,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: harnessEnrollments.id });
  return { id: row!.id, token, expiresAt };
}

export interface HarnessEnrollmentStatus {
  id: string;
  expiresAt: Date;
  /** The harness that redeemed the token (null while unused, or once that harness is deleted). */
  harness: { id: string; name: string } | null;
}

/**
 * An enrollment of `organizationId` and the harness that redeemed it, if any: what the
 * enrollment dialog polls to show the harness connecting. Null for another organization's
 * enrollment.
 */
export async function getHarnessEnrollmentStatus(
  db: Database,
  organizationId: string,
  enrollmentId: string,
): Promise<HarnessEnrollmentStatus | null> {
  const [row] = await db
    .select({
      id: harnessEnrollments.id,
      expiresAt: harnessEnrollments.expiresAt,
      harnessId: harnesses.id,
      harnessName: harnesses.name,
    })
    .from(harnessEnrollments)
    .leftJoin(
      harnesses,
      and(
        eq(harnesses.id, harnessEnrollments.harnessId),
        eq(harnesses.organizationId, organizationId),
        isNull(harnesses.deletedAt),
      ),
    )
    .where(
      and(
        eq(harnessEnrollments.id, enrollmentId),
        eq(harnessEnrollments.organizationId, organizationId),
      ),
    );
  if (!row) return null;
  return {
    id: row.id,
    expiresAt: row.expiresAt,
    harness:
      row.harnessId && row.harnessName !== null
        ? { id: row.harnessId, name: row.harnessName }
        : null,
  };
}

export interface EnrollHarnessInput {
  enrollmentToken: string;
  name: string;
  version: string;
  now?: Date;
}

/**
 * Consumes an unused, unexpired enrollment token, creates the harness (in the
 * enrollment's organization) and its
 * first refresh token (a new family). Returns `null` if the token is unknown,
 * expired or already used.
 */
export async function enrollHarness(
  db: Database,
  input: EnrollHarnessInput,
): Promise<{ harnessId: string; refreshToken: string } | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [enrollment] = await tx
      .update(harnessEnrollments)
      .set({ usedAt: now })
      .where(
        and(
          eq(harnessEnrollments.tokenHash, hashToken(input.enrollmentToken)),
          isNull(harnessEnrollments.usedAt),
          gt(harnessEnrollments.expiresAt, now),
        ),
      )
      .returning();
    if (!enrollment) return null;

    const [agent] = await tx
      .insert(harnesses)
      .values({
        organizationId: enrollment.organizationId,
        // The admin's name for the enrollment wins over the host's self-reported one.
        name: enrollment.name ?? input.name,
        reportedVersion: input.version,
        enrolledBy: enrollment.createdBy,
      })
      .returning({ id: harnesses.id });
    const harnessId = agent!.id;
    await tx
      .update(harnessEnrollments)
      .set({ harnessId })
      .where(eq(harnessEnrollments.id, enrollment.id));

    const refreshToken = generateToken(REFRESH_TOKEN_PREFIX);
    await tx.insert(harnessRefreshTokens).values({
      harnessId,
      familyId: randomUUID(),
      tokenHash: hashToken(refreshToken),
      createdAt: now,
    });
    recordChange(tx, {
      resource: "agent",
      ids: [harnessId],
      organizationId: enrollment.organizationId,
    });
    return { harnessId, refreshToken };
  });
}

/** The harness a refresh token belongs to (for per-harness rate limiting), without consuming it. */
export async function findRefreshTokenHarness(
  db: Database,
  refreshToken: string,
): Promise<string | null> {
  const [row] = await db
    .select({ harnessId: harnessRefreshTokens.harnessId })
    .from(harnessRefreshTokens)
    .where(eq(harnessRefreshTokens.tokenHash, hashToken(refreshToken)));
  return row?.harnessId ?? null;
}

export type RotateRefreshTokenResult =
  | { status: "rotated"; harnessId: string; familyId: string; refreshToken: string }
  /** The token was already used: its family and the harness have been revoked. */
  | { status: "reused"; harnessId: string; familyId: string }
  | {
      status: "invalid";
      harnessId: string | null;
      reason: "unknown" | "revoked" | "agent_revoked";
    };

/**
 * Rotates a refresh token: marks it used and issues a new one in the same
 * family. Presenting an already-used token revokes the whole family and the
 * harness. Rows are locked, so concurrent presentations of one token resolve to
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
        id: harnessRefreshTokens.id,
        harnessId: harnessRefreshTokens.harnessId,
        familyId: harnessRefreshTokens.familyId,
        usedAt: harnessRefreshTokens.usedAt,
        revokedAt: harnessRefreshTokens.revokedAt,
        harnessRevokedAt: harnesses.revokedAt,
      })
      .from(harnessRefreshTokens)
      .innerJoin(harnesses, eq(harnesses.id, harnessRefreshTokens.harnessId))
      .where(eq(harnessRefreshTokens.tokenHash, hashToken(refreshToken)))
      .for("update");
    if (!token) return { status: "invalid", harnessId: null, reason: "unknown" };
    const { harnessId, familyId } = token;
    if (token.harnessRevokedAt) return { status: "invalid", harnessId, reason: "agent_revoked" };

    if (token.usedAt) {
      await tx
        .update(harnessRefreshTokens)
        .set({ revokedAt: now })
        .where(
          and(eq(harnessRefreshTokens.familyId, familyId), isNull(harnessRefreshTokens.revokedAt)),
        );
      await tx.update(harnesses).set({ revokedAt: now }).where(eq(harnesses.id, harnessId));
      return { status: "reused", harnessId, familyId };
    }
    if (token.revokedAt) return { status: "invalid", harnessId, reason: "revoked" };

    await tx
      .update(harnessRefreshTokens)
      .set({ usedAt: now })
      .where(eq(harnessRefreshTokens.id, token.id));
    const next = generateToken(REFRESH_TOKEN_PREFIX);
    await tx
      .insert(harnessRefreshTokens)
      .values({ harnessId, familyId, tokenHash: hashToken(next), createdAt: now });
    return { status: "rotated", harnessId, familyId, refreshToken: next };
  });
}

export interface RevokeHarnessResult {
  /** Running jobs put back to `queued` (failed-retryable): other harnesses claim them again. */
  requeuedJobs: Job[];
  /** Running jobs that had used up their deliveries and are now `failed`. */
  failedJobs: Job[];
  /** Running jobs with a cancel request, now `canceled`. */
  canceledJobs: Job[];
  /** Repositories that were pinned to the harness (the pins are removed). */
  unpinnedRepositoryIds: string[];
}

/**
 * Revokes a harness: sets `revoked_at` and revokes every refresh-token family.
 * Outstanding access and job tokens stop working immediately because every
 * authenticated request checks `revoked_at`. Its running jobs are failed as
 * retryable (back to `queued`, or `failed` once `maxDeliveries` is reached,
 * like `failJob`), so other harnesses claim them again, and its repository pins are removed. Returns null
 * for unknown harnesses (with `organizationId`, also for harnesses of another
 * organization).
 */
export async function revokeHarness(
  db: Database,
  harnessId: string,
  options: { now?: Date; maxDeliveries?: number; organizationId?: string } = {},
): Promise<RevokeHarnessResult | null> {
  const now = options.now ?? new Date();
  const maxDeliveries = options.maxDeliveries ?? 3;
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .update(harnesses)
      .set({ revokedAt: sql`coalesce(${harnesses.revokedAt}, ${now})` })
      .where(
        and(
          eq(harnesses.id, harnessId),
          options.organizationId ? eq(harnesses.organizationId, options.organizationId) : undefined,
        ),
      )
      .returning({ id: harnesses.id, organizationId: harnesses.organizationId });
    if (!agent) return null;
    recordChange(tx, { resource: "agent", ids: [agent.id], organizationId: agent.organizationId });
    await tx
      .update(harnessRefreshTokens)
      .set({ revokedAt: now })
      .where(
        and(eq(harnessRefreshTokens.harnessId, harnessId), isNull(harnessRefreshTokens.revokedAt)),
      );

    const error = "Harness revoked";
    const running = and(eq(jobs.harnessId, harnessId), eq(jobs.status, "running"));
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
      .set({ status: "queued", harnessId: null, error })
      .where(running)
      .returning();
    const unpinned = await tx
      .delete(harnessRepoPins)
      .where(eq(harnessRepoPins.harnessId, harnessId))
      .returning({ repositoryId: harnessRepoPins.repositoryId });
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

/** Whether the harness is active, revoked, or doesn't exist. */
export async function getHarnessAuthState(
  db: Database,
  harnessId: string,
): Promise<"active" | "revoked" | "unknown"> {
  const [row] = await db
    .select({ revokedAt: harnesses.revokedAt })
    .from(harnesses)
    .where(eq(harnesses.id, harnessId));
  if (!row) return "unknown";
  return row.revokedAt ? "revoked" : "active";
}

/** Whether the job is `running` on the given (non-revoked) harness, which belongs to its organization. */
export async function isJobRunningOnHarness(
  db: Database,
  jobId: string,
  harnessId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(harnesses, eq(harnesses.id, jobs.harnessId))
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.harnessId, harnessId),
        eq(jobs.organizationId, harnesses.organizationId),
        eq(jobs.status, "running"),
        isNull(harnesses.revokedAt),
      ),
    );
  return row !== undefined;
}

export interface HarnessAuditInput {
  harnessId?: string | null;
  event: HarnessAuditEvent;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export async function writeHarnessAudit(db: Database, input: HarnessAuditInput): Promise<void> {
  await db.insert(harnessAudit).values({
    harnessId: input.harnessId ?? null,
    event: input.event,
    ip: input.ip ?? null,
    detail: input.detail ?? {},
  });
}

export async function listHarnessAudit(
  db: Database,
  filter: { harnessId?: string; event?: HarnessAuditEvent } = {},
): Promise<HarnessAuditEntry[]> {
  return db
    .select()
    .from(harnessAudit)
    .where(
      and(
        filter.harnessId ? eq(harnessAudit.harnessId, filter.harnessId) : undefined,
        filter.event ? eq(harnessAudit.event, filter.event) : undefined,
      ),
    )
    .orderBy(harnessAudit.createdAt);
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
