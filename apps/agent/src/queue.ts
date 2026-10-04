import {
  PollingQueueClient,
  type MessageHandler,
  type ReceiveBatchOptions,
  type ReceiveResult,
  type VercelRegion,
} from "@vercel/queue";

export type { MessageHandler, MessageMetadata, ReceiveResult, RetryDirective } from "@vercel/queue";

/** The part of `PollingQueueClient` the daemon uses (mocked in tests). */
export interface QueueReceiver {
  receive<T = unknown>(
    topic: string,
    consumerGroup: string,
    handler: MessageHandler<T>,
    options?: ReceiveBatchOptions,
  ): Promise<ReceiveResult>;
}

export type QueueReceiverFactory = (region: string) => QueueReceiver;

/** The `dispatch` contract of undici, which Node's `fetch` calls for every request. */
interface Dispatcher {
  dispatch(options: { headers?: unknown } & Record<string, unknown>, handler: unknown): boolean;
}

// Node's built-in fetch registers its global dispatcher under one of these (undici ≥ 8, < 8).
const GLOBAL_DISPATCHER_SYMBOLS = [
  Symbol.for("undici.globalDispatcher.2"),
  Symbol.for("undici.globalDispatcher.1"),
];

function globalDispatcher(): Dispatcher {
  const globals = globalThis as unknown as Record<symbol, Dispatcher | undefined>;
  for (const symbol of GLOBAL_DISPATCHER_SYMBOLS) {
    const dispatcher = globals[symbol];
    if (dispatcher) return dispatcher;
  }
  throw new Error("Node's fetch dispatcher is not initialised");
}

/** Replaces any `Authorization` header (object or flat `[name, value, …]` array form). */
function withAuthorization(headers: unknown, value: string): unknown {
  if (Array.isArray(headers)) {
    const out: unknown[] = [];
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() !== "authorization")
        out.push(headers[i], headers[i + 1]);
    }
    return [...out, "authorization", value];
  }
  const out: Record<string, unknown> = {};
  if (headers && typeof headers === "object") {
    for (const [name, v] of Object.entries(headers)) {
      if (name.toLowerCase() !== "authorization") out[name] = v;
    }
  }
  out.authorization = value;
  return out;
}

/**
 * A fetch dispatcher that sets `Authorization: Bearer <current access token>`
 * on every request. `@vercel/queue` fixes its token per client and reuses it
 * for the lease extensions of a running handler; without this a job running
 * longer than the 15-minute access token would lose its lease (ADR 0001).
 */
export function bearerTokenDispatcher(currentToken: () => string | null): Dispatcher {
  return {
    dispatch(options, handler) {
      const token = currentToken() ?? "";
      return globalDispatcher().dispatch(
        { ...options, headers: withAuthorization(options.headers, `Bearer ${token}`) },
        handler,
      );
    },
  };
}

/**
 * A `PollingQueueClient` that talks to the control panel's queue proxy
 * (`/api/agent/queue/{region}/…`), never to Vercel directly.
 */
export function createQueueReceiver(
  server: string,
  region: string,
  currentToken: () => string | null,
): QueueReceiver {
  const client = new PollingQueueClient({
    region: region as VercelRegion,
    // Messages are published deploymentless; outside Vercel a pinned client throws.
    deploymentId: null,
    resolveBaseUrl: (r) => new URL(`${server}/api/agent/queue/${encodeURIComponent(r)}`),
    // Must be non-empty (otherwise the SDK fetches a Vercel OIDC token); the dispatcher
    // replaces it with the current access token on every request.
    token: "omniralph-agent",
    dispatcher: bearerTokenDispatcher(currentToken),
  });
  return { receive: client.receive };
}
