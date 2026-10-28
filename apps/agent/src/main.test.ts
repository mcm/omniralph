import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HeartbeatResponse } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchFn } from "./api.js";
import { writeConfig, type AgentConfig } from "./config.js";
import { silentLogger } from "./logger.js";
import { main, USAGE, type MainDeps } from "./main.js";
import packageJson from "../package.json" with { type: "json" };
import { AGENT_VERSION } from "./version.js";

const AGENT_ID = "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10";

function capture() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout: (text: string) => void (out.stdout += text),
      stderr: (text: string) => void (out.stderr += text),
    },
  };
}

type Route = (body: unknown, init: RequestInit) => Response | Promise<Response>;

/** A fake control panel: routes by pathname and records every call. */
function fakeServer(routes: Record<string, Route>) {
  const calls: { path: string; body: unknown; authorization: string | null }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ path: url.pathname, body, authorization });
    const route = routes[url.pathname];
    if (!route) return Response.json({ error: "not_found" }, { status: 404 });
    return route(body, init ?? {});
  });
  return { fetch: fetchFn as unknown as FetchFn, fetchMock: fetchFn, calls };
}

/** Holds a claim until the agent aborts it or the request times out, then answers 204. */
const holdClaim: Route = (_body, init) =>
  new Promise((resolve) =>
    init.signal?.addEventListener("abort", () => resolve(new Response(null, { status: 204 }))),
  );

const HEARTBEAT: HeartbeatResponse = {
  pollIntervalSeconds: 5,
  pinnedRepositories: [],
  organizationId: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
  topics: [],
  queueRegion: "iad1",
  cancelJobIds: [],
  jobTokens: [],
  jobMessages: [],
  desiredVersion: null,
  versionPolicy: null,
  requiredHostTools: [],
};

describe("omniralph-agent CLI", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-cli-"));
    configPath = path.join(dir, "omniralph", "agent.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("prints usage with --help", async () => {
    const { out, io } = capture();
    expect(await main(["--help"], { io })).toBe(0);
    expect(out.stdout).toBe(USAGE);
  });

  it("names the agent in its usage, never the old package (outside import) or the AI", () => {
    expect(USAGE).toMatch(/^Usage: omniralph-agent /);
    const importSection = USAGE.slice(USAGE.indexOf("  import "), USAGE.indexOf("  update "));
    expect(importSection).toContain("@omniralph/harness");
    expect(USAGE.replace(importSection, "")).not.toMatch(/harness/i);
    expect(USAGE).not.toMatch(/\bralph\b/i);
  });

  it("lists the agent.json keys, ui among them, and names settings.json for the rest", () => {
    const keys = USAGE.slice(USAGE.indexOf("Local config keys"));
    for (const key of [
      "server",
      "agentId",
      "refreshToken",
      "workspaceRoot",
      "dataDir",
      "blockedExecPaths",
      "ui.enabled",
      "ui.port",
      "ui.allowedHosts",
    ]) {
      expect(keys).toContain(key);
    }
    expect(keys).not.toMatch(/acceptedTaskTypes|installables\.allow/);
    expect(keys).toContain("settings.json");
  });

  it("lists ui and its option in its usage", () => {
    expect(USAGE).toMatch(/^ {2}ui {2,}Print the link to the running agent's page/m);
    expect(USAGE).toContain("--open");
  });

  it("lists import and its options in its usage", () => {
    for (const option of ["import", "--from <file>", "--force", "--dry-run"]) {
      expect(USAGE).toContain(option);
    }
  });

  it("prints the package.json version with --version", async () => {
    const { out, io } = capture();
    expect(await main(["--version"], { io })).toBe(0);
    expect(out.stdout).toBe(`${packageJson.version}\n`);
    expect(AGENT_VERSION).toBe(packageJson.version);
  });

  it("rejects unknown commands and options", async () => {
    const { out, io } = capture();
    expect(await main(["frobnicate"], { io })).toBe(1);
    expect(out.stderr).toContain("unknown command 'frobnicate'");
    expect(await main(["start", "--bogus"], { io })).toBe(1);
    expect(out.stderr).toContain("--bogus");
  });

  describe("enroll", () => {
    it("exchanges the enrollment token and writes the config with mode 0600", async () => {
      const { out, io } = capture();
      const server = fakeServer({
        "/api/agent/enroll": () => Response.json({ agentId: AGENT_ID, refreshToken: "refresh-0" }),
      });
      const code = await main(
        [
          "enroll",
          "--server",
          "https://omniralph.example/",
          "--token",
          "ore_abc",
          "--name",
          "coder-1",
          "--config",
          configPath,
        ],
        { io, fetch: server.fetch, homeDir: dir },
      );
      expect(code).toBe(0);
      expect(server.calls).toEqual([
        {
          path: "/api/agent/enroll",
          authorization: null,
          body: {
            enrollmentToken: "ore_abc",
            name: "coder-1",
            version: AGENT_VERSION,
          },
        },
      ]);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        server: "https://omniralph.example",
        agentId: AGENT_ID,
        refreshToken: "refresh-0",
        workspaceRoot: path.join(dir, ".omniralph", "repos"),
      } satisfies AgentConfig);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect(out.stdout).toContain(AGENT_ID);
      expect(out.stdout).not.toContain("refresh-0");
    });

    it("stores a custom workspace root", async () => {
      const server = fakeServer({
        "/api/agent/enroll": () => Response.json({ agentId: AGENT_ID, refreshToken: "refresh-0" }),
      });
      const code = await main(
        [
          "enroll",
          "--server",
          "http://localhost:3000",
          "--token",
          "t",
          "--workspace-root",
          "~/cache",
          "--config",
          configPath,
        ],
        { io: capture().io, fetch: server.fetch, homeDir: dir },
      );
      expect(code).toBe(0);
      const config = JSON.parse(await readFile(configPath, "utf8")) as AgentConfig;
      expect(config.workspaceRoot).toBe(path.join(dir, "cache"));
      expect(config.server).toBe("http://localhost:3000");
    });

    it("refuses a non-https server except localhost", async () => {
      const { out, io } = capture();
      const server = fakeServer({});
      const code = await main(
        ["enroll", "--server", "http://omniralph.example", "--token", "t", "--config", configPath],
        { io, fetch: server.fetch },
      );
      expect(code).toBe(1);
      expect(out.stderr).toContain("https://");
      expect(server.calls).toEqual([]);
    });

    it("reports an invalid enrollment token", async () => {
      const { out, io } = capture();
      const server = fakeServer({
        "/api/agent/enroll": () => Response.json({ error: "unauthorized" }, { status: 401 }),
      });
      const code = await main(
        ["enroll", "--server", "https://omniralph.example", "--token", "t", "--config", configPath],
        { io, fetch: server.fetch },
      );
      expect(code).toBe(1);
      expect(out.stderr).toContain("invalid, expired or already used");
      await expect(stat(configPath)).rejects.toThrow();
    });
  });

  describe("update", () => {
    it("needs an enrolled agent", async () => {
      const { out, io } = capture();
      expect(await main(["update", "--config", configPath], { io })).toBe(1);
      expect(out.stderr).toContain("run 'omniralph-agent enroll' first");
    });
  });

  // Every call passes a temp `homeDir` so the default never resolves to a real agent's config.
  describe("config path", () => {
    it("defaults to ~/.config/omniralph/agent.json", async () => {
      const { out, io } = capture();
      expect(await main(["update"], { io, env: {}, homeDir: dir })).toBe(1);
      expect(out.stderr).toContain(
        `${path.join(dir, ".config", "omniralph", "agent.json")} not found`,
      );
      expect(USAGE).toContain("~/.config/omniralph/agent.json, or $OMNIRALPH_AGENT_CONFIG");
    });

    it("reads OMNIRALPH_AGENT_CONFIG", async () => {
      const { out, io } = capture();
      const env = { OMNIRALPH_AGENT_CONFIG: configPath };
      expect(await main(["update"], { io, env, homeDir: dir })).toBe(1);
      expect(out.stderr).toContain(`${configPath} not found`);
    });

    it("prefers --config to OMNIRALPH_AGENT_CONFIG", async () => {
      const { out, io } = capture();
      const flagPath = path.join(dir, "flag.json");
      const env = { OMNIRALPH_AGENT_CONFIG: configPath };
      expect(await main(["update", "--config", flagPath], { io, env, homeDir: dir })).toBe(1);
      expect(out.stderr).toContain(`${flagPath} not found`);
      expect(out.stderr).not.toContain(configPath);
    });

    it("never reads the old package's config variable or file", async () => {
      // The pre-rename names, spelled out so the old name stays out of greps for leftovers.
      const legacyName = ["har", "ness"].join("");
      const legacyVar = `OMNIRALPH_${legacyName.toUpperCase()}_CONFIG`;
      const legacyPath = path.join(dir, ".config", "omniralph", `${legacyName}.json`);
      await writeConfig(legacyPath, {
        server: "https://omniralph.example",
        agentId: AGENT_ID,
        refreshToken: "refresh-0",
        workspaceRoot: "/tmp/repos",
      });
      const { out, io } = capture();
      expect(await main(["update"], { io, env: { [legacyVar]: legacyPath }, homeDir: dir })).toBe(
        1,
      );
      expect(out.stderr).not.toContain(legacyPath);
      expect(out.stderr).toContain(
        `${path.join(dir, ".config", "omniralph", "agent.json")} not found`,
      );
    });
  });

  describe("start", () => {
    const config: AgentConfig = {
      server: "https://omniralph.example",
      agentId: AGENT_ID,
      refreshToken: "refresh-0",
      workspaceRoot: "/tmp/repos",
    };

    function startDeps(server: ReturnType<typeof fakeServer>, extra: Partial<MainDeps> = {}) {
      return {
        fetch: server.fetch,
        // Not under pm2, whatever runs the tests.
        env: {},
        // The data directory (settings.json) under the temp dir, never the real one.
        homeDir: dir,
        logger: silentLogger(),
        onShutdownSignal: () => {},
        // Never the machine's real 7410.
        uiPort: 0,
        readClaude: async () => ({
          models: [{ value: "opus", displayName: "Opus", description: "" }],
          account: { email: "agent@example.com", apiProvider: "firstParty" as const },
        }),
        ...extra,
      };
    }

    it("refuses to start when the config file is readable by group or others", async () => {
      await writeConfig(configPath, config);
      await chmod(configPath, 0o644);
      const { out, io } = capture();
      const server = fakeServer({});
      expect(await main(["start", "--config", configPath], { io, ...startDeps(server) })).toBe(1);
      expect(out.stderr).toContain("accessible by group or others");
      expect(server.calls).toEqual([]);
    });

    it("refuses to start, calling nothing, when settings.json isn't valid", async () => {
      await writeConfig(configPath, config);
      const settings = path.join(dir, ".omniralph", "settings.json");
      await mkdir(path.dirname(settings), { recursive: true });
      await writeFile(settings, JSON.stringify({ v: 1, maxConcurrency: 0 }), { mode: 0o600 });
      const { out, io } = capture();
      const server = fakeServer({});
      expect(await main(["start", "--config", configPath], { io, ...startDeps(server) })).toBe(1);
      expect(out.stderr).toContain(`${settings} isn't valid: maxConcurrency`);
      expect(server.calls).toEqual([]);
    });

    it("refuses to start with a key that moved to settings.json", async () => {
      await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      await writeFile(
        configPath,
        JSON.stringify({ ...config, installables: { allow: ["@acme/*"] } }),
        { mode: 0o600 },
      );
      const { out, io } = capture();
      const server = fakeServer({});
      expect(await main(["start", "--config", configPath], { io, ...startDeps(server) })).toBe(1);
      expect(out.stderr).toContain("installables moved to settings.json");
      expect(server.calls).toEqual([]);
    });

    it("exits non-zero when /token rejects the refresh token at startup", async () => {
      await writeConfig(configPath, config);
      const { out, io } = capture();
      const server = fakeServer({
        "/api/agent/token": () => Response.json({ error: "unauthorized" }, { status: 401 }),
      });
      expect(await main(["start", "--config", configPath], { io, ...startDeps(server) })).toBe(1);
      expect(out.stderr).toContain("re-enrollment required");
      expect(server.calls.map((c) => c.path)).toEqual(["/api/agent/token"]);
    });

    it("runs with rotating tokens and exits non-zero once /token returns 401", async () => {
      vi.useFakeTimers();
      await writeConfig(configPath, config);
      const { out, io } = capture();
      let n = 0;
      const server = fakeServer({
        "/api/agent/token": () => {
          n++;
          return n === 1
            ? Response.json({ accessToken: "access-1", expiresIn: 900, refreshToken: "refresh-1" })
            : Response.json({ error: "refresh_token_reused" }, { status: 401 });
        },
        "/api/agent/heartbeat": () => Response.json(HEARTBEAT),
        "/api/agent/claim": holdClaim,
      });
      const exit = main(["start", "--config", configPath], { io, ...startDeps(server) });
      await vi.waitFor(() => expect(server.calls).toHaveLength(3));
      expect(server.calls).toEqual([
        { path: "/api/agent/token", authorization: null, body: { refreshToken: "refresh-0" } },
        expect.objectContaining({
          path: "/api/agent/heartbeat",
          authorization: "Bearer access-1",
        }),
        {
          path: "/api/agent/claim",
          authorization: "Bearer access-1",
          body: { pools: ["short", "long"], acceptedTaskTypes: ["query", "review", "coding"] },
        },
      ]);
      expect(JSON.parse(await readFile(configPath, "utf8")).refreshToken).toBe("refresh-1");

      await vi.advanceTimersByTimeAsync(720_000);
      await vi.waitFor(() => expect(out.stderr).toContain("re-enrollment required"));
      expect(await exit).toBe(1);
      expect(out.stderr).toContain("re-enrollment required (refresh_token_reused)");
      expect(server.calls.filter((c) => c.path === "/api/agent/token").at(-1)?.body).toEqual({
        refreshToken: "refresh-1",
      });
      // Nothing is called after the fatal 401.
      const calls = server.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(server.calls.length).toBe(calls);
    });

    it("stops gracefully on the shutdown signal", async () => {
      await writeConfig(configPath, config);
      let signal!: () => void;
      const server = fakeServer({
        "/api/agent/token": () =>
          Response.json({ accessToken: "a", expiresIn: 900, refreshToken: "refresh-1" }),
        "/api/agent/heartbeat": () => Response.json(HEARTBEAT),
      });
      const exit = main(["start", "--config", configPath], {
        io: capture().io,
        ...startDeps(server, { onShutdownSignal: (handler) => (signal = handler) }),
      });
      await vi.waitFor(() =>
        expect(server.calls.map((c) => c.path)).toContain("/api/agent/heartbeat"),
      );
      signal();
      expect(await exit).toBe(0);
    });

    it("under pm2, updates to the desired version and exits so pm2 restarts it", async () => {
      await writeConfig(configPath, config);
      const installs: string[] = [];
      const server = fakeServer({
        "/api/agent/token": () =>
          Response.json({ accessToken: "a", expiresIn: 900, refreshToken: "refresh-1" }),
        "/api/agent/heartbeat": () => Response.json({ ...HEARTBEAT, desiredVersion: "9.9.9" }),
      });
      const exit = main(["start", "--config", configPath], {
        io: capture().io,
        ...startDeps(server, {
          env: { pm_id: "3" },
          version: "1.0.0",
          installer: { install: async (version) => void installs.push(version) },
        }),
      });
      expect(await exit).toBe(0);
      expect(installs).toEqual(["9.9.9"]);
      const statePath = path.join(path.dirname(configPath), "update-state.json");
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        previous: "1.0.0",
        pending: "9.9.9",
        startsSincePending: 0,
        failed: [],
      });
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect(server.calls.find((c) => c.path === "/api/agent/heartbeat")?.body).toMatchObject({
        version: "1.0.0",
        selfUpdate: "supported",
        models: [{ value: "opus", displayName: "Opus" }],
        claude: { status: "signed_in", source: "login", checkedAt: expect.any(String) },
      });
      // The account never leaves the machine.
      expect(
        JSON.stringify(server.calls.find((c) => c.path === "/api/agent/heartbeat")?.body),
      ).not.toContain("agent@example.com");
    });

    it("under pm2, updates to the version pinned in settings.json over the organization's", async () => {
      await writeConfig(configPath, config);
      await mkdir(path.join(dir, ".omniralph"), { recursive: true });
      await writeFile(
        path.join(dir, ".omniralph", "settings.json"),
        JSON.stringify({ v: 1, update: { pin: "2.0.3" } }),
        { mode: 0o600 },
      );
      const installs: string[] = [];
      const server = fakeServer({
        "/api/agent/token": () =>
          Response.json({ accessToken: "a", expiresIn: 900, refreshToken: "refresh-1" }),
        "/api/agent/heartbeat": () => Response.json({ ...HEARTBEAT, desiredVersion: "9.9.9" }),
      });
      const exit = main(["start", "--config", configPath], {
        io: capture().io,
        ...startDeps(server, {
          env: { pm_id: "3" },
          version: "2.0.0",
          installer: { install: async (version) => void installs.push(version) },
        }),
      });
      expect(await exit).toBe(0);
      expect(installs).toEqual(["2.0.3"]);
      expect(server.calls.find((c) => c.path === "/api/agent/heartbeat")?.body).toMatchObject({
        local: { versionPin: "2.0.3" },
      });
    });

    it("acts on 'omniralph-agent update': retries a failed desired version", async () => {
      await writeConfig(configPath, config);
      const statePath = path.join(path.dirname(configPath), "update-state.json");
      await writeFile(statePath, JSON.stringify({ failed: ["9.9.9"] }));
      const requestPath = path.join(path.dirname(configPath), "update-request.json");

      const { out, io } = capture();
      expect(await main(["update", "--config", configPath], { io })).toBe(0);
      expect(out.stdout).toContain("Update requested");
      expect((await stat(requestPath)).mode & 0o777).toBe(0o600);

      const installs: string[] = [];
      const server = fakeServer({
        "/api/agent/token": () =>
          Response.json({ accessToken: "a", expiresIn: 900, refreshToken: "refresh-1" }),
        "/api/agent/heartbeat": () => Response.json({ ...HEARTBEAT, desiredVersion: "9.9.9" }),
      });
      const exit = main(["start", "--config", configPath], {
        io: capture().io,
        ...startDeps(server, {
          env: { pm_id: "3" },
          version: "1.0.0",
          installer: { install: async (version) => void installs.push(version) },
        }),
      });
      expect(await exit).toBe(0);
      expect(installs).toEqual(["9.9.9"]);
      await expect(stat(requestPath)).rejects.toThrow();
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        pending: "9.9.9",
        failed: [],
      });
    });

    it("rolls back on start after a new version failed to stay up 3 times", async () => {
      await writeConfig(configPath, config);
      const statePath = path.join(path.dirname(configPath), "update-state.json");
      await writeFile(
        statePath,
        JSON.stringify({ previous: "1.0.0", pending: "9.9.9", startsSincePending: 3, failed: [] }),
      );
      const installs: string[] = [];
      const server = fakeServer({});
      const code = await main(["start", "--config", configPath], {
        io: capture().io,
        ...startDeps(server, {
          env: { pm_id: "3" },
          version: "9.9.9",
          installer: { install: async (version) => void installs.push(version) },
        }),
      });
      expect(code).toBe(0);
      expect(installs).toEqual(["1.0.0"]);
      expect(server.calls).toEqual([]);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        pending: null,
        failed: ["9.9.9"],
      });
    });
  });
  describe("agent page", () => {
    const config: AgentConfig = {
      server: "https://omniralph.example",
      agentId: AGENT_ID,
      refreshToken: "refresh-0",
      workspaceRoot: "/tmp/repos",
    };
    const NOT_RUNNING = "The agent isn't running. Start it with 'omniralph-agent start'.\n";

    function controlPanel() {
      return fakeServer({
        "/api/agent/token": () =>
          Response.json({ accessToken: "a", expiresIn: 900, refreshToken: "refresh-1" }),
        "/api/agent/heartbeat": () => Response.json(HEARTBEAT),
        "/api/agent/claim": holdClaim,
      });
    }

    /** Starts the agent; resolves once ui.json is there. */
    async function startAgent(extra: Partial<MainDeps> = {}) {
      let signal!: () => void;
      const server = controlPanel();
      const exit = main(["start", "--config", configPath], {
        io: capture().io,
        fetch: server.fetch,
        env: {},
        homeDir: dir,
        logger: silentLogger(),
        onShutdownSignal: (handler) => (signal = handler),
        readClaude: async () => ({ models: [], account: {} }),
        uiPort: 0,
        uiBundleDir: path.join(dir, "no-bundle"),
        ...extra,
      });
      await vi.waitFor(async () => expect((await stat(uiJson())).isFile()).toBe(true));
      // ui.json is written just before the shutdown handler is registered.
      await vi.waitFor(() => expect(signal).toBeTypeOf("function"));
      return { exit, stop: () => signal(), server };
    }

    const uiJson = () => path.join(path.dirname(configPath), "ui.json");

    it("serves on 127.0.0.1, writes a 0600 ui.json and removes it on shutdown", async () => {
      await writeConfig(configPath, config);
      const agent = await startAgent();
      expect((await stat(uiJson())).mode & 0o777).toBe(0o600);
      const link = JSON.parse(await readFile(uiJson(), "utf8"));
      expect(link).toEqual({
        pid: process.pid,
        port: expect.any(Number),
        url: `http://127.0.0.1:${link.port}`,
        startedAt: expect.any(String),
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(Buffer.from(link.token, "base64url")).toHaveLength(32);

      // The page's API answers with the cookie; without the bundle, HTML is 503.
      const headers = { cookie: `omniralph_agent_${link.port}=${link.token}` };
      const ping = await fetch(`${link.url}/api/ping`, { headers });
      expect(await ping.json()).toEqual({ agentId: AGENT_ID, version: AGENT_VERSION });
      const state = await (await fetch(`${link.url}/api/state`, { headers })).json();
      expect(state).toMatchObject({
        agent: { agentId: AGENT_ID, server: "https://omniralph.example" },
        settings: { revision: "none", lastError: null, effective: { maxConcurrency: 5 } },
        connection: { revoked: false },
        problems: expect.any(Array),
      });
      expect((await fetch(`${link.url}/`, { headers })).status).toBe(503);
      expect((await fetch(`${link.url}/api/ping`)).status).toBe(401);

      agent.stop();
      expect(await agent.exit).toBe(0);
      await expect(stat(uiJson())).rejects.toThrow();
      await expect(fetch(`${link.url}/api/ping`, { headers })).rejects.toThrow();
    });

    it("installs and removes a package from the page, reporting it in a heartbeat at once", async () => {
      await writeConfig(configPath, config);
      const prefix = path.join(dir, ".omniralph", "installables");
      const dependencies = async (deps: Record<string, string>) =>
        writeFile(
          path.join(prefix, "package.json"),
          JSON.stringify({ name: "omniralph-installables", private: true, dependencies: deps }),
        );
      // An npm that "installs" a valid installable.
      const installableInstaller: MainDeps["installableInstaller"] = {
        install: async (name, version) => {
          const pkgDir = path.join(prefix, "node_modules", ...name.split("/"));
          await mkdir(pkgDir, { recursive: true });
          const installed = version === "latest" ? "1.0.0" : version;
          await writeFile(
            path.join(pkgDir, "package.json"),
            JSON.stringify({ name, version: installed, omniralph: {} }),
          );
          await dependencies({ [name]: installed });
          return `added ${name}@${installed}`;
        },
        uninstall: async (name) => {
          await rm(path.join(prefix, "node_modules", ...name.split("/")), { recursive: true });
          await dependencies({});
          return `removed ${name}`;
        },
      };
      const agent = await startAgent({ installableInstaller });
      const link = JSON.parse(await readFile(uiJson(), "utf8"));
      const headers = {
        cookie: `omniralph_agent_${link.port}=${link.token}`,
        origin: link.url,
        "content-type": "application/json",
      };
      const reported = () =>
        agent.server.calls
          .filter((call) => call.path === "/api/agent/heartbeat")
          .map((call) => (call.body as { installables: unknown }).installables);
      // The first heartbeat went out before anything was installed.
      await vi.waitFor(() => expect(reported()).toEqual([[]]));

      const reply = await fetch(`${link.url}/api/packages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "@omniralph/hello" }),
      });
      expect(reply.status).toBe(202);
      const queued = (await reply.json()) as { id: string };
      // Long before the 5 s interval: the install heartbeats at once.
      await vi.waitFor(() =>
        expect(reported().at(-1)).toEqual([{ name: "@omniralph/hello", version: "1.0.0" }]),
      );
      const entry = await (
        await fetch(`${link.url}/api/packages/history/${queued.id}`, { headers })
      ).json();
      expect(entry).toMatchObject({
        from: "local",
        outcome: "installed",
        output: "added @omniralph/hello@1.0.0",
      });

      const removal = await fetch(`${link.url}/api/packages/%40omniralph%2Fhello`, {
        method: "DELETE",
        headers,
        body: "{}",
      });
      expect(removal.status).toBe(202);
      await vi.waitFor(() => expect(reported().at(-1)).toEqual([]));

      agent.stop();
      expect(await agent.exit).toBe(0);
      // The history survives the restart.
      const saved = JSON.parse(
        await readFile(path.join(dir, ".omniralph", "state", "installs.json"), "utf8"),
      ) as { installs: { outcome: string }[] };
      expect(saved.installs.map((install) => install.outcome)).toEqual(["removed", "installed"]);
    });

    it("serves on ui.port and makes a new token at every start", async () => {
      const free = await new Promise<number>((resolve) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const { port } = probe.address() as AddressInfo;
          probe.close(() => resolve(port));
        });
      });
      await writeConfig(configPath, { ...config, ui: { port: free } });
      const first = await startAgent({ uiPort: undefined });
      const firstLink = JSON.parse(await readFile(uiJson(), "utf8"));
      expect(firstLink.port).toBe(free);
      first.stop();
      await first.exit;

      const second = await startAgent({ uiPort: undefined });
      const secondLink = JSON.parse(await readFile(uiJson(), "utf8"));
      expect(secondLink.port).toBe(free);
      expect(secondLink.token).not.toBe(firstLink.token);
      second.stop();
      await second.exit;
    });

    it("serves nothing with ui.enabled false", async () => {
      await writeConfig(configPath, { ...config, ui: { enabled: false } });
      let signal!: () => void;
      const server = controlPanel();
      const exit = main(["start", "--config", configPath], {
        io: capture().io,
        fetch: server.fetch,
        env: {},
        homeDir: dir,
        logger: silentLogger(),
        onShutdownSignal: (handler) => (signal = handler),
        readClaude: async () => ({ models: [], account: {} }),
        uiPort: 0,
      });
      await vi.waitFor(() =>
        expect(server.calls.map((c) => c.path)).toContain("/api/agent/heartbeat"),
      );
      await expect(stat(uiJson())).rejects.toThrow();
      signal();
      expect(await exit).toBe(0);
    });

    it("ui prints the running agent's link, and opens it with --open", async () => {
      await writeConfig(configPath, config);
      const agent = await startAgent();
      const link = JSON.parse(await readFile(uiJson(), "utf8"));

      const { out, io } = capture();
      expect(await main(["ui", "--config", configPath], { io })).toBe(0);
      expect(out.stdout).toBe(`Agent page: ${link.url}/?token=${link.token}\n`);

      const opened: string[] = [];
      const opening = capture();
      expect(
        await main(["ui", "--open", "--config", configPath], {
          io: opening.io,
          openUrl: async (url) => void opened.push(url),
        }),
      ).toBe(0);
      expect(opened).toEqual([`${link.url}/?token=${link.token}`]);
      expect(opening.out.stdout).toBe(out.stdout);

      // The link works: it trades the token for the cookie.
      const reply = await fetch(`${link.url}/?token=${link.token}`, { redirect: "manual" });
      expect(reply.status).toBe(303);
      expect(reply.headers.get("set-cookie")).toContain(`omniralph_agent_${link.port}=`);

      // A failing opener still prints the link.
      const failing = capture();
      expect(
        await main(["ui", "--open", "--config", configPath], {
          io: failing.io,
          openUrl: async () => {
            throw new Error("spawn xdg-open ENOENT");
          },
        }),
      ).toBe(0);
      expect(failing.out.stdout).toContain("Agent page: ");
      expect(failing.out.stderr).toContain("couldn't open a browser (spawn xdg-open ENOENT)");

      agent.stop();
      await agent.exit;
    });

    it("ui says the agent isn't running without ui.json", async () => {
      await writeConfig(configPath, config);
      const { out, io } = capture();
      const opened: string[] = [];
      expect(
        await main(["ui", "--open", "--config", configPath], {
          io,
          openUrl: async (url) => void opened.push(url),
        }),
      ).toBe(1);
      expect(out.stderr).toBe(NOT_RUNNING);
      expect(out.stdout).toBe("");
      expect(opened).toEqual([]);
    });

    it("ui says the agent isn't running when ui.json's process is gone", async () => {
      await writeConfig(configPath, config);
      const agent = await startAgent();
      const { out, io } = capture();
      expect(await main(["ui", "--config", configPath], { io, processAlive: () => false })).toBe(1);
      expect(out.stderr).toBe(NOT_RUNNING);
      agent.stop();
      await agent.exit;
    });

    it("ui says the agent isn't running when nothing, or another agent, answers there", async () => {
      await writeConfig(configPath, config);
      const agent = await startAgent();
      const link = JSON.parse(await readFile(uiJson(), "utf8"));
      agent.stop();
      await agent.exit;

      // A stale ui.json (the agent was killed): nothing listens on its port any more.
      await writeFile(uiJson(), JSON.stringify(link), { mode: 0o600 });
      const stale = capture();
      expect(await main(["ui", "--config", configPath], { io: stale.io })).toBe(1);
      expect(stale.out.stderr).toBe(NOT_RUNNING);

      // Another agent's page.
      await rm(uiJson());
      await writeConfig(configPath, { ...config, agentId: "another-agent" });
      const other = await startAgent();
      const otherLink = JSON.parse(await readFile(uiJson(), "utf8"));
      await writeConfig(configPath, config);
      const mismatch = capture();
      expect(await main(["ui", "--config", configPath], { io: mismatch.io })).toBe(1);
      expect(mismatch.out.stderr).toBe(NOT_RUNNING);
      expect(otherLink.pid).toBe(process.pid);
      other.stop();
      await other.exit;

      // An unreadable ui.json.
      await writeFile(uiJson(), "{not json", { mode: 0o600 });
      const broken = capture();
      expect(await main(["ui", "--config", configPath], { io: broken.io })).toBe(1);
      expect(broken.out.stderr).toBe(NOT_RUNNING);
    });
  });
});
