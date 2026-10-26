import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

  it("clones blobless into <workspaceRoot>/<provider>/<host>/<path> on first use, then fetches the needed SHAs", async () => {
    const first = await remote.commit({ "README.md": "one\n" });
    const repos = cache();
    // A `file:` URL has no host: its scheme stands in.
    const dir = path.join(workspaceRoot, "gitlab", "file", "group", "sub", "app");
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

  it("resolves a branch's head after fetching every branch, or null when it doesn't exist", async () => {
    const first = await remote.commit({ "README.md": "one\n" });
    const repos = cache();
    expect(await repos.branchHead(repo, "main", opts)).toBe(first);
    const second = await remote.commit({ "README.md": "two\n" });
    const other = await remote.commit({ "b.txt": "b\n" }, "feature/b");
    expect(await repos.branchHead(repo, "main", opts)).toBe(second);
    expect(await repos.branchHead(repo, "feature/b", opts)).toBe(other);
    expect(await repos.branchHead(repo, "missing", opts)).toBeNull();
    await expect(repos.branchHead(repo, "-x", opts)).rejects.toThrow(/invalid branch name/);
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
    const lockfilePath = path.join(
      workspaceRoot,
      ".locks",
      "gitlab",
      "file",
      "group",
      "sub",
      "app.lock",
    );
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

  it("keys repositories by the host of their clone URL", () => {
    const repos = cache();
    const at = (cloneUrl: string): JobRepository => ({
      provider: "github",
      fullPath: "acme/app",
      cloneUrl,
    });
    const cloud = at("https://github.com/acme/app.git");
    const enterprise = at("https://GHE.example.com:8443/acme/app.git");
    expect(repos.repoDir(cloud)).toBe(
      path.join(workspaceRoot, "github", "github.com", "acme", "app"),
    );
    expect(repos.repoDir(enterprise)).toBe(
      path.join(workspaceRoot, "github", "ghe.example.com:8443", "acme", "app"),
    );
    expect(repos.branchWorktreePath(cloud, "feat/x")).toBe(
      path.join(workspaceRoot, ".branches", "github", "github.com", "acme", "app", "feat__x"),
    );
    expect(repos.branchWorktreePath(enterprise, "feat/x")).not.toBe(
      repos.branchWorktreePath(cloud, "feat/x"),
    );
  });

  it("rejects repository paths and job IDs that would escape the workspace", () => {
    const repos = cache();
    const cloneUrl = "https://github.com/a/b.git";
    for (const fullPath of ["../etc", "group/../../x", "/abs/path", "group/.git", "a//b"]) {
      expect(() => repos.repoDir({ provider: "github", fullPath, cloneUrl })).toThrow(
        /invalid repository path/,
      );
    }
    expect(() =>
      repos.repoDir({ provider: "bitbucket" as "github", fullPath: "a/b", cloneUrl }),
    ).toThrow();
    for (const bad of ["not a url", "https://.hidden/a/b.git"]) {
      expect(() => repos.repoDir({ provider: "github", fullPath: "a/b", cloneUrl: bad })).toThrow(
        /invalid clone URL/,
      );
    }
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
        path.join(workspaceRoot, ".branches", "github", "file", "acme", "app", "feat__TOOL-1"),
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

  it("lets a branch worktree push its run's hidden ref only when the push names it", async () => {
    const runA = "refs/omniralph/runs/run-a";
    const runB = "refs/omniralph/runs/run-b";
    await remote.commit({ "README.md": "base\n" });
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      await writeFile(path.join(wt.path, "story.txt"), "work\n");
      git(wt.path, "add", "-A");
      git(wt.path, "commit", "--quiet", "-m", "work");
      const head = git(wt.path, "rev-parse", "HEAD");

      // The lifecycle's push names the hidden ref: allowed, and the branch isn't pushed.
      expect(await wt.pushHiddenRef(runA)).toBe(head);
      expect(git(remote.bare, "rev-parse", runA)).toBe(head);
      expect(() =>
        git(remote.bare, "rev-parse", "--verify", "--quiet", "refs/heads/feat/TOOL-1"),
      ).toThrow();

      const push = (ref: string, env: NodeJS.ProcessEnv = {}) => {
        try {
          execFileSync("git", ["push", "--quiet", "--force", "origin", `HEAD:${ref}`], {
            cwd: wt.path,
            env: { ...ENV, ...env },
            stdio: ["ignore", "pipe", "pipe"],
          });
          return "";
        } catch (error) {
          return String((error as { stderr?: Buffer }).stderr ?? "");
        }
      };
      // Another run's hidden ref, a hidden ref no push named, and other refs/omniralph refs: rejected.
      expect(push(runB, { OMNIRALPH_PUSH_REF: runA })).toContain(
        `omniralph: this worktree may only push feat/TOOL-1, not ${runB}`,
      );
      // (A push with nothing to update never runs the hook.)
      git(wt.path, "commit", "--quiet", "--allow-empty", "-m", "more");
      expect(push(runA)).toContain("omniralph: this worktree may only push feat/TOOL-1");
      expect(git(remote.bare, "rev-parse", runA)).toBe(head);
      expect(
        push("refs/omniralph/other", { OMNIRALPH_PUSH_REF: "refs/omniralph/other" }),
      ).toContain("omniralph: this worktree may only push feat/TOOL-1");
      expect(push("main", { OMNIRALPH_PUSH_REF: runA })).toContain(
        "omniralph: this worktree may only push feat/TOOL-1",
      );
      expect(git(remote.bare, "for-each-ref", "--format=%(refname)", "refs/omniralph")).toBe(runA);
      // Named by the push itself: allowed.
      expect(push(runB, { OMNIRALPH_PUSH_REF: runB })).toBe("");

      await expect(wt.pushHiddenRef("refs/heads/feat/TOOL-1")).rejects.toThrow(
        "invalid hidden ref",
      );
      await expect(wt.pushHiddenRef("refs/omniralph/runs/")).rejects.toThrow("invalid hidden ref");
    });
  });

  it("starts a new worktree from the run's hidden ref, and fast-forwards a reused one to it", async () => {
    const hiddenRef = "refs/omniralph/runs/run-a";
    const base = await remote.commit({ "README.md": "base\n" });
    // No hidden ref on origin yet: the usual start.
    const pushed = await repos.withBranchWorktree(repo, { ...feature, hiddenRef }, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(base);
      return commitAndPush(wt.path, { "pushed.txt": "on the branch\n" }, "feat/TOOL-1");
    });

    // Another agent keeps a commit on top of the branch on the hidden ref.
    const other = new RepoCache({
      workspaceRoot: path.join(root, "other"),
      credentialHelper: "!true",
      lockRetryMs: 20,
    });
    const hidden = await other.withBranchWorktree(repo, { ...feature, hiddenRef }, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(pushed);
      await writeFile(path.join(wt.path, "hidden.txt"), "unpushed\n");
      git(wt.path, "add", "-A");
      git(wt.path, "commit", "--quiet", "-m", "hidden");
      return wt.pushHiddenRef(hiddenRef);
    });

    // A third agent creates its worktree from the hidden ref (the branch is an ancestor of it).
    const third = new RepoCache({
      workspaceRoot: path.join(root, "third"),
      credentialHelper: "!true",
      lockRetryMs: 20,
    });
    await third.withBranchWorktree(repo, { ...feature, hiddenRef }, async (wt) => {
      expect(wt.created).toBe(true);
      expect(git(wt.path, "symbolic-ref", "--short", "HEAD")).toBe("feat/TOOL-1");
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(hidden);
      expect(await readFile(path.join(wt.path, "hidden.txt"), "utf8")).toBe("unpushed\n");
    });
    // The first agent's reused worktree (an ancestor of the hidden ref) fast-forwards to it.
    await repos.withBranchWorktree(repo, { ...feature, hiddenRef }, async (wt) => {
      expect(wt.created).toBe(false);
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(hidden);
    });
    // Without the option, the hidden ref is ignored.
    const fourth = new RepoCache({
      workspaceRoot: path.join(root, "fourth"),
      credentialHelper: "!true",
      lockRetryMs: 20,
    });
    await fourth.withBranchWorktree(repo, feature, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(pushed);
    });
  });

  it("starts a branch not pushed yet from its hidden ref, even when the base branch moved on", async () => {
    const hiddenRef = "refs/omniralph/runs/run-a";
    await remote.commit({ "README.md": "base\n" });
    const hidden = await repos.withBranchWorktree(repo, { ...feature, hiddenRef }, async (wt) => {
      await writeFile(path.join(wt.path, "hidden.txt"), "unpushed\n");
      git(wt.path, "add", "-A");
      git(wt.path, "commit", "--quiet", "-m", "hidden");
      return wt.pushHiddenRef(hiddenRef);
    });
    await remote.commit({ "README.md": "main moved on\n" });
    const other = new RepoCache({
      workspaceRoot: path.join(root, "other"),
      credentialHelper: "!true",
      lockRetryMs: 20,
    });
    await other.withBranchWorktree(repo, { ...feature, hiddenRef }, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(hidden);
    });
    await expect(
      repos.withBranchWorktree(repo, { ...feature, hiddenRef: "refs/heads/main" }, async () => {}),
    ).rejects.toThrow("invalid hidden ref");
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
    // Resolves once fn is running, i.e. the branch lock is held — a fixed head start races on a slow runner.
    const run = (name: string) => {
      let started!: () => void;
      const holding = new Promise<void>((resolve) => (started = resolve));
      const done = repos.withBranchWorktree(repo, feature, async (wt) => {
        events.push(`start ${name} ${wt.created}`);
        started();
        await new Promise((resolve) => setTimeout(resolve, 200));
        events.push(`end ${name}`);
      });
      return { holding, done };
    };
    // Two caches on one workspace stand in for two agent processes.
    const other = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
    const second = () =>
      other.withBranchWorktree(repo, feature, async (wt) => {
        events.push(`start b ${wt.created}`);
        events.push("end b");
      });
    const a = run("a");
    await Promise.all([a.done, a.holding.then(second)]);
    expect(events).toEqual(["start a true", "end a", "start b false", "end b"]);

    // An abort while waiting for the branch lock rejects.
    const controller = new AbortController();
    const c = run("c");
    await c.holding;
    const waiting = other.withBranchWorktree(
      repo,
      { ...feature, signal: controller.signal },
      async () => events.push("never"),
    );
    controller.abort(new Error("canceled while waiting"));
    await expect(waiting).rejects.toThrow("canceled while waiting");
    await c.done;
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

  /** Rebases `branch` on the remote onto `main` and force-pushes it, like a GitLab UI rebase; returns the new tip. */
  function rebaseRemoteBranch(branch: string, edit?: { file: string; content: string }): string {
    const clone = path.join(root, `rebase-${Math.random().toString(36).slice(2)}`);
    execFileSync("git", ["clone", "--quiet", "--branch", branch, remote.bare, clone], { env: ENV });
    git(clone, "rebase", "--quiet", "origin/main");
    if (edit) {
      execFileSync("sh", ["-c", `printf '%s\\n' "${edit.content}" > ${edit.file}`], { cwd: clone });
      git(clone, "commit", "--quiet", "-a", "--amend", "--no-edit");
    }
    git(clone, "push", "--quiet", "--force", "origin", branch);
    return git(clone, "rev-parse", "HEAD");
  }

  it("rebases the worktree onto a remote branch that was rebased, keeping unpushed work", async () => {
    await remote.commit({ "README.md": "base\n" });
    await repos.withBranchWorktree(repo, feature, (wt) =>
      commitAndPush(wt.path, { "story1.txt": "one\n" }, "feat/TOOL-1"),
    );
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      await writeFile(path.join(wt.path, "story2.txt"), "two\n");
      git(wt.path, "add", "-A");
      git(wt.path, "commit", "--quiet", "-m", "unpushed story 2");
      await writeFile(path.join(wt.path, "scratch.txt"), "uncommitted\n");
    });
    await remote.commit({ "main.txt": "main moved on\n" }, "main");
    // Rebased with a conflict resolution: the rewritten commit isn't patch-equivalent.
    const rebased = rebaseRemoteBranch("feat/TOOL-1", {
      file: "story1.txt",
      content: "one, resolved",
    });

    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD^")).toBe(rebased);
      expect(git(wt.path, "log", "-1", "--format=%s")).toBe("unpushed story 2");
      expect(await readFile(path.join(wt.path, "story1.txt"), "utf8")).toBe("one, resolved\n");
      expect(await readFile(path.join(wt.path, "story2.txt"), "utf8")).toBe("two\n");
      expect(await readFile(path.join(wt.path, "main.txt"), "utf8")).toBe("main moved on\n");
      expect(await readFile(path.join(wt.path, "scratch.txt"), "utf8")).toBe("uncommitted\n");
      expect(git(wt.path, "status", "--porcelain")).toBe("?? scratch.txt");
    });
  });

  it("resets to a rebased remote branch whose commits match the local ones without a reflog", async () => {
    await remote.commit({ "README.md": "base\n" });
    await repos.withBranchWorktree(repo, feature, (wt) =>
      commitAndPush(wt.path, { "story1.txt": "one\n" }, "feat/TOOL-1"),
    );
    // A cache from before reflogs were kept.
    const dir = repos.repoDir(repo);
    git(dir, "config", "core.logAllRefUpdates", "false");
    await rm(path.join(dir, "logs"), { recursive: true, force: true });
    await remote.commit({ "main.txt": "main moved on\n" }, "main");
    const rebased = rebaseRemoteBranch("feat/TOOL-1");
    // Fetched before reflogs were kept: the remote's old tip is in no reflog.
    git(dir, "fetch", "--quiet", "origin");
    await rm(path.join(dir, "logs"), { recursive: true, force: true });

    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(git(wt.path, "rev-parse", "HEAD")).toBe(rebased);
      expect(git(wt.path, "status", "--porcelain")).toBe("");
    });
  });

  it("throws BranchDivergedError when replaying local commits onto a rebased remote conflicts", async () => {
    await remote.commit({ "README.md": "base\n" });
    await repos.withBranchWorktree(repo, feature, (wt) =>
      commitAndPush(wt.path, { "story1.txt": "one\n" }, "feat/TOOL-1"),
    );
    const local = await repos.withBranchWorktree(repo, feature, async (wt) => {
      await writeFile(path.join(wt.path, "story1.txt"), "one, locally\n");
      git(wt.path, "commit", "--quiet", "-am", "unpushed edit");
      return git(wt.path, "rev-parse", "HEAD");
    });
    await remote.commit({ "main.txt": "main moved on\n" }, "main");
    rebaseRemoteBranch("feat/TOOL-1", { file: "story1.txt", content: "one, resolved" });

    const error = await repos
      .withBranchWorktree(repo, feature, async () => {})
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BranchDivergedError);
    const wt = repos.branchWorktreePath(repo, "feat/TOOL-1");
    expect(git(wt, "rev-parse", "HEAD")).toBe(local);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("runs the setup command only when the worktree is created, and removes it when setup fails", async () => {
    await remote.commit({ "README.md": "base\n" });
    const setupCommand = 'echo "$PWD" >> ../setup.log && touch .setup-done';
    const log = path.join(workspaceRoot, ".branches", "github", "file", "acme", "app", "setup.log");
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

  it("moves repositories and branch worktrees cached without a host directory on startup", async () => {
    await remote.commit({ "README.md": "base\n" });
    const wtPath = await repos.withBranchWorktree(repo, feature, async (wt) => {
      await writeFile(path.join(wt.path, "wip.txt"), "uncommitted\n");
      return wt.path;
    });
    const dir = repos.repoDir(repo);
    // The layout before repositories were keyed by host.
    const legacyDir = path.join(workspaceRoot, "github", "acme", "app");
    const legacyWt = path.join(workspaceRoot, ".branches", "github", "acme", "app", "feat__TOOL-1");
    await mkdir(path.dirname(legacyDir), { recursive: true });
    await mkdir(path.dirname(legacyWt), { recursive: true });
    await rename(dir, legacyDir);
    await rename(wtPath, legacyWt);
    git(legacyDir, "worktree", "repair", legacyWt);
    git(legacyDir, "config", "--unset", "omniralph.hostDir");
    await rm(path.join(workspaceRoot, "github", "file"), { recursive: true });
    await rm(path.join(workspaceRoot, ".branches", "github", "file"), { recursive: true });
    expect(git(legacyWt, "status", "--porcelain")).toBe("?? wip.txt");

    expect(await repos.pruneStaleWorktrees()).toEqual([]);
    expect(await exists(legacyDir)).toBe(false);
    expect(await exists(path.join(workspaceRoot, "github", "acme"))).toBe(false);
    expect(await exists(path.join(workspaceRoot, ".branches", "github", "acme"))).toBe(false);
    expect(git(dir, "config", "omniralph.hostDir")).toBe("file");
    expect(git(wtPath, "status", "--porcelain")).toBe("?? wip.txt");
    const entry = git(dir, "worktree", "list", "--porcelain")
      .split("\n\n")
      .find((e) => e.includes(wtPath));
    expect(entry).toMatch(/^locked/m);

    // The moved worktree is reused, and a second startup leaves everything in place.
    await repos.withBranchWorktree(repo, feature, async (wt) => {
      expect(wt.created).toBe(false);
      expect(wt.path).toBe(wtPath);
    });
    await repos.pruneStaleWorktrees();
    expect(git(wtPath, "symbolic-ref", "--short", "HEAD")).toBe("feat/TOOL-1");
  });

  it("keeps a moved repository and relinks a branch worktree that can't be moved", async () => {
    await remote.commit({ "README.md": "base\n" });
    const wtPath = await repos.withBranchWorktree(repo, feature, async (wt) => wt.path);
    const dir = repos.repoDir(repo);
    const legacyDir = path.join(workspaceRoot, "github", "acme", "app");
    const legacyWt = path.join(workspaceRoot, ".branches", "github", "acme", "app", "feat__TOOL-1");
    await mkdir(path.dirname(legacyDir), { recursive: true });
    await mkdir(path.dirname(legacyWt), { recursive: true });
    await rename(dir, legacyDir);
    await rename(wtPath, legacyWt);
    git(legacyDir, "worktree", "repair", legacyWt);
    git(legacyDir, "config", "--unset", "omniralph.hostDir");
    await rm(path.join(workspaceRoot, "github", "file"), { recursive: true });
    // Something already occupies the worktree's new path.
    await mkdir(wtPath, { recursive: true });
    await writeFile(path.join(wtPath, "in-the-way.txt"), "x\n");

    await repos.pruneStaleWorktrees();
    expect(await exists(legacyDir)).toBe(false);
    expect(git(dir, "config", "omniralph.hostDir")).toBe("file");
    expect(git(legacyWt, "symbolic-ref", "--short", "HEAD")).toBe("feat/TOOL-1");
    expect(git(dir, "worktree", "list", "--porcelain")).toContain(`worktree ${legacyWt}`);

    // The next startup leaves the repository where it is.
    await repos.pruneStaleWorktrees();
    expect(git(dir, "config", "omniralph.hostDir")).toBe("file");
    expect(git(legacyWt, "symbolic-ref", "--short", "HEAD")).toBe("feat/TOOL-1");
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
