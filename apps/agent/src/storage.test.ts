import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_SYNC_JOB_TYPE, REVIEW_TASK_JOB_TYPE } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptHistory } from "./attempts/history.js";
import { silentLogger } from "./logger.js";
import {
  AgentStorage,
  LOW_DISK_BYTES,
  STORAGE_CACHE_MS,
  WALK_YIELD_EVERY,
  isLowDisk,
  type AgentStorageOptions,
  type StorageItemKey,
} from "./storage.js";

const GB = 1024 ** 3;

let dir: string;
let workspaceRoot: string;
let dataDir: string;

async function file(at: string, bytes: number): Promise<void> {
  await mkdir(path.dirname(at), { recursive: true });
  await writeFile(at, Buffer.alloc(bytes, 1));
}

/** A bare clone as `RepoCache` leaves it: `HEAD`, `config` (with `omniralph.hostDir` when given) and a pack. */
async function bareRepo(at: string, options: { host?: string; bytes: number }): Promise<void> {
  await file(path.join(at, "HEAD"), 0);
  await writeFile(path.join(at, "HEAD"), "ref: refs/heads/main\n");
  const config = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tbare = true",
    '[remote "origin"]',
    "\turl = https://example.com/x.git",
    ...(options.host ? ["[omniralph]", `\thostDir = ${options.host}`] : []),
    "",
  ].join("\n");
  await writeFile(path.join(at, "config"), config);
  await file(path.join(at, "objects", "pack", "pack-1.pack"), options.bytes);
}

/** Sizes of every item, by key. */
async function sizes(
  storage: AgentStorage,
  fresh = false,
): Promise<Record<StorageItemKey, number>> {
  const report = await storage.measure({ fresh });
  return Object.fromEntries(report.items.map((i) => [i.key, i.bytes])) as Record<
    StorageItemKey,
    number
  >;
}

function plentyStatfs(): NonNullable<AgentStorageOptions["statfs"]> {
  // 500 GB, 120 GB free.
  return vi.fn(async () => ({ bsize: 4096, blocks: (500 * GB) / 4096, bavail: (120 * GB) / 4096 }));
}

function storage(options: Partial<AgentStorageOptions> = {}): AgentStorage {
  return new AgentStorage({
    workspaceRoot,
    dataDir,
    statfs: plentyStatfs(),
    logger: silentLogger(),
    ...options,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "omniralph-storage-"));
  workspaceRoot = path.join(dir, "repos");
  dataDir = path.join(dir, "data");

  // Repo cache: two clones plus a lock file.
  await bareRepo(path.join(workspaceRoot, "github", "github.com", "acme", "web"), {
    host: "github.com",
    bytes: 1000,
  });
  await bareRepo(
    path.join(workspaceRoot, "gitlab", "gitlab.example.com", "acme", "platform", "api"),
    {
      host: "gitlab.example.com",
      bytes: 2000,
    },
  );
  await file(path.join(workspaceRoot, ".locks", "github", "x.lock"), 5);
  // A symlink loop and a link to a big file outside: neither is followed.
  await symlink(workspaceRoot, path.join(workspaceRoot, "github", "loop"));
  await file(path.join(dir, "outside", "big"), 1_000_000);
  await symlink(path.join(dir, "outside", "big"), path.join(workspaceRoot, "big-link"));
  await symlink(path.join(dir, "outside"), path.join(workspaceRoot, ".worktrees-link"));

  await file(path.join(workspaceRoot, ".worktrees", "job-1", "src", "a.ts"), 300);
  await file(path.join(workspaceRoot, ".worktrees", "job-1", "src", "b.ts"), 200);
  await file(
    path.join(workspaceRoot, ".branches", "github", "github.com", "acme", "web", "main", "c"),
    700,
  );

  await file(path.join(dataDir, "installables", "node_modules", "pkg", "index.js"), 40);
  await file(path.join(dataDir, "cache", "pkg", "x"), 11);
  await file(path.join(dataDir, "pr-cache", "pkg", "repo", "12", "y"), 22);
  await file(path.join(dataDir, "logs", "agent.log"), 90);
  await file(path.join(dataDir, "logs", "agent.log.1"), 10);
  await writeFile(path.join(dataDir, "settings.json"), "{}");
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** Bytes of the symlinks themselves (their target's path length). */
function linkBytes(...targets: string[]): number {
  return targets.reduce((sum, t) => sum + Buffer.byteLength(t), 0);
}

describe("AgentStorage.measure", () => {
  it("sizes each item, the repo cache without the worktrees, never following symlinks", async () => {
    const repoConfig = (host: string) =>
      Buffer.byteLength(
        [
          "[core]",
          "\trepositoryformatversion = 0",
          "\tbare = true",
          '[remote "origin"]',
          "\turl = https://example.com/x.git",
          "[omniralph]",
          `\thostDir = ${host}`,
          "",
        ].join("\n"),
      );
    const head = Buffer.byteLength("ref: refs/heads/main\n");
    const report = await storage().measure();
    expect(report.items.map((i) => i.key)).toEqual([
      "repo_cache",
      "worktrees",
      "branch_worktrees",
      "packages",
      "caches",
      "logs",
    ]);
    expect(Object.fromEntries(report.items.map((i) => [i.key, i.bytes]))).toEqual({
      repo_cache:
        1000 +
        2000 +
        5 +
        2 * head +
        repoConfig("github.com") +
        repoConfig("gitlab.example.com") +
        linkBytes(workspaceRoot, path.join(dir, "outside", "big"), path.join(dir, "outside")),
      worktrees: 500,
      branch_worktrees: 700,
      packages: 40,
      caches: 33,
      logs: 100,
    });
    expect(report.items.find((i) => i.key === "caches")!.paths).toEqual([
      path.join(dataDir, "cache"),
      path.join(dataDir, "pr-cache"),
    ]);
    expect(report.items.find((i) => i.key === "repo_cache")!.paths).toEqual([workspaceRoot]);
  });

  it("counts a missing directory as empty", async () => {
    await rm(path.join(dataDir, "installables"), { recursive: true });
    await rm(path.join(workspaceRoot, ".branches"), { recursive: true });
    const measured = await sizes(storage());
    expect(measured.packages).toBe(0);
    expect(measured.branch_worktrees).toBe(0);
  });

  it("yields to the event loop every 1,000 entries", async () => {
    await mkdir(path.join(dataDir, "logs", "many"), { recursive: true });
    await Promise.all(
      Array.from({ length: 2_500 }, (_, i) =>
        writeFile(path.join(dataDir, "logs", "many", `f${i}`), ""),
      ),
    );
    const yieldToLoop = vi.fn(async () => {});
    await storage({ yieldToLoop }).measure();
    // Logs alone has 2,503 entries (2 files, `many` and its 2,500), and every other item fewer.
    const logsWalk = Math.floor(2_503 / WALK_YIELD_EVERY);
    expect(yieldToLoop.mock.calls.length).toBeGreaterThanOrEqual(logsWalk);
    expect(yieldToLoop.mock.calls.length).toBeLessThanOrEqual(logsWalk + 1);
  });

  it("reuses the sizes for 10 minutes, and measures again when asked", async () => {
    let now = new Date("2026-10-28T10:00:00Z");
    const changes = vi.fn();
    const s = storage({ now: () => now });
    s.on("change", changes);
    const first = await s.measure();
    expect(first.measuredAt).toBe("2026-10-28T10:00:00.000Z");
    expect(changes).toHaveBeenCalledTimes(1);

    await file(path.join(dataDir, "logs", "agent.log.2"), 1000);
    now = new Date(now.getTime() + STORAGE_CACHE_MS - 1);
    expect((await sizes(s)).logs).toBe(100);
    expect(changes).toHaveBeenCalledTimes(1);

    // "Measure again".
    expect((await sizes(s, true)).logs).toBe(1100);
    expect(changes).toHaveBeenCalledTimes(2);

    await file(path.join(dataDir, "logs", "agent.log.3"), 1000);
    now = new Date(now.getTime() + STORAGE_CACHE_MS);
    const later = await s.measure();
    expect(later.items.find((i) => i.key === "logs")!.bytes).toBe(2100);
    expect(later.measuredAt).toBe(now.toISOString());
  });

  it("shares one walk between concurrent calls", async () => {
    const yieldToLoop = vi.fn(async () => {});
    const changes = vi.fn();
    const s = storage({ yieldToLoop });
    s.on("change", changes);
    const [a, b] = await Promise.all([s.measure({ fresh: true }), s.measure({ fresh: true })]);
    expect(a.items).toEqual(b.items);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("reports free and total space once per filesystem, read on every call", async () => {
    const statfs = plentyStatfs();
    const report = await storage({ statfs }).measure();
    expect(report.filesystems).toEqual([
      { paths: [workspaceRoot, dataDir], freeBytes: 120 * GB, totalBytes: 500 * GB, low: false },
    ]);
    expect(report.low).toBe(false);
    expect(statfs).toHaveBeenCalledTimes(1);
    await storage({ statfs }).measure();
    expect(statfs).toHaveBeenCalledTimes(2);
  });

  it("tells filesystems apart by device and reads a missing directory's nearest ancestor", async () => {
    const missing = path.join(dataDir, "not-yet", "made");
    const statfs = vi.fn(async (p: string) =>
      p === workspaceRoot
        ? { bsize: 1024, blocks: (100 * GB) / 1024, bavail: (4 * GB) / 1024 }
        : { bsize: 1024, blocks: (1000 * GB) / 1024, bavail: (200 * GB) / 1024 },
    );
    const device = vi.fn(async (p: string) => {
      if (p.startsWith(path.join(dataDir, "not-yet"))) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return p.startsWith(workspaceRoot) ? 1 : 2;
    });
    const report = await new AgentStorage({
      workspaceRoot,
      dataDir: missing,
      statfs,
      device,
    }).measure();
    expect(report.filesystems).toEqual([
      { paths: [workspaceRoot], freeBytes: 4 * GB, totalBytes: 100 * GB, low: true },
      { paths: [missing], freeBytes: 200 * GB, totalBytes: 1000 * GB, low: false },
    ]);
    expect(statfs).toHaveBeenLastCalledWith(dataDir);
    expect(report.low).toBe(true);
  });

  it("reads the real free space by default", async () => {
    const report = await new AgentStorage({ workspaceRoot, dataDir }).measure();
    expect(report.filesystems).toHaveLength(1);
    expect(report.filesystems[0]!.totalBytes).toBeGreaterThan(0);
    expect(report.filesystems[0]!.freeBytes).toBeLessThanOrEqual(report.filesystems[0]!.totalBytes);
  });
});

describe("isLowDisk", () => {
  it("is low under 5 GB or under 10 % free", () => {
    expect(isLowDisk(LOW_DISK_BYTES - 1, 20 * GB)).toBe(true);
    expect(isLowDisk(LOW_DISK_BYTES, 20 * GB)).toBe(false);
    expect(isLowDisk(49 * GB, 500 * GB)).toBe(true);
    expect(isLowDisk(50 * GB, 500 * GB)).toBe(false);
    expect(isLowDisk(120 * GB, 500 * GB)).toBe(false);
  });
});

describe("AgentStorage.listRepos", () => {
  function syncJob(provider: "github" | "gitlab", fullPath: string) {
    return {
      id: randomUUID(),
      type: REPO_SYNC_JOB_TYPE,
      taskType: "system" as const,
      payload: {
        repository: { provider, fullPath, cloneUrl: `https://example.com/${fullPath}.git` },
      },
    };
  }

  it("lists each cached repo with its host, size, last fetch, last sync and pin", async () => {
    const web = path.join(workspaceRoot, "github", "github.com", "acme", "web");
    const api = path.join(workspaceRoot, "gitlab", "gitlab.example.com", "acme", "platform", "api");
    // Cached before repositories were keyed by host: no `omniralph.hostDir`.
    const legacy = path.join(workspaceRoot, "gitlab", "acme", "legacy");
    await bareRepo(legacy, { bytes: 10 });
    const fetched = new Date("2026-10-28T09:50:00Z");
    await writeFile(path.join(web, "FETCH_HEAD"), "abc\tbranch 'main'\n");
    await utimes(path.join(web, "FETCH_HEAD"), fetched, fetched);

    let now = new Date("2026-10-28T10:00:00Z");
    const history = new AttemptHistory({ logger: silentLogger(), now: () => now });
    const older = syncJob("github", "acme/web");
    history.start(older);
    history.finish(older.id, "completed");
    now = new Date("2026-10-28T10:05:00Z");
    const failed = syncJob("github", "acme/web");
    history.start(failed);
    history.finish(failed.id, "failed", "fatal: could not read Username");
    const apiSync = syncJob("gitlab", "acme/platform/api");
    history.start(apiSync);
    history.finish(apiSync.id, "completed");
    // Another kind of work in the same repo isn't a sync.
    const review = {
      ...syncJob("gitlab", "acme/platform/api"),
      type: REVIEW_TASK_JOB_TYPE,
      taskType: "review" as const,
    };
    history.start(review);
    history.finish(review.id, "failed", "review failed");
    // A sync still running has no outcome yet.
    history.start(syncJob("gitlab", "acme/legacy"));

    const pins = [{ id: randomUUID(), provider: "gitlab" as const, fullPath: "acme/platform/api" }];
    const repos = await storage({ history, pinned: () => pins }).listRepos();
    const headBytes = Buffer.byteLength("ref: refs/heads/main\n");
    expect(repos).toEqual([
      {
        provider: "github",
        host: "github.com",
        fullPath: "acme/web",
        path: web,
        bytes: expect.any(Number),
        lastFetchedAt: fetched.toISOString(),
        lastSync: {
          outcome: "failed",
          error: "fatal: could not read Username",
          at: "2026-10-28T10:05:00.000Z",
        },
        pinned: false,
      },
      {
        provider: "gitlab",
        host: null,
        fullPath: "acme/legacy",
        path: legacy,
        bytes: expect.any(Number),
        lastFetchedAt: null,
        lastSync: null,
        pinned: false,
      },
      {
        provider: "gitlab",
        host: "gitlab.example.com",
        fullPath: "acme/platform/api",
        path: api,
        bytes: expect.any(Number),
        lastFetchedAt: null,
        lastSync: { outcome: "completed", error: null, at: "2026-10-28T10:05:00.000Z" },
        pinned: true,
      },
    ]);
    // The pack, HEAD and config (and FETCH_HEAD for web).
    expect(repos[0]!.bytes).toBeGreaterThan(1000 + headBytes);
    expect(repos[2]!.bytes).toBeGreaterThan(2000 + headBytes);
    expect(repos[2]!.bytes).toBeLessThan(3000);
  });

  it("lists nothing without a cache, history or heartbeat", async () => {
    await rm(workspaceRoot, { recursive: true });
    expect(await new AgentStorage({ workspaceRoot, dataDir }).listRepos()).toEqual([]);
  });

  it("doesn't search the worktree directories or follow symlinks", async () => {
    await bareRepo(path.join(workspaceRoot, ".branches", "github", "github.com", "acme", "x"), {
      host: "github.com",
      bytes: 1,
    });
    await symlink(
      path.join(workspaceRoot, "github", "github.com", "acme"),
      path.join(workspaceRoot, "github", "github.com", "mirror"),
    );
    const repos = await storage().listRepos();
    expect(repos.map((r) => `${r.provider}:${r.fullPath}`)).toEqual([
      "github:acme/web",
      "gitlab:acme/platform/api",
    ]);
  });

  it("reuses repo sizes for 10 minutes unless measured again", async () => {
    let now = new Date("2026-10-28T10:00:00Z");
    const s = storage({ now: () => now });
    const before = (await s.listRepos())[0]!.bytes;
    await file(
      path.join(
        workspaceRoot,
        "github",
        "github.com",
        "acme",
        "web",
        "objects",
        "pack",
        "pack-2.pack",
      ),
      500,
    );
    expect((await s.listRepos())[0]!.bytes).toBe(before);
    expect((await s.listRepos({ fresh: true }))[0]!.bytes).toBe(before + 500);
    await file(
      path.join(
        workspaceRoot,
        "github",
        "github.com",
        "acme",
        "web",
        "objects",
        "pack",
        "pack-3.pack",
      ),
      500,
    );
    // "Measure again" on the page measures the repos again too.
    await s.measure({ fresh: true });
    expect((await s.listRepos())[0]!.bytes).toBe(before + 1000);
    await file(
      path.join(
        workspaceRoot,
        "github",
        "github.com",
        "acme",
        "web",
        "objects",
        "pack",
        "pack-4.pack",
      ),
      500,
    );
    now = new Date(now.getTime() + STORAGE_CACHE_MS);
    expect((await s.listRepos())[0]!.bytes).toBe(before + 1500);
  });
});
