import { EventEmitter } from "node:events";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptHistory } from "../attempts/history.js";
import type { ClaudeStatusReporter } from "../claude-status.js";
import { installablePackageDir, type InstallableInstaller } from "../installables.js";
import { silentLogger } from "../logger.js";
import { InstallHistory } from "../packages/history.js";
import { PackageManager } from "../packages/manager.js";
import { LocalSettingsStore } from "../settings.js";
import type { AgentStorage } from "../storage.js";
import { memorySettingsFs } from "../test/settings-fs.js";
import { UiEventHub } from "./events.js";
import { PACKAGE_INVALID_MESSAGE, packageRoutes } from "./package-routes.js";
import { publishLocalChanges } from "./publish.js";
import { startUiServer, uiCookieName, type UiServer } from "./server.js";
import { settingsRoutes } from "./settings-routes.js";

const TOKEN = "t".repeat(43);
const manifest = { commands: [{ name: "hello", bin: "bin/hello.js" }] };

function send(
  server: UiServer,
  method: "GET" | "POST" | "PUT" | "DELETE",
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path: urlPath,
        headers: {
          host: `127.0.0.1:${server.port}`,
          cookie: `${uiCookieName(server.port)}=${TOKEN}`,
          origin: `http://127.0.0.1:${server.port}`,
          // Node sends a DELETE's body without a length unless told (browsers always do).
          ...(text !== undefined && {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(text),
          }),
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("the packages API", () => {
  let root: string;
  let prefix: string;
  let store: LocalSettingsStore;
  let installs: InstallHistory;
  let hub: UiEventHub;
  let published: { resource: string; ids?: string[] }[];
  let server: UiServer;
  let unpublish: () => void;
  let gate: ReturnType<typeof deferred>;
  let installer: InstallableInstaller;

  async function place(name: string, version: string, extra: Record<string, unknown> = {}) {
    const dir = installablePackageDir(prefix, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version, ...extra }));
    const file = path.join(prefix, "package.json");
    const json = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as {
      dependencies?: Record<string, string>;
    };
    await writeFile(
      file,
      JSON.stringify({ ...json, dependencies: { ...json.dependencies, [name]: version } }),
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-package-routes-"));
    prefix = path.join(root, "installables");
    const memory = memorySettingsFs();
    store = await LocalSettingsStore.open({
      file: "/data/settings.json",
      logger: silentLogger(),
      fs: memory.fs,
    });
    installs = new InstallHistory({ logger: silentLogger() });
    gate = deferred();
    installer = {
      install: vi.fn<InstallableInstaller["install"]>(async (name, version) => {
        await gate.promise;
        if (version === "9.9.9")
          throw Object.assign(new Error("E404"), { output: "npm error 404" });
        await place(name, version === "latest" ? "1.1.0" : version, { omniralph: manifest });
        return `added ${name}`;
      }),
      uninstall: vi.fn<InstallableInstaller["uninstall"]>(async (name) => {
        await rm(installablePackageDir(prefix, name), { recursive: true, force: true });
        return `removed ${name}`;
      }),
    };
    const packages = new PackageManager({
      allowList: () => store.effective().installablesAllow,
      prefix,
      installer,
      history: installs,
      logger: silentLogger(),
    });
    hub = new UiEventHub();
    published = [];
    vi.spyOn(hub, "publish").mockImplementation((resource, change) => {
      published.push({ resource, ...(change?.ids && { ids: change.ids }) });
    });
    // The same wiring as `runAgent`.
    unpublish = publishLocalChanges(hub, {
      settings: store,
      history: new EventEmitter() as unknown as AttemptHistory,
      claude: new EventEmitter() as unknown as ClaudeStatusReporter,
      storage: new EventEmitter() as unknown as AgentStorage,
      installs,
    });
    server = await startUiServer({
      port: 0,
      agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
      version: "2.0.4",
      bundleDir: "/nonexistent",
      state: async () => ({}),
      hub,
      routes: [
        ...settingsRoutes(store),
        ...packageRoutes({ packages, history: installs, logger: silentLogger() }),
      ],
      token: TOKEN,
      logger: silentLogger(),
    });
  });

  afterEach(async () => {
    gate.resolve();
    unpublish();
    await server.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  }

  it("installs: 202 with the queued entry, then packages events as it finishes", async () => {
    expect(await send(server, "GET", "/api/packages")).toEqual({
      status: 200,
      body: { packages: [] },
    });
    const reply = await send(server, "POST", "/api/packages", { name: "@omniralph/hello" });
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({
      name: "@omniralph/hello",
      version: "latest",
      from: "local",
      outcome: null,
    });
    const id = reply.body.id as string;
    expect(published).toEqual([{ resource: "packages", ids: [id] }]);

    gate.resolve();
    await until(() => published.length === 2);
    expect(published[1]).toEqual({ resource: "packages", ids: [id] });
    expect(await send(server, "GET", "/api/packages")).toEqual({
      status: 200,
      body: { packages: [{ name: "@omniralph/hello", version: "1.1.0" }] },
    });
    const history = await send(server, "GET", "/api/packages/history");
    expect(history.body.installs).toEqual([
      expect.objectContaining({ id, outcome: "installed", installedVersion: "1.1.0" }),
    ]);
    expect(history.body.installs as object[]).not.toContainEqual(
      expect.objectContaining({ output: expect.anything() }),
    );
    expect(await send(server, "GET", `/api/packages/history/${id}`)).toEqual({
      status: 200,
      body: expect.objectContaining({ id, output: "added @omniralph/hello" }),
    });
    expect((await send(server, "GET", "/api/packages/history/nope")).status).toBe(404);
  });

  it("records a failed install with npm's output", async () => {
    gate.resolve();
    const reply = await send(server, "POST", "/api/packages", {
      name: "@omniralph/hello",
      version: "9.9.9",
    });
    expect(reply.status).toBe(202);
    await until(() => published.length === 2);
    expect(await send(server, "GET", `/api/packages/history/${reply.body.id as string}`)).toEqual({
      status: 200,
      body: expect.objectContaining({ outcome: "failed", error: "E404", output: "npm error 404" }),
    });
  });

  it("refuses a package the allow-list doesn't match (403) and an invalid body (400)", async () => {
    const refused = await send(server, "POST", "/api/packages", { name: "left-pad" });
    expect(refused).toEqual({
      status: 403,
      body: {
        error:
          "left-pad isn't allowed on this agent (its allow-list in settings.json doesn't match it)",
      },
    });
    for (const body of [
      {},
      { name: "-g" },
      { name: "@omniralph/x", version: "file:/tmp/x" },
      {
        name: "@omniralph/x",
        extra: 1,
      },
    ]) {
      const reply = await send(server, "POST", "/api/packages", body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.body).toEqual({ error: PACKAGE_INVALID_MESSAGE, issues: expect.any(Array) });
    }
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("follows the allow-list saved with PUT /api/settings/allow-list", async () => {
    gate.resolve();
    const saved = await send(server, "PUT", "/api/settings/allow-list", {
      revision: "none",
      allow: ["left-pad"],
    });
    expect(saved.status).toBe(200);
    expect(published).toEqual([{ resource: "settings" }]);
    expect((await send(server, "POST", "/api/packages", { name: "left-pad" })).status).toBe(202);
    // Let the install finish: it writes into the prefix `afterEach` removes.
    await until(() => published.filter((p) => p.resource === "packages").length === 2);
    expect((await send(server, "POST", "/api/packages", { name: "@omniralph/x" })).status).toBe(
      403,
    );

    const none = await send(server, "PUT", "/api/settings/allow-list", {
      revision: saved.body.revision,
      allow: [],
    });
    expect(none.status).toBe(200);
    expect(store.effective().installablesAllow).toEqual([]);
    expect((await send(server, "POST", "/api/packages", { name: "left-pad" })).status).toBe(403);
  });

  it("removes an installed package (202) and 404s one that isn't installed", async () => {
    gate.resolve();
    await place("@omniralph/hello", "1.0.0", { omniralph: manifest });
    const reply = await send(server, "DELETE", "/api/packages/%40omniralph%2Fhello", {});
    expect(reply.status).toBe(202);
    expect(reply.body).toMatchObject({ action: "remove", name: "@omniralph/hello" });
    await until(() => published.length === 2);
    expect(installer.uninstall).toHaveBeenCalledWith("@omniralph/hello", prefix);
    expect(await send(server, "GET", `/api/packages/history/${reply.body.id as string}`)).toEqual({
      status: 200,
      body: expect.objectContaining({ outcome: "removed", output: "removed @omniralph/hello" }),
    });

    expect((await send(server, "DELETE", "/api/packages/@omniralph/hello", {})).status).toBe(404);
    expect((await send(server, "DELETE", "/api/packages/-g", {})).status).toBe(404);
  });
});
