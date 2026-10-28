import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AccountInfo, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { REPO_SYNC_JOB_TYPE } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptChange, AttemptHistory, AttemptRecord } from "../attempts/history.js";
import { ClaudeStatusReporter, type ClaudeRead } from "../claude-status.js";
import { silentLogger } from "../logger.js";
import { LocalSettingsStore } from "../settings.js";
import { AgentStorage } from "../storage.js";
import { memorySettingsFs } from "../test/settings-fs.js";
import { UiEventHub } from "./events.js";
import { claudeRoutes, storageRoutes, type StorageState } from "./machine-routes.js";
import { publishLocalChanges } from "./publish.js";
import { startUiServer, uiCookieName, type UiServer } from "./server.js";

const TOKEN = "t".repeat(43);
const NOW = Date.parse("2026-10-28T10:42:00.000Z");
const GB = 1024 ** 3;

function send(
  server: UiServer,
  method: "GET" | "POST",
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = method === "POST" ? "{}" : "";
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path: pathname,
        headers: {
          host: `127.0.0.1:${server.port}`,
          cookie: `${uiCookieName(server.port)}=${TOKEN}`,
          ...(method === "POST" && {
            origin: `http://127.0.0.1:${server.port}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(text)),
          }),
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

const MODELS: ModelInfo[] = [
  { value: "opus", displayName: "Opus 5.5", description: "" },
  { value: "sonnet", displayName: "Sonnet 5.5", description: "" },
];

const ACCOUNT: AccountInfo = {
  email: "steve@example.com",
  organization: "Example",
  subscriptionType: "max",
  apiProvider: "firstParty",
};

describe("the Claude and Storage routes", () => {
  let dir: string;
  let store: LocalSettingsStore;
  let hub: UiEventHub;
  let published: { resource: string; ids?: string[] }[];
  let servers: UiServer[];
  let unpublish: (() => void)[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-machine-routes-"));
    store = await LocalSettingsStore.open({
      file: "/data/settings.json",
      logger: silentLogger(),
      fs: memorySettingsFs().fs,
    });
    hub = new UiEventHub();
    published = [];
    vi.spyOn(hub, "publish").mockImplementation((resource, change) => {
      published.push({ resource, ...(change?.ids && { ids: change.ids }) });
    });
    servers = [];
    unpublish = [];
  });

  afterEach(async () => {
    for (const stop of unpublish) stop();
    for (const server of servers) await server.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(
    options: {
      read?: (signal: AbortSignal) => Promise<ClaudeRead>;
      statfs?: () => Promise<{ bsize: number; blocks: number; bavail: number }>;
      pinned?: { provider: "github" | "gitlab"; fullPath: string }[];
    } = {},
  ) {
    let now = NOW;
    const claude = new ClaudeStatusReporter({
      read: options.read ?? (async () => ({ models: MODELS, account: ACCOUNT })),
      logger: silentLogger(),
      now: () => now,
    });
    const history = new EventEmitter() as EventEmitter & {
      recent(): AttemptRecord[];
    };
    const recent: AttemptRecord[] = [];
    history.recent = () => recent;
    const workspaceRoot = path.join(dir, "repos");
    const dataDir = path.join(dir, "data");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const storage = new AgentStorage({
      workspaceRoot,
      dataDir,
      history: history as unknown as AttemptHistory,
      pinned: () => options.pinned ?? [],
      statfs:
        options.statfs ??
        (async () => ({ bsize: 4096, blocks: (500 * GB) / 4096, bavail: (120 * GB) / 4096 })),
      logger: silentLogger(),
    });
    // The same wiring as `runAgent`.
    unpublish.push(
      publishLocalChanges(hub, {
        settings: store,
        history: history as unknown as AttemptHistory,
        claude,
        storage,
      }),
    );
    const server = await startUiServer({
      port: 0,
      agentId: "0b6f5e0e-8a52-4a4b-9a43-6e8e0c1f9b10",
      version: "2.0.3",
      bundleDir: "/nonexistent",
      state: async () => ({}),
      hub,
      routes: [...claudeRoutes(claude), ...storageRoutes({ storage, logger: silentLogger() })],
      token: TOKEN,
      logger: silentLogger(),
    });
    servers.push(server);
    return {
      server,
      claude,
      storage,
      history,
      recent,
      workspaceRoot,
      dataDir,
      advance: (ms: number) => (now += ms),
    };
  }

  async function bareClone(workspaceRoot: string, fullPath: string, bytes: number) {
    const clone = path.join(workspaceRoot, "github", "github.com", fullPath);
    await mkdir(clone, { recursive: true });
    await writeFile(path.join(clone, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      path.join(clone, "config"),
      "[core]\n\tbare = true\n[omniralph]\n\thostDir = github.com\n",
    );
    await writeFile(path.join(clone, "pack"), Buffer.alloc(bytes));
    return clone;
  }

  describe("POST /api/claude/check", () => {
    it("checks Claude, answers the result and publishes claude", async () => {
      const { server, claude } = await start();
      const reply = await send(server, "POST", "/api/claude/check");
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({
        claude: {
          status: "signed_in",
          source: "login",
          account: { email: "steve@example.com", organization: "Example", subscriptionType: "max" },
          models: [
            { value: "opus", displayName: "Opus 5.5" },
            { value: "sonnet", displayName: "Sonnet 5.5" },
          ],
          checkedAt: "2026-10-28T10:42:00.000Z",
        },
      });
      expect(claude.status()?.status).toBe("signed_in");
      expect(published).toEqual([{ resource: "claude" }]);
    });

    it("answers signed out, and doesn't read again (or publish) within 10 seconds", async () => {
      const read = vi.fn(async () => {
        throw new Error("Not logged in · Please run /login");
      });
      const { server, advance } = await start({ read });
      const first = await send(server, "POST", "/api/claude/check");
      expect(first.body.claude).toMatchObject({ status: "signed_out", source: null, models: [] });
      advance(5_000);
      const second = await send(server, "POST", "/api/claude/check");
      expect(second.body).toEqual(first.body);
      expect(read).toHaveBeenCalledTimes(1);
      expect(published).toEqual([{ resource: "claude" }]);
      advance(10_000);
      await send(server, "POST", "/api/claude/check");
      expect(read).toHaveBeenCalledTimes(2);
      expect(published).toEqual([{ resource: "claude" }, { resource: "claude" }]);
    });

    it("refuses a cross-origin check", async () => {
      const read = vi.fn(async () => ({ models: MODELS, account: ACCOUNT }));
      const { server } = await start({ read });
      const reply = await send(server, "POST", "/api/claude/check", {
        origin: "http://evil.example",
      });
      expect(reply.status).toBe(403);
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe("storage", () => {
    it("GET /api/storage answers the sizes, free space and roots", async () => {
      const { server, workspaceRoot, dataDir } = await start();
      await mkdir(path.join(dataDir, "logs"), { recursive: true });
      await writeFile(path.join(dataDir, "logs", "agent.log"), Buffer.alloc(300));
      const reply = await send(server, "GET", "/api/storage");
      expect(reply.status).toBe(200);
      const body = reply.body as unknown as StorageState;
      expect(body.roots).toEqual({ workspaceRoot, dataDir });
      expect(body.measuring).toBe(false);
      expect(body.items.map((item) => item.key)).toEqual([
        "repo_cache",
        "worktrees",
        "branch_worktrees",
        "packages",
        "caches",
        "logs",
      ]);
      expect(body.items.find((item) => item.key === "logs")?.bytes).toBe(300);
      expect(body.filesystems).toEqual([
        {
          paths: [workspaceRoot, dataDir],
          freeBytes: 120 * GB,
          totalBytes: 500 * GB,
          low: false,
        },
      ]);
      expect(body.low).toBe(false);
    });

    it("says low when under 5 GB are free", async () => {
      const { server } = await start({
        statfs: async () => ({ bsize: 4096, blocks: (500 * GB) / 4096, bavail: (4 * GB) / 4096 }),
      });
      const body = (await send(server, "GET", "/api/storage")).body as unknown as StorageState;
      expect(body.filesystems[0]?.low).toBe(true);
      expect(body.low).toBe(true);
    });

    it("POST /api/storage/measure answers 202 at once, then measures again and publishes", async () => {
      const { server, dataDir } = await start();
      const first = (await send(server, "GET", "/api/storage")).body as unknown as StorageState;
      expect(first.items.find((item) => item.key === "logs")?.bytes).toBe(0);
      published.length = 0;
      await mkdir(path.join(dataDir, "logs"), { recursive: true });
      await writeFile(path.join(dataDir, "logs", "agent.log"), Buffer.alloc(1_000));
      // Within the 10 minutes, the sizes are reused.
      const cached = (await send(server, "GET", "/api/storage")).body as unknown as StorageState;
      expect(cached.items.find((item) => item.key === "logs")?.bytes).toBe(0);

      const reply = await send(server, "POST", "/api/storage/measure");
      expect(reply.status).toBe(202);
      expect(reply.body).toEqual({ measuring: true });
      await vi.waitFor(() =>
        expect(published).toEqual([{ resource: "storage" }, { resource: "repos" }]),
      );
      const after = (await send(server, "GET", "/api/storage")).body as unknown as StorageState;
      expect(after.items.find((item) => item.key === "logs")?.bytes).toBe(1_000);
      expect(after.measuring).toBe(false);
    });

    it("answers the last sizes and says measuring while a measurement runs", async () => {
      const { server, storage } = await start();
      await send(server, "GET", "/api/storage");
      const measuring = storage.measure({ fresh: true });
      const body = (await send(server, "GET", "/api/storage")).body as unknown as StorageState;
      expect(body.measuring).toBe(true);
      await measuring;
      expect(storage.isMeasuring()).toBe(false);
    });
  });

  describe("GET /api/repos", () => {
    it("answers no repos for an empty cache", async () => {
      const { server } = await start();
      const reply = await send(server, "GET", "/api/repos");
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ repos: [] });
    });

    it("answers each cached repo with its size, last fetch, last sync and pin", async () => {
      const { server, workspaceRoot, recent } = await start({
        pinned: [{ provider: "github", fullPath: "acme/customer-portal" }],
      });
      const clone = await bareClone(workspaceRoot, "acme/customer-portal", 2_048);
      await writeFile(path.join(clone, "FETCH_HEAD"), "");
      const fetched = new Date("2026-10-28T10:32:00.000Z");
      await utimes(path.join(clone, "FETCH_HEAD"), fetched, fetched);
      await bareClone(workspaceRoot, "acme/billing", 10);
      recent.push({
        id: "job-1",
        type: REPO_SYNC_JOB_TYPE,
        repo: { provider: "github", fullPath: "acme/customer-portal" },
        outcome: "failed",
        error: "fatal: could not read from remote",
        finishedAt: "2026-10-28T10:40:00.000Z",
      } as unknown as AttemptRecord);
      const reply = await send(server, "GET", "/api/repos");
      expect(reply.body.repos).toEqual([
        expect.objectContaining({
          provider: "github",
          host: "github.com",
          fullPath: "acme/billing",
          lastFetchedAt: null,
          lastSync: null,
          pinned: false,
        }),
        expect.objectContaining({
          provider: "github",
          host: "github.com",
          fullPath: "acme/customer-portal",
          path: clone,
          lastFetchedAt: fetched.toISOString(),
          lastSync: {
            outcome: "failed",
            error: "fatal: could not read from remote",
            at: "2026-10-28T10:40:00.000Z",
          },
          pinned: true,
        }),
      ]);
      const portal = (reply.body.repos as { fullPath: string; bytes: number }[]).find(
        (repo) => repo.fullPath === "acme/customer-portal",
      );
      expect(portal?.bytes).toBeGreaterThanOrEqual(2_048);
    });

    it("publishes repos when a repo sync is recorded, and not for other attempts", async () => {
      const { history } = await start();
      const finished = (type: string): AttemptChange => ({
        kind: "finished",
        attempt: { id: `job-${type}`, type } as AttemptRecord,
      });
      history.emit("change", finished("ralph.story"));
      expect(published).toEqual([{ resource: "attempts", ids: ["job-ralph.story"] }]);
      published.length = 0;
      history.emit("change", finished(REPO_SYNC_JOB_TYPE));
      expect(published).toEqual([
        { resource: "attempts", ids: [`job-${REPO_SYNC_JOB_TYPE}`] },
        { resource: "repos" },
      ]);
    });

    it("needs the cookie", async () => {
      const { server } = await start();
      const reply = await send(server, "GET", "/api/repos", { cookie: "" });
      expect(reply.status).toBe(401);
    });
  });
});
