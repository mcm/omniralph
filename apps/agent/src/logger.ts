import { pino, type Logger } from "pino";

export type { Logger };

/** JSON logs to stderr (stdout stays free for CLI output such as `git-credential`). */
export function createLogger(level = process.env.OMNIRALPH_LOG_LEVEL ?? "info"): Logger {
  return pino({ name: "omniralph-agent", level }, pino.destination(2));
}

/** A logger that drops everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
