import "server-only";
import {
  listLiveOnlineAgents,
  markAgentLiveOnline,
  markAgentsLiveOffline,
  type Database,
} from "@omniralph/db";
import { getRedis, hotStateEnabled } from "@/lib/hot-state";
import { HARNESS_ONLINE_WINDOW_MS } from "./display";
import { withLastSeen } from "./last-seen";

/**
 * Agent online/offline transitions for live change events. Only transitions publish:
 * a heartbeat announces an agent online when `harnesses.live_online` was false
 * (`noteAgentOnline`), and the `agent-liveness` cron announces it offline once its
 * last heartbeat is older than `HARNESS_ONLINE_WINDOW_MS` (`sweepAgentLiveness`).
 *
 * With hot state on, `agent-live:{id}` in Redis remembers for a short while that the
 * agent was announced, so a steady heartbeat doesn't touch Postgres for it. The key
 * lives no longer than the online window, so a cron flip that raced a heartbeat is
 * corrected by a heartbeat within that window.
 */

const LIVE_PREFIX = "agent-live:";

export function harnessLiveKey(harnessId: string): string {
  return `${LIVE_PREFIX}${harnessId}`;
}

/** After a heartbeat (its last-seen recorded): announces the agent online if it wasn't. */
export async function noteAgentOnline(db: Database, harnessId: string): Promise<void> {
  if (!hotStateEnabled()) {
    await markAgentLiveOnline(db, harnessId);
    return;
  }
  try {
    const redis = getRedis();
    if ((await redis.get(harnessLiveKey(harnessId))) === "1") return;
    await markAgentLiveOnline(db, harnessId);
    await redis.set(harnessLiveKey(harnessId), "1", "PX", HARNESS_ONLINE_WINDOW_MS);
  } catch (error) {
    console.warn("hot-state: noting the agent online falling back to Postgres", error);
    await markAgentLiveOnline(db, harnessId);
  }
}

/**
 * Announces offline every agent announced online whose last heartbeat (Redis's
 * last-seen, else the row's) is older than the online window. Returns their IDs.
 */
export async function sweepAgentLiveness(db: Database, now: Date = new Date()): Promise<string[]> {
  const online = await withLastSeen(await listLiveOnlineAgents(db));
  const stale = online
    .filter(
      (h) =>
        h.lastHeartbeatAt === null ||
        now.getTime() - h.lastHeartbeatAt.getTime() >= HARNESS_ONLINE_WINDOW_MS,
    )
    .map((h) => h.id);
  const offline = await markAgentsLiveOffline(db, stale);
  if (offline.length > 0 && hotStateEnabled()) {
    await getRedis()
      .del(...offline.map(harnessLiveKey))
      .catch((error: unknown) => console.warn("hot-state: clearing agent liveness failed", error));
  }
  return offline;
}
