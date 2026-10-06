import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRepository } from "@omniralph/shared";
import lockfile from "proper-lockfile";
import type { Logger } from "../logger.js";
import {
  credentialConfigArgs,
  credentialConfigEnv,
  GitError,
  gitEnv,
  runGit,
  runShell,
} from "./git.js";

/** Directory (under `workspaceRoot`) holding one git worktree per running job. */
export const WORKTREES_DIR = ".worktrees";
/** Directory (under `workspaceRoot`) holding the long-lived branch worktrees of ralph runs. */
export const BRANCHES_DIR = ".branches";
const LOCKS_DIR = ".locks";
/** Where fetches put the remote's branches, so `origin/<branch>` resolves in worktrees. */
const FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";
/** Marks a branch worktree whose setup command hasn't finished (in its git dir). */
const SETUP_PENDING = "omniralph-setup-pending";
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

export interface BranchWorktreeOptions extends GitJobOptions {
  /** The local branch checked out in the worktree (and pushed to `origin`). */
  branch: string;
  /** Branch to start from when `origin/<branch>` doesn't exist yet. */
  baseBranch: string;
  /** Runs once (`bash -lc`) in a newly created worktree. */
  setupCommand?: string;
}

/** A long-lived worktree on a branch, reused across jobs (see `withBranchWorktree`). */
export interface BranchWorktree {
  branch: string;
  baseBranch: string;
  /** `<workspaceRoot>/.branches/<provider>/<repo path>/<branch with "/" → "__">` */
  path: string;
  repoDir: string;
  /** True when this call created the worktree (and ran the setup command). */
  created: boolean;
  /**
   * Stashes uncommitted changes (including untracked files) with `label` as
   * the message. Returns the stash commit SHA, or `null` when the tree is clean.
   */
  stashWork(label: string): Promise<string | null>;
  /** Reapplies a stash made by `stashWork` and drops it from the stash list. */
  applyStash(sha: string): Promise<void>;
}

/**
 * The local branch and `origin/<branch>` both have commits the other doesn't
 * (e.g. someone force-pushed). Retrying won't help, so this fails the job.
 */
export class BranchDivergedError extends Error {
  override name = "BranchDivergedError";
  constructor(
    readonly branch: string,
    readonly ahead: number,
    readonly behind: number,
  ) {
    super(
      `local branch ${branch} has diverged from origin/${branch} (${ahead} local commit(s) not on the remote, ` +
        `${behind} remote commit(s) not local); reconcile the branch on the remote or remove the agent's worktree`,
    );
  }
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

  /** `<workspaceRoot>/.branches/<provider>/<repo path>/<branch with "/" → "__">` */
  branchWorktreePath(repo: Pick<JobRepository, "provider" | "fullPath">, branch: string): string {
    const relative = path.relative(this.workspaceRoot, this.repoDir(repo));
    return path.join(this.workspaceRoot, BRANCHES_DIR, relative, branch.replaceAll("/", "__"));
  }

  /**
   * Runs `fn` in the long-lived worktree of `branch`, which stays in place for
   * the next job. After a fetch, the worktree is created from
   * `origin/<branch>` when the remote has that branch, otherwise from
   * `origin/<baseBranch>` (an empty repository first gets an initial commit on
   * `baseBranch`, pushed to `origin`); `setupCommand` then runs once, and a
   * failure removes the worktree again. A reused worktree is fast-forwarded
   * to `origin/<branch>` when the remote is ahead; a diverged branch throws
   * `BranchDivergedError`. Calls for the same branch are serialized for the
   * whole of `fn` (in-process and through a file lock).
   */
  async withBranchWorktree<T>(
    repo: JobRepository,
    options: BranchWorktreeOptions,
    fn: (worktree: BranchWorktree) => Promise<T>,
  ): Promise<T> {
    await this.checkBranchName(options.branch);
    await this.checkBranchName(options.baseBranch);
    if (options.branch === options.baseBranch) {
      throw new Error(`branch ${options.branch} is the base branch`);
    }
    const worktreePath = this.branchWorktreePath(repo, options.branch);
    return this.withLock(worktreePath, options.signal, async () => {
      const worktree = await this.openBranchWorktree(repo, worktreePath, options);
      return fn(worktree);
    });
  }

  /**
   * Deletes a branch worktree and its local branch (for cleanup once the
   * branch is merged). Waits for a job using the worktree to finish.
   */
  async removeBranchWorktree(
    repo: JobRepository,
    branch: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.checkBranchName(branch);
    const worktreePath = this.branchWorktreePath(repo, branch);
    await this.withLock(worktreePath, options.signal, () =>
      this.removeBranchWorktreeLocked(repo, worktreePath, branch),
    );
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
   * (branch worktrees under `.branches` are kept) and leftover partial clones, then runs `git worktree prune` in each cached
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

  private async checkBranchName(branch: string): Promise<void> {
    // check-ref-format also rules out "..", leading dots and the like, which keeps paths safe.
    const valid = await runGit(["check-ref-format", "--branch", branch], {
      env: hostEnv(),
      git: this.git,
    }).then(
      (normalized) => normalized.trim() === branch && !branch.startsWith("-"),
      () => false,
    );
    if (!valid) throw new Error(`invalid branch name ${JSON.stringify(branch)}`);
  }

  /** Called with the worktree lock held. */
  private async openBranchWorktree(
    repo: JobRepository,
    worktreePath: string,
    options: BranchWorktreeOptions,
  ): Promise<BranchWorktree> {
    const repoDir = this.repoDir(repo);
    const { branch, baseBranch } = options;
    const job = { env: options.env, signal: options.signal };
    const git = (args: string[]) => this.runGit(args, { ...job, cwd: worktreePath });
    let created = false;

    await this.withRepoLock(repo, options.signal, async () => {
      // Fetch every branch first: a reused worktree compares itself with the remote.
      await this.syncLocked(repo, [], job);
      if (await this.isBranchWorktree(worktreePath, branch, job)) return;
      await this.createBranchWorktree(repoDir, worktreePath, options);
      created = true;
    });

    if (created) {
      // The checkout (which lazily fetches blobs) and the setup command run outside the repo lock.
      try {
        await git(["reset", "--hard", "--quiet", "HEAD"]);
        if (options.setupCommand) {
          this.logger?.info({ path: worktreePath }, "running the repository's setup command");
          await runShell(options.setupCommand, {
            cwd: worktreePath,
            env: this.gitEnv(options.env),
            signal: options.signal,
          });
        }
        await rm(await this.setupMarker(worktreePath, job), { force: true });
      } catch (error) {
        await this.removeBranchWorktreeLocked(repo, worktreePath, branch).catch(
          (cleanupError: unknown) =>
            this.logger?.warn({ err: cleanupError, path: worktreePath }, "worktree cleanup failed"),
        );
        throw error;
      }
    } else {
      await this.fastForward(worktreePath, branch, job);
    }

    return {
      branch,
      baseBranch,
      path: worktreePath,
      repoDir,
      created,
      stashWork: (label) => this.stashWork(worktreePath, label, job),
      applyStash: (sha) => this.applyStash(worktreePath, sha, job),
    };
  }

  /**
   * True when `worktreePath` is a usable worktree on `branch`. Anything else
   * there (a half-created worktree, or one whose setup never finished) is
   * removed so it can be created again.
   */
  private async isBranchWorktree(
    worktreePath: string,
    branch: string,
    options: GitJobOptions,
  ): Promise<boolean> {
    if (await exists(path.join(worktreePath, ".git"))) {
      const head = await this.runGit(["symbolic-ref", "--quiet", "HEAD"], {
        ...options,
        cwd: worktreePath,
      }).catch(() => "");
      if (
        head.trim() === `refs/heads/${branch}` &&
        !(await exists(await this.setupMarker(worktreePath, options)))
      ) {
        return true;
      }
      this.logger?.warn({ path: worktreePath }, "recreating an incomplete branch worktree");
    }
    await rm(worktreePath, { recursive: true, force: true });
    return false;
  }

  /** Called with the repo lock held; leaves the new worktree checked out with `--no-checkout`. */
  private async createBranchWorktree(
    repoDir: string,
    worktreePath: string,
    options: BranchWorktreeOptions,
  ): Promise<void> {
    const { branch, baseBranch } = options;
    const job = { env: options.env, signal: options.signal };
    const git = (args: string[]) => this.runGit(args, { ...job, cwd: repoDir });
    const hasRef = (ref: string) =>
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
        () => true,
        () => false,
      );

    let start = `refs/remotes/origin/${branch}`;
    if (!(await hasRef(start))) {
      start = `refs/remotes/origin/${baseBranch}`;
      if (!(await hasRef(start))) await this.createInitialCommit(repoDir, baseBranch, job);
    }
    // Drops the bookkeeping of a worktree whose directory is gone, which would block the branch.
    await git(["worktree", "prune"]);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    this.logger?.info({ path: worktreePath, branch, start }, "creating branch worktree");
    // -B: a local branch left in the bare repository (e.g. by the clone) starts over from `start`.
    await git(["worktree", "add", "--no-checkout", "-B", branch, worktreePath, start]);
    await writeFile(await this.setupMarker(worktreePath, job), "");
  }

  /**
   * Gives an empty repository its first (empty) commit on `baseBranch`, pushed
   * to `origin`. A repository with commits is left alone: its base branch is
   * just missing, which is a configuration mistake.
   */
  private async createInitialCommit(
    repoDir: string,
    baseBranch: string,
    options: GitJobOptions,
  ): Promise<void> {
    const git = (args: string[]) => this.runGit(args, { ...options, cwd: repoDir });
    const refs = await git(["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes"]);
    if (refs.trim()) throw new Error(`base branch ${baseBranch} doesn't exist on origin`);
    const emptyTree = (await git(["hash-object", "-t", "tree", "/dev/null"])).trim();
    const sha = (await git(["commit-tree", emptyTree, "-m", "Initial commit"])).trim();
    await git(["push", "--quiet", "origin", `${sha}:refs/heads/${baseBranch}`]);
    await git(["update-ref", `refs/remotes/origin/${baseBranch}`, sha]);
  }

  /** Brings a reused worktree up to `origin/<branch>`, or throws when they have diverged. */
  private async fastForward(
    worktreePath: string,
    branch: string,
    options: GitJobOptions,
  ): Promise<void> {
    const git = (args: string[]) => this.runGit(args, { ...options, cwd: worktreePath });
    const remote = `refs/remotes/origin/${branch}`;
    // Not pushed yet: nothing to catch up with.
    if (
      !(await git(["rev-parse", "--verify", "--quiet", remote]).then(
        () => true,
        () => false,
      ))
    )
      return;
    const counts = await git(["rev-list", "--left-right", "--count", `HEAD...${remote}`]);
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
    if (behind === 0) return;
    if (ahead > 0) throw new BranchDivergedError(branch, ahead, behind);
    this.logger?.info({ path: worktreePath, branch, behind }, "fast-forwarding branch worktree");
    await git(["merge", "--ff-only", "--quiet", remote]);
  }

  /** Called with the worktree lock (but not the repo lock) held. */
  private async removeBranchWorktreeLocked(
    repo: JobRepository,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    const repoDir = this.repoDir(repo);
    await rm(worktreePath, { recursive: true, force: true });
    if (!(await exists(repoDir))) return;
    const options = { env: hostEnv(), cwd: repoDir };
    await this.withLock(repoDir, undefined, async () => {
      await this.runGit(["worktree", "prune"], options);
      const local = await this.runGit(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        options,
      ).then(
        () => true,
        () => false,
      );
      if (local) await this.runGit(["branch", "-D", branch], options);
    });
  }

  private async setupMarker(worktreePath: string, options: GitJobOptions): Promise<string> {
    const gitDir = await this.runGit(["rev-parse", "--absolute-git-dir"], {
      ...options,
      cwd: worktreePath,
    });
    return path.join(gitDir.trim(), SETUP_PENDING);
  }

  private async stashWork(
    worktreePath: string,
    label: string,
    options: GitJobOptions,
  ): Promise<string | null> {
    const git = (args: string[]) => this.runGit(args, { ...options, cwd: worktreePath });
    if (!(await git(["status", "--porcelain", "--untracked-files=all"])).trim()) return null;
    const before = new Set(await this.stashShas(worktreePath, options));
    await git(["stash", "push", "--quiet", "--include-untracked", "-m", label]);
    // Every worktree of the repository shares the stash list, so stash@{0} may not be ours.
    const list = await git(["stash", "list", "--format=%H%x1f%gs"]);
    for (const line of list.split("\n")) {
      const [sha = "", subject = ""] = line.split("\x1f");
      if (sha && !before.has(sha) && subject.endsWith(`: ${label}`)) return sha;
    }
    throw new Error(`stashed "${label}", but the entry isn't in the stash list`);
  }

  private async applyStash(
    worktreePath: string,
    sha: string,
    options: GitJobOptions,
  ): Promise<void> {
    if (!SHA.test(sha)) throw new Error(`invalid stash SHA ${sha}`);
    const git = (args: string[]) => this.runGit(args, { ...options, cwd: worktreePath });
    await git(["stash", "apply", "--quiet", sha]);
    // Indexes shift as entries come and go, so look the entry up right before dropping it.
    const index = (await this.stashShas(worktreePath, options)).indexOf(sha);
    if (index >= 0) await git(["stash", "drop", "--quiet", `stash@{${index}}`]);
  }

  private async stashShas(worktreePath: string, options: GitJobOptions): Promise<string[]> {
    const list = await this.runGit(["stash", "list", "--format=%H"], {
      ...options,
      cwd: worktreePath,
    });
    return list.split("\n").filter(Boolean);
  }

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
      // Bare clones have no fetch refspec. Fetch branches as `origin/<branch>`, so a branch
      // checked out in a branch worktree is never overwritten by a fetch.
      await this.runGit(["config", "remote.origin.fetch", FETCH_REFSPEC], { ...options, cwd: tmp });
      await this.runGit(["fetch", "--quiet", "--filter=blob:none", "--no-tags", "origin"], {
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
    // Caches cloned before branch worktrees fetched into refs/heads/*.
    await git(["config", "--replace-all", "remote.origin.fetch", FETCH_REFSPEC]);
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
