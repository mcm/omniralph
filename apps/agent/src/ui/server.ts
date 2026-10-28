/**
 * The agent page's server: the static bundle and a JSON API, on 127.0.0.1
 * only. Every request passes, in order:
 *
 * 1. the `Host` check (DNS rebinding): `127.0.0.1:<port>`, `localhost:<port>`
 *    or a `ui.allowedHosts` name, else 403;
 * 2. auth: `?token=` (the per-start token in `ui.json`) is traded for an
 *    HttpOnly, SameSite=Strict cookie and a 303 to the same path without it;
 *    anything else needs the cookie, else 401;
 * 3. CSRF: requests other than GET and HEAD need `Origin` equal to the page's
 *    own origin and a JSON body type, else 403;
 *
 * and only then routing. Node `http` only: no runtime dependency.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";
import type { UiEventHub } from "./events.js";

/** The only address the page is served on. */
export const UI_HOST = "127.0.0.1";

/** Most bytes of a JSON request body. */
export const UI_MAX_BODY_BYTES = 1024 * 1024;

export const UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  // The first URL carries the token.
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const NO_STORE = "no-store";
const IMMUTABLE = "public, max-age=31536000, immutable";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** `dist/ui/` next to `dist/cli.js` (missing when running from source). */
export function defaultBundleDir(): string {
  return fileURLToPath(new URL("./ui/", import.meta.url));
}

/** 32 random bytes, base64url: new at every start. */
export function newUiToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The auth cookie's name: cookies aren't port-scoped, and two agents can share a host. */
export function uiCookieName(port: number): string {
  return `omniralph_agent_${port}`;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison (of digests, so the lengths match too). */
export function tokensEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Whether the page answers to `host` (a `Host` header): `127.0.0.1` or
 * `localhost` on its own port, or exactly one of `allowedHosts` (any port, as
 * a forwarding proxy chooses it).
 */
export function hostAllowed(
  host: string | undefined,
  port: number,
  allowedHosts: readonly string[],
): boolean {
  if (!host) return false;
  const value = host.toLowerCase();
  if (value === `127.0.0.1:${port}` || value === `localhost:${port}`) return true;
  const match = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) return false;
  return allowedHosts.some((allowed) => allowed.toLowerCase() === match[1]);
}

/** An API error answered as `{ error, issues? }`. */
export class UiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
  }
}

export interface UiApiRequest {
  method: string;
  /** The decoded path, e.g. `/api/packages/@omniralph%2Fx` → `/api/packages/@omniralph/x`. */
  path: string;
  /** The route's capture groups. */
  params: string[];
  query: URLSearchParams;
  /** The parsed JSON body (`UiHttpError` 400 when it isn't JSON, 413 when too big). */
  json(): Promise<unknown>;
  req: IncomingMessage;
  res: ServerResponse;
}

/** `stream`: the handler answered itself (e.g. an event stream or a file download). */
export type UiApiResult =
  { status: number; body?: unknown; headers?: OutgoingHttpHeaders } | { stream: true };

export interface UiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** An exact path, or a pattern whose groups become `params`. */
  path: string | RegExp;
  handle(request: UiApiRequest): Promise<UiApiResult> | UiApiResult;
}

export interface UiServerOptions {
  /** `ui.port`; when taken, an ephemeral port is used (with a warning). 0: ephemeral. */
  port: number;
  /** `ui.allowedHosts`. */
  allowedHosts?: readonly string[];
  agentId: string;
  version: string;
  /** The built page (default `defaultBundleDir()`). */
  bundleDir?: string;
  /** `GET /api/state`. */
  state: () => Promise<unknown>;
  /** `GET /api/events`; closed with the server. */
  hub: UiEventHub;
  /** More API routes (the pages' own). */
  routes?: readonly UiRoute[];
  /** Default `newUiToken()`. */
  token?: string;
  logger: Logger;
}

export interface UiServer {
  readonly server: Server;
  /** The port bound. */
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly token: string;
  /** Ends the event streams and stops listening. */
  close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, UI_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><p>${message}</p></body>
</html>
`;
}

const UNAUTHORIZED_PAGE = htmlPage(
  "Open this page again",
  "This page's link no longer works. Run <code>omniralph-agent ui</code> on the machine to get a new one.",
);
const NOT_BUILT_PAGE = htmlPage(
  "The agent page isn't built",
  "This agent has no page bundle. Run <code>pnpm --filter @omniralph/agent build</code>, or install the published package.",
);

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function isJsonContentType(header: string | undefined): boolean {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

/**
 * The decoded path segments, or null for a path that tries to leave its
 * directory (`..`, also encoded) or isn't decodable.
 */
function safeSegments(rawPath: string): string[] | null {
  const segments: string[] = [];
  for (const raw of rawPath.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === ".." || segment === "." || /[/\\\0]/.test(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = options.token ?? newUiToken();
  const bundleDir = path.resolve(options.bundleDir ?? defaultBundleDir());
  const allowedHosts = options.allowedHosts ?? [];
  const routes: UiRoute[] = [
    {
      method: "GET",
      path: "/api/ping",
      handle: () => ({
        status: 200,
        body: { agentId: options.agentId, version: options.version },
      }),
    },
    {
      method: "GET",
      path: "/api/state",
      handle: async () => ({ status: 200, body: await options.state() }),
    },
    {
      method: "GET",
      path: "/api/events",
      handle: ({ res }) => {
        options.hub.attach(res);
        return { stream: true };
      },
    },
    ...(options.routes ?? []),
  ];
  let port = 0;

  const sendJson = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: OutgoingHttpHeaders = {},
  ) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const sendHtml = (req: IncomingMessage, res: ServerResponse, status: number, html: string) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : html);
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > UI_MAX_BODY_BYTES) throw new UiHttpError(413, "The request body is too large");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UiHttpError(400, "The request body isn't valid JSON");
    }
  };

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    rawPath: string,
    query: URLSearchParams,
  ) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const method = req.method ?? "GET";
    let pathMatched = false;
    for (const route of routes) {
      let params: string[];
      if (typeof route.path === "string") {
        if (route.path !== decoded) continue;
        params = [];
      } else {
        const match = route.path.exec(decoded);
        if (!match) continue;
        params = match.slice(1);
      }
      pathMatched = true;
      if (route.method !== method && !(route.method === "GET" && method === "HEAD")) continue;
      try {
        const result = await route.handle({
          method,
          path: decoded,
          params,
          query,
          json: () => readJson(req),
          req,
          res,
        });
        if ("stream" in result) return;
        sendJson(res, result.status, result.body, result.headers);
      } catch (error) {
        if (error instanceof UiHttpError) {
          sendJson(res, error.status, {
            error: error.message,
            ...(error.issues && { issues: error.issues }),
          });
          return;
        }
        options.logger.error({ err: error, path: decoded, method }, "agent page request failed");
        if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong" });
        else res.end();
      }
      return;
    }
    if (pathMatched) sendJson(res, 405, { error: "Method not allowed" });
    else sendJson(res, 404, { error: "Not found" });
  };

  const serveFile = (
    req: IncomingMessage,
    res: ServerResponse,
    file: string,
    cacheControl: string,
  ) => {
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": cacheControl,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", (error) => {
      options.logger.warn({ err: error, file }, "cannot read an agent page file");
      res.destroy();
    });
    stream.pipe(res);
  };

  const handleStatic = async (req: IncomingMessage, res: ServerResponse, rawPath: string) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    let segments = safeSegments(rawPath);
    // The bundle's URLs are relative (`./assets/…`), so a page opened at a nested route
    // (`/attempts/<id>`) asks for `/attempts/assets/…`: that is the bundle's `assets/…`.
    const assetsAt = segments?.lastIndexOf("assets") ?? -1;
    if (segments && assetsAt > 0 && assetsAt === segments.length - 2) {
      segments = segments.slice(assetsAt);
    }
    if (segments === null) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    let root: string;
    try {
      root = await realpath(bundleDir);
      if (!(await stat(path.join(root, "index.html"))).isFile()) throw new Error("not a file");
    } catch {
      sendHtml(req, res, 503, NOT_BUILT_PAGE);
      return;
    }
    const index = path.join(root, "index.html");
    if (segments.length > 0) {
      const candidate = path.join(root, ...segments);
      const real = await realpath(candidate).catch(() => null);
      const info = real && isWithin(real, root) ? await stat(real).catch(() => null) : null;
      if (real && info?.isFile()) {
        const hashed = segments[0] === "assets" && segments.length > 1;
        serveFile(req, res, real, hashed ? IMMUTABLE : NO_STORE);
        return;
      }
      // A missing asset is a missing file, not a page of the app.
      if (segments[0] === "assets") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
    }
    // Client-side routing: every other path is the app.
    serveFile(req, res, index, NO_STORE);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(UI_SECURITY_HEADERS)) res.setHeader(name, value);
    res.setHeader("cache-control", NO_STORE);

    // 1. DNS rebinding: before auth or routing.
    const host = req.headers.host;
    if (!hostAllowed(host, port, allowedHosts)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("Forbidden");
      return;
    }

    const rawUrl = req.url ?? "/";
    if (!rawUrl.startsWith("/")) {
      res.writeHead(400).end();
      return;
    }
    const queryIndex = rawUrl.indexOf("?");
    const rawPath = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
    const query = new URLSearchParams(queryIndex < 0 ? "" : rawUrl.slice(queryIndex + 1));
    const isApi = rawPath === "/api" || rawPath.startsWith("/api/");
    const unauthorized = () => {
      if (isApi) sendJson(res, 401, { error: "Open this page again with omniralph-agent ui" });
      else sendHtml(req, res, 401, UNAUTHORIZED_PAGE);
    };

    // 2. Auth: trade the link's token for the cookie.
    const linkToken = query.get("token");
    if (linkToken !== null) {
      if (!tokensEqual(linkToken, token)) {
        unauthorized();
        return;
      }
      query.delete("token");
      const rest = query.toString();
      res.writeHead(303, {
        "set-cookie": `${uiCookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        // Never `//host…`, which a browser reads as another site.
        location: `/${rawPath.replace(/^\/+/, "")}${rest ? `?${rest}` : ""}`,
      });
      res.end();
      return;
    }
    const cookie = parseCookies(req.headers.cookie).get(uiCookieName(port));
    if (cookie === undefined || !tokensEqual(cookie, token)) {
      unauthorized();
      return;
    }

    // 3. CSRF: only the page itself may change anything.
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.origin;
      const sameOrigin = origin === `http://${host}` || origin === `https://${host}`;
      if (!sameOrigin || !isJsonContentType(req.headers["content-type"])) {
        sendJson(res, 403, { error: "Cross-origin or non-JSON request" });
        return;
      }
    }

    if (isApi) await handleApi(req, res, rawPath, query);
    else await handleStatic(req, res, rawPath);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.logger.error({ err: error }, "agent page request failed");
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  try {
    await listen(server, options.port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || options.port === 0) throw error;
    await listen(server, 0);
    options.logger.warn(
      { port: options.port, fallbackPort: (server.address() as AddressInfo).port },
      "the agent page's port is taken; using another one (omniralph-agent ui prints it)",
    );
  }
  port = (server.address() as AddressInfo).port;
  const url = `http://${UI_HOST}:${port}`;

  return {
    server,
    port,
    url,
    token,
    close: async () => {
      options.hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}
