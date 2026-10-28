import type { SessionEvent } from "../session/session.js";
import { activityFor } from "../tools/activities.js";

/** Transcript events a running attempt's tail keeps. */
export const JOB_TAIL_SIZE = 2_000;

/** One transcript row, shaped as `Transcript` (`@omniralph/ui`) shows it. */
export interface TailEvent {
  type: "thought" | "action";
  /** A thought's text, or an action's name (the tool). */
  body: string;
  /** An action's parameter (e.g. the command); null for thoughts. */
  parameter: string | null;
  /** ISO timestamp. */
  at: string;
}

export type TailListener = (event: TailEvent) => void;

export interface JobTailOptions {
  /** Most events kept (default `JOB_TAIL_SIZE`); older ones are dropped. */
  size?: number;
  now?: () => Date;
}

/**
 * The live transcript of one attempt: its Claude sessions' events, as the
 * control panel's activities (`activityFor`), the last `size` kept in memory.
 */
export class JobTail {
  private readonly items: TailEvent[] = [];
  private readonly listeners = new Set<TailListener>();
  private readonly size: number;
  private readonly now: () => Date;

  constructor(options: JobTailOptions = {}) {
    this.size = options.size ?? JOB_TAIL_SIZE;
    this.now = options.now ?? (() => new Date());
  }

  /** Adds a session event, if it becomes an activity, and tells the subscribers. */
  event(event: SessionEvent): void {
    const activity = activityFor(event);
    if (!activity) return;
    const row: TailEvent = {
      type: activity.type,
      body: activity.body,
      parameter: activity.type === "action" ? (activity.parameter ?? null) : null,
      at: this.now().toISOString(),
    };
    this.items.push(row);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
    for (const listener of this.listeners) {
      try {
        listener(row);
      } catch {
        // A subscriber never breaks the session.
      }
    }
  }

  /** The kept events, oldest first. */
  events(): TailEvent[] {
    return [...this.items];
  }

  /** Calls `listener` with every new event; returns the unsubscribe. */
  subscribe(listener: TailListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops every subscriber. */
  close(): void {
    this.listeners.clear();
  }
}
