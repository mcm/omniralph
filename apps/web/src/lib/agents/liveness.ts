import "server-only";
import {
  listLiveOnlineAgents,
  markAgentLiveOnline,
  markAgentsLiveOffline,
  type Database,
} from "@omniralph/db";
import { readHotState, registerHotStateRebuilder, writeHotState } from "@/lib/hot-state";
import "@/lib/hot-state/rebuilders";
import { AGENT_ONLINE_WINDOW_MS } from "./display";
import { readAgentLastSeen } from "./last-seen";

/**
 * Agent online/offline transitions for live change events. Only transitions publish:
 * a heartbeat announces an agent online when `agents.live_online` was false
 * (`noteAgentOnline`), and the `agent-liveness` cron announces it offline once its
 * last heartbeat is older than `AGENT_ONLINE_WINDOW_MS` (`sweepAgentLiveness`), writing
 * that last heartbeat to the row as it does (so `live_online` and an offline agent's
 * `last_heartbeat_at` are exact in Postgres).
 *
 * With hot state on, the `agents-live-online` set in Redis holds the agents announced
 * online, so neither a steady heartbeat nor a sweep that finds every one of them fresh
 * (by Redis's last-seen) queries Postgres. It's derived from `live_online` (rebuilt
 * with the epoch). A heartbeat adds its agent after its Postgres write; the sweep
 * removes the agents Postgres no longer has online.
 */

export const LIVE_ONLINE_KEY = "agents-live-online";

function isStale(lastHeartbeatAt: Date | null | undefined, now: Date): boolean {
  return !lastHeartbeatAt || now.getTime() - lastHeartbeatAt.getTime() >= AGENT_ONLINE_WINDOW_MS;
}

/** After a heartbeat (its last-seen recorded): announces the agent online if it wasn't. */
export async function noteAgentOnline(db: Database, agentId: string): Promise<void> {
  const announced = await readHotState(
    db,
    async (redis) => (await redis.sismember(LIVE_ONLINE_KEY, agentId)) === 1,
    async () => false,
  );
  if (announced) return;
  await markAgentLiveOnline(db, agentId);
  // Added even when it was already online (a write that missed the set): a revoked
  // agent added here is removed by the sweep once its heartbeats stop.
  await writeHotState((redis) => redis.sadd(LIVE_ONLINE_KEY, agentId));
}

/**
 * Announces offline every agent announced online whose last heartbeat (Redis's
 * last-seen, else the row's) is older than the online window. Returns their IDs.
 * With hot state on, Postgres is only read when an agent in `agents-live-online` has no
 * recent last-seen.
 */
export async function sweepAgentLiveness(db: Database, now: Date = new Date()): Promise<string[]> {
  // The set's agents without a recent last-seen; null: read Postgres for all of them.
  const candidates = await readHotState<string[] | null>(
    db,
    async (redis) => {
      const ids = await redis.smembers(LIVE_ONLINE_KEY);
      const lastSeen = await readAgentLastSeen(ids);
      return ids.filter((id) => isStale(lastSeen.get(id), now));
    },
    async () => null,
  );
  if (candidates?.length === 0) return [];
  const rows = await listLiveOnlineAgents(db);
  const lastSeen = await readAgentLastSeen(rows.map((h) => h.id));
  // Each agent's real last heartbeat: Redis's last-seen when later than the row's.
  const online = rows.map((h) => {
    const seen = lastSeen.get(h.id);
    return seen && (!h.lastHeartbeatAt || seen > h.lastHeartbeatAt)
      ? { id: h.id, lastHeartbeatAt: seen }
      : { id: h.id, lastHeartbeatAt: h.lastHeartbeatAt };
  });
  const stale = online.filter((h) => isStale(h.lastHeartbeatAt, now));
  // Writes their last heartbeat with the flag, so an offline agent's row is exact.
  const offline = await markAgentsLiveOffline(db, stale);
  // Candidates still online (a fresh row: a heartbeat that missed Redis) stay in the set.
  const staleIds = new Set(stale.map((h) => h.id));
  const fresh = new Set(online.map((h) => h.id).filter((id) => !staleIds.has(id)));
  const gone = (candidates ?? offline).filter((id) => !fresh.has(id));
  if (gone.length > 0) await writeHotState((redis) => redis.srem(LIVE_ONLINE_KEY, ...gone));
  return offline;
}

registerHotStateRebuilder("agent-liveness", async (redis, db) => {
  const ids = (await listLiveOnlineAgents(db)).map((h) => h.id);
  const multi = redis.multi().del(LIVE_ONLINE_KEY);
  if (ids.length > 0) multi.sadd(LIVE_ONLINE_KEY, ...ids);
  const results = await multi.exec();
  if (!results || results.some(([error]) => error)) throw new Error("MULTI failed");
});
