import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../logger.js";
import { UiEventHub } from "./events.js";
import {
  hostAllowed,
  newUiToken,
  startUiServer,
  tokensEqual,
  uiCookieName,
  UiHttpError,
  type UiServer,
  type UiServerOptions,
} from "./server.js";

const AGENT_ID = "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10";
const TOKEN = "t".repeat(43);

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A raw request: `fetch` would normalize the path and refuses to set `Host`. */
function send(
  server: UiServer,
  options: {
    method?: string;
    path?: string;
    host?: string;
    cookie?: string | null;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    host: options.host ?? `127.0.0.1:${server.port}`,
    ...options.headers,
  };
  const cookie =
    options.cookie === undefined ? `${uiCookieName(server.port)}=${TOKEN}` : options.cookie;
  if (cookie !== null) headers.cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** A same-origin JSON mutation's headers. */
function mutationHeaders(server: UiServer): Record<string, string> {
  return { origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" };
}

describe("agent page server", () => {
  let dir: string;
  let bundleDir: string;
  let hub: UiEventHub;
  const servers: UiServer[] = [];
  const blockers: Server[] = [];

  async function start(options: Partial<UiServerOptions> = {}): Promise<UiServer> {
    const server = await startUiServer({
      port: 0,
      agentId: AGENT_ID,
      version: "2.0.4",
      bundleDir,
      state: async () => ({ status: "ok" }),
      hub,
      token: TOKEN,
      logger: silentLogger(),
      ...options,
    });
    servers.push(server);
    return server;
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-ui-"));
    bundleDir = path.join(dir, "ui");
    await mkdir(path.join(bundleDir, "assets"), { recursive: true });
    await writeFile(path.join(bundleDir, "index.html"), "<!doctype html><title>Agent</title>");
    await writeFile(path.join(bundleDir, "assets", "index-abc123.js"), "console.log(1)");
    await writeFile(path.join(dir, "secret.txt"), "secret");
    hub = new UiEventHub();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const server of servers.splice(0)) await server.close();
    for (const blocker of blockers.splice(0)) {
      await new Promise((resolve) => blocker.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });

  describe("bind", () => {
    it("listens on 127.0.0.1 only", async () => {
      const server = await start();
      expect((server.server.address() as AddressInfo).address).toBe("127.0.0.1");
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    });

    it("falls back to an ephemeral port, with a warning, when its port is taken", async () => {
      const blocker = createServer();
      blockers.push(blocker);
      await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const taken = (blocker.address() as AddressInfo).port;
      const logger = silentLogger();
      const warn = vi.spyOn(logger, "warn");
      const server = await start({ port: taken, logger });
      expect(server.port).not.toBe(taken);
      expect(server.port).toBeGreaterThan(0);
      expect((server.server.address() as AddressInfo).address).toBe("127.0.0.1");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ port: taken, fallbackPort: server.port }),
        expect.stringContaining("port is taken"),
      );
      expect((await send(server, { path: "/api/ping" })).status).toBe(200);
    });

    it("makes a new 32-byte base64url token by default", async () => {
      const a = newUiToken();
      expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(a, "base64url")).toHaveLength(32);
      expect(newUiToken()).not.toBe(a);
      const server = await start({ token: undefined });
      expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe("Host check", () => {
    it.each([
      ["a foreign name", "evil.example"],
      ["a foreign name with the right port", "evil.example:PORT"],
      ["127.0.0.1 on another port", "127.0.0.1:OTHER"],
      ["localhost on another port", "localhost:OTHER"],
      ["127.0.0.1 without a port", "127.0.0.1"],
    ])("answers 403 for %s, before auth or routing", async (_name, template) => {
      const server = await start();
      const host = template
        .replace("OTHER", String(server.port === 65535 ? 1 : server.port + 1))
        .replace("PORT", String(server.port));
      for (const target of ["/api/ping", "/api/nowhere", "/", `/?token=${TOKEN}`]) {
        const reply = await send(server, { host, path: target });
        expect(reply.status).toBe(403);
        expect(reply.headers["set-cookie"]).toBeUndefined();
      }
      // Without a cookie either: the Host check comes first.
      expect((await send(server, { host, path: "/api/ping", cookie: null })).status).toBe(403);
    });

    it("answers on 127.0.0.1, localhost and an allowed Coder host", async () => {
      const coder = "7410--main--dev--steve.coder.example.com";
      const server = await start({ allowedHosts: [coder] });
      for (const host of [
        `127.0.0.1:${server.port}`,
        `localhost:${server.port}`,
        coder,
        `${coder}:443`,
      ]) {
        expect((await send(server, { host, path: "/api/ping" })).status).toBe(200);
      }
      expect((await send(server, { host: `x.${coder}`, path: "/api/ping" })).status).toBe(403);
    });

    it("matches exact names only", () => {
      expect(hostAllowed("LOCALHOST:7410", 7410, [])).toBe(true);
      expect(hostAllowed("127.0.0.1:7410.evil.example", 7410, [])).toBe(false);
      expect(hostAllowed("coder.example:80", 7410, ["coder.example"])).toBe(true);
      expect(hostAllowed("evilcoder.example", 7410, ["coder.example"])).toBe(false);
      expect(hostAllowed("[::1]:7410", 7410, [])).toBe(false);
      expect(hostAllowed(undefined, 7410, [])).toBe(false);
    });
  });

  describe("auth", () => {
    it("trades a valid ?token= for the cookie and a 303 to the path without it", async () => {
      const server = await start();
      const reply = await send(server, {
        path: `/attempts/abc?token=${TOKEN}&tab=log`,
        cookie: null,
      });
      expect(reply.status).toBe(303);
      expect(reply.headers.location).toBe("/attempts/abc?tab=log");
      expect(reply.headers["set-cookie"]).toEqual([
        `omniralph_agent_${server.port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
      ]);
      const root = await send(server, { path: `/?token=${TOKEN}`, cookie: null });
      expect(root.headers.location).toBe("/");
      const doubled = await send(server, { path: `//evil.example?token=${TOKEN}`, cookie: null });
      expect(doubled.headers.location).toBe("/evil.example");
    });

    it("answers 401 for an invalid token, setting no cookie", async () => {
      const server = await start();
      for (const token of ["wrong", `${TOKEN}x`, ""]) {
        const reply = await send(server, { path: `/?token=${token}`, cookie: null });
        expect(reply.status).toBe(401);
        expect(reply.headers["set-cookie"]).toBeUndefined();
      }
    });

    it("compares tokens in constant time, whatever their lengths", () => {
      expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
      expect(tokensEqual(TOKEN, "short")).toBe(false);
    });

    it("answers 401 JSON for /api/* without the cookie, and a 401 page for HTML", async () => {
      const server = await start();
      for (const cookie of [
        null,
        `${uiCookieName(server.port)}=wrong`,
        `${uiCookieName(server.port + 1)}=${TOKEN}`,
      ]) {
        const api = await send(server, { path: "/api/state", cookie });
        expect(api.status).toBe(401);
        expect(api.headers["content-type"]).toMatch(/^application\/json/);
        expect(JSON.parse(api.body)).toEqual({ error: expect.any(String) });
        const html = await send(server, { path: "/capacity", cookie });
        expect(html.status).toBe(401);
        expect(html.headers["content-type"]).toMatch(/^text\/html/);
        expect(html.body).toContain("Open this page again");
        expect(html.body).toContain("omniralph-agent ui");
      }
    });

    it("accepts the cookie among others", async () => {
      const server = await start();
      const reply = await send(server, {
        path: "/api/ping",
        cookie: `theme=dark; ${uiCookieName(server.port)}=${TOKEN}; other=1`,
      });
      expect(reply.status).toBe(200);
    });
  });

  describe("CSRF", () => {
    const echo = {
      method: "POST" as const,
      path: "/api/echo",
      handle: async ({ json }: { json: () => Promise<unknown> }) => ({
        status: 200,
        body: { got: await json() },
      }),
    };

    it("accepts a same-origin JSON mutation", async () => {
      const server = await start({ routes: [echo] });
      const reply = await send(server, {
        method: "POST",
        path: "/api/echo",
        headers: { ...mutationHeaders(server), "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual({ got: { a: 1 } });
    });

    it.each([
      ["no Origin", { "content-type": "application/json" }],
      ["a foreign Origin", { origin: "http://evil.example", "content-type": "application/json" }],
      [
        "another port's Origin",
        { origin: "http://127.0.0.1:1", "content-type": "application/json" },
      ],
      ["a null Origin", { origin: "null", "content-type": "application/json" }],
      ["a form body", { origin: "ORIGIN", "content-type": "application/x-www-form-urlencoded" }],
      ["a text body", { origin: "ORIGIN", "content-type": "text/plain" }],
      ["no body type", { origin: "ORIGIN" }],
    ])("answers 403 for a POST with %s", async (_name, template) => {
      const server = await start({ routes: [echo] });
      const handle = vi.spyOn(echo, "handle");
      const headers = Object.fromEntries(
        Object.entries(template).map(([key, value]) => [
          key,
          value.replace("ORIGIN", `http://127.0.0.1:${server.port}`),
        ]),
      );
      for (const method of ["POST", "PUT", "DELETE"]) {
        const reply = await send(server, { method, path: "/api/echo", headers, body: "{}" });
        expect(reply.status).toBe(403);
      }
      expect(handle).not.toHaveBeenCalled();
      handle.mockRestore();
    });

    it("answers API errors as { error, issues? }", async () => {
      const server = await start({
        routes: [
          echo,
          {
            method: "PUT",
            path: /^\/api\/things\/([^/]+)$/,
            handle: ({ params }) => {
              throw new UiHttpError(400, `bad ${params[0]}`, ["x: too big"]);
            },
          },
        ],
      });
      const invalid = await send(server, {
        method: "POST",
        path: "/api/echo",
        headers: mutationHeaders(server),
        body: "{nope",
      });
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body)).toEqual({ error: "The request body isn't valid JSON" });
      const thrown = await send(server, {
        method: "PUT",
        path: "/api/things/a%20b",
        headers: mutationHeaders(server),
        body: "{}",
      });
      expect(thrown.status).toBe(400);
      expect(JSON.parse(thrown.body)).toEqual({ error: "bad a b", issues: ["x: too big"] });
      expect((await send(server, { path: "/api/echo" })).status).toBe(405);
      expect((await send(server, { path: "/api/nowhere" })).status).toBe(404);
    });
  });

  describe("headers", () => {
    it("sends the security headers on every response", async () => {
      const server = await start();
      const replies = [
        await send(server, { path: "/" }),
        await send(server, { path: "/assets/index-abc123.js" }),
        await send(server, { path: "/api/ping" }),
        await send(server, { path: "/api/ping", cookie: null }),
        await send(server, { path: "/", host: "evil.example" }),
        await send(server, { path: `/?token=${TOKEN}`, cookie: null }),
        await send(server, { path: "/%2e%2e/secret.txt" }),
      ];
      for (const reply of replies) {
        expect(reply.headers["content-security-policy"]).toBe(
          "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        );
        expect(reply.headers["x-frame-options"]).toBe("DENY");
        expect(reply.headers["referrer-policy"]).toBe("no-referrer");
        expect(reply.headers["x-content-type-options"]).toBe("nosniff");
        expect(reply.headers["cache-control"]).toBeDefined();
      }
    });

    it("never caches HTML or the API, and caches hashed assets for good", async () => {
      const server = await start();
      expect((await send(server, { path: "/" })).headers["cache-control"]).toBe("no-store");
      expect((await send(server, { path: "/logs" })).headers["cache-control"]).toBe("no-store");
      expect((await send(server, { path: "/api/state" })).headers["cache-control"]).toBe(
        "no-store",
      );
      expect(
        (await send(server, { path: "/assets/index-abc123.js" })).headers["cache-control"],
      ).toBe("public, max-age=31536000, immutable");
    });
  });

  describe("static files", () => {
    it("serves the bundle's files and index.html for every other page", async () => {
      const server = await start();
      const asset = await send(server, { path: "/assets/index-abc123.js" });
      expect(asset.status).toBe(200);
      expect(asset.headers["content-type"]).toMatch(/^text\/javascript/);
      expect(asset.body).toBe("console.log(1)");
      for (const page of ["/", "/index.html", "/capacity", "/attempts/abc", "/logs?level=warn"]) {
        const reply = await send(server, { path: page });
        expect(reply.status).toBe(200);
        expect(reply.headers["content-type"]).toMatch(/^text\/html/);
        expect(reply.body).toBe("<!doctype html><title>Agent</title>");
      }
      expect((await send(server, { path: "/assets/missing.js" })).status).toBe(404);
      expect((await send(server, { method: "HEAD", path: "/" })).body).toBe("");
    });

    it("serves the bundle's relative asset URLs from a nested page", async () => {
      const server = await start();
      const asset = await send(server, { path: "/attempts/assets/index-abc123.js" });
      expect(asset.status).toBe(200);
      expect(asset.body).toBe("console.log(1)");
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect((await send(server, { path: "/attempts/assets/missing.js" })).status).toBe(404);
      // An attempt whose ID is "assets" is still a page.
      expect((await send(server, { path: "/attempts/assets" })).headers["content-type"]).toMatch(
        /^text\/html/,
      );
    });

    it.each([
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/..%5csecret.txt",
      "/%00",
      "/%zz",
    ])("answers 404 for %s, never reading outside the bundle", async (target) => {
      const server = await start();
      const reply = await send(server, { path: target });
      expect(reply.status).toBe(404);
      expect(reply.body).not.toContain("secret");
    });

    it("doesn't follow a symlink out of the bundle", async () => {
      const { symlink } = await import("node:fs/promises");
      await symlink(path.join(dir, "secret.txt"), path.join(bundleDir, "assets", "link.txt"));
      const server = await start();
      const reply = await send(server, { path: "/assets/link.txt" });
      expect(reply.status).toBe(404);
      expect(reply.body).not.toContain("secret");
    });

    it("answers 503 for HTML when there's no bundle, and the API still works", async () => {
      const server = await start({ bundleDir: path.join(dir, "missing") });
      for (const page of ["/", "/capacity", "/assets/index-abc123.js"]) {
        const reply = await send(server, { path: page });
        expect(reply.status).toBe(503);
        expect(reply.body).toContain("The agent page isn't built");
      }
      expect((await send(server, { path: "/api/ping" })).status).toBe(200);
    });

    it("refuses mutations of static paths", async () => {
      const server = await start();
      const reply = await send(server, {
        method: "POST",
        path: "/",
        headers: mutationHeaders(server),
        body: "{}",
      });
      expect(reply.status).toBe(405);
    });
  });

  describe("API", () => {
    it("answers /api/ping with the agent ID and version", async () => {
      const server = await start();
      const reply = await send(server, { path: "/api/ping" });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual({ agentId: AGENT_ID, version: "2.0.4" });
    });

    it("answers /api/state from its source", async () => {
      const state = vi.fn(async () => ({ status: { connected: true } }));
      const server = await start({ state });
      const reply = await send(server, { path: "/api/state" });
      expect(JSON.parse(reply.body)).toEqual({ status: { connected: true } });
      expect(state).toHaveBeenCalledOnce();
    });

    it("answers 500 when a handler fails, without its details", async () => {
      const server = await start({
        state: async () => {
          throw new Error("disk on fire");
        },
      });
      const reply = await send(server, { path: "/api/state" });
      expect(reply.status).toBe(500);
      expect(reply.body).not.toContain("disk on fire");
    });
  });

  describe("events", () => {
    /** Opens /api/events and collects what arrives. */
    function openStream(server: UiServer) {
      const received = { text: "", ended: false, status: 0, headers: {} as IncomingHttpHeaders };
      const req = request({
        host: "127.0.0.1",
        port: server.port,
        path: "/api/events",
        headers: {
          host: `127.0.0.1:${server.port}`,
          cookie: `${uiCookieName(server.port)}=${TOKEN}`,
        },
      });
      req.on("response", (res) => {
        received.status = res.statusCode!;
        received.headers = res.headers;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (received.text += chunk));
        res.on("end", () => (received.ended = true));
      });
      req.on("error", () => {});
      req.end();
      return { received, abort: () => req.destroy() };
    }

    it("streams change events from the hub, with a keep-alive comment", async () => {
      hub = new UiEventHub({ keepAliveMs: 20, now: () => new Date("2026-10-28T10:42:00.000Z") });
      const server = await start();
      const stream = openStream(server);
      await vi.waitFor(() => expect(hub.size).toBe(1));
      expect(stream.received.status).toBe(200);
      expect(stream.received.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(stream.received.headers["cache-control"]).toBe("no-store");
      expect(stream.received.headers["content-security-policy"]).toBeDefined();

      hub.publish("settings");
      hub.publish("transcript", { ids: ["job-1"], data: [{ type: "text", body: "hi" }] });
      await vi.waitFor(() => expect(stream.received.text).toContain("job-1"));
      const events = stream.received.text
        .split("\n\n")
        .filter((block) => block.startsWith("event: change"))
        .map((block) => JSON.parse(block.split("\ndata: ")[1]!));
      expect(events).toEqual([
        { v: 1, resource: "settings", at: "2026-10-28T10:42:00.000Z" },
        {
          v: 1,
          resource: "transcript",
          ids: ["job-1"],
          at: "2026-10-28T10:42:00.000Z",
          data: [{ type: "text", body: "hi" }],
        },
      ]);
      await vi.waitFor(() => expect(stream.received.text).toContain(": keep-alive\n\n"));

      stream.abort();
      await vi.waitFor(() => expect(hub.size).toBe(0));
    });

    it("keeps alive every 15 s by default", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const server = await start();
      const stream = openStream(server);
      // Not vi.waitFor: it would advance the fake timers.
      const until = async (done: () => boolean) => {
        while (!done()) await new Promise((resolve) => setTimeout(resolve, 5));
      };
      await until(() => stream.received.text.includes("retry:"));
      await vi.advanceTimersByTimeAsync(14_999);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(stream.received.text).not.toContain("keep-alive");
      await vi.advanceTimersByTimeAsync(1);
      await until(() => stream.received.text.includes(": keep-alive\n\n"));
      stream.abort();
    });

    it("needs the cookie", async () => {
      const server = await start();
      const reply = await send(server, { path: "/api/events", cookie: null });
      expect(reply.status).toBe(401);
      expect(hub.size).toBe(0);
    });

    it("ends the streams cleanly when the server closes", async () => {
      const server = await start();
      const stream = openStream(server);
      await vi.waitFor(() => expect(hub.size).toBe(1));
      await server.close();
      servers.splice(servers.indexOf(server), 1);
      await vi.waitFor(() => expect(stream.received.ended).toBe(true));
      expect(hub.size).toBe(0);
    });
  });
});
