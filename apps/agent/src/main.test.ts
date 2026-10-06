import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

const HEARTBEAT: HeartbeatResponse = {
  maxConcurrency: 1,
  pollIntervalSeconds: 5,
  enabledCapabilities: ["review"],
  pinnedRepoIds: [],
  topics: [],
  queueRegion: "iad1",
  cancelJobIds: [],
  jobTokens: [],
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
        { io, fetch: server.fetch },
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
            capabilities: ["system", "review"],
          },
        },
      ]);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        server: "https://omniralph.example",
        agentId: AGENT_ID,
        refreshToken: "refresh-0",
        workspaceRoot: path.join(homedir(), ".omniralph", "repos"),
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
        { io: capture().io, fetch: server.fetch },
      );
      expect(code).toBe(0);
      const config = JSON.parse(await readFile(configPath, "utf8")) as AgentConfig;
      expect(config.workspaceRoot).toBe(path.join(homedir(), "cache"));
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
        logger: silentLogger(),
        queue: () => ({ receive: async () => ({ ok: false as const, reason: "empty" as const }) }),
        onShutdownSignal: () => {},
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
      });
      const exit = main(["start", "--config", configPath], { io, ...startDeps(server) });
      await vi.waitFor(() => expect(server.calls).toHaveLength(2));
      expect(server.calls.slice(0, 2)).toEqual([
        { path: "/api/agent/token", authorization: null, body: { refreshToken: "refresh-0" } },
        expect.objectContaining({ path: "/api/agent/heartbeat", authorization: "Bearer access-1" }),
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
  });
});
