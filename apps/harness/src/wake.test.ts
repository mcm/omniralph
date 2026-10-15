import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.js";
import {
  createWakeSubscription,
  type WakeClientOptions,
  type WakeEvent,
  type WakeRealtimeChannel,
  type WakeRealtimeClient,
} from "./wake.js";

const HARNESS_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const ORG_ID = "0b6c1f0e-6a2d-4a8e-8f0a-1d2b3c4d5e70";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const LATER = "2026-10-16T00:00:00.000Z";

class FakeChannel implements WakeRealtimeChannel {
  state = "initialized";
  listeners: ((message: unknown) => void)[] = [];
  attach = vi.fn(() => Promise.resolve());
  subscribe(listener: (message: unknown) => void): Promise<unknown> {
    this.listeners.push(listener);
    return Promise.resolve();
  }
  publish(): void {
    for (const listener of this.listeners) listener({ name: "wake" });
  }
}

class FakeClient implements WakeRealtimeClient {
  readonly channelMap = new Map<string, FakeChannel>();
  private stateListeners: ((change: { current: string; previous: string }) => void)[] = [];
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
  };
  close = vi.fn(() => {});

  constructor(readonly options: WakeClientOptions) {}

  setState(current: string): void {
    const previous = this.connection.state;
    this.connection.state = current;
    for (const listener of this.stateListeners) listener({ current, previous });
  }

  /** Calls the subscription's `authCallback` as Ably would. */
  requestToken(): Promise<{ error: unknown; token: unknown }> {
    return new Promise((resolve) => {
      this.options.authCallback!({}, (error, token) => resolve({ error, token }));
    });
  }
}

function setup() {
  let client: FakeClient | undefined;
  const subscription = createWakeSubscription({
    harnessId: HARNESS_ID,
    organizationId: ORG_ID,
    logger: silentLogger(),
    createClient: (options) => (client = new FakeClient(options)),
    now: () => NOW,
  });
  const events: WakeEvent[] = [];
  for (const event of ["wake", "connected", "disconnected"] as const) {
    subscription.on(event, () => events.push(event));
  }
  return { subscription, client: client!, events };
}

describe("createWakeSubscription", () => {
  it("connects as the harness once it has a token", () => {
    const { subscription, client } = setup();
    expect(client.options.clientId).toBe(HARNESS_ID);
    expect(client.connection.connect).not.toHaveBeenCalled();

    subscription.setToken("jwt-1", LATER);
    expect(client.connection.connect).toHaveBeenCalledTimes(1);
  });

  it("hands Ably the latest token it was given", async () => {
    const { subscription, client } = setup();
    expect((await client.requestToken()).token).toBeNull();

    subscription.setToken("jwt-1", LATER);
    expect(await client.requestToken()).toEqual({ error: null, token: "jwt-1" });

    client.setState("connected");
    subscription.setToken("jwt-2", LATER);
    expect(await client.requestToken()).toEqual({ error: null, token: "jwt-2" });
    // Already connected: the new token waits for Ably to ask for it.
    expect(client.connection.connect).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired token", async () => {
    const { subscription, client } = setup();
    subscription.setToken("jwt-1", "2026-10-15T11:59:59.000Z");
    const { error, token } = await client.requestToken();
    expect(error).toBeTruthy();
    expect(token).toBeNull();
  });

  it("reconnects at once when a token arrives while disconnected", () => {
    const { subscription, client } = setup();
    subscription.setToken("jwt-1", LATER);
    client.setState("connected");
    client.setState("disconnected");
    subscription.setToken("jwt-2", LATER);
    expect(client.connection.connect).toHaveBeenCalledTimes(2);
  });

  it("subscribes to the harness and organization channels and emits wake for their messages", () => {
    const { subscription, client, events } = setup();
    subscription.setToken("jwt-1", LATER);
    subscription.setToken("jwt-2", LATER);
    expect([...client.channelMap.keys()]).toEqual([`harness:${HARNESS_ID}`, `org:${ORG_ID}`]);
    for (const channel of client.channelMap.values()) expect(channel.listeners).toHaveLength(1);

    client.channelMap.get(`harness:${HARNESS_ID}`)!.publish();
    client.channelMap.get(`org:${ORG_ID}`)!.publish();
    expect(events).toEqual(["wake", "wake"]);
  });

  it("emits connected and disconnected when the connection enters or leaves the connected state", () => {
    const { subscription, client, events } = setup();
    subscription.setToken("jwt-1", LATER);
    client.setState("connecting");
    client.setState("connected");
    client.setState("connected"); // an update
    client.setState("disconnected");
    client.setState("connecting");
    client.setState("suspended");
    client.setState("connected");
    client.setState("failed");
    expect(events).toEqual(["connected", "disconnected", "connected", "disconnected"]);
  });

  it("re-attaches failed channels on reconnect", () => {
    const { subscription, client } = setup();
    subscription.setToken("jwt-1", LATER);
    const harness = client.channelMap.get(`harness:${HARNESS_ID}`)!;
    const org = client.channelMap.get(`org:${ORG_ID}`)!;
    harness.state = "failed";
    org.state = "attached";
    client.setState("connected");
    expect(harness.attach).toHaveBeenCalledTimes(1);
    expect(org.attach).not.toHaveBeenCalled();
  });

  it("close() closes the connection and stops all events", async () => {
    const { subscription, client, events } = setup();
    subscription.setToken("jwt-1", LATER);
    client.setState("connected");
    subscription.close();
    expect(client.close).toHaveBeenCalledTimes(1);

    client.channelMap.get(`harness:${HARNESS_ID}`)!.publish();
    client.setState("closed");
    subscription.setToken("jwt-2", LATER);
    expect(events).toEqual(["connected"]);
    expect(client.connection.connect).toHaveBeenCalledTimes(1);
    expect((await client.requestToken()).token).toBeNull();

    subscription.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
