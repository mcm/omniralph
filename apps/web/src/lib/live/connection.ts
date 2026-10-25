/**
 * The browser's realtime connection for live change events: an Ably Realtime client
 * authorized by `GET /api/ui/live/token` (renewals before the hour's expiry go through
 * the same callback), subscribed to a set of change channels that can change while it
 * runs. Framework-free (`LiveProvider` drives it from React); the Ably client is
 * injectable so tests use a fake.
 *
 * Safe to import in the browser.
 */
import type { ClientOptions } from "ably";
import { CHANGE_EVENT_NAME, parseChangeEvent, type ChangeEvent } from "./events";

/**
 * Live updates as the app sees them: `live` (connected), `connecting` (not yet connected
 * for the first time), `down` (the connection dropped or can't be made, or the token
 * endpoint fails: queries poll) or `off` (realtime isn't configured: queries poll, and no
 * notice is ever shown).
 */
export type LiveStatus = "live" | "connecting" | "down" | "off";

/** The part of an Ably realtime channel the connection uses (faked in tests). */
export interface LiveRealtimeChannel {
  readonly state: string;
  subscribe(name: string, listener: (message: { data?: unknown }) => void): Promise<unknown>;
  unsubscribe(): void;
  attach(): Promise<unknown>;
  detach(): Promise<unknown>;
}

/** The part of the Ably realtime client the connection uses (faked in tests). */
export interface LiveRealtimeClient {
  connection: {
    readonly state: string;
    on(listener: (change: { current: string; previous: string }) => void): void;
    connect(): void;
  };
  channels: {
    get(name: string): LiveRealtimeChannel;
    release(name: string): void;
  };
  auth: { authorize(): Promise<unknown> };
  close(): void;
}

export type LiveClientOptions = Pick<ClientOptions, "clientId" | "authCallback">;
export type CreateLiveClient = (options: LiveClientOptions) => LiveRealtimeClient;

/** A token from the token endpoint; `null` when realtime isn't configured. */
export type FetchLiveToken = () => Promise<{ token: string; expiresAt: string } | null>;

/** After the token endpoint fails, it's asked again this often (queries poll meanwhile). */
export const TOKEN_RETRY_MS = 10_000;

export interface LiveConnectionOptions {
  userId: string;
  fetchToken: FetchLiveToken;
  createClient: CreateLiveClient;
  /** A change event received on `channel` (anything else on the channels is dropped). */
  onEvent: (event: ChangeEvent, channel: string) => void;
  onStatus: (status: LiveStatus) => void;
  now?: () => number;
}

export interface LiveConnection {
  /** Subscribes to exactly `channels` (adding and dropping as needed). */
  setChannels(channels: readonly string[]): void;
  /** Reconnects now ("Retry now"), or asks for a token again if there's no client yet. */
  reconnect(): void;
  /** Asks for a new token now: the user's organizations, and so its channels, changed. */
  reauthorize(): void;
  /** Closes the connection; no events or statuses are reported afterwards. */
  close(): void;
}

/** Received data: Ably decodes the publisher's JSON, but take a string too. */
function decode(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function createLiveConnection(options: LiveConnectionOptions): LiveConnection {
  const { userId, fetchToken, createClient, onEvent, onStatus } = options;
  const now = options.now ?? Date.now;
  let closed = false;
  let client: LiveRealtimeClient | null = null;
  let token: { token: string; expiresAt: number } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let everConnected = false;
  let status: LiveStatus | null = null;
  const wanted = new Set<string>();
  const subscribed = new Set<string>();

  const report = (next: LiveStatus) => {
    if (closed || next === status) return;
    status = next;
    onStatus(next);
  };

  const listener = (channel: string) => (message: { data?: unknown }) => {
    if (closed) return;
    const event = parseChangeEvent(decode(message.data));
    if (event) onEvent(event, channel);
  };

  const sync = () => {
    if (!client) return;
    for (const name of wanted) {
      if (subscribed.has(name)) continue;
      subscribed.add(name);
      // Subscribing attaches; a failed attach is retried on the next connect.
      client.channels
        .get(name)
        .subscribe(CHANGE_EVENT_NAME, listener(name))
        .catch(() => {});
    }
    for (const name of [...subscribed]) {
      if (wanted.has(name)) continue;
      subscribed.delete(name);
      const channel = client.channels.get(name);
      channel.unsubscribe();
      const current = client;
      channel
        .detach()
        .then(() => {
          // Re-wanted while detaching: keep the channel.
          if (!subscribed.has(name)) current.channels.release(name);
        })
        .catch(() => {});
    }
  };

  const reattachFailed = () => {
    if (!client) return;
    for (const name of subscribed) {
      const channel = client.channels.get(name);
      if (channel.state === "failed") channel.attach().catch(() => {});
    }
  };

  const connect = (first: { token: string; expiresAt: string }) => {
    token = { token: first.token, expiresAt: Date.parse(first.expiresAt) };
    client = createClient({
      clientId: userId,
      authCallback: (_params, callback) => {
        // The first connect uses the token already fetched; renewals fetch a new one.
        const cached = token;
        token = null;
        if (cached && cached.expiresAt > now()) {
          callback(null, cached.token);
          return;
        }
        fetchToken().then(
          (next) => {
            if (next) callback(null, next.token);
            else callback("Live updates aren't configured.", null);
          },
          () => callback("Couldn't get a live updates token.", null),
        );
      },
    });
    client.connection.on(({ current }) => {
      if (closed) return;
      if (current === "connected") {
        everConnected = true;
        reattachFailed();
        report("live");
      } else if (current === "initialized" || current === "connecting") {
        report(everConnected ? "down" : "connecting");
      } else if (current !== "closing" && current !== "closed") {
        report("down");
      }
    });
    sync();
    client.connection.connect();
  };

  const start = () => {
    clearTimeout(retryTimer);
    fetchToken().then(
      (first) => {
        if (closed) return;
        if (!first) {
          report("off");
          return;
        }
        connect(first);
      },
      () => {
        if (closed) return;
        report("down");
        retryTimer = setTimeout(start, TOKEN_RETRY_MS);
      },
    );
  };

  report("connecting");
  start();

  return {
    setChannels(channels) {
      wanted.clear();
      for (const name of channels) wanted.add(name);
      sync();
    },
    reconnect() {
      if (closed) return;
      if (client) client.connection.connect();
      else if (status !== "off") start();
    },
    reauthorize() {
      if (closed || !client) return;
      client.auth.authorize().catch(() => {});
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      client?.close();
      client = null;
    },
  };
}
