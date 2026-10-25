// Test helpers for the live data layer: a fake Ably realtime client (connection states,
// channels, delivered messages) and change events that pass the catalogue's schema.
import { vi } from "vitest";
import type {
  CreateLiveClient,
  FetchLiveToken,
  LiveClientOptions,
  LiveRealtimeChannel,
  LiveRealtimeClient,
} from "@/lib/live/connection";
import { CHANGE_EVENT_VERSION, type ChangeEvent } from "@/lib/live/events";

export class FakeChannel implements LiveRealtimeChannel {
  state = "initialized";
  listeners: { name: string; listener: (message: { data?: unknown }) => void }[] = [];

  subscribe(name: string, listener: (message: { data?: unknown }) => void) {
    this.listeners.push({ name, listener });
    this.state = "attached";
    return Promise.resolve(null);
  }
  unsubscribe() {
    this.listeners = [];
  }
  attach() {
    this.state = "attached";
    return Promise.resolve(null);
  }
  detach() {
    this.state = "detached";
    return Promise.resolve(null);
  }
}

export class FakeRealtime implements LiveRealtimeClient {
  readonly options: LiveClientOptions;
  readonly channelMap = new Map<string, FakeChannel>();
  readonly close = vi.fn(() => this.setState("closed"));
  readonly auth = { authorize: vi.fn(async () => ({})) };
  private readonly stateListeners: ((change: { current: string; previous: string }) => void)[] = [];
  readonly connection = {
    state: "initialized",
    on: (listener: (change: { current: string; previous: string }) => void) => {
      this.stateListeners.push(listener);
    },
    connect: vi.fn(() => {}),
  };
  readonly channels = {
    get: (name: string) => {
      let channel = this.channelMap.get(name);
      if (!channel) {
        channel = new FakeChannel();
        this.channelMap.set(name, channel);
      }
      return channel;
    },
    release: vi.fn((name: string) => {
      this.channelMap.delete(name);
    }),
  };

  constructor(options: LiveClientOptions) {
    this.options = options;
  }

  /** Moves the connection to `state`, telling its listeners. */
  setState(state: string) {
    const previous = this.connection.state;
    this.connection.state = state;
    for (const listener of this.stateListeners) listener({ current: state, previous });
  }

  /** The channels with a change listener, sorted. */
  subscribed(): string[] {
    return [...this.channelMap]
      .filter(([, channel]) => channel.listeners.length > 0)
      .map(([name]) => name)
      .sort();
  }

  /** Delivers `data` on `channel` as Ably would (decoded JSON). */
  deliver(channel: string, data: unknown) {
    for (const { listener } of this.channelMap.get(channel)?.listeners ?? []) listener({ data });
  }
}

/** A `createClient` that records every fake client it builds (`clients.at(-1)` is current). */
export function fakeAbly() {
  const clients: FakeRealtime[] = [];
  const createClient: CreateLiveClient = (options) => {
    const client = new FakeRealtime(options);
    clients.push(client);
    return client;
  };
  return { clients, createClient, current: () => clients.at(-1)! };
}

/** A token endpoint that answers a token valid for an hour. */
export const fakeToken: FetchLiveToken = async () => ({
  token: "jwt",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A change event for `organizationId`, with the catalogue's required fields filled in. */
export function changeEvent<E extends Partial<ChangeEvent>>(
  organizationId: string,
  event: E & { resource: ChangeEvent["resource"] },
): ChangeEvent {
  return {
    v: CHANGE_EVENT_VERSION,
    ids: ["33333333-3333-4333-8333-333333333333"],
    organizationId,
    at: "2026-10-25T12:00:00.000Z",
    ...event,
  } as ChangeEvent;
}
