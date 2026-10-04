import { QUEUE_CONSUMER_GROUP } from "@omniralph/shared";

/** Largest request body forwarded upstream (ExtendLease sends a tiny JSON body). */
export const MAX_PROXY_BODY_BYTES = 64 * 1024;

/** Path prefix of the proxy route; agents use `<APP_URL>/api/agent/queue/<region>` as base URL. */
const PREFIX = "/api/agent/queue/";

/**
 * The Vercel Queues API calls the agent's `PollingQueueClient` makes, and the
 * only ones forwarded (see `@vercel/queue`'s `ApiClient`):
 * - ReceiveMessages: `POST /api/v3/topic/<topic>/consumer/<group>`
 * - AcknowledgeMessage: `DELETE …/consumer/<group>/lease/<receiptHandle>`
 * - ExtendLease: `PATCH …/consumer/<group>/lease/<receiptHandle>`
 *
 * Receipt handles are opaque and `encodeURIComponent`-encoded by the client;
 * percent-escapes are allowed except encoded slashes, backslashes and dots.
 */
const OPERATION_PATH = new RegExp(
  "^/(?<region>[a-z0-9]{1,16})/api/v3/topic/(?<topic>[A-Za-z0-9_-]{1,200})" +
    "/consumer/(?<group>[A-Za-z0-9_-]{1,200})" +
    "(?:/lease/(?<handle>(?:[A-Za-z0-9_.~!*'()-]|%(?!2[EeFf]|5[Cc])[0-9A-Fa-f]{2}){1,1024}))?$",
);

export type QueueOperation = "receive" | "acknowledge" | "extendLease";

export interface ParsedQueueRequest {
  operation: QueueOperation;
  region: string;
  topic: string;
  group: string;
  /** Upstream path, rebuilt from the validated parts. */
  path: string;
}

/**
 * Parses the raw request URL of a proxied queue call. Returns null for
 * anything but the three allowed operations (wrong method, unknown path,
 * traversal or encoded separators, query strings).
 */
export function parseQueueRequest(method: string, rawUrl: string): ParsedQueueRequest | null {
  // Check the raw URL: `..`, encoded dots/slashes/backslashes and query strings never
  // appear in calls made by the SDK.
  if (/\.\.|%2e|%2f|%5c|\\|\?|#/i.test(rawUrl.replace(/^[a-z]+:\/\/[^/]+/i, ""))) return null;
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(PREFIX)) return null;
  const match = OPERATION_PATH.exec(pathname.slice(PREFIX.length - 1));
  if (!match?.groups) return null;
  const { region, topic, group, handle } = match.groups as {
    region: string;
    topic: string;
    group: string;
    handle?: string;
  };

  let operation: QueueOperation;
  if (method === "POST" && handle === undefined) operation = "receive";
  else if (method === "DELETE" && handle !== undefined) operation = "acknowledge";
  else if (method === "PATCH" && handle !== undefined) operation = "extendLease";
  else return null;

  const path =
    `/api/v3/topic/${topic}/consumer/${group}` + (handle === undefined ? "" : `/lease/${handle}`);
  return { operation, region, topic, group, path };
}

/** Request headers forwarded upstream: `Accept`, `Content-Type` and `Vqs-*`. */
export function forwardedRequestHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "accept" || lower === "content-type" || lower.startsWith("vqs-")) {
      out.set(name, value);
    }
  });
  return out;
}

/** Response headers passed back to the agent (the multipart boundary lives in `Content-Type`). */
function forwardedResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower === "retry-after" || lower.startsWith("vqs-")) {
      out.set(name, value);
    }
  });
  return out;
}

class BodyTooLargeError extends Error {}

/** Reads the body, refusing more than `MAX_PROXY_BODY_BYTES` (without trusting `Content-Length`). */
async function readLimitedBody(req: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_PROXY_BODY_BYTES) throw new BodyTooLargeError();
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROXY_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  if (size === 0) return null;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function error(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

export interface QueueProxyOptions {
  /** Regions the proxy may forward to (`QUEUE_REGIONS`). */
  regions: readonly string[];
  /** Topics this agent may read. */
  allowedTopics: readonly string[];
  /** The control panel's Vercel OIDC token (`@vercel/oidc`). */
  getOidcToken: () => Promise<string>;
  fetch?: typeof fetch;
}

/**
 * Forwards an (already authenticated) agent's queue call to
 * `https://<region>.vercel-queue.com` with the control panel's OIDC token,
 * streaming the response back. Everything that isn't one of the three
 * allowed operations, in an allowed region, on an allowed topic, in consumer
 * group `agents` gets 403. The agent's own `Authorization` header is never
 * forwarded, upstream redirects aren't followed and bodies over 64 KB are
 * rejected.
 */
export async function proxyQueueRequest(
  req: Request,
  options: QueueProxyOptions,
): Promise<Response> {
  const parsed = parseQueueRequest(req.method, req.url);
  if (!parsed) return error(403, "operation_not_allowed");
  if (!options.regions.includes(parsed.region)) return error(403, "region_not_allowed");
  if (parsed.group !== QUEUE_CONSUMER_GROUP) return error(403, "consumer_group_not_allowed");
  if (!options.allowedTopics.includes(parsed.topic)) return error(403, "topic_not_allowed");

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await readLimitedBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return error(413, "body_too_large");
    throw e;
  }

  let token: string;
  try {
    token = await options.getOidcToken();
  } catch {
    return error(503, "queue_unavailable");
  }
  const headers = forwardedRequestHeaders(req.headers);
  headers.set("Authorization", `Bearer ${token}`);

  // The host is fixed; only the validated region and path vary.
  const url = `https://${parsed.region}.vercel-queue.com${parsed.path}`;
  let upstream: Response;
  try {
    upstream = await (options.fetch ?? fetch)(url, {
      method: req.method,
      headers,
      body: parsed.operation === "extendLease" ? body : null,
      redirect: "manual",
    });
  } catch {
    return error(502, "upstream_unreachable");
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return error(502, "upstream_redirect");
  }
  // 204 (empty queue) must not carry a body.
  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardedResponseHeaders(upstream.headers),
  });
}
