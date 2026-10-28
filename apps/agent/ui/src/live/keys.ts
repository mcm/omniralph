/**
 * Every query key of the agent page. A page keys its queries under these, so the live
 * change events (`./invalidations.ts`) find them.
 */
export const agentKeys = {
  /** `GET /api/state`: status, settings, update, Claude, the nav's problems. */
  state: ["state"] as const,
  attempts: {
    all: ["attempts"] as const,
    /** `GET /api/attempts`. */
    list: ["attempts", "list"] as const,
    /** `GET /api/attempts/{id}`, with its `events` (the transcript so far). */
    detail: (id: string) => ["attempts", "detail", id] as const,
  },
  logs: {
    all: ["logs"] as const,
    /** The lines `logs` events delivered since the page opened, oldest first (no request). */
    tail: ["logs", "tail"] as const,
    /** `GET /api/logs` pages, by filter. */
    pages: (filter: { level?: string; q?: string }) => ["logs", "pages", filter] as const,
  },
  packages: {
    all: ["packages"] as const,
    /** `GET /api/packages`. */
    list: ["packages", "list"] as const,
    /** `GET /api/packages/history`. */
    history: ["packages", "history"] as const,
    /** `GET /api/packages/history/{id}`. */
    historyEntry: (id: string) => ["packages", "history", id] as const,
  },
  /** `GET /api/storage`. */
  storage: ["storage"] as const,
  /** `GET /api/repos`. */
  repos: ["repos"] as const,
};

export type AgentKeys = typeof agentKeys;
