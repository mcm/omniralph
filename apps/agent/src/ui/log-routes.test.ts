import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, silentLogger, type AgentLog } from "../logger.js";
import type { LogEntry } from "../logs/entries.js";
import { LogRing } from "../logs/ring.js";
import { logDirectory } from "../logs/rotating-file.js";
import { UiEventHub } from "./events.js";
import {
  LOG_PAGE_LINES,
  NO_LOG_FILE,
  logRoutes,
  type LogPageState,
  type LogSources,
} from "./log-routes.js";
import { publishLocalChanges } from "./publish.js";
import { startUiServer, uiCookieName, type UiServer } from "./server.js";

const TOKEN = "t".repeat(43);

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function get(server: UiServer, pathname: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: pathname,
        headers: {
          host: `127.0.0.1:${server.port}`,
          cookie: `${uiCookieName(server.port)}=${TOKEN}`,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function page(server: UiServer, query = ""): Promise<LogPageState> {
  const reply = await get(server, `/api/logs${query}`);
  expect(reply.status).toBe(200);
  return JSON.parse(reply.text) as LogPageState;
}

describe("the log routes", () => {
  let dir: string;
  let hub: UiEventHub;
  let servers: UiServer[];
  let logs: AgentLog[];
  let unpublish: (() => void)[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-log-routes-"));
    hub = new UiEventHub();
    servers = [];
    logs = [];
    unpublish = [];
  });

  afterEach(async () => {
    for (const stop of unpublish) stop();
    for (const server of servers) await server.close();
    for (const log of logs) log.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A logger writing `<dir>/logs/agent.log` and its ring, as `runAgent` creates it. */
  function agentLog(): AgentLog {
    const log = createLogger({ dataDir: dir, stderr: { write: () => true } as never });
    logs.push(log);
    return log;
  }

  async function start(sources: LogSources) {
    const server = await startUiServer({
      port: 0,
      agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
      version: "2.0.3",
      bundleDir: "/nonexistent",
      state: async () => ({}),
      hub,
      routes: logRoutes({ log: sources, logger: silentLogger() }),
      token: TOKEN,
      logger: silentLogger(),
    });
    servers.push(server);
    return server;
  }

  it("pages the file newest first, 200 lines per page", async () => {
    const log = agentLog();
    for (let i = 0; i < LOG_PAGE_LINES + 50; i++) log.logger.info({ n: i }, `line ${i}`);
    const server = await start({ dir: logDirectory(dir), ring: log.ring });

    const first = await page(server);
    expect(first.entries).toHaveLength(LOG_PAGE_LINES);
    expect(first.entries[0]).toMatchObject({ level: "info", msg: "line 249", fields: { n: 249 } });
    expect(first.entries.at(-1)!.msg).toBe("line 50");
    expect(first.before).not.toBeNull();

    const second = await page(server, `?before=${encodeURIComponent(first.before!)}`);
    expect(second.entries.map((entry) => entry.msg)).toEqual(
      Array.from({ length: 50 }, (_, i) => `line ${49 - i}`),
    );
    expect(second.before).toBeNull();
  });

  it("filters by level and text", async () => {
    const log = agentLog();
    log.logger.info("claimed a job");
    log.logger.warn({ repo: "acme/web" }, "fetch was slow");
    log.logger.error({ repo: "acme/api" }, "fetch failed");
    log.logger.debug("not written at info");
    const server = await start({ dir: logDirectory(dir), ring: log.ring });

    expect((await page(server, "?level=all")).entries.map((entry) => entry.msg)).toEqual([
      "fetch failed",
      "fetch was slow",
      "claimed a job",
    ]);
    expect((await page(server, "?level=warn")).entries.map((entry) => entry.msg)).toEqual([
      "fetch failed",
      "fetch was slow",
    ]);
    // Fields match too, case-insensitively.
    expect((await page(server, "?q=ACME%2Fapi")).entries.map((entry) => entry.msg)).toEqual([
      "fetch failed",
    ]);
    expect((await page(server, "?level=warn&q=CLAIMED")).entries).toEqual([]);
  });

  it("refuses an unknown level", async () => {
    const server = await start({ dir: logDirectory(dir) });
    const reply = await get(server, "/api/logs?level=debug");
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.text)).toMatchObject({ issues: [{ path: ["level"] }] });
  });

  it("answers an empty page before anything is written", async () => {
    const server = await start({ dir: logDirectory(dir) });
    expect(await page(server)).toEqual({ entries: [], before: null });
  });

  it("pages the ring when there is no file", async () => {
    const ring = new LogRing();
    const line = (n: number, level: number) =>
      JSON.stringify({ time: 1_000 + n, level, msg: `line ${n}`, n });
    for (let i = 0; i < LOG_PAGE_LINES + 10; i++) ring.write(line(i, i % 10 === 0 ? 40 : 30));
    const server = await start({ ring });

    const first = await page(server);
    expect(first.entries).toHaveLength(LOG_PAGE_LINES);
    expect(first.entries[0]!.msg).toBe(`line ${LOG_PAGE_LINES + 9}`);
    const second = await page(server, `?before=${first.before}`);
    expect(second.entries.map((entry) => entry.msg)).toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${9 - i}`),
    );
    expect(second.before).toBeNull();
    expect((await page(server, "?level=warn")).entries).toHaveLength(21);
  });

  it("streams the current agent.log as an attachment", async () => {
    const log = agentLog();
    log.logger.info({ jobId: "job-1" }, "claimed a job");
    log.logger.warn("fetch was slow");
    const server = await start({ dir: logDirectory(dir), ring: log.ring });

    const reply = await get(server, "/api/logs/download");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-disposition"]).toBe('attachment; filename="agent.log"');
    expect(reply.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.text).toBe(await readFile(path.join(logDirectory(dir), "agent.log"), "utf8"));
    expect(reply.text.trim().split("\n")).toHaveLength(2);
  });

  it("answers 404 when there is no log file", async () => {
    for (const sources of [{ dir: logDirectory(dir) }, { ring: new LogRing() }]) {
      const server = await start(sources);
      const reply = await get(server, "/api/logs/download");
      expect(reply.status).toBe(404);
      expect(JSON.parse(reply.text)).toEqual({ error: NO_LOG_FILE });
    }
  });

  it("sends new lines as logs events", async () => {
    const log = agentLog();
    unpublish.push(
      publishLocalChanges(hub, {
        settings: new EventEmitter() as never,
        history: new EventEmitter() as never,
        claude: new EventEmitter() as never,
        storage: new EventEmitter() as never,
        ring: log.ring,
      }),
    );
    const server = await start({ dir: logDirectory(dir), ring: log.ring });
    let text = "";
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
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
    });
    req.on("error", () => {});
    req.end();
    await vi.waitFor(() => expect(hub.size).toBe(1));

    log.logger.warn({ repo: "acme/web" }, "fetch was slow");
    await vi.waitFor(() => expect(text).toContain("fetch was slow"));
    req.destroy();
    const change = text
      .split("\n\n")
      .filter((block) => block.startsWith("event: change"))
      .map(
        (block) =>
          JSON.parse(block.split("\ndata: ")[1]!) as { resource: string; data: LogEntry[] },
      )
      .find((event) => event.resource === "logs")!;
    expect(change.data).toEqual([
      {
        time: expect.any(Number),
        level: "warn",
        msg: "fetch was slow",
        fields: { repo: "acme/web" },
      },
    ]);
  });
});
