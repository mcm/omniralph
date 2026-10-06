import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JobRepository } from "@omniralph/shared";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV, exists, git, Remote } from "../test/git-remote.js";
import { BranchDivergedError, RepoCache, type Worktree } from "./repoCache.js";

// Every test spawns real `git` processes; when all packages' suites run at once under
// `pnpm test`, one test can take well over the default 5s timeout.
describe("RepoCache", { timeout: 30_000 }, () => {
  let root: string;
  let workspaceRoot: string;
  let remote: Remote;
  let repo: JobRepository;
  const opts = { env: ENV };

  function cache(extra: Partial<ConstructorParameters<typeof RepoCache>[0]> = {}) {
    return new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20, ...extra });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-repocache-"));
    workspaceRoot = path.join(root, "workspace");
    remote = new Remote(root);
    remote.init();
    repo = {
      provider: "gitlab",
      fullPath: "group/sub/app",
      cloneUrl: pathToFileURL(remote.bare).href,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clones blobless into <workspaceRoot>/<provider>/<path> on first use, then fetches the needed SHAs", async () => {
    const first = await remote.commit({ "README.md": "one\n" });
    const repos = cache();
    const dir = path.join(workspaceRoot, "gitlab", "group", "sub", "app");
    expect(repos.repoDir(repo)).toBe(dir);

    expect(await repos.sync(repo, { ...opts, shas: [first] })).toEqual({
      dir,
      cloned: true,
      fetched: false,
    });
    expect(git(dir, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(dir, "config", "remote.origin.partialclonefilter")).toBe("blob:none");
    expect(git(dir, "cat-file", "-t", first)).toBe("commit");

    // Everything present: no fetch.
    expect(await repos.sync(repo, { ...opts, shas: [first] })).toEqual({
      dir,
      cloned: false,
      fetched: false,
    });

    const second = await remote.commit({ "README.md": "two\n" });
    expect(await repos.sync(repo, { ...opts, shas: [first, second] })).toEqual({
      dir,
      cloned: false,
      fetched: true,
    });
    expect(git(dir, "cat-file", "-t", second)).toBe("commit");

    // A commit only reachable from an unfetched ref is fetched by SHA.
    const prHead = await remote.unadvertisedCommit();
    expect((await repos.sync(repo, { ...opts, shas: [prHead] })).fetched).toBe(true);
    expect(git(dir, "cat-file", "-t", prHead)).toBe("commit");

    // repo.sync without SHAs fetches every branch.
    const third = await remote.commit({ "README.md": "three\n" }, "main");
    expect(await repos.sync(repo, opts)).toEqual({ dir, cloned: false, fetched: true });
    expect(git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(third);
  });

  it("creates a detached worktree at <workspaceRoot>/.worktrees/<jobId> and removes it", async () => {
    const first = await remote.commit({ "src/a.ts": "export const a = 1;\n" });
    const second = await remote.commit({ "src/a.ts": "export const a = 2;\n" });
    const repos = cache();
    const worktree = await repos.createWorktree(repo, first, { ...opts, jobId: "job-1" });
    expect(worktree.path).toBe(path.join(workspaceRoot, ".worktrees", "job-1"));
    expect(await readFile(path.join(worktree.path, "src/a.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(first);
    expect(git(worktree.path, "status", "--porcelain")).toBe("");

    const other = await repos.createWorktree(repo, second, { ...opts, jobId: "job-2" });
    expect(await readFile(path.join(other.path, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");

    await repos.removeWorktree(worktree);
    await repos.removeWorktree(worktree); // idempotent
    expect(await exists(worktree.path)).toBe(false);
    const listed = git(worktree.repoDir, "worktree", "list", "--porcelain");
    expect(listed).not.toContain(worktree.path);
    expect(listed).toContain(other.path);
    await repos.removeWorktree(other);
  });

  it("removes the worktree when the job fails or is aborted", async () => {
    const sha = await remote.commit({ "a.txt": "a\n" });
    const repos = cache();
    const controller = new AbortController();
    let seen: Worktree | undefined;
    await expect(
      repos.withWorktree(
        repo,
        sha,
        { ...opts, jobId: "aborted", signal: controller.signal },
        async (wt) => {
          seen = wt;
          expect(await exists(path.join(wt.path, "a.txt"))).toBe(true);
          controller.abort(new Error("job canceled"));
          controller.signal.throwIfAborted();
        },
      ),
    ).rejects.toThrow("job canceled");
    expect(await exists(seen!.path)).toBe(false);
    expect(git(seen!.repoDir, "worktree", "list", "--porcelain")).not.toContain(seen!.path);

    await expect(
      repos.withWorktree(repo, sha, { ...opts, jobId: "failed" }, async () => {
        throw new Error("review failed");
      }),
    ).rejects.toThrow("review failed");
    expect(await exists(repos.worktreePath("failed"))).toBe(false);

    // Aborted while git is running (a slow checkout): nothing is left behind.
    const slow = new AbortController();
    const slowGit = path.join(root, "slow-git");
    await writeFile(
      slowGit,
      `#!/bin/sh\ncase "$*" in *"reset --hard"*) exec sleep 5;; esac\nexec git "$@"\n`,
    );
    await chmod(slowGit, 0o755);
    const pending = cache({ git: slowGit }).createWorktree(repo, sha, {
      ...opts,
      jobId: "aborted-mid-git",
      signal: slow.signal,
    });
    setTimeout(() => slow.abort(new Error("canceled mid-checkout")), 300);
    await expect(pending).rejects.toThrow("canceled mid-checkout");
    expect(await exists(repos.worktreePath("aborted-mid-git"))).toBe(false);
    expect(git(repos.repoDir(repo), "worktree", "list", "--porcelain")).not.toContain(
      "aborted-mid-git",
    );

    // An unknown commit fails creation without leaving a worktree.
    await expect(
      repos.createWorktree(repo, "0".repeat(40), { ...opts, jobId: "missing" }),
    ).rejects.toThrow();
    expect(await exists(repos.worktreePath("missing"))).toBe(false);
  }, 20_000);

  it("serializes clone and fetch per repository across concurrent jobs and processes", async () => {
    const shas = [
      await remote.commit({ "a.txt": "1\n" }),
      await remote.commit({ "a.txt": "2\n" }),
      await remote.commit({ "a.txt": "3\n" }),
    ];
    // A git wrapper that logs when clone/fetch/worktree commands start and end, slowly.
    const log = path.join(root, "git.log");
    const loggingGit = path.join(root, "logging-git");
    await writeFile(
      loggingGit,
      [
        "#!/bin/sh",
        `case "$*" in *" clone "*) op=clone;; *" fetch "*) op=fetch;; *" worktree add "*) op=worktree;; *) op=;; esac`,
        `if [ -n "$op" ]; then echo "start $$ $op" >> "${log}"; sleep 0.2; fi`,
        `git "$@"; code=$?`,
        `if [ -n "$op" ]; then echo "end $$ $op" >> "${log}"; fi`,
        `exit $code`,
      ].join("\n"),
    );
    await chmod(loggingGit, 0o755);

    // Two caches on one workspace stand in for two agent processes.
    const a = cache({ git: loggingGit });
    const b = cache({ git: loggingGit });
    const worktrees = await Promise.all([
      a.createWorktree(repo, shas[0]!, { ...opts, jobId: "a1" }),
      b.createWorktree(repo, shas[1]!, { ...opts, jobId: "b1" }),
      a.createWorktree(repo, shas[2]!, { ...opts, jobId: "a2" }),
      b.sync(repo, opts),
    ]);
    expect(worktrees).toHaveLength(4);
    for (const [i, jobId] of ["a1", "b1", "a2"].entries()) {
      expect(await readFile(path.join(workspaceRoot, ".worktrees", jobId, "a.txt"), "utf8")).toBe(
        `${i + 1}\n`,
      );
    }

    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    // Never two locked git operations at once: starts and ends strictly alternate.
    lines.forEach((line, i) => expect(line.startsWith(i % 2 === 0 ? "start" : "end")).toBe(true));
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]!.split(" ")[1]).toBe(lines[i + 1]!.split(" ")[1]);
    }
    // Exactly one clone; the other jobs fetched what they needed.
    expect(
      lines.filter((line) => line.startsWith("start") && line.endsWith(" clone")),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.startsWith("start") && line.endsWith(" worktree")),
    ).toHaveLength(3);
  });

  it("waits for a repo lock held by another process", async () => {
    const sha = await remote.commit({ "a.txt": "a\n" });
    const repos = cache();
    const dir = repos.repoDir(repo);
    const lockfilePath = path.join(workspaceRoot, ".locks", "gitlab", "group", "sub", "app.lock");
    await mkdir(path.dirname(lockfilePath), { recursive: true });
    const release = await lockfile.lock(dir, { realpath: false, lockfilePath });
    let done = false;
    const pending = repos.sync(repo, { ...opts, shas: [sha] }).then((result) => {
      done = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    expect(await exists(path.join(dir, "HEAD"))).toBe(false);
    await release();
    expect((await pending).cloned).toBe(true);

    // An abort while waiting for the lock rejects without touching the repo.
    const again = await lockfile.lock(dir, { realpath: false, lockfilePath });
    const controller = new AbortController();
    const waiting = repos.sync(repo, { ...opts, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("canceled while waiting")), 100);
    await expect(waiting).rejects.toThrow("canceled while waiting");
    await again();
  });

  it("prunes worktrees left behind by a crash on startup", async () => {
    const sha = await remote.commit({ "a.txt": "a\n" });
    const crashed = await cache().createWorktree(repo, sha, { ...opts, jobId: "crashed" });
    await mkdir(path.join(workspaceRoot, ".tmp", "half-clone"), { recursive: true });

    const removed = await cache().pruneStaleWorktrees();
    expect(removed).toEqual([crashed.path]);
    expect(await exists(crashed.path)).toBe(false);
    expect(await exists(path.join(workspaceRoot, ".tmp"))).toBe(false);
    expect(git(crashed.repoDir, "worktree", "list", "--porcelain")).not.toContain("crashed");
    // The cache itself survives and is reused.
    expect((await cache().sync(repo, { ...opts, shas: [sha] })).cloned).toBe(false);

    // A fresh workspace has nothing to prune (and nothing is created).
    const empty = new RepoCache({
      workspaceRoot: path.join(root, "none"),
      credentialHelper: "!true",
    });
    expect(await empty.pruneStaleWorktrees()).toEqual([]);
    expect(await exists(path.join(root, "none"))).toBe(false);
  });

  it("rejects repository paths and job IDs that would escape the workspace", () => {
    const repos = cache();
    for (const fullPath of ["../etc", "group/../../x", "/abs/path", "group/.git", "a//b"]) {
      expect(() => repos.repoDir({ provider: "github", fullPath })).toThrow(
        /invalid repository path/,
      );
    }
    expect(() => repos.repoDir({ provider: "bitbucket" as "github", fullPath: "a/b" })).toThrow();
    expect(() => repos.worktreePath("../x")).toThrow(/invalid job ID/);
  });

  it("gives other git commands an environment with only the agent's credential helper", async () => {
    const first = await remote.commit({ "README.md": "one\n" });
    const repos = cache({ credentialHelper: "!omniralph-agent git-credential" });
    const env = repos.gitEnv({ ...ENV, GIT_ASKPASS: "/usr/bin/askpass", OMNIRALPH_JOB_TOKEN: "t" });
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.OMNIRALPH_JOB_TOKEN).toBe("t");

    await repos.withWorktree(repo, first, { ...opts, jobId: "job-env" }, async (worktree) => {
      // A host-level helper (e.g. in the repo's config) is reset by the env config.
      git(worktree.repoDir, "config", "credential.helper", "!host-helper");
      const run = (...args: string[]) =>
        execFileSync("git", args, { cwd: worktree.path, env, encoding: "utf8" });
      expect(run("config", "--get-all", "credential.helper").split("\n")).toEqual([
        "!host-helper",
        "",
        "!omniralph-agent git-credential",
        "",
      ]);
      expect(run("config", "--get", "core.askPass")).toBe("\n");
    });
  });
});

describe("RepoCache branch worktrees", { timeout: 30_000 }, () => {
  let root: string;
  let workspaceRoot: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  const opts = { env: ENV };
  const feature = { ...opts, branch: "feat/TOOL-1", baseBranch: "main" };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-branches-"));
    workspaceRoot = path.join(root, "workspace");
    remote = new Remote(root);
    remote.init();
    repo = { provider: "github", fullPath: "acme/app", cloneUrl: pathToFileURL(remote.bare).href };
    repos = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Commits `files` in a worktree and pushes the branch; returns the commit SHA. */
  async function commitAndPush(cwd: string, files: Record<string, string>, branch: string) {
    for (const [file, content] of Object.entries(files)) {
      await writeFile(path.join(cwd, file), content);
    }
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", `update ${Object.keys(files).join(",")}`);
    git(cwd, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    return git(cwd, "rev-parse", "HEAD");
  }

  /** Pushes a commit to `branch` on the remote on top of the remote's branch. */
  function pushToRemoteBranch(branch: string, file: string): string {
    const clone = path.join(root, `other-${Math.random().toString(36).slice(2)}`);
    execFileSync("git", ["clone", "--quiet", "--branch", branch, remote.bare, clone], { env: ENV });
    execFileSync("sh", ["-c", `echo remote > ${file}`], { cwd: clone });
    git(clone, "add", "-A");
    git(clone, "commit", "--quiet", "-m", `remote ${file}`);
    git(clone, "push", "--quiet", "origin", branch);
    return git(clone, "rev-parse", "HEAD");
  }

  it("creates the worktree on a new local branch from origin/<baseBranch>", async () => {
    const base = await remote.commit({ "README.md": "base\n" });
    const result = await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(wt.path).toBe(
        path.join(workspaceRoot, ".branches", "github", "acme", "app", "feat__TOOL-1"),
      );
      expect(wt.path).toBe(repos.branchWorktreePath(repo, "feat/TOOL-1"));
      expect(wt.created).toBe(true);
      expect(git(wt.path, "symbolic-ref", "--short", "HEAD")).toBe("feat/TOOL-1");
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(base);
      expect(await readFile(path.join(wt.path, "README.md"), "utf8")).toBe("base\n");
      expect(git(wt.path, "status", "--porcelain")).toBe("");
      return "done";
    });
    expect(result).toBe("done");
    // The worktree outlives the call.
    expect(await exists(repos.branchWorktreePath(repo, "feat/TOOL-1"))).toBe(true);
  });

  it("installs a pre-push hook that only lets a branch worktree push its own branch", async () => {
    const base = await remote.commit({ "README.md": "base\n" });
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      await writeFile(path.join(wt.path, "story.txt"), "work\n");
      git(wt.path, "add", "-A");
      git(wt.path, "commit", "--quiet", "-m", "work");
      const head = git(wt.path, "rev-parse", "HEAD");

      // Its own branch: allowed.
      git(wt.path, "push", "--quiet", "origin", "feat/TOOL-1");
      expect(git(remote.bare, "rev-parse", "refs/heads/feat/TOOL-1")).toBe(head);

      // The base branch (or any other ref): rejected by the hook, nothing pushed.
      for (const ref of ["HEAD:main", "HEAD:refs/heads/other"]) {
        let stderr = "";
        try {
          execFileSync("git", ["push", "--quiet", "origin", ref], {
            cwd: wt.path,
            env: ENV,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          stderr = String((error as { stderr?: Buffer }).stderr ?? "");
        }
        expect(stderr).toContain("omniralph: this worktree may only push feat/TOOL-1");
      }
      expect(git(remote.bare, "rev-parse", "refs/heads/main")).toBe(base);
      expect(() =>
        git(remote.bare, "rev-parse", "--verify", "--quiet", "refs/heads/other"),
      ).toThrow();
    });
  });

  it("creates the worktree from an existing remote branch pushed after the clone", async () => {
    await remote.commit({ "README.md": "base\n" });
    await repos.sync(repo, opts); // clone before the branch exists
    const tip = await remote.commit({ "feature.txt": "pushed earlier\n" }, "feat/TOOL-1");
    await remote.commit({ "README.md": "main moved on\n" }, "main");
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(wt.created).toBe(true);
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(tip);
      expect(git(wt.path, "rev-parse", "origin/feat/TOOL-1")).toBe(tip);
      expect(await readFile(path.join(wt.path, "feature.txt"), "utf8")).toBe("pushed earlier\n");
    });
  });

  it("reuses the worktree across calls and fast-forwards it when the remote is ahead", async () => {
    await remote.commit({ "README.md": "base\n" });
    const first = await repos.withBranchWorktree(repo, feature, async (wt) => {
      await writeFile(path.join(wt.path, "scratch.txt"), "kept\n");
      return commitAndPush(wt.path, { "story1.txt": "one\n" }, "feat/TOOL-1");
    });
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(wt.created).toBe(false);
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(first);
      // Same directory: even untracked files survive.
      expect(await readFile(path.join(wt.path, "scratch.txt"), "utf8")).toBe("kept\n");
      await rm(path.join(wt.path, "scratch.txt"));
    });

    // Another agent (or a person) pushed to the branch: the next call catches up.
    const pushed = pushToRemoteBranch("feat/TOOL-1", "remote.txt");
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(wt.created).toBe(false);
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(pushed);
      expect(await exists(path.join(wt.path, "remote.txt"))).toBe(true);
    });

    // Unpushed local commits on top of the remote are kept as they are.
    const local = await repos.withBranchWorktree(repo, feature, async (wt) => {
      git(wt.path, "commit", "--quiet", "--allow-empty", "-m", "local only");
      return git(wt.path, "rev-parse", "HEAD");
    });
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(local);
    });
  });

  it("serializes concurrent calls on the same branch for the whole of fn", async () => {
    await remote.commit({ "README.md": "base\n" });
    const events: string[] = [];
    const run = (name: string) =>
      repos.withBranchWorktree(repo, feature, async (wt) => {
        events.push(`start ${name} ${wt.created}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        events.push(`end ${name}`);
      });
    // Two caches on one workspace stand in for two agent processes.
    const other = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
    const second = () =>
      other.withBranchWorktree(repo, feature, async (wt) => {
        events.push(`start b ${wt.created}`);
        events.push("end b");
      });
    await Promise.all([run("a"), new Promise((r) => setTimeout(r, 50)).then(second)]);
    expect(events).toEqual(["start a true", "end a", "start b false", "end b"]);

    // An abort while waiting for the branch lock rejects.
    const controller = new AbortController();
    const holding = run("c");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = other.withBranchWorktree(
      repo,
      { ...feature, signal: controller.signal },
      async () => events.push("never"),
    );
    controller.abort(new Error("canceled while waiting"));
    await expect(waiting).rejects.toThrow("canceled while waiting");
    await holding;
    expect(events).not.toContain("never");
  });

  it("throws a non-retryable error when the local branch has diverged from the remote", async () => {
    await remote.commit({ "README.md": "base\n" });
    const pushed = await repos.withBranchWorktree(repo, feature, (wt) =>
      commitAndPush(wt.path, { "story1.txt": "one\n" }, "feat/TOOL-1"),
    );
    const local = await repos.withBranchWorktree(repo, feature, async (wt) => {
      git(wt.path, "commit", "--quiet", "--allow-empty", "-m", "unpushed");
      return git(wt.path, "rev-parse", "HEAD");
    });
    pushToRemoteBranch("feat/TOOL-1", "remote.txt");

    let ran = false;
    const error = await repos
      .withBranchWorktree(repo, feature, async () => {
        ran = true;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BranchDivergedError);
    expect((error as BranchDivergedError).message).toMatch(
      /feat\/TOOL-1 has diverged from origin\/feat\/TOOL-1 \(1 local commit\(s\).*1 remote commit/,
    );
    expect(ran).toBe(false);
    // Nothing was touched.
    const wt = repos.branchWorktreePath(repo, "feat/TOOL-1");
    expect(git(wt, "rev-parse", "HEAD")).toBe(local);
    expect(git(wt, "rev-parse", `${local}^`)).toBe(pushed);
  });

  it("runs the setup command only when the worktree is created, and removes it when setup fails", async () => {
    await remote.commit({ "README.md": "base\n" });
    const setupCommand = 'echo "$PWD" >> ../setup.log && touch .setup-done';
    const log = path.join(workspaceRoot, ".branches", "github", "acme", "app", "setup.log");
    await repos.withBranchWorktree(repo, { ...feature, setupCommand }, async (wt) => {
      expect(await exists(path.join(wt.path, ".setup-done"))).toBe(true);
    });
    await repos.withBranchWorktree(repo, { ...feature, setupCommand }, async (wt) => {
      expect(wt.created).toBe(false);
    });
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);

    const failing = { ...feature, branch: "feat/broken", setupCommand: "echo boom >&2; exit 3" };
    let ran = false;
    await expect(
      repos.withBranchWorktree(repo, failing, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/`echo boom >&2; exit 3` failed \(exit 3\): boom/);
    expect(ran).toBe(false);
    const broken = repos.branchWorktreePath(repo, "feat/broken");
    expect(await exists(broken)).toBe(false);
    const dir = repos.repoDir(repo);
    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(broken);
    expect(git(dir, "branch", "--list", "feat/broken")).toBe("");

    // Fixed: the next call creates it again and runs the setup command.
    await repos.withBranchWorktree(
      repo,
      { ...failing, setupCommand: "touch .setup-done" },
      async (wt) => {
        expect(wt.created).toBe(true);
        expect(await exists(path.join(wt.path, ".setup-done"))).toBe(true);
      },
    );
  });

  it("runs the setup command without the job token", async () => {
    await remote.commit({ "README.md": "base\n" });
    const env = { ...ENV, OMNIRALPH_JOB_TOKEN: "secret", OMNIRALPH_JOB_ID: "job-1" };
    const setupCommand = 'test -z "$OMNIRALPH_JOB_TOKEN$OMNIRALPH_JOB_ID" && touch .clean';
    await repos.withBranchWorktree(repo, { ...feature, env, setupCommand }, async (wt) => {
      expect(await exists(path.join(wt.path, ".clean"))).toBe(true);
    });
  });

  it("recreates a locked worktree whose directory was deleted", async () => {
    await remote.commit({ "README.md": "base\n" });
    const wtPath = await repos.withBranchWorktree(repo, feature, async (wt) => wt.path);
    await rm(wtPath, { recursive: true, force: true });
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(wt.created).toBe(true);
      expect(await exists(path.join(wt.path, "README.md"))).toBe(true);
    });
  });

  it("recreates a worktree whose setup command never finished (agent crash)", async () => {
    await remote.commit({ "README.md": "base\n" });
    const wtPath = await repos.withBranchWorktree(repo, feature, async (wt) => wt.path);
    const gitDir = git(wtPath, "rev-parse", "--absolute-git-dir");
    await writeFile(path.join(gitDir, "omniralph-setup-pending"), "");
    await repos.withBranchWorktree(repo, { ...feature, setupCommand: "touch .ok" }, async (wt) => {
      expect(wt.created).toBe(true);
      expect(await exists(path.join(wt.path, ".ok"))).toBe(true);
    });
  });

  it("stashes uncommitted work by SHA and reapplies it", async () => {
    await remote.commit({ "README.md": "base\n" });
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(await wt.stashWork("clean")).toBeNull();

      await writeFile(path.join(wt.path, "README.md"), "changed\n");
      await writeFile(path.join(wt.path, "new.txt"), "untracked\n");
      const sha = await wt.stashWork("TOOL-1 attempt 1");
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(wt.path, "status", "--porcelain")).toBe("");
      expect(git(wt.path, "log", "-1", "--format=%s", sha!)).toContain("TOOL-1 attempt 1");
      // A newer entry (the stash list is shared): apply finds ours by SHA, not stash@{0}.
      await writeFile(path.join(wt.path, "other.txt"), "x\n");
      const otherSha = await wt.stashWork("another");
      expect(otherSha).not.toBe(sha);

      await wt.applyStash(sha!);
      expect(await readFile(path.join(wt.path, "README.md"), "utf8")).toBe("changed\n");
      expect(await readFile(path.join(wt.path, "new.txt"), "utf8")).toBe("untracked\n");
      expect(await exists(path.join(wt.path, "other.txt"))).toBe(false);
      // Applied entries are dropped; the other one stays.
      expect(git(wt.path, "stash", "list", "--format=%H")).toBe(otherSha);
      await expect(wt.applyStash("not-a-sha")).rejects.toThrow(/invalid stash SHA/);
    });
  });

  it("gives an empty repository an initial commit on the base branch", async () => {
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(wt.created).toBe(true);
      const initial = git(wt.path, "rev-parse", "HEAD");
      expect(git(remote.bare, "rev-parse", "refs/heads/main")).toBe(initial);
      expect(git(wt.path, "log", "--format=%s")).toBe("Initial commit");
    });
    // A repository with commits but no such base branch is a configuration mistake.
    await remote.commit({ "README.md": "x\n" }, "trunk");
    await expect(
      repos.withBranchWorktree(repo, { ...feature, branch: "b2", baseBranch: "develop" }, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow(/base branch develop doesn't exist on origin/);
  });

  it("keeps branch worktrees when pruning, and removes them with removeBranchWorktree", async () => {
    await remote.commit({ "README.md": "base\n" });
    const wtPath = await repos.withBranchWorktree(repo, feature, async (wt) => wt.path);
    expect(await repos.pruneStaleWorktrees()).toEqual([]);
    expect(await exists(path.join(wtPath, "README.md"))).toBe(true);
    const dir = repos.repoDir(repo);
    expect(git(dir, "worktree", "list", "--porcelain")).toContain(wtPath);
    // Git-locked too: `git worktree prune` keeps it even while its directory is missing.
    const entry = (list: string) => list.split("\n\n").find((e) => e.includes(wtPath)) ?? "";
    expect(entry(git(dir, "worktree", "list", "--porcelain"))).toMatch(/^locked/m);

    await repos.removeBranchWorktree(repo, "feat/TOOL-1");
    await repos.removeBranchWorktree(repo, "feat/TOOL-1"); // idempotent
    expect(await exists(wtPath)).toBe(false);
    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(wtPath);
    expect(git(dir, "branch", "--list", "feat/TOOL-1")).toBe("");
  });

  it("migrates caches that fetched branches into refs/heads", async () => {
    await remote.commit({ "README.md": "base\n" });
    await repos.sync(repo, opts);
    const dir = repos.repoDir(repo);
    git(dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    const tip = await remote.commit({ "a.txt": "a\n" }, "feat/TOOL-1");
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(tip);
    });
    expect(git(dir, "config", "--get-all", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    // A fetch no longer touches the branch checked out in the worktree.
    pushToRemoteBranch("feat/TOOL-1", "remote.txt");
    await repos.sync(repo, opts);
  });

  it("rejects invalid branch names", async () => {
    for (const branch of ["../x", "a..b", "-rf", "a b", ".hidden", "x/.y", ""]) {
      await expect(
        repos.withBranchWorktree(repo, { ...feature, branch }, () => Promise.resolve()),
      ).rejects.toThrow(/invalid branch name/);
    }
    await expect(
      repos.withBranchWorktree(repo, { ...feature, branch: "main" }, () => Promise.resolve()),
    ).rejects.toThrow(/is the base branch/);
  });
});
