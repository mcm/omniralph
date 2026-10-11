import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { preparationHash } from "@omniralph/ralph";
import {
  WorktreeExecResult,
  type JobPayload,
  type JobRepository,
  type WorktreeExecPayload,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../logger.js";
import { ENV, Remote } from "../test/git-remote.js";
import { RepoCache } from "../workspace/repoCache.js";
import { SystemRpcRegistry, defaultSystemRpcs, type SystemRpcContext } from "./index.js";
import { worktreeExecRpc } from "./worktree-exec.js";

// Any Claude session would go through the SDK's `query()`: a fake that records every one.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const { scriptedQuery } = await import("../test/fake-query.js");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    query: vi.fn(scriptedQuery(() => []).query),
  };
});

// Spawns real `git` and `bash` processes, which can be slow while every package's suite runs.
describe("worktree.exec", { timeout: 60_000 }, () => {
  let root: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let head: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const branch = "feat/tool-32";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-worktree-exec-"));
    remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "hello\n" });
    head = await remote.commit({ "story.txt": "story 1\n" }, branch);
    repo = { provider: "github", fullPath: "acme/app", cloneUrl: pathToFileURL(remote.bare).href };
    repos = new RepoCache({
      workspaceRoot: path.join(root, "workspace"),
      credentialHelper: "!true",
      lockRetryMs: 20,
    });
    controller = new AbortController();
    // A system RPC posts nothing to the control panel (its token can't post activities).
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.mocked(query).mockClear();
    vi.restoreAllMocks();
  });

  function context(): { ctx: SystemRpcContext; env: ReturnType<typeof vi.fn> } {
    const env = vi.fn((extra?: NodeJS.ProcessEnv) => ({
      ...ENV,
      OMNIRALPH_JOB_TOKEN: "job-token",
      ...extra,
    }));
    const ctx: SystemRpcContext = {
      signal: controller.signal,
      jobToken: () => "job-token",
      env,
      spawn: () => {
        throw new Error("worktree.exec must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot: path.join(root, "workspace"),
      repos,
      logger: silentLogger(),
    };
    return { ctx, env };
  }

  function job(commands: string[], overrides: Partial<WorktreeExecPayload> = {}): JobPayload {
    const payload: WorktreeExecPayload = {
      runId: randomUUID(),
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
      story: { identifier: "TOOL-40", title: "Create the bucket" },
      commands,
      commandsHash: preparationHash(commands),
      approvedHeadSha: head,
      ...overrides,
    };
    return {
      id: randomUUID(),
      type: "worktree.exec",
      taskType: "system",
      pool: null,
      taskId: null,
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  const run = async (j: JobPayload) =>
    WorktreeExecResult.parse(await worktreeExecRpc.run(j, context().ctx));
  const worktree = () => repos.branchWorktreePath(repo, branch);

  it("is in the registry", () => {
    expect(new SystemRpcRegistry(defaultSystemRpcs()).get("worktree.exec")).toBe(worktreeExecRpc);
  });

  it("runs the commands one at a time in the branch worktree, without the job token or a session", async () => {
    const { ctx, env } = context();
    const out = WorktreeExecResult.parse(
      await worktreeExecRpc.run(
        job([
          "echo one > prepared.txt && echo stdout-one",
          'echo two >&2; echo "token=${OMNIRALPH_JOB_TOKEN:-none}"',
          'test "$(cat prepared.txt)" = one && echo login-shell=$0',
        ]),
        ctx,
      ),
    );
    expect(out.status).toBe("completed");
    expect(out.headSha).toBe(head);
    expect(out.commands).toEqual([
      { command: "echo one > prepared.txt && echo stdout-one", exitCode: 0, output: "stdout-one" },
      {
        command: 'echo two >&2; echo "token=${OMNIRALPH_JOB_TOKEN:-none}"',
        exitCode: 0,
        output: "two\ntoken=none",
      },
      {
        command: 'test "$(cat prepared.txt)" = one && echo login-shell=$0',
        exitCode: 0,
        output: "login-shell=bash",
      },
    ]);
    expect(await readFile(path.join(worktree(), "prepared.txt"), "utf8")).toBe("one\n");
    // The fetch used the job env (its read-only token); the commands didn't get it.
    expect(env).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops at the first failure and reports its exit code and output tail", async () => {
    const out = await run(job(["echo ok", "echo broken >&2; exit 3", "touch never.txt"]));
    expect(out.status).toBe("failed");
    expect(out.commands).toEqual([
      { command: "echo ok", exitCode: 0, output: "ok" },
      { command: "echo broken >&2; exit 3", exitCode: 3, output: "broken" },
    ]);
    await expect(readFile(path.join(worktree(), "never.txt"), "utf8")).rejects.toThrow();
  });

  it("reports HEAD after the commands when they commit", async () => {
    const out = await run(
      job([
        "echo made > made.txt && git add made.txt && git -c user.name=t -c user.email=t@example.com commit -qm made",
      ]),
    );
    expect(out.status).toBe("completed");
    expect(out.headSha).not.toBe(head);
    expect(out.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("runs nothing when HEAD moved since the approval", async () => {
    const moved = await remote.commit({ "story.txt": "story 2\n" }, branch);
    const out = await run(job(["touch never.txt"]));
    expect(out).toMatchObject({ status: "stale", commands: [], headSha: moved });
    await expect(readFile(path.join(worktree(), "never.txt"), "utf8")).rejects.toThrow();
  });

  it("runs nothing when the commands changed since the approval", async () => {
    const out = await run(
      job(["touch never.txt"], { commandsHash: preparationHash(["echo approved"]) }),
    );
    expect(out).toMatchObject({ status: "stale", commands: [], headSha: head });
    await expect(readFile(path.join(worktree(), "never.txt"), "utf8")).rejects.toThrow();
  });

  it("with no story committed, requires HEAD to be the base branch", async () => {
    const base = job(["echo fresh"], { branch: "feat/fresh", approvedHeadSha: null });
    expect((await run(base)).status).toBe("completed");
    // The branch with a story commit on top of main isn't "nothing committed".
    expect((await run(job(["echo x"], { approvedHeadSha: null }))).status).toBe("stale");
  });

  it("rejects an invalid payload", async () => {
    await expect(run({ ...job(["x"]), payload: {} })).rejects.toThrow(
      "invalid worktree.exec payload",
    );
  });
});
