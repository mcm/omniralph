/**
 * What each live change event (`GET /api/events`, `src/ui/events.ts`) does to the cache:
 * `logs` and `transcript` carry their new lines and append them directly; every other
 * resource invalidates the queries that show it. The map is exhaustive, so a resource the
 * daemon adds without a mapping here fails typecheck.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { AttemptDetail } from "../../../src/attempts/history.js";
import type { TailEvent } from "../../../src/attempts/tail.js";
import type { LogEntry } from "../../../src/logs/entries.js";
import type { AgentUiChange, AgentUiResource } from "../../../src/ui/events.js";
import { agentKeys } from "./keys.js";

export type { AgentUiChange, AgentUiResource };

/** Most live log lines kept (the daemon's ring holds as many). */
export const LIVE_LOG_TAIL_SIZE = 2_000;
/** Most transcript events kept per attempt (the daemon's tail holds as many). */
export const TRANSCRIPT_TAIL_SIZE = 2_000;

export type LiveHandler =
  | { invalidate: (change: AgentUiChange) => QueryKey[] }
  | { append: (client: QueryClient, change: AgentUiChange) => void };

/** The attempts an event names, or every attempt query when it names none. */
function attemptKeys(change: AgentUiChange): QueryKey[] {
  if (!change.ids?.length) return [agentKeys.attempts.all];
  return [agentKeys.attempts.list, ...change.ids.map((id) => agentKeys.attempts.detail(id))];
}

export const LIVE_HANDLERS = {
  status: { invalidate: () => [agentKeys.state] },
  // A started or finished attempt changes the busy slots too.
  attempts: { invalidate: (change) => [...attemptKeys(change), agentKeys.state] },
  transcript: {
    append: (client, change) => {
      const events = Array.isArray(change.data) ? (change.data as TailEvent[]) : null;
      for (const id of change.ids ?? []) {
        const key = agentKeys.attempts.detail(id);
        // Without lines (or before the attempt was fetched) the next fetch has them.
        if (!events) {
          void client.invalidateQueries({ queryKey: key });
          continue;
        }
        client.setQueryData<AttemptDetail>(key, (detail) =>
          detail
            ? { ...detail, events: [...detail.events, ...events].slice(-TRANSCRIPT_TAIL_SIZE) }
            : detail,
        );
      }
    },
  },
  logs: {
    append: (client, change) => {
      if (!Array.isArray(change.data)) return;
      const lines = change.data as LogEntry[];
      client.setQueryData<LogEntry[]>(agentKeys.logs.tail, (tail = []) =>
        [...tail, ...lines].slice(-LIVE_LOG_TAIL_SIZE),
      );
    },
  },
  // Settings, host tools, the update and Claude are all part of the state.
  settings: { invalidate: () => [agentKeys.state] },
  packages: { invalidate: () => [agentKeys.packages.all] },
  host_tools: { invalidate: () => [agentKeys.state] },
  update: { invalidate: () => [agentKeys.state] },
  claude: { invalidate: () => [agentKeys.state] },
  // Free space shows in the state (the nav's low disk dot) as well as on Storage.
  storage: { invalidate: () => [agentKeys.storage, agentKeys.state] },
  repos: { invalidate: () => [agentKeys.repos] },
} satisfies Record<AgentUiResource, LiveHandler>;

const RESOURCES = new Set<string>(Object.keys(LIVE_HANDLERS));

/** The event's data, or null for anything that isn't a v1 change of a known resource. */
export function parseLiveChange(data: unknown): AgentUiChange | null {
  let value: unknown = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const change = value as Partial<AgentUiChange>;
  if (change.v !== 1 || typeof change.resource !== "string" || !RESOURCES.has(change.resource)) {
    return null;
  }
  return change as AgentUiChange;
}

/** Applies one change to the cache. */
export function applyLiveChange(client: QueryClient, change: AgentUiChange): void {
  const handler: LiveHandler = LIVE_HANDLERS[change.resource];
  if ("append" in handler) {
    handler.append(client, change);
    return;
  }
  for (const queryKey of handler.invalidate(change)) {
    void client.invalidateQueries({ queryKey });
  }
}
