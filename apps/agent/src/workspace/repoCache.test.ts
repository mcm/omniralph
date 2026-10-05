import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JobRepository } from "@omniralph/shared";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV, exists, git, Remote } from "../test/git-remote.js";
import { RepoCache, type Worktree } from "./repoCache.js";

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
    expect(git(dir, "rev-parse", "refs/heads/main")).toBe(third);
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
