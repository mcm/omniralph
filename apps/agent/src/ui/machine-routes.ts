/**
 * The Claude and Storage pages' API.
 *
 * - `POST /api/claude/check` ("Check again"): `ClaudeStatusReporter.check()`'s
 *   result. A new read emits `change`, which publishes the `claude` event
 *   (`publishLocalChanges`).
 * - `POST /api/claude/sign-in` ("Refresh sign-in…"): starts a sign-in and
 *   answers the URL to open (`ClaudeSignIn.start()`); 409 when it can't help
 *   on this machine.
 * - `POST /api/claude/sign-in/complete` `{ code }`: the `CODE#STATE` that
 *   page showed. Writes the login, checks Claude again at once and heartbeats.
 * - `GET /api/storage`: sizes (reused for 10 minutes; the last ones while a
 *   measurement runs), free space, the two roots and whether one is running.
 * - `POST /api/storage/measure` ("Measure again"): answers 202 at once and
 *   measures in the background; the new measurement publishes `storage` and
 *   `repos`.
 * - `GET /api/repos`: the cached repositories with their last fetch, last
 *   sync and pin. A recorded `repo.sync` publishes `repos`.
 */
import {
  ClaudeSignInError,
  type ClaudeSignIn,
  type ClaudeSignInStart,
} from "../claude-credentials.js";
import type { ClaudeStatus, ClaudeStatusReporter } from "../claude-status.js";
import type { Logger } from "../logger.js";
import type { AgentStorage, StorageReport, StoredRepo } from "../storage.js";
import { UiHttpError, type UiRoute } from "./server.js";

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

/** `POST /api/claude/sign-in`. */
export type ClaudeSignInStartResult = ClaudeSignInStart;

/** `POST /api/claude/sign-in/complete`: the check that followed. */
export type ClaudeSignInCompleteResult = ClaudeCheckResult;

function signInError(error: unknown): never {
  if (error instanceof ClaudeSignInError) throw new UiHttpError(error.status, error.message);
  throw error;
}

export function claudeRoutes(
  claude: Pick<ClaudeStatusReporter, "check">,
  options: {
    signIn?: Pick<ClaudeSignIn, "start" | "complete">;
    /** After a sign-in: report the new login now, not at the next interval. */
    heartbeatSoon?: () => void;
    logger?: Logger;
  } = {},
): UiRoute[] {
  const { signIn, heartbeatSoon, logger } = options;
  const routes: UiRoute[] = [
    {
      method: "POST",
      path: "/api/claude/check",
      handle: async () => ({
        status: 200,
        body: { claude: await claude.check() } satisfies ClaudeCheckResult,
      }),
    },
  ];
  if (!signIn) return routes;
  routes.push(
    {
      method: "POST",
      path: "/api/claude/sign-in",
      handle: () => {
        try {
          return { status: 200, body: signIn.start() satisfies ClaudeSignInStartResult };
        } catch (error) {
          signInError(error);
        }
      },
    },
    {
      method: "POST",
      path: "/api/claude/sign-in/complete",
      handle: async (request) => {
        const body = await request.json();
        const code =
          body !== null && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
        if (typeof code !== "string" || code.trim().length === 0 || code.length > 4096) {
          throw new UiHttpError(400, "Paste the code the sign-in page shows");
        }
        try {
          const result = await signIn.complete(code);
          logger?.info({ subscriptionType: result.subscriptionType }, "Claude signed in again");
        } catch (error) {
          signInError(error);
        }
        const status = await claude.check({ force: true });
        heartbeatSoon?.();
        return { status: 200, body: { claude: status } satisfies ClaudeSignInCompleteResult };
      },
    },
  );
  return routes;
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
