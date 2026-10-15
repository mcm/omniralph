import { EventEmitter } from "node:events";
import { harnessWakeChannel, orgWakeChannel } from "@omniralph/shared";
import { Realtime, type ClientOptions } from "ably";
import type { Logger } from "./logger.js";

/**
 * `wake`: a job may be claimable (a message on either wake channel).
 * `connected` / `disconnected`: the Ably connection entered or left the connected state.
 */
export type WakeEvent = "wake" | "connected" | "disconnected";

/** Push wake-ups for the claim loop, over Ably. */
export interface WakeSubscription {
  /**
   * Hands over the latest token from the heartbeat (an Ably JWT and its ISO
   * expiry). The first call connects; later ones are used when Ably asks for a
   * token (on expiry or reconnect).
   */
  setToken(token: string, expiresAt: string): void;
  on(event: WakeEvent, listener: () => void): void;
  /** Closes the connection; no events are emitted afterwards. */
  close(): void;
}

/** The part of the Ably realtime client the subscription uses (faked in tests). */
export interface WakeRealtimeClient {
  connection: {
    readonly state: string;
    on(listener: (change: { current: string; previous: string }) => void): void;
    connect(): void;
  };
  channels: {
    get(name: string): WakeRealtimeChannel;
  };
  close(): void;
}

export interface WakeRealtimeChannel {
  readonly state: string;
  subscribe(listener: (message: unknown) => void): Promise<unknown>;
  attach(): Promise<unknown>;
}

export type WakeClientOptions = Pick<ClientOptions, "clientId" | "authCallback">;
export type CreateWakeClient = (options: WakeClientOptions) => WakeRealtimeClient;

export interface WakeSubscriptionOptions {
  harnessId: string;
  organizationId: string;
  logger: Logger;
  /** Builds the Ably client; the real one by default. */
  createClient?: CreateWakeClient;
  now?: () => number;
}

/** Connection states from which `setToken` reconnects at once instead of waiting for Ably's retry. */
const RECONNECT_STATES = new Set(["initialized", "disconnected", "suspended", "failed"]);

export function createWakeSubscription(options: WakeSubscriptionOptions): WakeSubscription {
  const { harnessId, organizationId, logger } = options;
  const now = options.now ?? Date.now;
  const createClient =
    options.createClient ??
    ((clientOptions: WakeClientOptions) =>
      new Realtime({
        ...clientOptions,
        autoConnect: false,
        echoMessages: false,
        logLevel: 1,
        logHandler: (msg) => logger.warn({ ably: msg }, "ably"),
      }));

  const events = new EventEmitter();
  let token: { token: string; expiresAt: number } | null = null;
  let closed = false;
  let subscribed = false;
  const channelNames = [harnessWakeChannel(harnessId), orgWakeChannel(organizationId)];

  const client = createClient({
    clientId: harnessId,
    authCallback: (_params, callback) => {
      if (closed) callback("wake subscription closed", null);
      else if (!token) callback("no Ably token yet", null);
      else if (token.expiresAt <= now()) callback("Ably token expired", null);
      else callback(null, token.token);
    },
  });

  client.connection.on(({ current, previous }) => {
    if (closed) return;
    if (current === "connected" && previous !== "connected") {
      logger.info("wake subscription connected");
      reattachFailedChannels();
      events.emit("connected");
    } else if (previous === "connected" && current !== "connected") {
      logger.info({ state: current }, "wake subscription disconnected");
      events.emit("disconnected");
    }
  });

  // Subscribing attaches, which needs a connection: done on the first token.
  function subscribe(): void {
    subscribed = true;
    for (const channel of channelNames) {
      client.channels
        .get(channel)
        .subscribe(() => {
          if (!closed) events.emit("wake");
        })
        .catch((err: unknown) => {
          if (!closed) logger.warn({ err, channel }, "wake channel attach failed");
        });
    }
  }

  // A channel whose attach failed (e.g. on a rejected token) isn't retried by Ably.
  function reattachFailedChannels(): void {
    if (!subscribed) return;
    for (const channel of channelNames) {
      const realtimeChannel = client.channels.get(channel);
      if (realtimeChannel.state !== "failed") continue;
      realtimeChannel.attach().catch((err: unknown) => {
        if (!closed) logger.warn({ err, channel }, "wake channel attach failed");
      });
    }
  }

  return {
    setToken(newToken, expiresAt) {
      if (closed) return;
      token = { token: newToken, expiresAt: Date.parse(expiresAt) };
      if (RECONNECT_STATES.has(client.connection.state)) client.connection.connect();
      if (!subscribed) subscribe();
    },
    on(event, listener) {
      events.on(event, listener);
    },
    close() {
      if (closed) return;
      closed = true;
      events.removeAllListeners();
      client.close();
    },
  };
}
