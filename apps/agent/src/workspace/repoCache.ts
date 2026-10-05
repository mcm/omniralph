import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { JobRepository } from "@omniralph/shared";
import lockfile from "proper-lockfile";
import type { Logger } from "../logger.js";
import { credentialConfigArgs, credentialConfigEnv, GitError, gitEnv, runGit } from "./git.js";

/** Directory (under `workspaceRoot`) holding one git worktree per running job. */
export const WORKTREES_DIR = ".worktrees";
const LOCKS_DIR = ".locks";
/** Clones are made here and renamed into place, so a crash never leaves a half clone. */
const TMP_DIR = ".tmp";
const PROVIDERS = ["github", "gitlab"] as const;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface RepoCacheOptions {
  /** Cache root (`workspaceRoot` from the agent config). */
  workspaceRoot: string;
  /** `credential.helper` value for job git commands (see `defaultCredentialHelper`). */
  credentialHelper: string;
  logger?: Logger;
  /** git binary (default: `git` on PATH). */
  git?: string;
  /** Time between attempts to take a repo lock held by another process. */
  lockRetryMs?: number;
  /** A lock whose holder stopped updating it for this long is taken over. */
  lockStaleMs?: number;
}

/** Per-call git environment: the job's `ctx.env()` (it carries `OMNIRALPH_JOB_TOKEN`). */
export interface GitJobOptions {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface SyncResult {
  /** The bare repository in the cache. */
  dir: string;
  /** True when this call made the first clone. */
  cloned: boolean;
  /** True when this call ran `git fetch`. */
  fetched: boolean;
}

export interface Worktree {
  jobId: string;
  sha: string;
  /** `<workspaceRoot>/.worktrees/<jobId>` */
  path: string;
  repoDir: string;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Keeps the agent's environment for git commands outside jobs, minus `OMNIRALPH_*`. */
function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("OMNIRALPH_")),
  );
}

/**
 * The agent's repo cache: one blobless bare clone per repository under
 * `<workspaceRoot>/<provider>/<repo path>`, made on first use and fetched
 * afterwards, and one git worktree per job under
 * `<workspaceRoot>/.worktrees/<jobId>`. Clone, fetch and worktree
 * bookkeeping are serialized per repository with a file lock (so several agent
 * processes can share a cache); checkouts run outside the lock.
 *
 * Every git command runs with the host's credential helpers reset and only
 * the agent's `git-credential` helper configured.
 */
export class RepoCache {
  readonly workspaceRoot: string;
  private readonly credentialHelper: string;
  private readonly logger: Logger | undefined;
  private readonly git: string | undefined;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;
  /** In-process queue per repository, in front of the file lock. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: RepoCacheOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.credentialHelper = options.credentialHelper;
    this.logger = options.logger;
    this.git = options.git;
    this.lockRetryMs = options.lockRetryMs ?? 250;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
  }

  /** `<workspaceRoot>/<provider>/<repo path>` */
  repoDir(repo: Pick<JobRepository, "provider" | "fullPath">): string {
    const segments = repo.fullPath.split("/");
    if (
      !PROVIDERS.includes(repo.provider) ||
      segments.some(
        (s) => s === "" || s === "." || s === ".." || s.startsWith(".") || /[\\\0]/.test(s),
      )
    ) {
      throw new Error(`invalid repository path ${repo.provider}/${repo.fullPath}`);
    }
    return path.join(this.workspaceRoot, repo.provider, ...segments);
  }

  /**
   * Environment for git commands run by others in a worktree (e.g. the
   * engine's diffs): no askpass or prompts, and only the agent's credential
   * helper, so on-demand blob fetches authenticate with the job token in `env`.
   */
  gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const { GIT_CONFIG_PARAMETERS: _params, ...rest } = gitEnv(env);
    return { ...rest, ...credentialConfigEnv(this.credentialHelper) };
  }

  worktreePath(jobId: string): string {
    if (!JOB_ID.test(jobId)) throw new Error(`invalid job ID ${jobId}`);
    return path.join(this.workspaceRoot, WORKTREES_DIR, jobId);
  }

  /**
   * Clones the repository on first use, otherwise fetches: the given `shas`
   * when any is missing (skipped when all are present), or every branch when
   * no SHA is given (`repo.sync`).
   */
  async sync(
    repo: JobRepository,
    options: GitJobOptions & { shas?: string[] },
  ): Promise<SyncResult> {
    const shas = options.shas ?? [];
    for (const sha of shas) if (!SHA.test(sha)) throw new Error(`invalid commit SHA ${sha}`);
    return this.withRepoLock(repo, options.signal, () => this.syncLocked(repo, shas, options));
  }

  /**
   * Makes `sha` available and checks it out (detached) into
   * `<workspaceRoot>/.worktrees/<jobId>`. On failure or abort the worktree is
   * removed again before the error is rethrown.
   */
  async createWorktree(
    repo: JobRepository,
    sha: string,
    options: GitJobOptions & { jobId: string },
  ): Promise<Worktree> {
    const worktree: Worktree = {
      jobId: options.jobId,
      sha,
      path: this.worktreePath(options.jobId),
      repoDir: this.repoDir(repo),
    };
    try {
      await this.withRepoLock(repo, options.signal, async () => {
        await this.syncLocked(repo, [sha], options);
        await rm(worktree.path, { recursive: true, force: true });
        await mkdir(path.dirname(worktree.path), { recursive: true });
        await this.runGit(["worktree", "add", "--detach", "--no-checkout", worktree.path, sha], {
          ...options,
          cwd: worktree.repoDir,
        });
      });
      // The checkout (which lazily fetches blobs) runs outside the lock.
      await this.runGit(["reset", "--hard", "--quiet", sha], { ...options, cwd: worktree.path });
    } catch (error) {
      await this.removeWorktree(worktree).catch((cleanupError: unknown) =>
        this.logger?.warn({ err: cleanupError, path: worktree.path }, "worktree cleanup failed"),
      );
      throw error;
    }
    return worktree;
  }

  /** Deletes a job's worktree and its git bookkeeping. Safe to call more than once. */
  async removeWorktree(worktree: Worktree): Promise<void> {
    const repoExists = await exists(worktree.repoDir);
    await this.withLock(worktree.repoDir, undefined, async () => {
      await rm(worktree.path, { recursive: true, force: true });
      if (repoExists) {
        await this.runGit(["worktree", "prune"], { env: hostEnv(), cwd: worktree.repoDir });
      }
    });
  }

  /** Runs `fn` in a fresh worktree of `sha` and always removes the worktree afterwards. */
  async withWorktree<T>(
    repo: JobRepository,
    sha: string,
    options: GitJobOptions & { jobId: string },
    fn: (worktree: Worktree) => Promise<T>,
  ): Promise<T> {
    const worktree = await this.createWorktree(repo, sha, options);
    try {
      return await fn(worktree);
    } finally {
      await this.removeWorktree(worktree).catch((error: unknown) =>
        this.logger?.warn({ err: error, path: worktree.path }, "worktree cleanup failed"),
      );
    }
  }

  /**
   * Startup cleanup after a crash: deletes every worktree under `.worktrees`
   * and leftover partial clones, then runs `git worktree prune` in each cached
   * repository. Only call it while no job is running. Returns the removed
   * worktree paths.
   */
  async pruneStaleWorktrees(): Promise<string[]> {
    const worktreesDir = path.join(this.workspaceRoot, WORKTREES_DIR);
    const removed: string[] = [];
    for (const entry of await readdir(worktreesDir).catch(() => [] as string[])) {
      const stale = path.join(worktreesDir, entry);
      await rm(stale, { recursive: true, force: true });
      removed.push(stale);
    }
    await rm(path.join(this.workspaceRoot, TMP_DIR), { recursive: true, force: true });
    for (const provider of PROVIDERS) {
      for (const dir of await this.findRepos(path.join(this.workspaceRoot, provider), 0)) {
        await this.withLock(dir, undefined, () =>
          this.runGit(["worktree", "prune"], { env: hostEnv(), cwd: dir }),
        ).catch((error: unknown) =>
          this.logger?.warn({ err: error, repo: dir }, "git worktree prune failed"),
        );
      }
    }
    if (removed.length > 0) this.logger?.info({ removed }, "pruned stale worktrees");
    return removed;
  }

  // --- internals --------------------------------------------------------------------------

  private async syncLocked(
    repo: JobRepository,
    shas: string[],
    options: GitJobOptions,
  ): Promise<SyncResult> {
    const dir = this.repoDir(repo);
    if (!(await exists(path.join(dir, "HEAD")))) {
      await this.clone(repo, dir, options);
      const missing = await this.missingCommits(dir, shas, options);
      if (missing.length > 0) await this.fetch(dir, missing, options);
      return { dir, cloned: true, fetched: missing.length > 0 };
    }
    const missing = await this.missingCommits(dir, shas, options);
    if (shas.length > 0 && missing.length === 0) return { dir, cloned: false, fetched: false };
    await this.fetch(dir, missing, options);
    return { dir, cloned: false, fetched: true };
  }

  private async clone(repo: JobRepository, dir: string, options: GitJobOptions): Promise<void> {
    const tmp = path.join(this.workspaceRoot, TMP_DIR, randomUUID());
    await mkdir(path.dirname(tmp), { recursive: true });
    this.logger?.info({ repo: `${repo.provider}/${repo.fullPath}` }, "cloning repository");
    try {
      await this.runGit(
        ["clone", "--bare", "--filter=blob:none", "--", repo.cloneUrl, tmp],
        options,
      );
      // Bare clones have no fetch refspec; keep branches up to date on fetch.
      await this.runGit(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], {
        ...options,
        cwd: tmp,
      });
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      await rename(tmp, dir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Fetches `shas` (servers that don't serve unadvertised commits get a full
   * fetch instead), or every branch when `shas` is empty.
   */
  private async fetch(dir: string, shas: string[], options: GitJobOptions): Promise<void> {
    const git = (args: string[]) => this.runGit(args, { ...options, cwd: dir });
    const base = ["fetch", "--quiet", "--filter=blob:none", "--no-tags", "origin"];
    if (shas.length === 0) {
      await git([...base, "--prune"]);
      return;
    }
    try {
      await git([...base, ...shas]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      await git([...base, "--prune"]);
    }
    const missing = await this.missingCommits(dir, shas, options);
    if (missing.length > 0) {
      throw new Error(`commit(s) ${missing.join(", ")} not found in ${dir}'s remote`);
    }
  }

  private async missingCommits(
    dir: string,
    shas: string[],
    options: GitJobOptions,
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of shas) {
      try {
        // Without GIT_NO_LAZY_FETCH a partial clone would fetch a missing commit on demand.
        await this.runGit(["cat-file", "-e", `${sha}^{commit}`], {
          ...options,
          env: { ...options.env, GIT_NO_LAZY_FETCH: "1" },
          cwd: dir,
        });
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        missing.push(sha);
      }
    }
    return missing;
  }

  private runGit(args: string[], options: GitJobOptions & { cwd?: string }): Promise<string> {
    return runGit([...credentialConfigArgs(this.credentialHelper), ...args], {
      ...options,
      git: this.git,
    });
  }

  private async findRepos(dir: string, depth: number): Promise<string[]> {
    if (depth > 8) return [];
    if (await exists(path.join(dir, "HEAD"))) return [dir];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const repos: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory())
        repos.push(...(await this.findRepos(path.join(dir, entry.name), depth + 1)));
    }
    return repos;
  }

  private withRepoLock<T>(
    repo: JobRepository,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ) {
    return this.withLock(this.repoDir(repo), signal, fn);
  }

  /**
   * Serializes `fn` per repository: in-process through a promise chain, across
   * processes through a `proper-lockfile` lock in `<workspaceRoot>/.locks`.
   */
  private async withLock<T>(
    repoDir: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(repoDir) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted();
        const release = await this.acquireFileLock(repoDir, signal);
        try {
          return await fn();
        } finally {
          await release().catch(() => {});
        }
      });
    const tail = run.catch(() => {});
    this.queues.set(repoDir, tail);
    void tail.then(() => {
      if (this.queues.get(repoDir) === tail) this.queues.delete(repoDir);
    });
    return run;
  }

  private async acquireFileLock(
    repoDir: string,
    signal: AbortSignal | undefined,
  ): Promise<() => Promise<void>> {
    const relative = path.relative(this.workspaceRoot, repoDir);
    const lockfilePath = path.join(this.workspaceRoot, LOCKS_DIR, `${relative}.lock`);
    await mkdir(path.dirname(lockfilePath), { recursive: true });
    for (;;) {
      try {
        return await lockfile.lock(repoDir, {
          realpath: false,
          lockfilePath,
          stale: this.lockStaleMs,
          retries: 0,
          onCompromised: (error) =>
            this.logger?.warn({ err: error, repo: repoDir }, "repo lock compromised"),
        });
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ELOCKED") throw error;
        await abortableDelay(this.lockRetryMs, signal);
      }
    }
  }
}
