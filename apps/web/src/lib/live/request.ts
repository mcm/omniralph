import "server-only";
import type { Database } from "@omniralph/db";
import {
  ChangeCollector,
  currentChangeCollector,
  runWithChangeCollector,
  type RecordedChange,
} from "@omniralph/db/changes";
import { after } from "next/server";
import { getDb } from "@/lib/db";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  changeMessage,
  getChangePublisher,
  type ChangeMessage,
  type ChangePublisher,
} from "./publisher";

/**
 * Publishing the changes a request committed (`recordChange` in `@omniralph/db`):
 * `withLiveChanges` opens a collector around a handler and, after the response
 * (Next `after()`), publishes its de-duplicated changes with one Ably batch request.
 * Publishing never changes a write or a response: when Ably is off, answers with an
 * error or times out, the failure is logged once per request and the events are lost
 * (clients still poll as a fallback).
 *
 * Transcript changes are coalesced per run (`TRANSCRIPT_COALESCE_SECONDS`): the
 * first in a window publishes at once, the second claims the window's trailing
 * publish, sent when the window ends (so after the window's last activity), and
 * later ones are covered by it.
 */

/** A run's transcript events are published at most twice per window of this many seconds. */
export const TRANSCRIPT_COALESCE_SECONDS = 1;

export interface LiveOptions {
  /** Default: `getChangePublisher()` (null when Ably is off). */
  publisher?: ChangePublisher | null;
  /** Runs work after the response; default Next's `after()`. */
  schedule?: (task: () => Promise<void>) => void;
  /** For transcript coalescing; default `getDb()`. */
  db?: () => Database;
  now?: () => Date;
  /** Waits before a trailing transcript publish; default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Names the request in logs. */
  label?: string;
}

/** The open requests by their collector (for deferred work to find its request). */
const requests = new WeakMap<ChangeCollector, LiveRequest>();

/** One request's live changes: what it collected and whether it logged a failure yet. */
class LiveRequest {
  readonly collector = new ChangeCollector();
  private logged = false;
  private flushed = false;

  constructor(
    private readonly options: LiveOptions,
    /** The request this deferred work belongs to: failures are logged once for both. */
    private readonly parent?: LiveRequest,
  ) {}

  private get publisher(): ChangePublisher | null {
    return this.options.publisher !== undefined ? this.options.publisher : getChangePublisher();
  }

  private log(problem: string, error?: unknown): void {
    if (this.parent) return this.parent.log(problem, error);
    if (this.logged) return;
    this.logged = true;
    const where = this.options.label ? ` (${this.options.label})` : "";
    console.warn(`live changes${where}: ${problem}`, ...(error === undefined ? [] : [error]));
  }

  /**
   * Publishes what was collected so far, after the response. Changes recorded once
   * the request has flushed (a late `after()` write) are published on their own.
   */
  flushAfterResponse(): void {
    if (!this.flushed) {
      this.flushed = true;
      this.collector.onAdd(() => queueMicrotask(() => void this.publishNow()));
    }
    if (this.collector.size === 0) return;
    const publisher = this.publisher;
    if (!publisher) {
      this.collector.drain();
      this.log("Ably is off (ABLY_API_KEY unset): change events aren't published");
      return;
    }
    const changes = this.collector.drain();
    const schedule = this.options.schedule ?? after;
    try {
      schedule(() => this.publish(publisher, changes));
    } catch (error) {
      this.log("couldn't schedule publishing the change events", error);
    }
  }

  /** Publishes what was collected, now (for work that already runs after the response). */
  async publishNow(): Promise<void> {
    if (this.collector.size === 0) return;
    const publisher = this.publisher;
    if (!publisher) {
      this.collector.drain();
      this.log("Ably is off (ABLY_API_KEY unset): change events aren't published");
      return;
    }
    await this.publish(publisher, this.collector.drain());
  }

  private async publish(publisher: ChangePublisher, changes: RecordedChange[]): Promise<void> {
    try {
      const now = this.options.now?.() ?? new Date();
      const immediate: RecordedChange[] = [];
      const trailing: RecordedChange[] = [];
      for (const change of changes) {
        if (change.resource !== "transcript") {
          immediate.push(change);
          continue;
        }
        const claim = await this.claimTranscript(change, now);
        if (claim === "lead") immediate.push(change);
        else if (claim === "trail") trailing.push(change);
      }
      const work: Promise<void>[] = [];
      if (immediate.length > 0) work.push(this.send(publisher, immediate));
      if (trailing.length > 0) {
        const windowMs = TRANSCRIPT_COALESCE_SECONDS * 1000;
        const wait = windowMs - (now.getTime() % windowMs);
        const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        work.push(
          sleep(wait).then(() => {
            const at = this.options.now?.() ?? new Date();
            return this.send(
              publisher,
              trailing.map((change) => ({ ...change, at })),
            );
          }),
        );
      }
      await Promise.all(work);
    } catch (error) {
      this.log("publishing the change events failed", error);
    }
  }

  private async send(publisher: ChangePublisher, changes: RecordedChange[]): Promise<void> {
    const messages: ChangeMessage[] = [];
    for (const change of changes) {
      try {
        messages.push(changeMessage(change));
      } catch (error) {
        this.log(`a ${change.resource} change isn't a valid event`, error);
      }
    }
    try {
      await publisher.publish(messages);
    } catch (error) {
      this.log("publishing the change events failed", error);
    }
  }

  /** Claims the run's transcript publish for the current window (`live:transcript:<runId>`). */
  private async claimTranscript(
    change: RecordedChange,
    now: Date,
  ): Promise<"lead" | "trail" | "covered"> {
    const runId = change.runId ?? change.ids[0]!;
    const db = (this.options.db ?? getDb)();
    const { count } = await hitRateLimit(
      db,
      { key: `live:transcript:${runId}`, limit: 1, windowSeconds: TRANSCRIPT_COALESCE_SECONDS },
      now,
    );
    return count === 1 ? "lead" : count === 2 ? "trail" : "covered";
  }
}

/**
 * Runs `fn` (a request handler, a cron run, a webhook delivery) with a change
 * collector open and publishes what it committed after the response. Inside an
 * already open collector, `fn` just runs in it (the outer request publishes).
 */
export async function withLiveChanges<T>(
  fn: () => Promise<T>,
  options: LiveOptions = {},
): Promise<T> {
  if (currentChangeCollector()) return fn();
  const live = new LiveRequest(options);
  requests.set(live.collector, live);
  try {
    return await runWithChangeCollector(live.collector, fn);
  } finally {
    live.flushAfterResponse();
  }
}

/**
 * Wraps work deferred until after the response (a webhook's `defer`): it runs with
 * its own collector and publishes what it committed when it finishes.
 */
export function liveDeferred(
  task: () => Promise<void>,
  options: LiveOptions = {},
): () => Promise<void> {
  const current = currentChangeCollector();
  const parent = current && requests.get(current);
  return async () => {
    const live = new LiveRequest(options, parent);
    try {
      await runWithChangeCollector(live.collector, task);
    } finally {
      await live.publishNow();
    }
  };
}

/**
 * Wraps work already running after the response (a chat webhook's `waitUntil`): once
 * it settles, what it committed into the request's collector is published.
 */
export function liveWaitUntil(task: Promise<unknown>): Promise<void> {
  const current = currentChangeCollector();
  const live = current && requests.get(current);
  return task.then(
    () => live?.publishNow(),
    (error: unknown) => {
      void live?.publishNow();
      throw error;
    },
  );
}

/** A route handler that runs with `withLiveChanges` (agent API, webhook and cron routes). */
export function liveRoute<A extends unknown[], R extends Response>(
  handler: (...args: A) => Promise<R>,
  options: LiveOptions = {},
): (...args: A) => Promise<R> {
  return (...args) => withLiveChanges(() => handler(...args), options);
}
