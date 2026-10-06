import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_STORY_TEMPLATE, RALPH_SYSTEM_APPEND } from "@omniralph/ralph";
import type { JobPayload, JobRepository, RalphRequestPayload } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../logger.js";
import { firstPrompt } from "../../test/fake-query.js";
import { ENV, git, Remote } from "../../test/git-remote.js";
import { RepoCache } from "../../workspace/repoCache.js";
import { RetryableJobError, type JobContext } from "../index.js";
import { createRalphCapability } from "./index.js";
import { runRequest } from "./request.js";
import { createSessionRunner, type SessionQueryFn } from "./session.js";
import type { StoryOptions } from "./story.js";

interface Call {
  prompt: string;
  options: Options;
}

function fakeQuery(script: (call: Call, n: number) => AsyncGenerator<unknown>): {
  query: SessionQueryFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query: SessionQueryFn = (params) =>
    (async function* () {
      const call = { prompt: await firstPrompt(params.prompt), options: params.options ?? {} };
      calls.push(call);
      yield* script(call, calls.length) as AsyncGenerator<SDKMessage>;
    })();
  return { query, calls };
}

function result(structured: unknown, sessionId = "claude-req-1") {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    session_id: sessionId,
    structured_output: structured,
    modelUsage: {
      opus: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
}

const LONG_PRD = `# PRD: Ralph core\n\n${"x".repeat(7000)}\n\n## Quality Gates\n- \`true\`\n`;

describe("ralph.request", { timeout: 60_000 }, () => {
  let root: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  const runId = randomUUID();
  const branch = "feat/tool-32";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-request-"));
    remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "hello\n" });
    repo = { provider: "gitlab", fullPath: "group/app", cloneUrl: pathToFileURL(remote.bare).href };
    repos = new RepoCache({
      workspaceRoot: path.join(root, "workspace"),
      credentialHelper: "!true",
      lockRetryMs: 20,
    });
    controller = new AbortController();
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
        throw new Error("ralph.request must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot: path.join(root, "workspace"),
      repos,
      logger: silentLogger(),
    };
  }

  function job(overrides: Partial<RalphRequestPayload> = {}): JobPayload {
    const payload: RalphRequestPayload = {
      runId,
      repositoryId: randomUUID(),
      repository: repo,
      branch,
      baseBranch: "main",
      settings: {
        model: null,
        setupCommand: null,
        fallbackModel: null,
        appendInstruction: "Always be brief.",
        allowedTools: null,
        disallowedTools: null,
      },
      epic: {
        identifier: "TOOL-32",
        title: "Ralph core",
        kind: "children",
        url: null,
        prd: LONG_PRD,
      },
      stories: [
        {
          identifier: "TOOL-90",
          title: "Start runs",
          status: "completed",
          manual: false,
          dependsOn: [],
          repository: null,
        },
        {
          identifier: "TOOL-91",
          title: "Run a story",
          status: "open",
          manual: false,
          dependsOn: [],
          repository: null,
        },
      ],
      requests: [{ id: randomUUID(), text: "what's left on this epic?\nand why" }],
      prUrl: "https://gitlab.example.com/group/app/-/merge_requests/3",
      progress: "# Ralph Progress Log\n",
      qualityGates: ["pnpm test"],
      historyRewrite: "when-asked",
      resumeSessionId: null,
      ...overrides,
    };
    return {
      id: randomUUID(),
      capability: "ralph",
      type: "ralph.request",
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  function options(query: SessionQueryFn): StoryOptions {
    return {
      runSession: createSessionRunner(query),
      fetch: (async () => Response.json({ ok: true })) as typeof fetch,
    };
  }

  const worktreePath = () => repos.branchWorktreePath(repo, branch);

  it("runs one session in the lane's worktree with the request prompt and ralph's policy (a mention only does what it asks)", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield result({ summary: "The epic has 1 open story; TOOL-91 is next." });
    });
    const out = await runRequest(job(), context(), options(query));

    expect(out).toEqual({
      summary: "The epic has 1 open story; TOOL-91 is next.",
      error: null,
      sessionId: "claude-req-1",
      usage: { inputTokens: 100, outputTokens: 20 },
      durationMs: expect.any(Number),
    });
    const [call] = calls;
    expect(call!.options).toMatchObject({
      cwd: worktreePath(),
      model: "opus",
      permissionMode: "bypassPermissions",
      settingSources: ["project", "local"],
      persistSession: true,
    });
    expect(call!.options.resume).toBeUndefined();
    expect(call!.options.env?.OMNIRALPH_JOB_TOKEN).toBeUndefined();
    const prompt = call!.prompt;
    expect(prompt).toContain("You are working on Linear TOOL-32: Ralph core.");
    expect(prompt).toContain("## Status: 1/2 stories complete");
    expect(prompt).toContain("- [x] TOOL-90: Start runs");
    expect(prompt).toContain("- [ ] TOOL-91: Run a story");
    expect(prompt).toContain(
      "- Merge request: https://gitlab.example.com/group/app/-/merge_requests/3",
    );
    expect(prompt).toContain("- Progress log (learnings from earlier sessions): `");
    expect(prompt).toContain("- Quality gates: `pnpm test`");
    expect(prompt).toContain(`${"x".repeat(100)}`);
    expect(prompt).not.toContain("x".repeat(6500));
    expect(prompt).toContain("## Request from your team\n> what's left on this epic?\n> and why");
    expect(prompt).toContain("Do what it asks, and nothing beyond it.");
    expect(prompt).toContain("don't run `gh` or `glab`");
    expect(prompt).toContain("set `pullRequest` in your structured result");
    expect(prompt).toContain("Always be brief.");
    const system = JSON.stringify(call!.options.systemPrompt);
    expect(system).toContain("responding to a request in a Linear agent session");
    expect(system).toContain("through `pullRequest`");
    expect(system).not.toContain("Never run git commit, git push");
    // Nothing was left uncommitted.
    expect(git(worktreePath(), "stash", "list")).toBe("");
  });

  it("returns the PR/MR change the session asks for", async () => {
    const { query } = fakeQuery(async function* () {
      yield result({
        summary: "Pushed the branch.",
        pullRequest: { action: "open", title: "  Add   priorities ", body: "Adds them." },
      });
    });
    const out = await runRequest(job(), context(), options(query));
    expect(out.pullRequest).toEqual({
      action: "open",
      title: "Add priorities",
      body: "Adds them.",
    });
  });

  it("resumes the lane's request conversation, and starts fresh when the resume fails without a session", async () => {
    const resumed = fakeQuery(async function* () {
      yield result({ summary: "Shorter." }, "claude-req-2");
    });
    const out = await runRequest(
      job({ resumeSessionId: "claude-req-1" }),
      context(),
      options(resumed.query),
    );
    expect(resumed.calls.map((c) => c.options.resume)).toEqual(["claude-req-1"]);
    expect(out.sessionId).toBe("claude-req-2");

    const failing = fakeQuery(async function* (_call, n) {
      if (n === 1) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["no conversation"],
        };
        return;
      }
      yield result({ summary: "Fresh." }, "claude-req-3");
    });
    const fresh = await runRequest(
      job({ resumeSessionId: "gone" }),
      context(),
      options(failing.query),
    );
    expect(failing.calls.map((c) => c.options.resume)).toEqual(["gone", undefined]);
    expect(fresh).toMatchObject({ summary: "Fresh.", sessionId: "claude-req-3", error: null });
  });

  it("stashes a dirty worktree before a request session too, and what the session left after it", async () => {
    await repos.withBranchWorktree(repo, { branch, baseBranch: "main", env: ENV }, async (wt) =>
      writeFile(path.join(wt.path, "stray.txt"), "left behind\n"),
    );
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(call.options.cwd!, "half.txt"), "half done\n");
      yield result({ summary: "Renamed most of it." });
    });
    const out = await runRequest(job(), context(), options(query));
    const stashes = git(worktreePath(), "stash", "list", "--format=%H %gs");
    expect(stashes).toContain(`omniralph ralph ${runId} request pre-run`);
    expect(stashes).toContain(`omniralph ralph ${runId} request unfinished`);
    const unfinished = stashes.split("\n").find((l) => l.includes("request unfinished"))!;
    expect(out.stashSha).toBe(unfinished.split(" ")[0]);
    expect(git(worktreePath(), "status", "--porcelain")).toBe("");
  });

  it("reports a session without a valid result as an error", async () => {
    const { query } = fakeQuery(async function* () {
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "I tried." }] },
      };
      yield result({ nope: true });
    });
    const out = await runRequest(job(), context(), options(query));
    expect(out.error).toContain("it ended without a valid structured result");
    expect(out.summary).toBe("Done.");
  });

  it("throws a retryable error on a Claude rate limit", async () => {
    const { query } = fakeQuery(async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["rate_limit exceeded"],
      };
    });
    await expect(runRequest(job(), context(), options(query))).rejects.toBeInstanceOf(
      RetryableJobError,
    );
  });

  describe("history rewrites on request (rebase)", () => {
    it("lets an explicit rebase request rewrite the epic branch with --force-with-lease", async () => {
      const { query, calls } = fakeQuery(async function* () {
        yield result({ summary: "Rebased." });
      });
      await runRequest(
        job({ requests: [{ id: randomUUID(), text: "please rebase this branch onto main" }] }),
        context(),
        options(query),
      );
      const [call] = calls;
      expect(call!.prompt).toContain("git rebase origin/main");
      expect(call!.prompt).toContain(`git push --force-with-lease origin ${branch}`);
      expect(call!.prompt).toContain("don't substitute a merge");
      const system = JSON.stringify(call!.options.systemPrompt);
      expect(system).toContain("That is allowed here.");
      expect(system).not.toContain("Never rewrite published history");
    });

    it("can be disabled per repository, in which case the agent explains and offers a merge", async () => {
      const { query, calls } = fakeQuery(async function* () {
        yield result({ summary: "Not allowed." });
      });
      await runRequest(
        job({
          historyRewrite: "never",
          requests: [{ id: randomUUID(), text: "rebase onto main" }],
        }),
        context(),
        options(query),
      );
      const [call] = calls;
      expect(call!.prompt).toContain(
        "History rewrites (rebase, squash, force-push) are disabled for this repository",
      );
      expect(call!.prompt).not.toContain("--force-with-lease");
      expect(JSON.stringify(call!.options.systemPrompt)).toContain(
        "Never rewrite published history",
      );
    });

    it("story sessions still never touch git history or pushes", () => {
      expect(RALPH_SYSTEM_APPEND).toContain("Never run git commit, git push");
      expect(RALPH_SYSTEM_APPEND).not.toContain("force-with-lease");
      expect(DEFAULT_STORY_TEMPLATE).toContain("Do NOT create git commits or push");
      // Request jobs run with ralph's policy, like stories; only their system prompt differs.
      const capability = createRalphCapability();
      expect(capability.jobTypes).toContain("ralph.request");
      expect(capability.jobToolPolicies?.["ralph.request"]).toBe(capability.toolPolicy);
    });
  });
});
