import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  RalphCleanupResult,
  type JobPayload,
  type JobRepository,
  type RalphCleanupAction,
  type RalphCleanupPayload,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../logger.js";
import { ENV, exists, git, Remote } from "../../test/git-remote.js";
import { RepoCache } from "../../workspace/repoCache.js";
import { SystemRpcRegistry, defaultSystemRpcs } from "../../rpc/index.js";
import type { JobContext } from "../index.js";
import { createRalphCapability } from "./index.js";

/**
 * Ported from cyralph's "cleanup after a merge" (`test/engine.test.ts`), for
 * the harness's side: run as the `worktree.cleanup` system RPC the control
 * panel enqueues, and as a legacy `ralph.cleanup` job queued before it did.
 */
describe.each(["worktree.cleanup", "ralph.cleanup"] as const)("%s", { timeout: 60_000 }, (type) => {
  let root: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let runId: string;
  const branch = "eng-1-task-priority";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-cleanup-"));
    remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "hello\n" });
    repo = { provider: "github", fullPath: "acme/app", cloneUrl: pathToFileURL(remote.bare).href };
    repos = new RepoCache({
      workspaceRoot: path.join(root, "workspace"),
      credentialHelper: "!true",
      lockRetryMs: 20,
    });
    controller = new AbortController();
    runId = randomUUID();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(): JobContext {
    return {
      signal: controller.signal,
      jobToken: () => "job-token",
      sessionToken: () => "job-token",
      env: (extra) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "job-token", ...extra }),
      sessionEnv: (extra) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "job-token", ...extra }),
      spawn: () => {
        throw new Error(`${type} must not spawn processes through the context`);
      },
      server: "https://omniralph.example.com",
      workspaceRoot: path.join(root, "workspace"),
      repos,
      logger: silentLogger(),
    };
  }

  function job(
    action: RalphCleanupAction | undefined,
    overrides: Partial<RalphCleanupPayload> = {},
  ): JobPayload {
    const payload: RalphCleanupPayload = {
      runId,
      repositoryId: randomUUID(),
      repository: repo,
      branch,
      baseBranch: "main",
      settings: {
        model: null,
        setupCommand: null,
        fallbackModel: null,
        appendInstruction: null,
        allowedTools: null,
        disallowedTools: null,
      },
      epic: { identifier: "ENG-1" },
      action,
      ...overrides,
    };
    return {
      id: randomUUID(),
      type,
      ...(type === "ralph.cleanup"
        ? { taskType: "coding" as const, pool: "long" as const }
        : { taskType: "system" as const, pool: null }),
      taskId: null,
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  const run = async (j: JobPayload) =>
    RalphCleanupResult.parse(
      type === "ralph.cleanup"
        ? await createRalphCapability().run(j, context())
        : await new SystemRpcRegistry(defaultSystemRpcs()).get(type)!.run(j, context()),
    );
  const worktree = () => repos.branchWorktreePath(repo, branch);
  const bareDir = () => repos.repoDir(repo);
  const branchExists = (b = branch) => git(bareDir(), "branch", "--list", b) !== "";
  const stashes = () => {
    try {
      return git(bareDir(), "log", "-g", "--format=%gs", "refs/stash", "--");
    } catch {
      return ""; // No stash list at all.
    }
  };

  /** The epic's branch worktree with its story commit pushed (the PR/MR head that is merged). */
  async function mergedEpic(): Promise<string> {
    return repos.withBranchWorktree(repo, { branch, baseBranch: "main", env: ENV }, async (wt) => {
      await writeFile(path.join(wt.path, "story.txt"), "story 1\n");
      git(wt.path, "add", "-A");
      git(wt.path, "commit", "--quiet", "-m", "feat(ENG-2): story");
      git(wt.path, "push", "--quiet", "origin", branch);
      return git(wt.path, "rev-parse", "HEAD");
    });
  }

  const cleanup = (mergedSha: string, recorded: string[] = []) =>
    run(job({ kind: "cleanup", mergedSha, stashes: recorded }));

  it("removes the worktree and local branch once its PR merged", async () => {
    const head = await mergedEpic();
    expect(await exists(worktree())).toBe(true);
    const result = await cleanup(head);
    expect(result).toMatchObject({
      error: null,
      removedWorktree: true,
      hadBranch: true,
      stashed: null,
      unmerged: 0,
      stashes: [],
    });
    expect(await exists(worktree())).toBe(false);
    expect(branchExists()).toBe(false);
    expect(git(bareDir(), "worktree", "list")).not.toContain(worktree());
    // The merged branch stays on the remote: only the local one goes.
    expect(git(remote.bare, "rev-parse", branch)).toBe(head);
  });

  it("does nothing the second time, or on an agent that never had the repository", async () => {
    const head = await mergedEpic();
    await cleanup(head);
    expect(await cleanup(head)).toMatchObject({
      error: null,
      removedWorktree: false,
      hadBranch: false,
      stashes: [],
    });

    const elsewhere: JobRepository = { ...repo, fullPath: "acme/never-cloned" };
    expect(
      await run(job({ kind: "cleanup", mergedSha: head, stashes: [] }, { repository: elsewhere })),
    ).toMatchObject({ error: null, removedWorktree: false, hadBranch: false });
    expect(await exists(repos.repoDir(elsewhere))).toBe(false);
  });

  it("never touches the base branch", async () => {
    const head = await mergedEpic();
    const result = await run(
      job({ kind: "cleanup", mergedSha: head, stashes: [] }, { branch: "main" }),
    );
    expect(result.error).toContain("`main` is the base branch");
    expect(await exists(worktree())).toBe(true);
  });

  it("stashes a dirty worktree, removes it, lists the stash, and pushes it to origin when told to", async () => {
    const head = await mergedEpic();
    await writeFile(path.join(worktree(), "notes.txt"), "wip\n");
    const result = await cleanup(head);
    expect(result.removedWorktree).toBe(true);
    expect(result.unmerged).toBe(0);
    expect(result.stashed).toMatch(/^[0-9a-f]{40}$/);
    expect(await exists(worktree())).toBe(false);
    expect(branchExists()).toBe(false);
    expect(result.stashes).toEqual([
      { sha: result.stashed, label: `omniralph ralph ${runId} cleanup`, date: expect.any(String) },
    ]);
    expect(stashes()).toContain(`omniralph ralph ${runId} cleanup`);

    expect(await run(job({ kind: "stashes", push: true, shas: [result.stashed!] }))).toMatchObject({
      error: null,
      handled: 1,
    });
    expect(stashes()).not.toContain(`omniralph ralph ${runId} cleanup`);
    expect(git(remote.bare, "log", "--format=%B", "ralph/stash/eng-1")).toContain(
      `omniralph ralph ${runId} cleanup`,
    );
    expect(git(remote.bare, "show", "ralph/stash/eng-1:notes.txt")).toBe("wip");
  });

  it("drops leftover stashes of the run when told to, and never touches other entries", async () => {
    const head = await mergedEpic();
    // A story's stash (offered to its later attempts), one recorded on the lane, and someone else's.
    await writeFile(path.join(worktree(), "blocked.txt"), "blocked\n");
    git(
      worktree(),
      "stash",
      "push",
      "--quiet",
      "-u",
      "-m",
      `omniralph ralph ${runId} ENG-2 blocked`,
    );
    await writeFile(path.join(worktree(), "request.txt"), "request\n");
    git(worktree(), "stash", "push", "--quiet", "-u", "-m", "omniralph ralph other-run request x");
    const recorded = git(worktree(), "rev-parse", "stash@{0}");
    await writeFile(path.join(worktree(), "other.txt"), "someone else's\n");
    git(worktree(), "stash", "push", "--quiet", "-u", "-m", "omniralph ralph ENG-9 ENG-10 blocked");
    await writeFile(path.join(worktree(), "notes.txt"), "wip\n");

    const result = await cleanup(head, [recorded]);
    expect(result.stashes.map((e) => e.label)).toEqual([
      `omniralph ralph ${runId} cleanup`,
      "omniralph ralph other-run request x",
      `omniralph ralph ${runId} ENG-2 blocked`,
    ]);

    expect(
      await run(job({ kind: "stashes", push: false, shas: result.stashes.map((e) => e.sha) })),
    ).toMatchObject({ error: null, handled: 3 });
    expect(stashes().split("\n")).toEqual([
      "On eng-1-task-priority: omniralph ralph ENG-9 ENG-10 blocked",
    ]);
    expect(git(remote.bare, "branch", "--list", "ralph/stash/*")).toBe("");
  });

  /** A merged epic whose branch got another commit after the merge. */
  async function aheadEpic(): Promise<{ head: string; tip: string; result: RalphCleanupResult }> {
    const head = await mergedEpic();
    await writeFile(path.join(worktree(), "more.txt"), "more\n");
    git(worktree(), "add", ".");
    git(worktree(), "commit", "--quiet", "-m", "after merge");
    const tip = git(worktree(), "rev-parse", "HEAD");
    const result = await cleanup(head);
    expect(result).toMatchObject({ removedWorktree: true, hadBranch: true, unmerged: 1 });
    expect(await exists(worktree())).toBe(false);
    expect(branchExists()).toBe(true);
    return { head, tip, result };
  }

  it("removes the worktree of a branch with unmerged commits, keeps the branch, and pushes it when told to", async () => {
    const { tip } = await aheadEpic();
    expect(await run(job({ kind: "branch", push: true }))).toMatchObject({ error: null });
    expect(git(remote.bare, "rev-parse", branch)).toBe(tip);
    expect(branchExists()).toBe(false);
  });

  it("pushes with the job token read from a file the agent keeps current", async () => {
    await aheadEpic();
    const seen = path.join(root, "push-env");
    await writeFile(
      path.join(remote.bare, "hooks", "pre-receive"),
      `#!/bin/sh\n{ echo "env=\${OMNIRALPH_JOB_TOKEN:-none}"; echo "file=$(cat "$OMNIRALPH_JOB_TOKEN_FILE")"; } > '${seen}'\n`,
      { mode: 0o755 },
    );
    expect(await run(job({ kind: "branch", push: true }))).toMatchObject({ error: null });
    expect(await readFile(seen, "utf8")).toBe("env=none\nfile=job-token\n");
  });

  it("deletes the kept branch when told to, and reports a push that fails", async () => {
    const { tip } = await aheadEpic();
    // The remote refuses the push: reported as the error, the branch stays for another answer.
    await writeFile(path.join(remote.bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const refused = await run(job({ kind: "branch", push: true }));
    expect(refused.error).toContain("push");
    expect(branchExists()).toBe(true);

    expect(await run(job({ kind: "branch", push: false }))).toMatchObject({ error: null });
    expect(branchExists()).toBe(false);
    expect(git(remote.bare, "rev-parse", branch)).not.toBe(tip);
    // Already gone is what was asked for.
    expect(await run(job({ kind: "branch", push: false }))).toMatchObject({ error: null });
  });

  it("never deletes the branch on the remote, whatever the action", async () => {
    const head = await mergedEpic();
    await writeFile(path.join(worktree(), "more.txt"), "more\n");
    git(worktree(), "add", ".");
    git(worktree(), "commit", "--quiet", "-m", "after merge");
    const tip = git(worktree(), "rev-parse", "HEAD");
    await writeFile(path.join(worktree(), "notes.txt"), "wip\n");
    const onRemote = () => git(remote.bare, "rev-parse", "--verify", `refs/heads/${branch}`);

    const cleaned = await cleanup(head);
    expect(cleaned).toMatchObject({ error: null, removedWorktree: true, unmerged: 1 });
    expect(onRemote()).toBe(head);
    const shas = cleaned.stashes.map((e) => e.sha);
    expect(shas).toHaveLength(1);
    expect(await run(job({ kind: "stashes", push: true, shas }))).toMatchObject({ handled: 1 });
    expect(onRemote()).toBe(head);
    expect(await run(job({ kind: "branch", push: true }))).toMatchObject({ error: null });
    expect(onRemote()).toBe(tip);
    expect(await run(job({ kind: "branch", push: false }))).toMatchObject({ error: null });
    expect(await run(job({ kind: "stashes", push: false, shas }))).toMatchObject({ error: null });
    expect(await cleanup(head)).toMatchObject({ error: null });
    expect(onRemote()).toBe(tip);
  });

  describe("keep-branch cleanup (a PR/MR closed unmerged, a stopped run)", () => {
    const keep = (recorded: string[] = []) =>
      run(job({ kind: "cleanup", keepBranch: true, stashes: recorded }));

    it("stashes uncommitted work, removes the worktree and keeps the local and remote branch", async () => {
      const head = await mergedEpic();
      // An unpushed commit on top, and uncommitted work.
      await writeFile(path.join(worktree(), "more.txt"), "more\n");
      git(worktree(), "add", ".");
      git(worktree(), "commit", "--quiet", "-m", "not pushed");
      const tip = git(worktree(), "rev-parse", "HEAD");
      await writeFile(path.join(worktree(), "notes.txt"), "wip\n");

      const result = await keep();
      expect(result).toMatchObject({
        error: null,
        removedWorktree: true,
        hadBranch: true,
        unmerged: 0,
      });
      expect(result.stashed).toMatch(/^[0-9a-f]{40}$/);
      expect(result.stashes.map((e) => e.label)).toEqual([`omniralph ralph ${runId} cleanup`]);
      expect(await exists(worktree())).toBe(false);
      expect(git(bareDir(), "worktree", "list")).not.toContain(worktree());
      expect(git(bareDir(), "rev-parse", `refs/heads/${branch}`)).toBe(tip);
      expect(git(remote.bare, "rev-parse", "--verify", `refs/heads/${branch}`)).toBe(head);
      // Again: nothing left to remove, the branch stays.
      expect(await keep()).toMatchObject({ error: null, removedWorktree: false, hadBranch: true });
      expect(branchExists()).toBe(true);
    });

    it("lets a resumed run recreate the worktree from the kept local branch", async () => {
      await mergedEpic();
      await writeFile(path.join(worktree(), "more.txt"), "more\n");
      git(worktree(), "add", ".");
      git(worktree(), "commit", "--quiet", "-m", "not pushed");
      const tip = git(worktree(), "rev-parse", "HEAD");
      await keep();
      expect(await exists(worktree())).toBe(false);

      const resumed = await repos.withBranchWorktree(
        repo,
        { branch, baseBranch: "main", env: ENV },
        async (wt) => ({
          head: git(wt.path, "rev-parse", "HEAD"),
          more: await readFile(path.join(wt.path, "more.txt"), "utf8"),
        }),
      );
      expect(resumed).toEqual({ head: tip, more: "more\n" });
    });

    it("rejects a cleanup with both or neither of mergedSha and keepBranch", async () => {
      const head = await mergedEpic();
      const invalid = [
        { kind: "cleanup", mergedSha: head, keepBranch: true, stashes: [] },
        { kind: "cleanup", stashes: [] },
      ] as unknown as RalphCleanupAction[];
      for (const action of invalid) await expect(run(job(action))).rejects.toThrow(/payload/);
      expect(await exists(worktree())).toBe(true);
    });
  });

  describe("hidden refs of finished runs", () => {
    const hiddenRef = () => `refs/omniralph/runs/${runId}`;
    const onRemote = (ref: string) => {
      try {
        return git(remote.bare, "rev-parse", "--verify", "--quiet", ref);
      } catch {
        return null;
      }
    };
    const remoteRefs = () => git(remote.bare, "for-each-ref", "--format=%(refname)").split("\n");

    it("deletes the run's hidden ref on origin without cloning, and leaves every branch in place", async () => {
      const head = await mergedEpic();
      const other = `refs/omniralph/runs/${randomUUID()}`;
      git(remote.bare, "update-ref", hiddenRef(), head);
      git(remote.bare, "update-ref", other, head);
      // Another harness, which never had the repository.
      repos = new RepoCache({
        workspaceRoot: path.join(root, "other-workspace"),
        credentialHelper: "!true",
        lockRetryMs: 20,
      });
      const before = remoteRefs().filter((r) => r.startsWith("refs/heads/"));

      const result = await run(job(undefined, { hiddenRefs: [hiddenRef()] }));

      expect(result).toMatchObject({ error: null, deletedRefs: [hiddenRef()] });
      expect(onRemote(hiddenRef())).toBeNull();
      expect(onRemote(other)).toBe(head);
      expect(remoteRefs().filter((r) => r.startsWith("refs/heads/"))).toEqual(before);
      expect(before).toEqual(expect.arrayContaining(["refs/heads/main", `refs/heads/${branch}`]));
      expect(await exists(bareDir())).toBe(false);
    });

    it("deletes the hidden ref and its cached copy after the action, and counts a gone one as deleted", async () => {
      const head = await mergedEpic();
      await repos.withBranchWorktree(repo, { branch, baseBranch: "main", env: ENV }, (wt) =>
        wt.pushHiddenRef(hiddenRef()),
      );
      git(bareDir(), "update-ref", hiddenRef(), head);
      const gone = `refs/omniralph/runs/${randomUUID()}`;

      const result = await run(
        job({ kind: "cleanup", mergedSha: head, stashes: [] }, { hiddenRefs: [hiddenRef(), gone] }),
      );

      expect(result).toMatchObject({ error: null, removedWorktree: true });
      expect(result.deletedRefs).toEqual([hiddenRef(), gone]);
      expect(onRemote(hiddenRef())).toBeNull();
      expect(() => git(bareDir(), "rev-parse", "--verify", "--quiet", hiddenRef())).toThrow();
      expect(git(remote.bare, "rev-parse", branch)).toBe(head);
      expect(git(remote.bare, "rev-parse", "main")).not.toBe("");
    });

    it("refuses anything but a run's hidden ref, and deletes nothing", async () => {
      const head = await mergedEpic();
      git(remote.bare, "update-ref", hiddenRef(), head);
      for (const ref of [
        `refs/heads/${branch}`,
        "refs/heads/main",
        "refs/omniralph/other",
        `refs/omniralph/runs/${runId}/../../heads/main`,
      ]) {
        await expect(run(job(undefined, { hiddenRefs: [hiddenRef(), ref] }))).rejects.toThrow(
          /payload/,
        );
      }
      await expect(run(job(undefined, { hiddenRefs: [] }))).rejects.toThrow(/payload/);
      expect(onRemote(hiddenRef())).toBe(head);
      expect(onRemote(`refs/heads/${branch}`)).toBe(head);
      expect(onRemote("refs/heads/main")).not.toBeNull();
      // The harness's own check, should a bad ref get past the payload.
      await expect(
        repos.deleteHiddenRef(repo, `refs/heads/${branch}`, { env: ENV }),
      ).rejects.toThrow(/invalid hidden ref/);
      expect(onRemote(`refs/heads/${branch}`)).toBe(head);
    });
  });
});
