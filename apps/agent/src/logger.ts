import { pino, type DestinationStream, type Logger } from "pino";

import { LogRing } from "./logs/ring.js";
import { logDirectory, RotatingFile, type RotatingFileOptions } from "./logs/rotating-file.js";

export type { Logger };
export { LogRing };

/** Censored on every target: the file and the page's live tail as much as stderr. */
export const REDACTED_LOG_PATHS = [
  "refreshToken",
  "token",
  "jobToken",
  "sessionToken",
  "*.refreshToken",
  "*.token",
  "*.jobToken",
  "*.sessionToken",
  "authorization",
  "*.authorization",
  "*.headers.authorization",
  "env",
  "*.env",
];

export interface CreateLoggerOptions {
  level?: string;
  /** Where `logs/agent.log` goes; without it, the logger writes to stderr and the ring only. */
  dataDir?: string;
  /** Rotation limits (tests). */
  file?: Pick<RotatingFileOptions, "maxBytes" | "keep" | "onError">;
  /** In place of stderr (tests). */
  stderr?: DestinationStream;
  ringSize?: number;
}

export interface AgentLog {
  logger: Logger;
  /** The last lines, for the agent page's live tail. */
  ring: LogRing;
  /** The `agent.log` writer; undefined without a data directory. */
  file?: RotatingFile;
  /** Closes the log file; the logger keeps writing to stderr and the ring. */
  close(): void;
}

/**
 * JSON logs to stderr (stdout stays free for CLI output such as `git-credential`), to a rotating
 * `<dataDir>/logs/agent.log` and to an in-memory ring of the last lines.
 */
export function createLogger(options: CreateLoggerOptions = {}): AgentLog {
  const level = options.level ?? process.env.OMNIRALPH_LOG_LEVEL ?? "info";
  const ring = new LogRing(options.ringSize);
  const file =
    options.dataDir === undefined
      ? undefined
      : new RotatingFile({ dir: logDirectory(options.dataDir), ...options.file });
  // Each target takes every line the logger lets through: the logger's level is the filter.
  const streams = [options.stderr ?? pino.destination(2), ring, ...(file ? [file] : [])].map(
    (stream) => ({ stream, level: "trace" as const }),
  );
  const logger = pino(
    { name: "omniralph-agent", level, redact: { paths: REDACTED_LOG_PATHS, censor: "[redacted]" } },
    pino.multistream(streams),
  );
  return { logger, ring, file, close: () => file?.close() };
}

/** A logger that drops everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
