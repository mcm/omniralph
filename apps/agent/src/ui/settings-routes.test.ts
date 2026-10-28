import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptHistory } from "../attempts/history.js";
import type { ClaudeStatusReporter } from "../claude-status.js";
import { silentLogger } from "../logger.js";
import { LocalSettingsStore } from "../settings.js";
import type { AgentStorage } from "../storage.js";
import { memorySettingsFs } from "../test/settings-fs.js";
import { UiEventHub } from "./events.js";
import type { DaemonHostTools } from "../daemon.js";
import { heartbeatPublisher, publishLocalChanges } from "./publish.js";
import { startUiServer, uiCookieName, type UiServer } from "./server.js";
import {
  SETTINGS_CONFLICT_MESSAGE,
  SETTINGS_INVALID_MESSAGE,
  settingsRoutes,
} from "./settings-routes.js";

const FILE = "/data/settings.json";
const TOKEN = "t".repeat(43);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function put(
  server: UiServer,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "PUT",
        path,
        headers: {
          host: `127.0.0.1:${server.port}`,
          cookie: `${uiCookieName(server.port)}=${TOKEN}`,
          origin: `http://127.0.0.1:${server.port}`,
          "content-type": "application/json",
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

describe("PUT /api/settings/{section}", () => {
  let memory: ReturnType<typeof memorySettingsFs>;
  let store: LocalSettingsStore;
  let hub: UiEventHub;
  let published: string[];
  let server: UiServer;
  let unpublish: () => void;

  beforeEach(async () => {
    memory = memorySettingsFs();
    store = await LocalSettingsStore.open({ file: FILE, logger: silentLogger(), fs: memory.fs });
    hub = new UiEventHub();
    published = [];
    vi.spyOn(hub, "publish").mockImplementation((resource) => void published.push(resource));
    // The same wiring as `runAgent`: a store change is the page's `settings` event.
    unpublish = publishLocalChanges(hub, {
      settings: store,
      history: new EventEmitter() as unknown as AttemptHistory,
      claude: new EventEmitter() as unknown as ClaudeStatusReporter,
      storage: new EventEmitter() as unknown as AgentStorage,
    });
    server = await startUiServer({
      port: 0,
      agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
      version: "2.0.4",
      bundleDir: "/nonexistent",
      state: async () => ({}),
      hub,
      routes: settingsRoutes(store),
      token: TOKEN,
      logger: silentLogger(),
    });
  });

  afterEach(async () => {
    unpublish();
    await server.close();
    await store.close();
  });

  it("saves slots and pool limits and answers the new settings and revision", async () => {
    const reply = await put(server, "/api/settings/capacity", {
      revision: "none",
      maxConcurrency: 3,
      poolLimits: { long: 2, short: null },
    });
    expect(reply.status).toBe(200);
    const text = memory.files.get(FILE)!;
    expect(JSON.parse(text)).toEqual({ v: 1, maxConcurrency: 3, poolLimits: { long: 2 } });
    expect(reply.body).toEqual({
      settings: { v: 1, maxConcurrency: 3, poolLimits: { long: 2 } },
      effective: expect.objectContaining({ maxConcurrency: 3, poolLimits: { long: 2, short: 3 } }),
      revision: sha256(text),
      lastError: null,
    });
    expect(store.effective().maxConcurrency).toBe(3);
    expect(published).toEqual(["settings"]);
  });

  it("puts left-out capacity values back to their defaults", async () => {
    const first = await put(server, "/api/settings/capacity", {
      revision: "none",
      maxConcurrency: 3,
      poolLimits: { short: 2 },
    });
    const reply = await put(server, "/api/settings/capacity", { revision: first.body.revision });
    expect(reply.status).toBe(200);
    expect(reply.body.settings).toEqual({ v: 1 });
    expect(store.effective().maxConcurrency).toBe(5);
    expect(published).toEqual(["settings", "settings"]);
  });

  it("saves the accepted kinds", async () => {
    const reply = await put(server, "/api/settings/kinds", {
      revision: "none",
      acceptedTaskTypes: ["coding", "review"],
    });
    expect(reply.status).toBe(200);
    expect(reply.body.settings).toEqual({ v: 1, acceptedTaskTypes: ["coding", "review"] });
    expect(store.effective().acceptedTaskTypes).toEqual(["review", "coding"]);
    expect(published).toEqual(["settings"]);

    const all = await put(server, "/api/settings/kinds", { revision: reply.body.revision });
    expect(all.status).toBe(200);
    expect(store.effective().acceptedTaskTypes).toEqual(["query", "review", "coding"]);
    expect(published).toEqual(["settings", "settings"]);
  });

  it("saves the whole host tools map, and the next heartbeat's check is a host_tools event", async () => {
    // The daemon re-checks in the heartbeat a settings change sends (here by hand).
    let checked: DaemonHostTools = { tools: [], required: ["gh"] };
    const daemon = { pinnedRepositories: () => [], hostToolsState: () => checked };
    const heartbeat = heartbeatPublisher(hub, daemon);
    const onChange = () => {
      checked = {
        required: ["gh"],
        tools: Object.entries(store.effective().hostTools).map(([name, path]) => ({
          name,
          path,
          source: "configured" as const,
          problem: null,
          checkedPath: path,
          required: name === "gh",
        })),
      };
      heartbeat();
    };
    store.on("change", onChange);

    const reply = await put(server, "/api/settings/host-tools", {
      revision: "none",
      hostTools: { gh: "/opt/gh/bin/gh", opengrep: "/usr/local/bin/opengrep" },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.settings).toEqual({
      v: 1,
      hostTools: { gh: "/opt/gh/bin/gh", opengrep: "/usr/local/bin/opengrep" },
    });
    expect(store.effective().hostTools).toEqual({
      gh: "/opt/gh/bin/gh",
      opengrep: "/usr/local/bin/opengrep",
    });
    expect(published).toEqual(["settings", "status", "update", "host_tools"]);

    // "Use PATH": the whole map without the tool.
    const cleared = await put(server, "/api/settings/host-tools", {
      revision: reply.body.revision,
      hostTools: { opengrep: "/usr/local/bin/opengrep" },
    });
    expect(cleared.status).toBe(200);
    expect(store.effective().hostTools).toEqual({ opengrep: "/usr/local/bin/opengrep" });
    expect(published.filter((resource) => resource === "host_tools")).toHaveLength(2);
    store.off("change", onChange);
  });

  it("saves and clears the version pin", async () => {
    const reply = await put(server, "/api/settings/version", { revision: "none", pin: "2.0.3" });
    expect(reply.status).toBe(200);
    expect(reply.body.settings).toEqual({ v: 1, update: { pin: "2.0.3" } });
    expect(store.effective().versionPin).toBe("2.0.3");
    const cleared = await put(server, "/api/settings/version", {
      revision: reply.body.revision,
      pin: null,
    });
    expect(cleared.status).toBe(200);
    expect(store.effective().versionPin).toBeNull();
    expect(published).toEqual(["settings", "settings"]);
  });

  it("answers 409 with the current settings for a stale revision, writing nothing", async () => {
    memory.handEdit(FILE, `{"v":1,"maxConcurrency":8}`);
    for (const [path, body] of [
      ["/api/settings/capacity", { revision: "none", maxConcurrency: 2 }],
      ["/api/settings/kinds", { revision: "none", acceptedTaskTypes: ["review"] }],
      ["/api/settings/host-tools", { revision: "none", hostTools: { gh: "/usr/bin/gh" } }],
      ["/api/settings/version", { revision: "none", pin: "2.0.3" }],
    ] as const) {
      const reply = await put(server, path, body);
      expect(reply.status).toBe(409);
      expect(reply.body).toEqual({
        error: SETTINGS_CONFLICT_MESSAGE,
        settings: expect.objectContaining({
          settings: { v: 1, maxConcurrency: 8 },
          revision: sha256(`{"v":1,"maxConcurrency":8}`),
        }),
      });
    }
    expect(memory.files.get(FILE)).toBe(`{"v":1,"maxConcurrency":8}`);
  });

  it("answers 400 with issues for invalid input, writing nothing", async () => {
    const cases = [
      [
        "/api/settings/capacity",
        { revision: "none", maxConcurrency: 33 },
        [{ path: ["maxConcurrency"], message: expect.any(String) }],
      ],
      [
        "/api/settings/capacity",
        { revision: "none", maxConcurrency: 2, poolLimits: { long: 3 } },
        [{ path: ["poolLimits", "long"], message: "must be at most maxConcurrency (2)" }],
      ],
      [
        "/api/settings/capacity",
        { revision: "none", slots: 2 },
        [expect.objectContaining({ message: expect.any(String) })],
      ],
      [
        "/api/settings/kinds",
        { revision: "none", acceptedTaskTypes: [] },
        [{ path: ["acceptedTaskTypes"], message: expect.any(String) }],
      ],
      [
        "/api/settings/kinds",
        { revision: "none", acceptedTaskTypes: ["system"] },
        [expect.objectContaining({ path: ["acceptedTaskTypes", 0] })],
      ],
      [
        "/api/settings/kinds",
        { acceptedTaskTypes: ["review"] },
        [expect.objectContaining({ path: ["revision"] })],
      ],
      [
        "/api/settings/host-tools",
        { revision: "none", hostTools: { gh: "bin/gh" } },
        [{ path: ["hostTools", "gh"], message: "must be an absolute path" }],
      ],
      [
        "/api/settings/host-tools",
        { revision: "none", hostTools: { "not a name": "/usr/bin/x" } },
        [expect.objectContaining({ path: ["hostTools", "not a name"] })],
      ],
      [
        "/api/settings/version",
        { revision: "none", pin: "1.9.0" },
        [{ path: ["pin"], message: "must be 2.0.0 or later" }],
      ],
      [
        "/api/settings/version",
        { revision: "none", pin: "latest" },
        [expect.objectContaining({ path: ["pin"] }), expect.objectContaining({ path: ["pin"] })],
      ],
    ] as const;
    for (const [path, body, issues] of cases) {
      const reply = await put(server, path, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.body).toEqual({ error: SETTINGS_INVALID_MESSAGE, issues });
    }
    expect(memory.files.has(FILE)).toBe(false);
    expect(published).toEqual([]);
  });
});
