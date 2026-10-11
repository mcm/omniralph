import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { PR_DESCRIPTION_HEADING } from "@omniralph/ralph";
import {
  RalphDescribePrResult,
  type JobPayload,
  type JobRepository,
  type RalphDescribePrPayload,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../logger.js";
import { firstPrompt } from "../../test/fake-query.js";
import { ENV, git, Remote } from "../../test/git-remote.js";
import { RepoCache } from "../../workspace/repoCache.js";
import { RetryableJobError, type JobContext } from "../index.js";
import { fitTitle, runDescribePr } from "./describe-pr.js";
import { createRalphCapability } from "./index.js";
import { createSessionRunner, type SessionQueryFn } from "./session.js";
import type { StoryOptions } from "./story.js";

interface Call {
  prompt: string;
  options: Options;
}

/** A fake Agent SDK `query()` that yields `messages`. */
function fakeQuery(messages: (call: Call) => unknown[]): {
  query: SessionQueryFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query: SessionQueryFn = (params) =>
    (async function* () {
      const call = { prompt: await firstPrompt(params.prompt), options: params.options ?? {} };
      calls.push(call);
      for (const m of messages(call)) yield m;
    })() as AsyncGenerator<SDKMessage>;
  return { query, calls };
}

const assistant = (...content: unknown[]) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content },
});

function result(structured: unknown, subtype = "success") {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: "Described.",
    errors: subtype === "success" ? undefined : ["boom"],
    structured_output: structured,
    modelUsage: {
      opus: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
}

const BODY = [
  "Adds ralph runs to Omniralph.",
  "",
  "**Stories**",
  "- TOOL-90: Start runs",
  "- TOOL-91: Run a story",
  "",
  "**Verification**",
  "- `pnpm test` passed for every story.",
].join("\n");

describe("ralph.describe-pr", { timeout: 60_000 }, () => {
  let root: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let posted: Record<string, unknown>[];
  const branch = "feat/tool-32";

  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true });
  }) as typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-describe-"));
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
        throw new Error("ralph.describe-pr must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot: path.join(root, "workspace"),
      repos,
      logger: silentLogger(),
    };
  }

  function job(overrides: Partial<RalphDescribePrPayload> = {}): JobPayload {
    const payload: RalphDescribePrPayload = {
      runId: randomUUID(),
      repositoryId: randomUUID(),
      repository: repo,
      branch,
      baseBranch: "main",
      settings: {
        model: "sonnet",
        setupCommand: null,
        fallbackModel: null,
        appendInstruction: null,
        allowedTools: null,
        disallowedTools: null,
      },
      epic: {
        identifier: "TOOL-32",
        title: "Ralph core",
        url: "https://linear.app/x/issue/TOOL-32",
        prd: "# PRD: Ralph core\n\nBuild the loop.",
      },
      stories: [
        {
          identifier: "TOOL-90",
          title: "Start runs",
          status: "completed",
          commitSha: "a".repeat(40),
        },
        {
          identifier: "TOOL-91",
          title: "Run a story",
          status: "completed",
          commitSha: "b".repeat(40),
        },
      ],
      progress: "## [2026-10-06] - TOOL-90: Start runs\nUsed after().",
      qualityGates: ["pnpm test"],
      ...overrides,
    };
    return {
      id: randomUUID(),
      type: "ralph.describe-pr",
      taskType: "query",
      pool: "short",
      taskId: null,
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  const options = (query: SessionQueryFn, extra: StoryOptions = {}): StoryOptions => ({
    runSession: createSessionRunner(query),
    fetch: fetchFn,
    ...extra,
  });

  it("runs a read-only session in the branch worktree and returns the title and body", async () => {
    const { query, calls } = fakeQuery(() => [
      assistant({ type: "text", text: "Reading the diff." }),
      assistant({
        type: "tool_use",
        name: "Bash",
        input: { command: "git diff origin/main...HEAD" },
      }),
      result({ title: ' "Add ralph runs" ', body: `\n${BODY}\n` }),
    ]);
    const capability = createRalphCapability(options(query));
    const output = await capability.run(job(), context());

    expect(RalphDescribePrResult.parse(output)).toEqual({
      title: "Add ralph runs",
      body: BODY,
      usage: { inputTokens: 50, outputTokens: 10 },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.options.cwd).toBe(repos.branchWorktreePath(repo, branch));
    expect(git(call!.options.cwd!, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(call!.options.model).toBe("sonnet");
    expect(call!.options.permissionMode).toBe("dontAsk");
    expect(call!.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(call!.options.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(call!.options.allowedTools).toEqual(
      expect.arrayContaining(["Bash(git log:*)", "Bash(git diff:*)"]),
    );
    expect(call!.options.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(call!.options.settingSources).toEqual([]);
    expect(call!.options.env?.OMNIRALPH_JOB_TOKEN).toBeUndefined();
    expect(call!.prompt).toContain(PR_DESCRIPTION_HEADING);
    expect(call!.prompt).toContain("ready for a pull request into `main`");
    expect(call!.prompt).toContain("- TOOL-91: Run a story (`bbbbbbbbbb`)");
    expect(call!.prompt).toContain("Used after().");
    expect(call!.prompt).toContain("- `pnpm test`");
    expect(posted.map((p) => [p.type, p.body])).toEqual([
      ["thought", "Writing the pull request title and description."],
      ["thought", "Reading the diff."],
      ["action", "Bash"],
    ]);
  });

  it("fits a long title into 72 characters", async () => {
    const long =
      "Add the ralph capability with Linear delegations, branch worktrees and pull requests";
    const { query } = fakeQuery(() => [result({ title: long, body: BODY })]);
    const output = await runDescribePr(job(), context(), options(query));
    expect(output.title.length).toBeLessThanOrEqual(72);
    expect(output.title).toBe(
      "Add the ralph capability with Linear delegations, branch worktrees and…",
    );
    expect(fitTitle("Short")).toBe("Short");
    expect(fitTitle("x".repeat(100))).toHaveLength(72);
  });

  it("says merge request for GitLab", async () => {
    const { query, calls } = fakeQuery(() => [result({ title: "Add runs", body: BODY })]);
    repo = { ...repo, provider: "gitlab" };
    await runDescribePr(job({ repository: repo }), context(), options(query));
    expect(calls[0]!.prompt).toContain("ready for a merge request into `main`");
  });

  it("fails the job without a valid title and body", async () => {
    for (const structured of [
      undefined,
      { title: "Add runs" },
      { title: " ", body: BODY },
      { body: BODY },
    ]) {
      const { query } = fakeQuery(() => [result(structured)]);
      await expect(runDescribePr(job(), context(), options(query))).rejects.toThrow(
        /without a valid title and body/,
      );
    }
  });

  it("fails the job when the session fails", async () => {
    const { query } = fakeQuery(() => [result(undefined, "error_during_execution")]);
    await expect(runDescribePr(job(), context(), options(query))).rejects.toThrow(
      /description session failed: error_during_execution: boom/,
    );
  });

  it("retries on a Claude rate limit", async () => {
    const { query } = fakeQuery(() => [
      {
        type: "assistant",
        parent_tool_use_id: null,
        error: "rate_limit",
        message: { content: [] },
      },
    ]);
    const error = await runDescribePr(
      job(),
      context(),
      options(query, { defaultRetryAfterSeconds: 42 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableJobError);
    expect((error as RetryableJobError).retryAfterSeconds).toBe(42);
  });

  it("rejects an invalid payload", async () => {
    const { query } = fakeQuery(() => []);
    const bad = { ...job(), payload: { branch } };
    await expect(runDescribePr(bad, context(), options(query))).rejects.toThrow(
      /invalid ralph.describe-pr payload/,
    );
  });
});
