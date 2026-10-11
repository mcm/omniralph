import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { JobPayload, JobRepository } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../logger.js";
import { ENV, git, Remote } from "../test/git-remote.js";
import { RepoCache, WORKTREES_DIR } from "../workspace/repoCache.js";
import { SystemRpcRegistry, defaultSystemRpcs, type SystemRpcContext } from "./index.js";
import { repoSyncRpc } from "./repo-sync.js";

// Any Claude session would go through the SDK's `query()`: a fake that records every one.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const { scriptedQuery } = await import("../test/fake-query.js");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    query: vi.fn(scriptedQuery(() => []).query),
  };
});

// Spawns real `git` processes, which can be slow while every package's suite runs.
describe("repo.sync", { timeout: 30_000 }, () => {
  let root: string;
  let workspaceRoot: string;
  let remote: Remote;
  let repository: JobRepository;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-repo-sync-"));
    workspaceRoot = path.join(root, "workspace");
    remote = new Remote(root);
    remote.init();
    repository = {
      provider: "gitlab",
      fullPath: "group/app",
      cloneUrl: pathToFileURL(remote.bare).href,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.mocked(query).mockClear();
  });

  function syncJob(payload: JobPayload["payload"]): JobPayload {
    return {
      id: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
      type: "repo.sync",
      taskType: "system",
      pool: null,
      taskId: null,
      repositoryId: null,
      payload,
      deliveryCount: 1,
    };
  }

  function context(
    repos: RepoCache,
    env = vi.fn(() => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "job-token" })),
  ) {
    const ctx: SystemRpcContext = {
      signal: new AbortController().signal,
      jobToken: () => "job-token",
      env,
      spawn: () => {
        throw new Error("repo.sync spawns nothing itself");
      },
      server: "https://omniralph.example",
      workspaceRoot,
      repos,
      logger: silentLogger(),
    };
    return { ctx, env };
  }

  it("is the registry's only RPC", () => {
    const registry = new SystemRpcRegistry(defaultSystemRpcs());
    expect(registry.names()).toEqual(["repo.sync"]);
    expect(registry.get("repo.sync")).toBe(repoSyncRpc);
    expect(registry.get("repo.other")).toBeUndefined();
    expect(() => new SystemRpcRegistry([repoSyncRpc, repoSyncRpc])).toThrow(/twice/);
  });

  it("clones into the repo cache, then fetches, with the job token and no Claude session", async () => {
    await remote.commit({ "README.md": "one\n" });
    const repos = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
    const { ctx, env } = context(repos);
    const dir = repos.repoDir(repository);

    expect(await repoSyncRpc.run(syncJob({ repository }), ctx)).toEqual({
      repository: "gitlab/group/app",
      cloned: true,
      fetched: false,
    });
    expect(git(dir, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(env).toHaveBeenCalled();

    const second = await remote.commit({ "README.md": "two\n" });
    expect(await repoSyncRpc.run(syncJob({ repository }), ctx)).toEqual({
      repository: "gitlab/group/app",
      cloned: false,
      fetched: true,
    });
    expect(git(dir, "cat-file", "-t", second)).toBe("commit");

    // Nothing else: no worktree, and no Claude session.
    expect(await readdir(workspaceRoot)).not.toContain(WORKTREES_DIR);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload without touching the cache", async () => {
    const sync = vi.fn();
    const { ctx } = context({ sync } as unknown as RepoCache);
    await expect(repoSyncRpc.run(syncJob({}), ctx)).rejects.toThrow("invalid repo.sync payload");
    expect(sync).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
