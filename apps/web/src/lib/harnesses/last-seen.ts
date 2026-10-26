import "server-only";
import { createHash } from "node:crypto";
import { getHarness, recordHarnessHeartbeat, type Database } from "@omniralph/db";
import type { Redis } from "ioredis";
import { getRedis, hotStateEnabled } from "@/lib/hot-state";

/**
 * A harness's last heartbeat, kept in Redis so an unchanged heartbeat doesn't write to
 * Postgres. Every heartbeat sets `harness-last-seen:{id}`; the harness row is written
 * only when what the harness reports changed (`harness-report:{id}` holds a fingerprint
 * of the report last written) or its `last_heartbeat_at` is a day old (the fingerprint
 * expires then). Neither key is derived from Postgres, so there's no epoch: a lost key
 * just means a Postgres write on the next heartbeat, and readers fall back to the
 * row's `last_heartbeat_at` (at most a day behind).
 */

export type HeartbeatReport = Omit<Parameters<typeof recordHarnessHeartbeat>[2], "now">;
export type HarnessRow = NonNullable<Awaited<ReturnType<typeof recordHarnessHeartbeat>>>;

const LAST_SEEN_PREFIX = "harness-last-seen:";
const REPORT_PREFIX = "harness-report:";
/** Longest the harness row's `last_heartbeat_at` goes without a write while the harness is up. */
export const POSTGRES_HEARTBEAT_MAX_AGE_MS = 24 * 3600_000;
/** How long a last-seen outlives the harness's last heartbeat (then the row's value is used). */
export const LAST_SEEN_TTL_MS = 30 * 24 * 3600_000;

export function harnessLastSeenKey(harnessId: string): string {
  return `${LAST_SEEN_PREFIX}${harnessId}`;
}

export function harnessReportKey(harnessId: string): string {
  return `${REPORT_PREFIX}${harnessId}`;
}

/** Everything a heartbeat writes to the harness row, but its time. */
export function heartbeatReportFingerprint(report: HeartbeatReport): string {
  const normalized = [
    report.version,
    report.selfUpdate ?? null,
    report.update ?? null,
    report.failedVersions ?? [],
    report.handledUpdateRequestId ?? null,
    report.installables ?? [],
    report.models ?? [],
    report.acceptedTaskTypes ?? null,
  ];
  return createHash("sha256").update(JSON.stringify(normalized)).digest("base64url");
}

/**
 * Records a heartbeat and returns the harness row (null for an unknown harness). With
 * hot state on, last-seen goes to Redis and the row is only written when the report
 * changed or its `last_heartbeat_at` is a day old; otherwise (and on a Redis error) it
 * writes the row every time, as without Redis.
 */
export async function recordHeartbeat(
  db: Database,
  harnessId: string,
  report: HeartbeatReport,
  now: Date = new Date(),
): Promise<HarnessRow | null> {
  if (!hotStateEnabled()) return recordHarnessHeartbeat(db, harnessId, { ...report, now });
  const fingerprint = heartbeatReportFingerprint(report);
  const reportKey = harnessReportKey(harnessId);
  let redis: Redis;
  try {
    redis = getRedis();
    const results = await redis
      .multi()
      .set(harnessLastSeenKey(harnessId), String(now.getTime()), "PX", LAST_SEEN_TTL_MS)
      .get(reportKey)
      .exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
    if (results[1]![1] === fingerprint) return getHarness(db, harnessId);
    // Dropped before the write: if setting the new one fails, the next heartbeat writes
    // again rather than trust a fingerprint the row no longer matches.
    await redis.del(reportKey);
  } catch (error) {
    console.warn("hot-state: heartbeat falling back to Postgres", error);
    return recordHarnessHeartbeat(db, harnessId, { ...report, now });
  }
  const row = await recordHarnessHeartbeat(db, harnessId, { ...report, now });
  if (row) {
    await redis
      .set(reportKey, fingerprint, "PX", POSTGRES_HEARTBEAT_MAX_AGE_MS)
      .catch((error: unknown) => console.warn("hot-state: storing heartbeat report failed", error));
  }
  return row;
}

/** The harnesses' last-seen times in Redis (none with hot state off or on a Redis error). */
export async function readHarnessLastSeen(
  harnessIds: readonly string[],
): Promise<Map<string, Date>> {
  const lastSeen = new Map<string, Date>();
  if (!hotStateEnabled() || harnessIds.length === 0) return lastSeen;
  try {
    const values = await getRedis().mget(harnessIds.map(harnessLastSeenKey));
    values.forEach((value, i) => {
      const ms = value === null ? NaN : Number(value);
      if (Number.isFinite(ms)) lastSeen.set(harnessIds[i]!, new Date(ms));
    });
  } catch (error) {
    console.warn("hot-state: reading harness last-seen failed", error);
  }
  return lastSeen;
}

/**
 * The harnesses with `lastHeartbeatAt` from Redis where it's later than the row's (the
 * row is only written when the report changes or once a day).
 */
export async function withLastSeen<T extends { id: string; lastHeartbeatAt: Date | null }>(
  harnesses: readonly T[],
): Promise<T[]> {
  const lastSeen = await readHarnessLastSeen(harnesses.map((h) => h.id));
  return harnesses.map((harness) => {
    const seen = lastSeen.get(harness.id);
    return seen && (!harness.lastHeartbeatAt || seen > harness.lastHeartbeatAt)
      ? { ...harness, lastHeartbeatAt: seen }
      : harness;
  });
}

/** `withLastSeen` for a single harness (or none). */
export async function withHarnessLastSeen<T extends { id: string; lastHeartbeatAt: Date | null }>(
  harness: T | null,
): Promise<T | null> {
  return harness ? (await withLastSeen([harness]))[0]! : null;
}
