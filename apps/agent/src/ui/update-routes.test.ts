import { EventEmitter } from "node:events";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptHistory } from "../attempts/history.js";
import type { ClaudeStatusReporter } from "../claude-status.js";
import { silentLogger } from "../logger.js";
import { LocalSettingsStore } from "../settings.js";
import type { AgentStorage } from "../storage.js";
import { memorySettingsFs } from "../test/settings-fs.js";
import { SelfUpdater, updateStatePath } from "../update.js";
import { UiEventHub } from "./events.js";
import { publishLocalChanges } from "./publish.js";
import { startUiServer, uiCookieName, type UiServer } from "./server.js";
import { UPDATE_UNSUPPORTED_MESSAGE, updateRoutes } from "./update-routes.js";

const TOKEN = "t".repeat(43);

function post(
  server: UiServer,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path: "/api/update",
        headers: {
          host: `127.0.0.1:${server.port}`,
          cookie: `${uiCookieName(server.port)}=${TOKEN}`,
          origin: `http://127.0.0.1:${server.port}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(data) as Record<string, unknown> }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

describe("POST /api/update", () => {
  let dir: string;
  let store: LocalSettingsStore;
  let hub: UiEventHub;
  let published: string[];
  let servers: UiServer[];
  let unpublish: (() => void)[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-update-route-"));
    store = await LocalSettingsStore.open({
      file: "/data/settings.json",
      logger: silentLogger(),
      fs: memorySettingsFs().fs,
    });
    hub = new UiEventHub();
    published = [];
    vi.spyOn(hub, "publish").mockImplementation((resource) => void published.push(resource));
    servers = [];
    unpublish = [];
  });

  afterEach(async () => {
    for (const stop of unpublish) stop();
    for (const server of servers) await server.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(underPm2: boolean) {
    const updater = new SelfUpdater({
      statePath: updateStatePath(path.join(dir, "agent.json")),
      runningVersion: "2.0.3",
      underPm2,
      installer: { install: async () => {} },
      logger: silentLogger(),
      now: () => Date.parse("2026-10-28T10:42:00.000Z"),
    });
    await updater.start();
    const daemon = { heartbeatSoon: vi.fn() };
    // The same wiring as `runAgent`: the updater's change is the page's `update` event.
    unpublish.push(
      publishLocalChanges(hub, {
        settings: store,
        history: new EventEmitter() as unknown as AttemptHistory,
        claude: new EventEmitter() as unknown as ClaudeStatusReporter,
        storage: new EventEmitter() as unknown as AgentStorage,
        updater,
      }),
    );
    const server = await startUiServer({
      port: 0,
      agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
      version: "2.0.3",
      bundleDir: "/nonexistent",
      state: async () => ({}),
      hub,
      routes: updateRoutes({ updater, daemon }),
      token: TOKEN,
      logger: silentLogger(),
    });
    servers.push(server);
    return { server, updater, daemon };
  }

  it("asks the updater to update now, heartbeats at once and publishes update", async () => {
    const { server, updater, daemon } = await start(true);
    const reply = await post(server, {});
    expect(reply.status).toBe(202);
    const request = { version: null, requestedAt: "2026-10-28T10:42:00.000Z" };
    expect(reply.body).toEqual({ request });
    expect(updater.pendingRequest()).toEqual(request);
    expect(daemon.heartbeatSoon).toHaveBeenCalledTimes(1);
    expect(published).toEqual(["update"]);
  });

  it("takes one version to update to", async () => {
    const { server, updater } = await start(true);
    const reply = await post(server, { version: "2.0.4" });
    expect(reply.status).toBe(202);
    expect(updater.pendingRequest()?.version).toBe("2.0.4");
  });

  it("answers 409 when the agent isn't under pm2, requesting nothing", async () => {
    const { server, updater, daemon } = await start(false);
    const reply = await post(server, {});
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: UPDATE_UNSUPPORTED_MESSAGE });
    expect(UPDATE_UNSUPPORTED_MESSAGE).toBe("This agent can't update itself");
    expect(updater.pendingRequest()).toBeNull();
    expect(daemon.heartbeatSoon).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("answers 400 for an invalid body, and 403 for a cross-origin request", async () => {
    const { server, updater } = await start(true);
    const invalid = await post(server, { version: "latest; rm -rf /" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.issues).toEqual([expect.objectContaining({ path: ["version"] })]);
    const extra = await post(server, { force: true });
    expect(extra.status).toBe(400);
    const foreign = await post(server, {}, { origin: "http://evil.example" });
    expect(foreign.status).toBe(403);
    expect(updater.pendingRequest()).toBeNull();
  });
});
