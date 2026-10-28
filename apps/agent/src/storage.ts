import { EventEmitter } from "node:events";
import type { StatsFs } from "node:fs";
import { lstat, readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { REPO_SYNC_JOB_TYPE, type PinnedRepository } from "@omniralph/shared";
import type { AttemptHistory, AttemptOutcome } from "./attempts/history.js";
import { INSTALLABLES_DIR } from "./installables.js";
import type { Logger } from "./logger.js";
import { logDirectory } from "./logs/rotating-file.js";
import {
  BRANCHES_DIR,
  cachedRepositories,
  WORKTREES_DIR,
  type CachedRepository,
} from "./workspace/repoCache.js";

/** How long measured sizes are reused before `measure()` walks again. */
export const STORAGE_CACHE_MS = 10 * 60_000;
/** Entries the walk visits between yields to the event loop. */
export const WALK_YIELD_EVERY = 1_000;
/** Directories deeper than this under an item's path aren't walked. */
const MAX_WALK_DEPTH = 64;
/** A filesystem with less free space than this is low. */
export const LOW_DISK_BYTES = 5 * 1024 ** 3;
/** A filesystem with less than this share free is low. */
export const LOW_DISK_RATIO = 0.1;

/** What the agent stores, in the order the Storage page lists it. */
export const STORAGE_ITEMS = [
  "repo_cache",
  "worktrees",
  "branch_worktrees",
  "packages",
  "caches",
  "logs",
] as const;
export type StorageItemKey = (typeof STORAGE_ITEMS)[number];

export interface StorageItem {
  key: StorageItemKey;
  /** The directories it covers (the repo cache: `workspaceRoot`, without the other items in it). */
  paths: string[];
  bytes: number;
}

/** Free space of one filesystem the agent writes to. */
export interface StorageFilesystem {
  /** Which of `workspaceRoot` and `dataDir` are on it. */
  paths: string[];
  freeBytes: number;
  totalBytes: number;
  /** Under `LOW_DISK_BYTES` or `LOW_DISK_RATIO` free. */
  low: boolean;
}

export interface StorageReport {
  items: StorageItem[];
  /** When the sizes were measured (they're reused for `STORAGE_CACHE_MS`). */
  measuredAt: string;
  /** Read on every `measure()`. */
  filesystems: StorageFilesystem[];
  /** Whether any filesystem is low. */
  low: boolean;
}

/** The last `repo.sync` of a repository on this agent. */
export interface RepoSync {
  outcome: AttemptOutcome;
  error: string | null;
  at: string;
}

export interface StoredRepo {
  provider: CachedRepository["provider"];
  host: string | null;
  fullPath: string;
  path: string;
  bytes: number;
  /** The mtime of its `FETCH_HEAD`; null when it was never fetched. */
  lastFetchedAt: string | null;
  /** From the attempt history; null when none is recorded. */
  lastSync: RepoSync | null;
  /** Whether the last heartbeat named it in `pinnedRepositories`. */
  pinned: boolean;
}

export interface AgentStorageOptions {
  workspaceRoot: string;
  dataDir: string;
  /** The attempt history, for each repo's last `repo.sync`. */
  history?: Pick<AttemptHistory, "recent">;
  /** The last heartbeat's `pinnedRepositories`. */
  pinned?: () => readonly Pick<PinnedRepository, "provider" | "fullPath">[];
  /** Free and total space (default `fs.statfs`). */
  statfs?: (path: string) => Promise<Pick<StatsFs, "bsize" | "blocks" | "bavail">>;
  /** The device a path is on, to tell filesystems apart (default `fs.stat().dev`). */
  device?: (path: string) => Promise<number | bigint | string>;
  /** Hands the event loop back during a walk (default `setImmediate`). */
  yieldToLoop?: () => Promise<void>;
  cacheMs?: number;
  logger?: Logger;
  now?: () => Date;
}

interface Measured {
  at: number;
  items: StorageItem[];
}

const defaultYield = () => new Promise<void>((resolve) => setImmediate(resolve));

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * What the agent stores and how much space is left: sizes of the repo cache,
 * worktrees, branch worktrees, packages, caches and logs (walked without
 * following symlinks, yielding every `WALK_YIELD_EVERY` entries, reused for
 * `cacheMs`), free space per filesystem, and the cached repositories with
 * their last fetch and sync. Emits `change` after each new measurement.
 */
export class AgentStorage extends EventEmitter<{ change: [] }> {
  private readonly workspaceRoot: string;
  private readonly dataDir: string;
  private readonly cacheMs: number;
  private readonly now: () => Date;
  private readonly yieldToLoop: () => Promise<void>;
  private measured: Measured | null = null;
  private measuring: Promise<Measured> | null = null;
  /** Repo sizes by bare clone directory. */
  private readonly repoSizes = new Map<string, { at: number; bytes: number }>();

  constructor(private readonly options: AgentStorageOptions) {
    super();
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.dataDir = path.resolve(options.dataDir);
    this.cacheMs = options.cacheMs ?? STORAGE_CACHE_MS;
    this.now = options.now ?? (() => new Date());
    this.yieldToLoop = options.yieldToLoop ?? defaultYield;
  }

  /** The directories of each item. */
  itemPaths(): Record<StorageItemKey, string[]> {
    return {
      repo_cache: [this.workspaceRoot],
      worktrees: [path.join(this.workspaceRoot, WORKTREES_DIR)],
      branch_worktrees: [path.join(this.workspaceRoot, BRANCHES_DIR)],
      packages: [path.join(this.dataDir, INSTALLABLES_DIR)],
      caches: [path.join(this.dataDir, "cache"), path.join(this.dataDir, "pr-cache")],
      logs: [logDirectory(this.dataDir)],
    };
  }

  /**
   * Sizes (measured at most every `cacheMs`, or now with `fresh`, as "Measure
   * again" does; concurrent calls share one walk) and the free space now.
   */
  async measure(options: { fresh?: boolean } = {}): Promise<StorageReport> {
    // Measuring again measures the repos again too.
    if (options.fresh) this.repoSizes.clear();
    const [measured, filesystems] = await Promise.all([
      this.sizes(options.fresh ?? false),
      this.filesystems(),
    ]);
    return {
      items: measured.items,
      measuredAt: new Date(measured.at).toISOString(),
      filesystems,
      low: filesystems.some((fs) => fs.low),
    };
  }

  /**
   * The cached repositories with their size (reused for `cacheMs`, unless
   * `fresh`), last fetch, last `repo.sync` and whether they're pinned here.
   */
  async listRepos(options: { fresh?: boolean } = {}): Promise<StoredRepo[]> {
    const repos = await cachedRepositories(this.workspaceRoot);
    const pinned = this.options.pinned?.() ?? [];
    const syncs = this.options.history?.recent().filter((a) => a.type === REPO_SYNC_JOB_TYPE) ?? [];
    const result: StoredRepo[] = [];
    for (const repo of repos) {
      const fetchHead = await lstat(path.join(repo.dir, "FETCH_HEAD")).catch(() => null);
      // Newest first: the first match is the last sync.
      const sync = syncs.find(
        (a) => a.repo?.provider === repo.provider && a.repo.fullPath === repo.fullPath,
      );
      result.push({
        provider: repo.provider,
        host: repo.host,
        fullPath: repo.fullPath,
        path: repo.dir,
        bytes: await this.repoSize(repo.dir, options.fresh ?? false),
        lastFetchedAt: fetchHead ? fetchHead.mtime.toISOString() : null,
        lastSync:
          sync?.outcome && sync.finishedAt
            ? { outcome: sync.outcome, error: sync.error, at: sync.finishedAt }
            : null,
        pinned: pinned.some((p) => p.provider === repo.provider && p.fullPath === repo.fullPath),
      });
    }
    const live = new Set(repos.map((r) => r.dir));
    for (const dir of this.repoSizes.keys()) if (!live.has(dir)) this.repoSizes.delete(dir);
    return result;
  }

  private async repoSize(dir: string, fresh: boolean): Promise<number> {
    const cached = this.repoSizes.get(dir);
    const now = this.now().getTime();
    if (!fresh && cached && now - cached.at < this.cacheMs) return cached.bytes;
    const bytes = await this.walk(dir, []);
    this.repoSizes.set(dir, { at: now, bytes });
    return bytes;
  }

  private sizes(fresh: boolean): Promise<Measured> {
    const cached = this.measured;
    if (!fresh && cached && this.now().getTime() - cached.at < this.cacheMs) {
      return Promise.resolve(cached);
    }
    if (this.measuring) return this.measuring;
    const measuring = this.measureSizes().finally(() => {
      if (this.measuring === measuring) this.measuring = null;
    });
    this.measuring = measuring;
    return measuring;
  }

  private async measureSizes(): Promise<Measured> {
    const paths = this.itemPaths();
    // The repo cache is `workspaceRoot` without the other items under it.
    const excluded = STORAGE_ITEMS.filter((key) => key !== "repo_cache").flatMap(
      (key) => paths[key],
    );
    const items: StorageItem[] = [];
    for (const key of STORAGE_ITEMS) {
      let bytes = 0;
      for (const dir of paths[key]) {
        bytes += await this.walk(dir, key === "repo_cache" ? excluded : []);
      }
      items.push({ key, paths: paths[key], bytes });
    }
    const measured = { at: this.now().getTime(), items };
    this.measured = measured;
    this.emit("change");
    return measured;
  }

  /**
   * The bytes under `root` (its files' sizes): never follows a symlink
   * (counting the link itself), skips `exclude` and anything that vanished or
   * can't be read, and yields every `WALK_YIELD_EVERY` entries.
   */
  private async walk(root: string, exclude: readonly string[]): Promise<number> {
    let bytes = 0;
    let visited = 0;
    const stack: { dir: string; depth: number }[] = [];
    const top = await lstat(root).catch(() => null);
    if (!top) return 0;
    if (!top.isDirectory()) return top.size;
    stack.push({ dir: root, depth: 0 });
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!;
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.options.logger?.debug({ err: error, dir }, "couldn't read a directory to size it");
        }
        return [];
      });
      for (const entry of entries) {
        if (++visited % WALK_YIELD_EVERY === 0) await this.yieldToLoop();
        const full = path.join(dir, entry.name);
        if (exclude.some((p) => isWithin(full, p))) continue;
        if (entry.isDirectory()) {
          if (depth < MAX_WALK_DEPTH) stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        const info = await lstat(full).catch(() => null);
        if (info) bytes += info.size;
      }
    }
    return bytes;
  }

  private async filesystems(): Promise<StorageFilesystem[]> {
    const device = this.options.device ?? (async (p: string) => (await stat(p)).dev);
    const readStatfs = this.options.statfs ?? statfs;
    const byDevice = new Map<string, StorageFilesystem>();
    for (const target of [this.workspaceRoot, this.dataDir]) {
      // A directory not made yet is on its nearest existing ancestor's filesystem.
      let existing = target;
      let id: string | null = null;
      for (;;) {
        try {
          id = String(await device(existing));
          break;
        } catch {
          const parent = path.dirname(existing);
          if (parent === existing) break;
          existing = parent;
        }
      }
      if (id === null) continue;
      const known = byDevice.get(id);
      if (known) {
        if (!known.paths.includes(target)) known.paths.push(target);
        continue;
      }
      try {
        const fs = await readStatfs(existing);
        const freeBytes = Number(fs.bavail) * Number(fs.bsize);
        const totalBytes = Number(fs.blocks) * Number(fs.bsize);
        byDevice.set(id, {
          paths: [target],
          freeBytes,
          totalBytes,
          low: isLowDisk(freeBytes, totalBytes),
        });
      } catch (error) {
        this.options.logger?.warn({ err: error, path: target }, "couldn't read the free space");
      }
    }
    return [...byDevice.values()];
  }
}

/** Under `LOW_DISK_BYTES` or under `LOW_DISK_RATIO` free. */
export function isLowDisk(freeBytes: number, totalBytes: number): boolean {
  return freeBytes < LOW_DISK_BYTES || (totalBytes > 0 && freeBytes / totalBytes < LOW_DISK_RATIO);
}
