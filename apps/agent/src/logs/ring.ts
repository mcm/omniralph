import { parseLogLine, type LogEntry } from "./entries.js";

export const DEFAULT_LOG_RING_SIZE = 2000;

export type LogListener = (entry: LogEntry) => void;

/** The last lines in memory, as a pino destination, for the agent page's live tail. */
export class LogRing {
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<LogListener>();

  constructor(private readonly size = DEFAULT_LOG_RING_SIZE) {}

  write(line: string): void {
    const entry = parseLogLine(line);
    if (!entry) return;
    this.entries.push(entry);
    if (this.entries.length > this.size) this.entries.splice(0, this.entries.length - this.size);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A broken listener mustn't break logging (or log about itself in a loop).
      }
    }
  }

  /** Oldest first. */
  lines(): LogEntry[] {
    return [...this.entries];
  }

  /** Calls `listener` with every line logged from now on; returns the unsubscribe function. */
  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
