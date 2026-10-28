import "server-only";
import { createHash, randomInt } from "node:crypto";
import type { HeartbeatResponse } from "@omniralph/shared";
import { EPOCH_KEY, getRedis, hotStateEnabled, writeHotState } from "@/lib/hot-state";
import { LATEST_MAX_AGE_MS } from "./desired-version";
import {
  agentLastSeenKey,
  agentReportKey,
  heartbeatReportFingerprint,
  LAST_SEEN_TTL_MS,
  type HeartbeatReport,
} from "./last-seen";
import { latestAgentVersion, NpmRegistryError } from "./npm";

/**
 * An idle agent's heartbeat answered from Redis. The response a heartbeat with no
 * running jobs got is cached (`heartbeat-response:{id}`) with the agent's and its
 * organization's change counters (`heartbeat-changes:agent:{id}`,
 * `heartbeat-changes:org:{id}`) as they were before its Postgres reads, and the epoch.
 * Every write that changes a heartbeat response bumps a counter after its commit
 * (`bumpAgentHeartbeat`, `bumpOrganizationHeartbeat`), so the next heartbeat that
 * finds both counters, the epoch and its own report unchanged gets the cached response
 * without a Postgres query. The epoch check covers a bump that failed (`writeHotState`
 * then deletes the epoch); `CACHED_RESPONSE_TTL_MS` bounds anything else that slips
 * through, such as a write that forgot to bump. A cached response that reaches that bound
 * with its counters unchanged is checked for drift: the heartbeat builds the response
 * from Postgres anyway, and `checkHeartbeatDrift` logs the cached fields that differ (a
 * missed bump) before the fresh one is stored.
 *
 * An organization that tracks npm's `latest` also needs it unchanged: it's read from
 * `agent-latest-version:{org}` (refreshed from npm, not Postgres, once it's older
 * than `LATEST_MAX_AGE_MS`).
 */

const RESPONSE_PREFIX = "heartbeat-response:";
const AGENT_CHANGES_PREFIX = "heartbeat-changes:agent:";
const ORGANIZATION_CHANGES_PREFIX = "heartbeat-changes:org:";
const LATEST_PREFIX = "agent-latest-version:";
/** How long a cached response is used at most, whatever the counters say. */
export const CACHED_RESPONSE_TTL_MS = 24 * 3600_000;
/**
 * How long Redis keeps a cached response: past `CACHED_RESPONSE_TTL_MS`, so the heartbeat
 * that finds it due still has it to compare with the fresh one.
 */
export const CACHED_RESPONSE_KEEP_MS = 2 * CACHED_RESPONSE_TTL_MS;
/** Counters outlive any response cached with them; one created afresh starts at a random value. */
const CHANGES_TTL_MS = 30 * 24 * 3600_000;
const LATEST_TTL_MS = 24 * 3600_000;

/** The response fields that don't depend on the request's Ably token or claimable pools. */
export type CachedHeartbeatResponse = Omit<HeartbeatResponse, "ably" | "claimable">;

/** The change counters (and epoch) read before a heartbeat's Postgres reads. */
export interface HeartbeatChanges {
  epoch: string;
  agent: string;
  organization: string;
}

interface CacheEntry {
  changes: HeartbeatChanges;
  /** `heartbeatRequestKey` of the request the response answered. */
  request: string;
  /** The `latest` the response's `desiredVersion` came from; absent when it didn't. */
  latestVersion?: string | null;
  response: CachedHeartbeatResponse;
  /** When it was stored (ms); absent in entries stored before it was recorded. */
  builtAt?: number;
}

/** A cached response whose counters, epoch and report are unchanged. */
export interface CachedHeartbeat {
  response: CachedHeartbeatResponse;
  /** The `latest` its `desiredVersion` came from; absent when it didn't. */
  latestVersion?: string | null;
  /**
   * It reached `CACHED_RESPONSE_TTL_MS`: don't use it, build the response from Postgres
   * and `checkHeartbeatDrift` against it.
   */
  due: boolean;
}

export function heartbeatResponseKey(agentId: string): string {
  return `${RESPONSE_PREFIX}${agentId}`;
}

export function agentChangesKey(agentId: string): string {
  return `${AGENT_CHANGES_PREFIX}${agentId}`;
}

export function organizationChangesKey(organizationId: string): string {
  return `${ORGANIZATION_CHANGES_PREFIX}${organizationId}`;
}

export function latestVersionKey(organizationId: string): string {
  return `${LATEST_PREFIX}${organizationId}`;
}

/** Everything of a heartbeat request that the Postgres path writes (host tools included). */
export function heartbeatRequestKey(report: HeartbeatReport): string {
  return createHash("sha256")
    .update(JSON.stringify([heartbeatReportFingerprint(report)]))
    .digest("base64url");
}

async function bump(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await writeHotState(async (redis) => {
    const multi = redis.multi();
    for (const key of keys) multi.incr(key).pexpire(key, CHANGES_TTL_MS);
    const results = await multi.exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
  });
}

/** After a commit that changes the heartbeat response of these agents. */
export async function bumpAgentHeartbeat(
  ...agentIds: readonly (string | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(agentIds.filter((id): id is string => !!id))];
  await bump(ids.map(agentChangesKey));
}

/** After a commit that changes the heartbeat response of every agent of the organization. */
export async function bumpOrganizationHeartbeat(organizationId: string): Promise<void> {
  await bump([organizationChangesKey(organizationId)]);
}

/**
 * The counters and epoch to cache a response with; read before the Postgres reads the
 * response is built from. Null (don't cache) with hot state off, no epoch or a Redis error.
 */
export async function readHeartbeatChanges(
  agentId: string,
  organizationId: string,
): Promise<HeartbeatChanges | null> {
  if (!hotStateEnabled()) return null;
  try {
    const agentKey = agentChangesKey(agentId);
    const organizationKey = organizationChangesKey(organizationId);
    const results = await getRedis()
      .multi()
      .set(agentKey, String(randomInt(2 ** 47)), "PX", CHANGES_TTL_MS, "NX")
      .set(organizationKey, String(randomInt(2 ** 47)), "PX", CHANGES_TTL_MS, "NX")
      .mget(EPOCH_KEY, agentKey, organizationKey)
      .exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
    const [epoch, agent, organization] = results[2]![1] as (string | null)[];
    return epoch && agent && organization ? { epoch, agent, organization } : null;
  } catch (error) {
    console.warn("hot-state: reading heartbeat changes failed", error);
    return null;
  }
}

/** Caches a heartbeat's response (see the module comment). Never throws. */
export async function storeHeartbeatResponse(
  agentId: string,
  entry: Omit<CacheEntry, "builtAt">,
  latest?: { organizationId: string; version: string | null; checkedAt: Date },
  now: Date = new Date(),
): Promise<void> {
  try {
    const stored: CacheEntry = { ...entry, builtAt: now.getTime() };
    const multi = getRedis()
      .multi()
      .set(heartbeatResponseKey(agentId), JSON.stringify(stored), "PX", CACHED_RESPONSE_KEEP_MS);
    if (latest) {
      multi.set(
        latestVersionKey(latest.organizationId),
        JSON.stringify({ version: latest.version, checkedAt: latest.checkedAt.getTime() }),
        "PX",
        LATEST_TTL_MS,
      );
    }
    await multi.exec();
  } catch (error) {
    console.warn("hot-state: caching heartbeat response failed", error);
  }
}

export interface CachedHeartbeatOptions {
  now?: Date;
  /** Reads npm's `latest` (default: the registry, with `timeoutMs`). */
  fetchLatest?: () => Promise<string>;
  timeoutMs?: number;
}

/**
 * The cached response for a heartbeat with no running jobs or acknowledgements, when
 * nothing it was built from changed; records the heartbeat's last-seen either way. Null,
 * or `due` (it reached `CACHED_RESPONSE_TTL_MS`), means the caller takes the Postgres
 * path. Makes no Postgres query.
 */
export async function cachedHeartbeatResponse(
  agentId: string,
  report: HeartbeatReport,
  options: CachedHeartbeatOptions = {},
): Promise<CachedHeartbeat | null> {
  if (!hotStateEnabled()) return null;
  const now = options.now ?? new Date();
  try {
    const redis = getRedis();
    const results = await redis
      .multi()
      .set(agentLastSeenKey(agentId), String(now.getTime()), "PX", LAST_SEEN_TTL_MS)
      .mget(EPOCH_KEY, heartbeatResponseKey(agentId), agentReportKey(agentId))
      .exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
    const [epoch, cached, reported] = results[1]![1] as (string | null)[];
    if (!epoch || !cached || reported !== heartbeatReportFingerprint(report)) return null;
    const entry = JSON.parse(cached) as CacheEntry;
    if (entry.changes.epoch !== epoch) return null;
    if (entry.request !== heartbeatRequestKey(report)) return null;
    const organizationId = entry.response.organizationId;
    const [agent, organization] = await redis.mget(
      agentChangesKey(agentId),
      organizationChangesKey(organizationId),
    );
    if (agent !== entry.changes.agent || organization !== entry.changes.organization) {
      return null;
    }
    if (entry.latestVersion !== undefined) {
      const latest = await currentLatestVersion(organizationId, now, options);
      if (latest === undefined || latest !== entry.latestVersion) return null;
    }
    const due =
      entry.builtAt === undefined || now.getTime() - entry.builtAt >= CACHED_RESPONSE_TTL_MS;
    return {
      response: entry.response,
      ...(entry.latestVersion !== undefined && { latestVersion: entry.latestVersion }),
      due,
    };
  } catch (error) {
    console.warn("hot-state: reading the cached heartbeat failed", error);
    return null;
  }
}

/**
 * The organization's `latest` from Redis, read from npm again once it's older than
 * `LATEST_MAX_AGE_MS`; undefined when it can't be told (the Postgres path then reads
 * and records it as usual).
 */
async function currentLatestVersion(
  organizationId: string,
  now: Date,
  options: CachedHeartbeatOptions,
): Promise<string | null | undefined> {
  const redis = getRedis();
  const key = latestVersionKey(organizationId);
  const stored = await redis.get(key);
  if (stored) {
    const { version, checkedAt } = JSON.parse(stored) as {
      version: string | null;
      checkedAt: number;
    };
    if (now.getTime() - checkedAt < LATEST_MAX_AGE_MS) return version;
  }
  const fetchLatest = options.fetchLatest ?? (() => latestAgentVersion(fetch, options.timeoutMs));
  let version: string;
  try {
    version = await fetchLatest();
  } catch (error) {
    if (error instanceof NpmRegistryError) return undefined;
    throw error;
  }
  await redis.set(key, JSON.stringify({ version, checkedAt: now.getTime() }), "PX", LATEST_TTL_MS);
  return version;
}

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/**
 * Compares a cached response that reached `CACHED_RESPONSE_TTL_MS` with its counters and
 * epoch unchanged against the one just built from Postgres. A field that differs means a
 * write changed the response without bumping a counter: logs an error naming the agent,
 * the organization and the fields (not their values). `desiredVersion` and
 * `versionPolicy` are left out when the organization tracks npm's `latest`
 * (`latestVersion` given) and it isn't the one the cached response came from: `latest`
 * changes without a bump. Returns the fields that differ.
 */
export function checkHeartbeatDrift(input: {
  agentId: string;
  organizationId: string;
  cached: CachedHeartbeat;
  fresh: CachedHeartbeatResponse;
  /** The `latest` the fresh `desiredVersion` came from; undefined when it didn't. */
  latestVersion?: string | null;
}): string[] {
  const { cached, fresh } = input;
  const skip = new Set<string>();
  if (input.latestVersion !== undefined && input.latestVersion !== cached.latestVersion) {
    skip.add("desiredVersion").add("versionPolicy");
  }
  const cachedFields = cached.response as Record<string, unknown>;
  const freshFields = fresh as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(cachedFields), ...Object.keys(freshFields)])]
    .filter((field) => !skip.has(field))
    .filter((field) => canonicalJson(cachedFields[field]) !== canonicalJson(freshFields[field]))
    .sort();
  if (fields.length > 0) {
    console.error(
      `heartbeat cache drift: agent ${input.agentId} (organization ${input.organizationId}) ` +
        `was served a cached response whose ${fields.join(", ")} changed without a bump`,
      { agentId: input.agentId, organizationId: input.organizationId, fields },
    );
  }
  return fields;
}
