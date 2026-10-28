/**
 * The Overview and Attempt pages' API.
 *
 * - `GET /api/attempts`: the running attempts (oldest first) and the last `RECENT_ATTEMPTS`
 *   finished ones (newest first), each with its `describeAttempt` label.
 * - `GET /api/attempts/{id}`: one attempt with its transcript so far (`events`) and its log
 *   lines (`log`, oldest first); 404 "This attempt isn't on this agent." for an unknown ID.
 *
 * A start or finish publishes `attempts`, and each transcript event `transcript` with the
 * new events (`publishLocalChanges`); new log lines arrive as `logs` events.
 */
import type { AttemptDetail, AttemptHistory, AttemptRecord } from "../attempts/history.js";
import type { LogEntry } from "../logs/entries.js";
import { readLogPage } from "../logs/read.js";
import type { LogRing } from "../logs/ring.js";
import type { Logger } from "../logger.js";
import { UiHttpError, type UiRoute } from "./server.js";

/** Finished attempts Overview's Recent work shows. */
export const RECENT_ATTEMPTS = 50;
/** Most log lines an attempt's page shows (the newest). */
export const ATTEMPT_LOG_LINES = 500;

export const ATTEMPT_NOT_FOUND = "This attempt isn't on this agent.";

/** `GET /api/attempts`. */
export interface AttemptsState {
  /** Oldest first. */
  running: AttemptRecord[];
  /** Newest first. */
  recent: AttemptRecord[];
}

/** `GET /api/attempts/{id}`. */
export type AttemptPageState = AttemptDetail & {
  /** The attempt's log lines (its `jobId`), oldest first. */
  log: LogEntry[];
};

export interface AttemptLogSources {
  /** The log directory (`logDirectory(dataDir)`); unset when nothing is written to a file. */
  dir?: string;
  /** The in-memory ring, read when there is no file. */
  ring?: Pick<LogRing, "lines">;
}

function belongsTo(entry: LogEntry, id: string): boolean {
  return entry.fields.jobId === id;
}

/**
 * The newest `limit` lines an attempt logged, oldest first: from the log files (back to its
 * start), else from the ring.
 */
export async function attemptLogLines(
  sources: AttemptLogSources,
  attempt: Pick<AttemptRecord, "id" | "startedAt">,
  limit = ATTEMPT_LOG_LINES,
): Promise<LogEntry[]> {
  if (sources.dir !== undefined) {
    const page = await readLogPage({
      dir: sources.dir,
      // Narrows the parse to lines mentioning the ID; `belongsTo` keeps only its own.
      q: attempt.id,
      limit,
      // A line can be stamped a moment before the attempt's recorded start.
      since: Date.parse(attempt.startedAt) - 60_000,
    });
    return page.entries.filter((entry) => belongsTo(entry, attempt.id)).reverse();
  }
  const lines = sources.ring?.lines() ?? [];
  return lines.filter((entry) => belongsTo(entry, attempt.id)).slice(-limit);
}

export function attemptRoutes(options: {
  history: Pick<AttemptHistory, "running" | "recent" | "get">;
  log: AttemptLogSources;
  logger: Logger;
}): UiRoute[] {
  const { history, log, logger } = options;
  return [
    {
      method: "GET",
      path: "/api/attempts",
      handle: () => ({
        status: 200,
        body: {
          running: history.running(),
          recent: history.recent(RECENT_ATTEMPTS),
        } satisfies AttemptsState,
      }),
    },
    {
      method: "GET",
      path: /^\/api\/attempts\/([^/]+)$/,
      handle: async ({ params }) => {
        const id = params[0]!;
        const attempt = history.get(id);
        if (!attempt) throw new UiHttpError(404, ATTEMPT_NOT_FOUND);
        let lines: LogEntry[] = [];
        try {
          lines = await attemptLogLines(log, attempt);
        } catch (error) {
          logger.warn({ err: error, attemptId: id }, "cannot read the attempt's log lines");
        }
        return { status: 200, body: { ...attempt, log: lines } satisfies AttemptPageState };
      },
    },
  ];
}
