import "server-only";
import { randomBytes } from "node:crypto";
import {
  hashToken,
  listAgentRefreshTokenStates,
  revokeAgentForRefreshReuse,
  rotateSignedRefreshToken,
  saveAgentRefreshTokenStates,
  writeAgentAudit,
  writeAgentAudits,
  type AgentAuditInput,
  type Database,
  type IssuedRefreshToken,
  type RefreshTokenState,
} from "@omniralph/db";
import {
  EPOCH_KEY,
  ensureHotStateEpoch,
  getRedis,
  hotStateEnabled,
  registerHotStateRebuilder,
  writeHotState,
} from "@/lib/hot-state";
import { readAgentAuthState } from "./auth-state";
import { getTokenSigner } from "./signer";

/**
 * Write-free token refresh (TOOL-856). A signed refresh token carries the agent ID, a
 * generation and a random ID; Redis holds each agent's current generation and the hash of
 * its random ID (`agent-refresh:tokens`, field = agent ID, value `<generation>:<hash>`),
 * rebuilt from Postgres through the hot-state epoch. A refresh compares and advances it in
 * one script (`compareRefreshToken`), marks the agent changed (`agent-refresh:changed`) and
 * buffers its `token_refresh` audit row (`agent-refresh:audit`); the daily
 * `flush-agent-auth` cron writes the changed agents' tokens and the rows to Postgres.
 * With hot state off or Redis unavailable, refresh rotates in Postgres instead.
 *
 * Re-enrolling an agent in place (TOOL-925) starts a new token family past every
 * generation issued before; `agent-refresh:families` (field = agent ID, value its first
 * generation, from `agents.refresh_family_start`) makes the script reject an older token
 * as stale, without revoking the agent and never as a newer generation to catch up to.
 */

export const REFRESH_TOKENS_KEY = "agent-refresh:tokens";
export const REFRESH_AUDIT_KEY = "agent-refresh:audit";
/** Each re-enrolled agent's first generation of its current token family. */
export const REFRESH_FAMILIES_KEY = "agent-refresh:families";
/** The agents whose token in Redis is newer than Postgres's (until the flush). */
export const REFRESH_CHANGED_KEY = "agent-refresh:changed";
/** Held by a running flush, so a cron event delivered twice doesn't write its rows twice. */
const FLUSH_LOCK_KEY = "agent-refresh:flush-lock";
const FLUSH_LOCK_MS = 15 * 60_000;
/** Audit rows written per insert by the flush. */
const FLUSH_BATCH = 500;
/** Agents merged per rebuild script call. */
const REBUILD_BATCH = 300;

function encodeState(state: RefreshTokenState): string {
  return `${state.generation}:${state.tokenIdHash}`;
}

function decodeState(value: string): RefreshTokenState | null {
  const sep = value.indexOf(":");
  const generation = Number(value.slice(0, sep));
  if (sep < 1 || !Number.isSafeInteger(generation)) return null;
  return { generation, tokenIdHash: value.slice(sep + 1) };
}

/** Signs the agent's refresh token of `generation` with a fresh random ID. */
export async function issueRefreshToken(
  agentId: string,
  generation: number,
): Promise<IssuedRefreshToken> {
  const tokenId = randomBytes(32).toString("base64url");
  const token = await getTokenSigner().signRefreshToken({ agentId, generation, tokenId });
  return { token, generation, tokenIdHash: hashToken(tokenId) };
}

/**
 * Records an agent's new refresh token in Redis; call after its Postgres commit. Raise-only
 * (as the rebuild's merge): a newer generation already in Redis stays.
 */
export async function cacheRefreshToken(
  agentId: string,
  state: RefreshTokenState,
  familyStart: number | null = null,
): Promise<void> {
  await writeHotState((redis) =>
    redis.eval(
      MERGE_SCRIPT,
      2,
      REFRESH_TOKENS_KEY,
      REFRESH_FAMILIES_KEY,
      agentId,
      String(state.generation),
      state.tokenIdHash,
      familyStart === null ? "" : String(familyStart),
    ),
  );
}

/**
 * How far past the last generation it knows of a re-enrolled agent's new token family
 * starts: Redis runs ahead of Postgres by the refreshes since the last daily flush (about
 * 120 a day), and loses them if it loses its state. Tokens issued in that gap stay older
 * than the family, so they're rejected rather than caught up to.
 */
export const REENROLL_GENERATION_GAP = 1_000;

/**
 * The generation of the first refresh token of a re-enrolled agent (TOOL-925): past every
 * generation issued to it before, Postgres's (`previousGeneration`, up to a day behind) and
 * Redis's (the live one while hot state is on; best effort), plus `REENROLL_GENERATION_GAP`.
 */
export async function reenrolledGeneration(
  agentId: string,
  previousGeneration: number | null,
): Promise<number> {
  let live = 0;
  if (hotStateEnabled()) {
    try {
      const value = await getRedis().hget(REFRESH_TOKENS_KEY, agentId);
      live = (value ? decodeState(value)?.generation : undefined) ?? 0;
    } catch (error) {
      console.warn("agent refresh: reading the live generation failed", error);
    }
  }
  return Math.max(previousGeneration ?? 0, live) + REENROLL_GENERATION_GAP;
}

// Rejects a token of a family the agent left (as `isStaleRefreshFamily`), then compares it
// with the agent's current one (as `compareRefreshToken`); unless it's reuse, records the
// next token and buffers the audit row. Returns the outcome.
const ROTATE_SCRIPT = `local start = redis.call('HGET', KEYS[4], ARGV[1])
if start and tonumber(ARGV[2]) < tonumber(start) then
  return 'stale_family'
end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local status = 'caught_up'
if cur then
  local sep = string.find(cur, ':', 1, true)
  local gen = tonumber(string.sub(cur, 1, sep - 1))
  local presented = tonumber(ARGV[2])
  if presented == gen and string.sub(cur, sep + 1) == ARGV[3] then
    status = 'rotated'
  elseif presented <= gen then
    return 'reused'
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[5])
return status`;

// After the flush wrote them: unmarks each agent (ARGV: agent ID, value) whose token is
// still the one written; one that refreshed meanwhile stays for the next flush.
const FLUSHED_SCRIPT = `for i = 1, #ARGV, 2 do
  if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then
    redis.call('SREM', KEYS[2], ARGV[i])
  end
end
return 1`;

// Sets each agent's state from Postgres unless Redis already holds a newer generation
// (Redis runs ahead of Postgres until the daily flush) of the agent's current family: one
// older than the family's first generation (ARGV "" when none) is from before a
// re-enrollment and is replaced, and the family is recorded (KEYS[2]).
// ARGV: agent ID, generation, hash, family start, ...
const MERGE_SCRIPT = `for i = 1, #ARGV, 4 do
  local start = tonumber(ARGV[i + 3])
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  local gen = nil
  if cur then gen = tonumber(string.sub(cur, 1, string.find(cur, ':', 1, true) - 1)) end
  if not gen or tonumber(ARGV[i + 1]) >= gen or (start and gen < start) then
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1] .. ':' .. ARGV[i + 2])
  end
  if start then
    local known = tonumber(redis.call('HGET', KEYS[2], ARGV[i]))
    if not known or start > known then redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 3]) end
  end
end
return 1`;

// Puts the presented token back (ARGV: agent ID, next, presented) if the agent's token is
// still the one the rotate script recorded: that token was never handed out.
const UNDO_ROTATE_SCRIPT = `if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  return 1
end
return 0`;

/** A buffered audit row, as stored in `agent-refresh:audit`. */
interface BufferedAudit {
  agentId: string;
  ip: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type RefreshRotation =
  | { status: "rotated" | "caught_up" | "reused"; agentId: string }
  | {
      status: "invalid";
      agentId: string | null;
      reason: "unknown" | "agent_revoked" | "stale_family";
    };

/**
 * Rotates a signed refresh token: `presented` is the token's generation and the hash of
 * its random ID, `next` the token to issue in its place. In Redis while hot state is
 * trusted (nothing written to Postgres unless it's reuse), else in Postgres. Reuse revokes
 * the agent in Postgres; the caller caches the revocation and audits it.
 */
export async function rotateRefreshTokenState(
  db: Database,
  input: {
    agentId: string;
    presented: RefreshTokenState;
    next: RefreshTokenState;
    ip: string;
  },
  now: Date = new Date(),
): Promise<RefreshRotation> {
  const { agentId, presented, next, ip } = input;
  const detail = { generation: presented.generation };
  // Whether Redis answered, and whether the rotate script may have run.
  let reachable = false;
  let scriptSent = false;
  if (hotStateEnabled()) {
    let rotation: RefreshRotation | undefined;
    try {
      const redis = getRedis();
      const trusted = await ensureHotStateEpoch(redis, db);
      reachable = true;
      if (trusted) {
        const state = await readAgentAuthState(db, agentId);
        if (state !== "active") {
          return {
            status: "invalid",
            agentId: state === "unknown" ? null : agentId,
            reason: state === "unknown" ? "unknown" : "agent_revoked",
          };
        }
        const audit: BufferedAudit = { agentId, ip, detail, createdAt: now.toISOString() };
        scriptSent = true;
        const status = (await redis.eval(
          ROTATE_SCRIPT,
          4,
          REFRESH_TOKENS_KEY,
          REFRESH_AUDIT_KEY,
          REFRESH_CHANGED_KEY,
          REFRESH_FAMILIES_KEY,
          agentId,
          String(presented.generation),
          presented.tokenIdHash,
          encodeState(next),
          JSON.stringify(audit),
        )) as "rotated" | "caught_up" | "reused" | "stale_family";
        rotation =
          status === "stale_family"
            ? { status: "invalid", agentId, reason: status }
            : { status, agentId };
      }
    } catch (error) {
      // The script may have run: let readers rebuild from Postgres, which records the
      // rotation below.
      console.warn("agent refresh: rotating in Postgres", error);
      await getRedis()
        .del(EPOCH_KEY)
        .catch(() => undefined);
    }
    if (rotation) {
      if (rotation.status === "reused") await revokeAgentForRefreshReuse(db, agentId, now);
      return rotation;
    }
  }
  let rotation: RefreshRotation;
  try {
    rotation = await rotateSignedRefreshToken(db, { agentId, presented, next }, now);
  } catch (error) {
    // The client gets an error and retries with the presented token: if the script
    // recorded the next one (its reply lost), put the presented one back, or the retry
    // would be reuse. Best effort: with Redis failing too, the retry revokes the agent.
    if (scriptSent) {
      await getRedis()
        .eval(
          UNDO_ROTATE_SCRIPT,
          1,
          REFRESH_TOKENS_KEY,
          agentId,
          encodeState(next),
          encodeState(presented),
        )
        .catch(() => undefined);
    }
    throw error;
  }
  if (rotation.status === "rotated" || rotation.status === "caught_up") {
    // A rebuild running elsewhere may have read Postgres before this commit; without this,
    // Redis would keep the presented token as current and accept a copy of it once.
    if (reachable) await cacheRefreshToken(agentId, next);
    await writeAgentAudit(db, { agentId, event: "token_refresh", ip, detail });
  }
  return rotation;
}

function parseAudit(value: string): AgentAuditInput | null {
  try {
    const row = JSON.parse(value) as BufferedAudit;
    return {
      agentId: row.agentId,
      event: "token_refresh",
      ip: row.ip,
      detail: row.detail,
      createdAt: new Date(row.createdAt),
    };
  } catch {
    return null;
  }
}

export interface AgentAuthFlush {
  /** Agents whose refresh-token generation was written to Postgres. */
  generations: number;
  /** Buffered `token_refresh` audit rows written. */
  audits: number;
}

/**
 * The daily flush (`flush-agent-auth`): writes the refresh-token generations of the agents
 * that refreshed through Redis since the last flush, and the buffered `token_refresh` audit
 * rows, to Postgres. Makes no Postgres query when there's neither; a no-op with hot state
 * off, or while another flush runs. Agents are unmarked and rows leave the buffer only after
 * their write, so a failure retries them at the next flush.
 */
export async function flushAgentAuth(db: Database): Promise<AgentAuthFlush> {
  const none = { generations: 0, audits: 0 };
  if (!hotStateEnabled()) return none;
  const redis = getRedis();
  const lock = randomBytes(16).toString("base64url");
  if ((await redis.set(FLUSH_LOCK_KEY, lock, "PX", FLUSH_LOCK_MS, "NX")) !== "OK") return none;
  try {
    const changed = await redis.smembers(REFRESH_CHANGED_KEY);
    let generations = 0;
    if (changed.length > 0) {
      const values = await redis.hmget(REFRESH_TOKENS_KEY, ...changed);
      const written: string[] = [];
      const states = changed.flatMap((agentId, i) => {
        const value = values[i];
        const state = value ? decodeState(value) : null;
        if (!state) return [];
        written.push(agentId, value!);
        return [{ agentId, ...state }];
      });
      if (states.length > 0) generations = await saveAgentRefreshTokenStates(db, states);
      // Agents without a token in Redis (a rebuild dropped them) have nothing to write.
      const gone = changed.filter((_, i) => !values[i]);
      if (gone.length > 0) await redis.srem(REFRESH_CHANGED_KEY, ...gone);
      if (written.length > 0) {
        await redis.eval(FLUSHED_SCRIPT, 2, REFRESH_TOKENS_KEY, REFRESH_CHANGED_KEY, ...written);
      }
    }
    let audits = 0;
    for (;;) {
      const batch = await redis.lrange(REFRESH_AUDIT_KEY, 0, FLUSH_BATCH - 1);
      if (batch.length === 0) break;
      const rows = batch.flatMap((value) => parseAudit(value) ?? []);
      await writeAgentAudits(db, rows);
      await redis.ltrim(REFRESH_AUDIT_KEY, batch.length, -1);
      audits += rows.length;
    }
    return { generations, audits };
  } finally {
    // Only our own lock: one that expired may be another flush's by now.
    if ((await redis.get(FLUSH_LOCK_KEY).catch(() => null)) === lock) {
      await redis.del(FLUSH_LOCK_KEY).catch(() => undefined);
    }
  }
}

// Merges Postgres's last recorded generations in (the buffered audit rows aren't derived
// from Postgres: a lost Redis loses them).
registerHotStateRebuilder("agent-refresh", async (redis, db) => {
  const states = await listAgentRefreshTokenStates(db);
  for (let i = 0; i < states.length; i += REBUILD_BATCH) {
    const args = states
      .slice(i, i + REBUILD_BATCH)
      .flatMap((s) => [
        s.agentId,
        String(s.generation),
        s.tokenIdHash,
        s.familyStart === null ? "" : String(s.familyStart),
      ]);
    await redis.eval(MERGE_SCRIPT, 2, REFRESH_TOKENS_KEY, REFRESH_FAMILIES_KEY, ...args);
  }
});
