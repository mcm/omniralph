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
 * one script (`compareRefreshToken`) and buffers its `token_refresh` audit row
 * (`agent-refresh:audit`); the daily `flush-agent-auth` cron writes both to Postgres.
 * With hot state off or Redis unavailable, refresh rotates in Postgres instead.
 */

export const REFRESH_TOKENS_KEY = "agent-refresh:tokens";
export const REFRESH_AUDIT_KEY = "agent-refresh:audit";
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

/** Records an agent's new refresh token in Redis; call after its Postgres commit. */
export async function cacheRefreshToken(agentId: string, state: RefreshTokenState): Promise<void> {
  await writeHotState((redis) => redis.hset(REFRESH_TOKENS_KEY, agentId, encodeState(state)));
}

// Compares the presented token with the agent's current one (as `compareRefreshToken`);
// unless it's reuse, records the next token and buffers the audit row. Returns the outcome.
const ROTATE_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
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
redis.call('RPUSH', KEYS[2], ARGV[5])
return status`;

// Sets each agent's state from Postgres unless Redis already holds a newer generation
// (Redis runs ahead of Postgres until the daily flush). ARGV: agent ID, generation, hash, ...
const MERGE_SCRIPT = `for i = 1, #ARGV, 3 do
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  local gen = nil
  if cur then gen = tonumber(string.sub(cur, 1, string.find(cur, ':', 1, true) - 1)) end
  if not gen or tonumber(ARGV[i + 1]) >= gen then
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1] .. ':' .. ARGV[i + 2])
  end
end
return 1`;

/** A buffered audit row, as stored in `agent-refresh:audit`. */
interface BufferedAudit {
  agentId: string;
  ip: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type RefreshRotation =
  | { status: "rotated" | "caught_up" | "reused"; agentId: string }
  | { status: "invalid"; agentId: string | null; reason: "unknown" | "agent_revoked" };

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
  if (hotStateEnabled()) {
    let rotation: RefreshRotation | undefined;
    try {
      const redis = getRedis();
      if (await ensureHotStateEpoch(redis, db)) {
        const state = await readAgentAuthState(db, agentId);
        if (state !== "active") {
          return {
            status: "invalid",
            agentId: state === "unknown" ? null : agentId,
            reason: state === "unknown" ? "unknown" : "agent_revoked",
          };
        }
        const audit: BufferedAudit = { agentId, ip, detail, createdAt: now.toISOString() };
        const status = (await redis.eval(
          ROTATE_SCRIPT,
          2,
          REFRESH_TOKENS_KEY,
          REFRESH_AUDIT_KEY,
          agentId,
          String(presented.generation),
          presented.tokenIdHash,
          encodeState(next),
          JSON.stringify(audit),
        )) as "rotated" | "caught_up" | "reused";
        rotation = { status, agentId };
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
  const rotation = await rotateSignedRefreshToken(db, { agentId, presented, next }, now);
  if (rotation.status === "rotated" || rotation.status === "caught_up") {
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
 * The daily flush (`flush-agent-auth`): writes Redis's refresh-token generations and the
 * buffered `token_refresh` audit rows to Postgres. A no-op with hot state off. Rows leave
 * the buffer only after their insert, so a failure retries them at the next flush.
 */
export async function flushAgentAuth(db: Database): Promise<AgentAuthFlush> {
  if (!hotStateEnabled()) return { generations: 0, audits: 0 };
  const redis = getRedis();
  const states = Object.entries(await redis.hgetall(REFRESH_TOKENS_KEY)).flatMap(
    ([agentId, value]) => {
      const state = decodeState(value);
      return state ? [{ agentId, ...state }] : [];
    },
  );
  const generations = states.length > 0 ? await saveAgentRefreshTokenStates(db, states) : 0;
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
}

// Merges Postgres's last recorded generations in (the buffered audit rows aren't derived
// from Postgres: a lost Redis loses them).
registerHotStateRebuilder("agent-refresh", async (redis, db) => {
  const states = await listAgentRefreshTokenStates(db);
  for (let i = 0; i < states.length; i += REBUILD_BATCH) {
    const args = states
      .slice(i, i + REBUILD_BATCH)
      .flatMap((s) => [s.agentId, String(s.generation), s.tokenIdHash]);
    await redis.eval(MERGE_SCRIPT, 1, REFRESH_TOKENS_KEY, ...args);
  }
});
