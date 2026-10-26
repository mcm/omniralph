import "server-only";
import { createHash, randomInt } from "node:crypto";
import type { HeartbeatResponse, ReportedHostTool } from "@omniralph/shared";
import { EPOCH_KEY, getRedis, hotStateEnabled, writeHotState } from "@/lib/hot-state";
import { LATEST_MAX_AGE_MS } from "./desired-version";
import {
  harnessLastSeenKey,
  harnessReportKey,
  heartbeatReportFingerprint,
  LAST_SEEN_TTL_MS,
  type HeartbeatReport,
} from "./last-seen";
import { latestHarnessVersion, NpmRegistryError } from "./npm";

/**
 * An idle harness's heartbeat answered from Redis. The response a heartbeat with no
 * running jobs got is cached (`heartbeat-response:{id}`) with the harness's and its
 * organization's change counters (`heartbeat-changes:agent:{id}`,
 * `heartbeat-changes:org:{id}`) as they were before its Postgres reads, and the epoch.
 * Every write that changes a heartbeat response bumps a counter after its commit
 * (`bumpHarnessHeartbeat`, `bumpOrganizationHeartbeat`), so the next heartbeat that
 * finds both counters, the epoch and its own report unchanged gets the cached response
 * without a Postgres query. The epoch check covers a bump that failed (`writeHotState`
 * then deletes the epoch); the TTL bounds anything else that slips through.
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
export const CACHED_RESPONSE_TTL_MS = 3600_000;
/** Counters outlive any response cached with them; one created afresh starts at a random value. */
const CHANGES_TTL_MS = 30 * 24 * 3600_000;
const LATEST_TTL_MS = 24 * 3600_000;

/** The response fields that don't depend on the request's Ably token or claimable pools. */
export type CachedHeartbeatResponse = Omit<HeartbeatResponse, "ably" | "claimable">;

/** The change counters (and epoch) read before a heartbeat's Postgres reads. */
export interface HeartbeatChanges {
  epoch: string;
  harness: string;
  organization: string;
}

interface CacheEntry {
  changes: HeartbeatChanges;
  /** `heartbeatRequestKey` of the request the response answered. */
  request: string;
  /** The `latest` the response's `desiredVersion` came from; absent when it didn't. */
  latestVersion?: string | null;
  response: CachedHeartbeatResponse;
}

export function heartbeatResponseKey(harnessId: string): string {
  return `${RESPONSE_PREFIX}${harnessId}`;
}

export function harnessChangesKey(harnessId: string): string {
  return `${AGENT_CHANGES_PREFIX}${harnessId}`;
}

export function organizationChangesKey(organizationId: string): string {
  return `${ORGANIZATION_CHANGES_PREFIX}${organizationId}`;
}

export function latestVersionKey(organizationId: string): string {
  return `${LATEST_PREFIX}${organizationId}`;
}

/** Everything of a heartbeat request that the Postgres path writes. */
export function heartbeatRequestKey(
  report: HeartbeatReport,
  hostTools: readonly ReportedHostTool[],
): string {
  const tools = hostTools.map((tool) => [
    tool.name,
    tool.configuredPath ?? null,
    tool.configuredPathExists,
    tool.discoveredPath,
  ]);
  return createHash("sha256")
    .update(JSON.stringify([heartbeatReportFingerprint(report), tools]))
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

/** After a commit that changes the heartbeat response of these harnesses. */
export async function bumpHarnessHeartbeat(
  ...harnessIds: readonly (string | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(harnessIds.filter((id): id is string => !!id))];
  await bump(ids.map(harnessChangesKey));
}

/** After a commit that changes the heartbeat response of every harness of the organization. */
export async function bumpOrganizationHeartbeat(organizationId: string): Promise<void> {
  await bump([organizationChangesKey(organizationId)]);
}

/**
 * The counters and epoch to cache a response with; read before the Postgres reads the
 * response is built from. Null (don't cache) with hot state off, no epoch or a Redis error.
 */
export async function readHeartbeatChanges(
  harnessId: string,
  organizationId: string,
): Promise<HeartbeatChanges | null> {
  if (!hotStateEnabled()) return null;
  try {
    const harnessKey = harnessChangesKey(harnessId);
    const organizationKey = organizationChangesKey(organizationId);
    const results = await getRedis()
      .multi()
      .set(harnessKey, String(randomInt(2 ** 47)), "PX", CHANGES_TTL_MS, "NX")
      .set(organizationKey, String(randomInt(2 ** 47)), "PX", CHANGES_TTL_MS, "NX")
      .mget(EPOCH_KEY, harnessKey, organizationKey)
      .exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
    const [epoch, harness, organization] = results[2]![1] as (string | null)[];
    return epoch && harness && organization ? { epoch, harness, organization } : null;
  } catch (error) {
    console.warn("hot-state: reading heartbeat changes failed", error);
    return null;
  }
}

/** Caches a heartbeat's response (see the module comment). Never throws. */
export async function storeHeartbeatResponse(
  harnessId: string,
  entry: CacheEntry,
  latest?: { organizationId: string; version: string | null; checkedAt: Date },
): Promise<void> {
  try {
    const multi = getRedis()
      .multi()
      .set(heartbeatResponseKey(harnessId), JSON.stringify(entry), "PX", CACHED_RESPONSE_TTL_MS);
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
 * nothing it was built from changed; records the heartbeat's last-seen either way. Null
 * means the caller takes the Postgres path. Makes no Postgres query.
 */
export async function cachedHeartbeatResponse(
  harnessId: string,
  report: HeartbeatReport,
  hostTools: readonly ReportedHostTool[],
  options: CachedHeartbeatOptions = {},
): Promise<CachedHeartbeatResponse | null> {
  if (!hotStateEnabled()) return null;
  const now = options.now ?? new Date();
  try {
    const redis = getRedis();
    const results = await redis
      .multi()
      .set(harnessLastSeenKey(harnessId), String(now.getTime()), "PX", LAST_SEEN_TTL_MS)
      .mget(EPOCH_KEY, heartbeatResponseKey(harnessId), harnessReportKey(harnessId))
      .exec();
    if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
    const [epoch, cached, reported] = results[1]![1] as (string | null)[];
    if (!epoch || !cached || reported !== heartbeatReportFingerprint(report)) return null;
    const entry = JSON.parse(cached) as CacheEntry;
    if (entry.changes.epoch !== epoch) return null;
    if (entry.request !== heartbeatRequestKey(report, hostTools)) return null;
    const organizationId = entry.response.organizationId;
    const [harness, organization] = await redis.mget(
      harnessChangesKey(harnessId),
      organizationChangesKey(organizationId),
    );
    if (harness !== entry.changes.harness || organization !== entry.changes.organization) {
      return null;
    }
    if (entry.latestVersion !== undefined) {
      const latest = await currentLatestVersion(organizationId, now, options);
      if (latest === undefined || latest !== entry.latestVersion) return null;
    }
    return entry.response;
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
  const fetchLatest = options.fetchLatest ?? (() => latestHarnessVersion(fetch, options.timeoutMs));
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
