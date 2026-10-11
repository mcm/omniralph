import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { preparationHash } from "@omniralph/ralph";
import {
  RalphPrepareResult,
  type JobPayload,
  type JobRepository,
  type RalphPreparePayload,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../logger.js";
import { ENV, Remote } from "../../test/git-remote.js";
import { RepoCache } from "../../workspace/repoCache.js";
import type { JobContext } from "../index.js";
import { createRalphCapability } from "./index.js";

describe("ralph.prepare", { timeout: 60_000 }, () => {
  let root: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let posted: Record<string, unknown>[];
  let head: string;
  const branch = "feat/tool-32";

  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true });
  }) as typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-prepare-"));
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
    posted = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(): JobContext {
    return {
      signal: controller.signal,
      jobToken: () => "job-token",
      env: (extra) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "job-token", ...extra }),
      spawn: () => {
        throw new Error("ralph.prepare must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot: path.join(root, "workspace"),
      repos,
      logger: silentLogger(),
    };
  }

  function job(commands: string[], overrides: Partial<RalphPreparePayload> = {}): JobPayload {
    const payload: RalphPreparePayload = {
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
      capability: "ralph",
      type: "ralph.prepare",
      taskType: "coding",
      pool: "long",
      taskId: null,
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  const run = async (j: JobPayload) =>
    RalphPrepareResult.parse(await createRalphCapability({ fetch: fetchFn }).run(j, context()));
  const worktree = () => repos.branchWorktreePath(repo, branch);

  it("runs the commands one at a time in the branch worktree, without the job token", async () => {
    const out = await run(
      job([
        "echo one > prepared.txt && echo stdout-one",
        'echo two >&2; echo "token=${OMNIRALPH_JOB_TOKEN:-none}"',
      ]),
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
    ]);
    expect(await readFile(path.join(worktree(), "prepared.txt"), "utf8")).toBe("one\n");
    expect(posted.map((p) => [p.type, p.body, p.parameter])).toEqual([
      ["action", "Prepare", "echo one > prepared.txt && echo stdout-one"],
      ["action", "Prepare", 'echo two >&2; echo "token=${OMNIRALPH_JOB_TOKEN:-none}"'],
    ]);
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

  it("runs nothing when HEAD moved since the approval", async () => {
    const moved = await remote.commit({ "story.txt": "story 2\n" }, branch);
    const out = await run(job(["touch never.txt"]));
    expect(out).toMatchObject({ status: "stale", commands: [], headSha: moved });
    await expect(readFile(path.join(worktree(), "never.txt"), "utf8")).rejects.toThrow();
    expect(posted).toEqual([]);
  });

  it("runs nothing when the commands changed since the approval", async () => {
    const out = await run(
      job(["touch never.txt"], { commandsHash: preparationHash(["echo approved"]) }),
    );
    expect(out).toMatchObject({ status: "stale", commands: [], headSha: head });
  });

  it("with no story committed, requires HEAD to be the base branch", async () => {
    const fresh = "feat/fresh";
    const base = job(["echo fresh"], { branch: fresh, approvedHeadSha: null });
    expect((await run(base)).status).toBe("completed");
    // The branch with a story commit on top of main isn't "nothing committed".
    expect((await run(job(["echo x"], { approvedHeadSha: null }))).status).toBe("stale");
  });

  it("rejects an invalid payload", async () => {
    await expect(run({ ...job(["x"]), payload: {} })).rejects.toThrow(
      "invalid ralph.prepare payload",
    );
  });
});
