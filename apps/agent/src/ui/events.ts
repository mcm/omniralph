/**
 * The agent page's live stream (`GET /api/events`): server-sent `change`
 * events, one per thing that changed, and a comment every
 * `UI_EVENTS_KEEP_ALIVE_MS` so proxies don't drop an idle stream.
 */
import type { ServerResponse } from "node:http";

/** What a `change` event is about. The page maps each to the queries it refreshes. */
export const AGENT_UI_RESOURCES = [
  "status",
  "attempts",
  "transcript",
  "logs",
  "settings",
  "packages",
  "host_tools",
  "update",
  "claude",
  "storage",
  "repos",
] as const;
export type AgentUiResource = (typeof AGENT_UI_RESOURCES)[number];

/** The `data` of one `event: change`. */
export interface AgentUiChange {
  v: 1;
  resource: AgentUiResource;
  /** The changed items (e.g. attempt IDs), when the change is about some of them. */
  ids?: string[];
  at: string;
  /** New items to append (`logs` lines, `transcript` events); other resources only invalidate. */
  data?: unknown;
}

export const UI_EVENTS_KEEP_ALIVE_MS = 15_000;

export interface UiEventHubOptions {
  keepAliveMs?: number;
  now?: () => Date;
}

/** Fans changes out to every open `/api/events` stream. */
export class UiEventHub {
  private readonly streams = new Set<ServerResponse>();
  private readonly keepAliveMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: UiEventHubOptions = {}) {
    this.keepAliveMs = options.keepAliveMs ?? UI_EVENTS_KEEP_ALIVE_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Open streams. */
  get size(): number {
    return this.streams.size;
  }

  publish(resource: AgentUiResource, change: { ids?: string[]; data?: unknown } = {}): void {
    if (this.closed || this.streams.size === 0) return;
    const event: AgentUiChange = {
      v: 1,
      resource,
      ...(change.ids && { ids: change.ids }),
      at: this.now().toISOString(),
      ...(change.data !== undefined && { data: change.data }),
    };
    this.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /**
   * Turns `res` into an event stream (its headers already set by the caller)
   * until the client goes away or the hub closes.
   */
  attach(res: ServerResponse): void {
    if (this.closed) {
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.flushHeaders();
    // Tells the browser how soon to reconnect after the stream drops.
    res.write("retry: 2000\n\n");
    this.streams.add(res);
    res.on("close", () => {
      this.streams.delete(res);
      this.stopTimerWhenIdle();
    });
    this.timer ??= setInterval(() => this.write(": keep-alive\n\n"), this.keepAliveMs);
  }

  /** Ends every stream (shutdown); later `attach`es end at once. */
  close(): void {
    this.closed = true;
    for (const res of this.streams) res.end();
    this.streams.clear();
    this.stopTimerWhenIdle();
  }

  private write(text: string): void {
    for (const res of this.streams) {
      if (!res.writableEnded) res.write(text);
    }
  }

  private stopTimerWhenIdle(): void {
    if (this.streams.size > 0 || this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
