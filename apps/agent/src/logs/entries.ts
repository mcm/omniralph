/** pino's level numbers. */
export const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export type LogLevelName = keyof typeof LOG_LEVELS;

/** One parsed log line. */
export interface LogEntry {
  /** Epoch milliseconds. */
  time: number;
  level: LogLevelName;
  msg: string;
  /** Everything else on the line, except pino's `pid`, `hostname` and `name`. */
  fields: Record<string, unknown>;
}

function levelName(level: unknown): LogLevelName | undefined {
  if (typeof level !== "number") return undefined;
  let name: LogLevelName | undefined;
  for (const [key, value] of Object.entries(LOG_LEVELS) as [LogLevelName, number][]) {
    if (level >= value) name = key;
  }
  return name;
}

/** Parses one pino JSON line; undefined for anything else (a torn line, a stray print). */
export function parseLogLine(line: string): LogEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const {
    time,
    level,
    msg,
    pid: _pid,
    hostname: _hostname,
    name: _name,
    ...fields
  } = value as Record<string, unknown>;
  const name = levelName(level);
  if (typeof time !== "number" || name === undefined) return undefined;
  return { time, level: name, msg: typeof msg === "string" ? msg : "", fields };
}

export interface LogFilter {
  /** The lowest level shown: `warn` is warnings and errors. */
  level?: LogLevelName;
  /** Case-insensitive text anywhere on the line (message or fields). */
  q?: string;
}

/** Whether a line passes a filter; `raw` is the line as written. */
export function matchesLogFilter(entry: LogEntry, raw: string, filter: LogFilter): boolean {
  if (filter.level && LOG_LEVELS[entry.level] < LOG_LEVELS[filter.level]) return false;
  const q = filter.q?.trim().toLowerCase();
  if (q && !raw.toLowerCase().includes(q)) return false;
  return true;
}
