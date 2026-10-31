import "server-only";
import { createHash } from "node:crypto";
import { getAgent, recordAgentHeartbeat, type Database } from "@omniralph/db";
import type { Redis } from "ioredis";
import { msUntilNextDailyWindow } from "@/lib/daily-window";
import { getRedis, hotStateEnabled } from "@/lib/hot-state";

/**
 * An agent's last heartbeat, kept in Redis so an unchanged heartbeat doesn't write to
 * Postgres. Every heartbeat sets `agent-last-seen:{id}`; the agent row is written
 * only when what the agent reports changed (`agent-report:{id}` holds a fingerprint
 * of the report last written) or a daily window started since the row was written (the
 * fingerprint expires at the next window start, so the write lands in the window Neon is
 * awake for anyway). Neither key is derived from Postgres, so there's no epoch: a lost key
 * just means a Postgres write on the next heartbeat, and readers fall back to the
 * row's `last_heartbeat_at` (at most about a day behind).
 */

export type HeartbeatReport = Omit<Parameters<typeof recordAgentHeartbeat>[2], "now">;
export type AgentRow = NonNullable<Awaited<ReturnType<typeof recordAgentHeartbeat>>>;

const LAST_SEEN_PREFIX = "agent-last-seen:";
const REPORT_PREFIX = "agent-report:";
/** How long a last-seen outlives the agent's last heartbeat (then the row's value is used). */
export const LAST_SEEN_TTL_MS = 30 * 24 * 3600_000;

export function agentLastSeenKey(agentId: string): string {
  return `${LAST_SEEN_PREFIX}${agentId}`;
}

export function agentReportKey(agentId: string): string {
  return `${REPORT_PREFIX}${agentId}`;
}

/** Everything a heartbeat writes to the agent row, but its time. */
export function heartbeatReportFingerprint(report: HeartbeatReport): string {
  const normalized = [
    report.version,
    report.selfUpdate ?? null,
    report.update ?? null,
    report.failedVersions ?? [],
    report.installables ?? [],
    report.models ?? [],
    report.acceptedTaskTypes ?? null,
    report.host ?? null,
    report.local ?? null,
    report.hostTools ?? [],
    report.claude ?? null,
  ];
  return createHash("sha256").update(JSON.stringify(normalized)).digest("base64url");
}

/**
 * Records a heartbeat and returns the agent row (null for an unknown agent). With
 * hot state on, last-seen goes to Redis and the row is only written when the report
 * changed or a daily window started since it was written; otherwise (and on a Redis error) it
 * writes the row every time, as without Redis.
 */
export async function recordHeartbeat(
  db: Database,
  agentId: string,
  report: HeartbeatReport,
  now: Date = new Date(),
): Promise<AgentRow | null> {
  if (!hotStateEnabled()) return recordAgentHeartbeat(db, agentId, { ...report, now });
  const fingerprint = heartbeatReportFingerprint(report);
  const reportKey = agentReportKey(agentId);
  let redis: Redis;
  try {
    redis = getRedis();
    const results = await redis
      .multi()
      .set(agentLastSeenKey(agentId), String(now.getTime()), "PX", LAST_SEEN_TTL_MS)
      .get(reportKey)
      .exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
    if (results[1]![1] === fingerprint) return getAgent(db, agentId);
    // Dropped before the write: if setting the new one fails, the next heartbeat writes
    // again rather than trust a fingerprint the row no longer matches.
    await redis.del(reportKey);
  } catch (error) {
    console.warn("hot-state: heartbeat falling back to Postgres", error);
    return recordAgentHeartbeat(db, agentId, { ...report, now });
  }
  const row = await recordAgentHeartbeat(db, agentId, { ...report, now });
  if (row) {
    await redis
      .set(reportKey, fingerprint, "PX", msUntilNextDailyWindow(now))
      .catch((error: unknown) => console.warn("hot-state: storing heartbeat report failed", error));
  }
  return row;
}

/** The agents' last-seen times in Redis (none with hot state off or on a Redis error). */
export async function readAgentLastSeen(agentIds: readonly string[]): Promise<Map<string, Date>> {
  const lastSeen = new Map<string, Date>();
  if (!hotStateEnabled() || agentIds.length === 0) return lastSeen;
  try {
    const values = await getRedis().mget(agentIds.map(agentLastSeenKey));
    values.forEach((value, i) => {
      const ms = value === null ? NaN : Number(value);
      if (Number.isFinite(ms)) lastSeen.set(agentIds[i]!, new Date(ms));
    });
  } catch (error) {
    console.warn("hot-state: reading agent last-seen failed", error);
  }
  return lastSeen;
}

/**
 * The agents with `lastHeartbeatAt` from Redis where it's later than the row's (the
 * row is only written when the report changes or once a day, in the daily window).
 */
export async function withLastSeen<T extends { id: string; lastHeartbeatAt: Date | null }>(
  agents: readonly T[],
): Promise<T[]> {
  const lastSeen = await readAgentLastSeen(agents.map((h) => h.id));
  return agents.map((agent) => {
    const seen = lastSeen.get(agent.id);
    return seen && (!agent.lastHeartbeatAt || seen > agent.lastHeartbeatAt)
      ? { ...agent, lastHeartbeatAt: seen }
      : agent;
  });
}

/** `withLastSeen` for a single agent (or none). */
export async function withAgentLastSeen<T extends { id: string; lastHeartbeatAt: Date | null }>(
  agent: T | null,
): Promise<T | null> {
  return agent ? (await withLastSeen([agent]))[0]! : null;
}
