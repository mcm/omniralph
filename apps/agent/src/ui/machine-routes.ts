/**
 * The Claude and Storage pages' API.
 *
 * - `POST /api/claude/check` ("Check again"): `ClaudeStatusReporter.check()`'s
 *   result. A new read emits `change`, which publishes the `claude` event
 *   (`publishLocalChanges`).
 * - `GET /api/storage`: sizes (reused for 10 minutes; the last ones while a
 *   measurement runs), free space, the two roots and whether one is running.
 * - `POST /api/storage/measure` ("Measure again"): answers 202 at once and
 *   measures in the background; the new measurement publishes `storage` and
 *   `repos`.
 * - `GET /api/repos`: the cached repositories with their last fetch, last
 *   sync and pin. A recorded `repo.sync` publishes `repos`.
 */
import type { ClaudeStatus, ClaudeStatusReporter } from "../claude-status.js";
import type { Logger } from "../logger.js";
import type { AgentStorage, StorageReport, StoredRepo } from "../storage.js";
import type { UiRoute } from "./server.js";

/** `GET /api/storage`. */
export interface StorageState extends StorageReport {
  /** `agent.json`'s `workspaceRoot` and `dataDir`, to name the filesystems. */
  roots: { workspaceRoot: string; dataDir: string };
  /** A measurement is running ("Measure again", or the first one). */
  measuring: boolean;
}

/** `POST /api/claude/check`. */
export interface ClaudeCheckResult {
  claude: ClaudeStatus;
}

/** `GET /api/repos`. */
export interface ReposState {
  repos: StoredRepo[];
}

export function claudeRoutes(claude: Pick<ClaudeStatusReporter, "check">): UiRoute[] {
  return [
    {
      method: "POST",
      path: "/api/claude/check",
      handle: async () => ({
        status: 200,
        body: { claude: await claude.check() } satisfies ClaudeCheckResult,
      }),
    },
  ];
}

export function storageRoutes(options: {
  storage: Pick<AgentStorage, "measure" | "listRepos" | "roots" | "isMeasuring">;
  logger: Logger;
}): UiRoute[] {
  const { storage, logger } = options;
  return [
    {
      method: "GET",
      path: "/api/storage",
      handle: async () => {
        const report = await storage.measure({ stale: true });
        return {
          status: 200,
          body: {
            ...report,
            roots: storage.roots(),
            measuring: storage.isMeasuring(),
          } satisfies StorageState,
        };
      },
    },
    {
      method: "POST",
      path: "/api/storage/measure",
      handle: () => {
        storage.measure({ fresh: true }).catch((error: unknown) => {
          logger.warn({ err: error }, "cannot measure storage");
        });
        return { status: 202, body: { measuring: true } };
      },
    },
    {
      method: "GET",
      path: "/api/repos",
      handle: async () => ({
        status: 200,
        body: { repos: await storage.listRepos() } satisfies ReposState,
      }),
    },
  ];
}
