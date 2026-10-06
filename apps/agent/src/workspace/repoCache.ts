import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobRepository } from "@omniralph/shared";
import lockfile from "proper-lockfile";
import { withoutJobEnv } from "../job-env.js";
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

/**
 * The `pre-push` hook of the cached repositories (shared by their
 * worktrees): in a branch worktree, a push may only update that worktree's
 * own branch. A guardrail against mistakes (a request session pushing the
 * base branch), not a security boundary: sessions run with
 * `bypassPermissions` and could remove it.
 */
export const PUSH_GUARD_HOOK = `#!/bin/sh
# Installed by the Omniralph agent: a branch worktree only pushes its own branch.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
here=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
# The bare repository itself (e.g. an empty repository's first commit) isn't a branch worktree.
[ "$common" = "$here" ] && exit 0
branch=$(git symbolic-ref --quiet HEAD) || exit 0
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" != "$branch" ]; then
    echo "omniralph: this worktree may only push \${branch#refs/heads/}, not \${remote_ref#refs/heads/}." >&2
    status=1
  fi
done
exit $status
`;
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

/**
 * Per-call override of a branch worktree operation: `signal: null` runs it
 * without the job's signal (e.g. to stash the work of a canceled job).
 */
export interface WorktreeCallOptions {
  signal?: AbortSignal | null;
}

/** An entry of the stash list (shared by every worktree of the repository). */
export interface StashEntry {
  sha: string;
  /** The message it was stashed with (without git's `On <branch>: ` prefix). */
  label: string;
  /** When it was stashed (ISO 8601). */
  date: string;
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
  stashWork(label: string, options?: WorktreeCallOptions): Promise<string | null>;
  /** Reapplies a stash made by `stashWork` and drops it from the stash list. */
  applyStash(sha: string): Promise<void>;
  /** The stash list, newest first. */
  listStashes(options?: WorktreeCallOptions): Promise<StashEntry[]>;
  /** Drops the stash entry with this SHA; false when it isn't in the list (anymore). */
  dropStash(sha: string, options?: WorktreeCallOptions): Promise<boolean>;
  /**
   * Runs git in the worktree with the job's environment and only the agent's
   * credential helper (so `git push` authenticates through the broker).
   */
  git(args: readonly string[], options?: WorktreeCallOptions): Promise<string>;
}

export interface BranchCleanupOptions extends GitJobOptions {
  branch: string;
  /** The merged PR/MR head: commits of the local branch it doesn't have keep the branch. */
  mergedSha: string;
  /** Message of the stash entry holding the worktree's uncommitted changes. */
  stashLabel: string;
}

/** What `cleanupBranchWorktree` did. */
export interface BranchCleanup {
  /** The worktree was there (it's removed now). */
  removedWorktree: boolean;
  /** The local branch was there. */
  hadBranch: boolean;
  /** The worktree's uncommitted changes, stashed; null when it was clean (or gone). */
  stashed: string | null;
  /** Commits of the local branch the merged head doesn't have; the branch is kept when > 0. */
  unmerged: number;
}

/** Identity for commits the agent makes on hosts without a git `user.name`/`user.email`. */
const FALLBACK_IDENTITY = ["-c", "user.name=Omniralph", "-c", "user.email=omniralph@localhost"];

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

/** Writes `PUSH_GUARD_HOOK` as the repository's `pre-push` hook (unless it's there already). */
async function installPushGuard(repoDir: string): Promise<void> {
  const hook = path.join(repoDir, "hooks", "pre-push");
  if ((await readFile(hook, "utf8").catch(() => null)) === PUSH_GUARD_HOOK) return;
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, PUSH_GUARD_HOOK);
  await chmod(hook, 0o755);
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

/** The job's git options with a call's signal override applied. */
function withCall(job: GitJobOptions, call: WorktreeCallOptions | undefined): GitJobOptions {
  if (!call || !("signal" in call)) return job;
  return { env: job.env, signal: call.signal ?? undefined };
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
   * Cleanup after a branch's PR/MR merged (ported from cyralph's
   * `removeWorkspace`): the worktree's uncommitted changes are stashed, the
   * worktree is removed, and the local branch is deleted unless it has commits
   * `mergedSha` doesn't (then it's kept, and they're counted). A repository
   * this agent never cloned has nothing to clean up: it isn't cloned for it.
   */
  async cleanupBranchWorktree(
    repo: JobRepository,
    options: BranchCleanupOptions,
  ): Promise<BranchCleanup> {
    const { branch, mergedSha } = options;
    await this.checkBranchName(branch);
    if (!SHA.test(mergedSha)) throw new Error(`invalid commit SHA ${mergedSha}`);
    const nothing: BranchCleanup = {
      removedWorktree: false,
      hadBranch: false,
      stashed: null,
      unmerged: 0,
    };
    const repoDir = this.repoDir(repo);
    if (!(await exists(path.join(repoDir, "HEAD")))) return nothing;
    const job = { env: options.env, signal: options.signal };
    const worktreePath = this.branchWorktreePath(repo, branch);
    return this.withLock(worktreePath, options.signal, async () => {
      const hasWorktree = await exists(path.join(worktreePath, ".git"));
      const stashed = hasWorktree
        ? await this.stashWork(worktreePath, options.stashLabel, job)
        : null;
      return this.withRepoLock(repo, options.signal, async () => {
        const git = (args: string[]) => this.runGit(args, { ...job, cwd: repoDir });
        const tip = (
          await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "")
        ).trim();
        let unmerged = 0;
        if (tip && tip !== mergedSha) {
          // The merged head may only be on the remote (e.g. pushed by someone else).
          if ((await this.missingCommits(repoDir, [mergedSha], job)).length > 0) {
            await this.fetch(repoDir, [mergedSha], job);
          }
          const merged = await git(["merge-base", "--is-ancestor", tip, mergedSha]).then(
            () => true,
            () => false,
          );
          if (!merged) {
            const count = await git(["rev-list", "--count", tip, `^${mergedSha}`]);
            unmerged = Number(count.trim()) || 1;
          }
        }
        await rm(worktreePath, { recursive: true, force: true });
        await git(["worktree", "unlock", worktreePath]).catch(() => undefined);
        await git(["worktree", "prune"]);
        if (tip && unmerged === 0) await git(["branch", "-D", branch]);
        if (hasWorktree || tip) {
          this.logger?.info(
            { path: worktreePath, branch, unmerged, stashed },
            "cleaned up a merged branch worktree",
          );
        }
        return { removedWorktree: hasWorktree, hadBranch: !!tip, stashed, unmerged };
      });
    });
  }

  /** The repository's stash list (shared by its worktrees), newest first; empty when it isn't cloned. */
  async listRepoStashes(repo: JobRepository, options: GitJobOptions): Promise<StashEntry[]> {
    const repoDir = this.repoDir(repo);
    if (!(await exists(path.join(repoDir, "HEAD")))) return [];
    return this.withRepoLock(repo, options.signal, () => this.repoStashes(repoDir, options));
  }

  /**
   * Drops stash entries by SHA (those no longer in the list are skipped);
   * returns how many were dropped. Works without a worktree.
   */
  async dropRepoStashes(
    repo: JobRepository,
    shas: readonly string[],
    options: GitJobOptions,
  ): Promise<number> {
    for (const sha of shas) if (!SHA.test(sha)) throw new Error(`invalid stash SHA ${sha}`);
    const repoDir = this.repoDir(repo);
    if (!(await exists(path.join(repoDir, "HEAD")))) return 0;
    return this.withRepoLock(repo, options.signal, async () => {
      const git = (args: string[]) => this.runGit(args, { ...options, cwd: repoDir });
      let dropped = 0;
      for (const sha of shas) {
        // Indexes shift as entries go, so look the entry up right before dropping it.
        const index = (await this.repoStashes(repoDir, options)).findIndex((e) => e.sha === sha);
        if (index < 0) continue;
        // What `git stash drop` does, which needs a work tree.
        await git(["reflog", "delete", "--updateref", "--rewrite", `refs/stash@{${index}}`]);
        dropped += 1;
      }
      if (dropped > 0 && (await this.repoStashes(repoDir, options)).length === 0) {
        await git(["update-ref", "-d", "refs/stash"]).catch(() => undefined);
      }
      return dropped;
    });
  }

  /**
   * Pushes stash entries to `branch` on `origin` (ported from cyralph's
   * `pushStashes`): one commit per entry, oldest first, on top of the
   * branch's tip there (or the entry's base when the branch is new), with
   * the tracked and untracked files of the entry. The entries stay stashed.
   */
  async pushStashes(
    repo: JobRepository,
    branch: string,
    entries: readonly StashEntry[],
    options: GitJobOptions,
  ): Promise<void> {
    await this.checkBranchName(branch);
    if (entries.length === 0) return;
    const repoDir = this.repoDir(repo);
    await this.withRepoLock(repo, options.signal, async () => {
      const git = (args: string[], env: NodeJS.ProcessEnv = options.env) =>
        this.runGit(args, { ...options, env, cwd: repoDir }).then((out) => out.trim());
      const existing = await git(["fetch", "--quiet", "origin", `refs/heads/${branch}`]).then(
        () => git(["rev-parse", "FETCH_HEAD"]),
        () => null,
      );
      let tip = existing;
      const identity = await git(["config", "--get", "user.email"]).then(
        (email) => (email ? [] : FALLBACK_IDENTITY),
        () => FALLBACK_IDENTITY,
      );
      const index = path.join(this.workspaceRoot, TMP_DIR, `stash-index-${randomUUID()}`);
      await mkdir(path.dirname(index), { recursive: true });
      try {
        for (const entry of [...entries].reverse()) {
          if (!SHA.test(entry.sha)) throw new Error(`invalid stash SHA ${entry.sha}`);
          const env = { ...options.env, GIT_INDEX_FILE: index };
          // A stash commit's tree has the tracked files; its third parent, if any, the untracked ones.
          const untracked = await git(["rev-parse", "--verify", "--quiet", `${entry.sha}^3`]).then(
            () => true,
            () => false,
          );
          const trees = [`${entry.sha}^{tree}`, ...(untracked ? [`${entry.sha}^3^{tree}`] : [])];
          await git(["read-tree", ...trees], env);
          const tree = await git(["write-tree"], env);
          const base = await git(["rev-parse", `${entry.sha}^1`]);
          const message = `${entry.label}\n\nStash ${entry.sha} from ${entry.date}, made on top of ${base}.`;
          tip = await git([...identity, "commit-tree", tree, "-p", tip ?? base, "-m", message]);
          await rm(index, { force: true });
        }
      } finally {
        await rm(index, { force: true });
      }
      await git(["push", "--quiet", "origin", `${tip}:refs/heads/${branch}`]);
    });
  }

  /** Pushes the local `branch` to `origin` (e.g. a kept branch with unmerged commits). */
  async pushBranch(repo: JobRepository, branch: string, options: GitJobOptions): Promise<void> {
    await this.checkBranchName(branch);
    const repoDir = this.repoDir(repo);
    if (!(await exists(path.join(repoDir, "HEAD")))) {
      throw new Error(`${repo.fullPath} isn't cloned on this agent`);
    }
    await this.withRepoLock(repo, options.signal, () =>
      this.runGit(["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`], {
        ...options,
        cwd: repoDir,
      }),
    );
  }

  /** Deletes the local `branch`; one that's already gone is fine. */
  async deleteBranch(repo: JobRepository, branch: string, options: GitJobOptions): Promise<void> {
    await this.checkBranchName(branch);
    const repoDir = this.repoDir(repo);
    if (!(await exists(path.join(repoDir, "HEAD")))) return;
    await this.withRepoLock(repo, options.signal, async () => {
      const git = (args: string[]) => this.runGit(args, { ...options, cwd: repoDir });
      const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(
        () => true,
        () => false,
      );
      if (local) await git(["branch", "-D", branch]);
    });
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
      await installPushGuard(repoDir);
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
          // Like the session and gates, the setup command never sees the job token.
          await runShell(options.setupCommand, {
            cwd: worktreePath,
            env: withoutJobEnv(options.env),
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
      stashWork: (label, call) => this.stashWork(worktreePath, label, withCall(job, call)),
      applyStash: (sha) => this.applyStash(worktreePath, sha, job),
      listStashes: (call) => this.listStashes(worktreePath, withCall(job, call)),
      dropStash: (sha, call) => this.dropStash(worktreePath, sha, withCall(job, call)),
      git: (args, call) => this.runGit([...args], { ...withCall(job, call), cwd: worktreePath }),
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
    // Drops the bookkeeping of a worktree whose directory is gone, which would block the branch
    // (unlocked first: branch worktrees are locked).
    await git(["worktree", "unlock", worktreePath]).catch(() => undefined);
    await git(["worktree", "prune"]);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    this.logger?.info({ path: worktreePath, branch, start }, "creating branch worktree");
    // -B: a local branch left in the bare repository (e.g. by the clone) starts over from `start`.
    // --lock: git never prunes a long-lived worktree's bookkeeping (e.g. while its disk is unmounted).
    await git(["worktree", "add", "--lock", "--no-checkout", "-B", branch, worktreePath, start]);
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
      await this.runGit(["worktree", "unlock", worktreePath], options).catch(() => undefined);
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

  private async listStashes(worktreePath: string, options: GitJobOptions): Promise<StashEntry[]> {
    const list = await this.runGit(["stash", "list", "--format=%H%x1f%cI%x1f%gs"], {
      ...options,
      cwd: worktreePath,
    });
    return list
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", date = "", subject = ""] = line.split("\x1f");
        // `git stash push -m` records "On <branch>: <message>".
        return { sha, date, label: subject.replace(/^On [^:]*: /, "") };
      });
  }

  private async dropStash(
    worktreePath: string,
    sha: string,
    options: GitJobOptions,
  ): Promise<boolean> {
    if (!SHA.test(sha)) throw new Error(`invalid stash SHA ${sha}`);
    const index = (await this.stashShas(worktreePath, options)).indexOf(sha);
    if (index < 0) return false;
    await this.runGit(["stash", "drop", "--quiet", `stash@{${index}}`], {
      ...options,
      cwd: worktreePath,
    });
    return true;
  }

  /** The stash list read from the repository itself (`git stash` needs a work tree). */
  private async repoStashes(repoDir: string, options: GitJobOptions): Promise<StashEntry[]> {
    const git = (args: string[]) => this.runGit(args, { ...options, cwd: repoDir });
    const has = await git(["rev-parse", "--verify", "--quiet", "refs/stash"]).then(
      () => true,
      () => false,
    );
    if (!has) return [];
    const list = await git(["log", "-g", "--format=%H%x1f%cI%x1f%gs", "refs/stash", "--"]);
    return list
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", date = "", subject = ""] = line.split("\x1f");
        return { sha, date, label: subject.replace(/^On [^:]*: /, "") };
      });
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
