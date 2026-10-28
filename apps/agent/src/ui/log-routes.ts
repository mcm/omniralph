/**
 * The Logs page's API.
 *
 * - `GET /api/logs?before=&level=&q=`: `LOG_PAGE_LINES` lines, newest first, across
 *   `agent.log` and its rotated files. `level` is `all` (the default) or `warn` (warnings and
 *   errors), `q` a case-insensitive text filter, `before` the previous page's cursor.
 * - `GET /api/logs/download`: the current `agent.log`, as an attachment.
 *
 * New lines arrive as `logs` events with the lines in `data` (`publishLocalChanges`).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { matchesLogFilter, type LogEntry, type LogFilter } from "../logs/entries.js";
import { readLogPage, type LogPage } from "../logs/read.js";
import type { LogRing } from "../logs/ring.js";
import { LOG_FILE_NAME } from "../logs/rotating-file.js";
import type { Logger } from "../logger.js";
import { UiHttpError, type UiRoute } from "./server.js";

/** Lines per `GET /api/logs` page. */
export const LOG_PAGE_LINES = 200;

/** The `level` filter values. */
export const LOG_PAGE_LEVELS = ["all", "warn"] as const;
export type LogPageLevel = (typeof LOG_PAGE_LEVELS)[number];

/** `GET /api/logs`. */
export type LogPageState = LogPage;

export const NO_LOG_FILE = "This agent hasn't written a log file.";

export interface LogSources {
  /** The log directory (`logDirectory(dataDir)`); unset when nothing is written to a file. */
  dir?: string;
  /** The in-memory ring, paged when there is no file. */
  ring?: Pick<LogRing, "lines">;
}

/** A ring cursor: how many matching lines (newest first) the earlier pages returned. */
const RING_CURSOR = /^ring:(\d+)$/;

function ringPage(
  ring: Pick<LogRing, "lines"> | undefined,
  filter: LogFilter,
  before: string | undefined,
): LogPage {
  let skip = 0;
  if (before !== undefined) {
    const match = RING_CURSOR.exec(before);
    if (!match) return { entries: [], before: null };
    skip = Number(match[1]);
  }
  const lines = (ring?.lines() ?? [])
    .reverse()
    .filter((entry) => matchesLogFilter(entry, rawLine(entry), filter));
  const entries = lines.slice(skip, skip + LOG_PAGE_LINES);
  const next = skip + entries.length;
  return { entries, before: next < lines.length ? `ring:${next}` : null };
}

/** What the text filter matches in a ring line (the file is matched as written). */
function rawLine(entry: LogEntry): string {
  return JSON.stringify({ ...entry.fields, msg: entry.msg });
}

function pageFilter(query: URLSearchParams): LogFilter {
  const level = query.get("level") ?? "all";
  if (!(LOG_PAGE_LEVELS as readonly string[]).includes(level)) {
    throw new UiHttpError(400, "level must be all or warn", [
      { path: ["level"], message: "Use all or warn" },
    ]);
  }
  const q = query.get("q")?.trim();
  return { ...(level === "warn" && { level: "warn" }), ...(q && { q }) };
}

export function logRoutes(options: { log: LogSources; logger: Logger }): UiRoute[] {
  const { log, logger } = options;
  return [
    {
      method: "GET",
      path: "/api/logs",
      handle: async ({ query }) => {
        const filter = pageFilter(query);
        const before = query.get("before") || undefined;
        const page =
          log.dir === undefined
            ? ringPage(log.ring, filter, before)
            : await readLogPage({ dir: log.dir, before, limit: LOG_PAGE_LINES, ...filter });
        return { status: 200, body: page satisfies LogPageState };
      },
    },
    {
      method: "GET",
      path: "/api/logs/download",
      handle: async ({ req, res }) => {
        const file = log.dir === undefined ? undefined : path.join(log.dir, LOG_FILE_NAME);
        const info = file ? await stat(file).catch(() => null) : null;
        if (!file || !info?.isFile()) throw new UiHttpError(404, NO_LOG_FILE);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${LOG_FILE_NAME}"`,
          // What the file holds now: it keeps growing while this streams.
          "content-length": info.size,
        });
        if (req.method === "HEAD" || info.size === 0) {
          res.end();
          return { stream: true };
        }
        const stream = createReadStream(file, { start: 0, end: info.size - 1 });
        stream.on("error", (error) => {
          logger.warn({ err: error, file }, "cannot read the log file");
          res.destroy();
        });
        stream.pipe(res);
        return { stream: true };
      },
    },
  ];
}
