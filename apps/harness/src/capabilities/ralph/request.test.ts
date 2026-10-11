import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_STORY_TEMPLATE, RALPH_SYSTEM_APPEND } from "@omniralph/ralph";
import {
  RalphRequestResult,
  type JobPayload,
  type JobRepository,
  type RalphRequestPayload,
} from "@omniralph/shared";
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
      source: "linear",
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
      attachments: [],
      ship: false,
      ...overrides,
    };
    return {
      id: randomUUID(),
      capability: "ralph",
      type: "ralph.request",
      taskType: "coding",
      pool: "long",
      taskId: null,
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  function options(query: SessionQueryFn, fetchFn?: typeof fetch): StoryOptions {
    return {
      runSession: createSessionRunner(query),
      fetch: fetchFn ?? ((async () => Response.json({ ok: true })) as typeof fetch),
    };
  }

  const worktreePath = () => repos.branchWorktreePath(repo, branch);

  it("lets the session fetch and push through the brokered git-credential helper (TOOL-138)", async () => {
    let seen: { env: NodeJS.ProcessEnv; token: string } | undefined;
    const { query } = fakeQuery(async function* (call) {
      const env = call.options.env ?? {};
      seen = { env, token: await readFile(env.OMNIRALPH_JOB_TOKEN_FILE!, "utf8") };
      yield result({ summary: "Pushed." });
    });
    await runRequest(job(), context(), options(query));

    const env = seen!.env;
    // The token comes from a file the agent keeps current, never from the env itself.
    expect(env.OMNIRALPH_JOB_TOKEN).toBeUndefined();
    expect(seen!.token).toBe("job-token");
    expect(env.OMNIRALPH_SERVER).toBe("https://omniralph.example.com");
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!true",
    });
    // The token file is removed with the job.
    await expect(readFile(env.OMNIRALPH_JOB_TOKEN_FILE!, "utf8")).rejects.toThrow();
  });

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
      settingSources: ["user", "project", "local"],
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

  it("tells a session when the request comes from chat: no Linear, no story status", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield result({ summary: "Fixed the typo." });
    });
    await runRequest(
      job({
        source: "chat",
        epic: { identifier: "chat-1a2b3c4d", title: "fix the typo", kind: "single", url: null, prd: "" },
        stories: [],
        prUrl: null,
        requests: [{ id: randomUUID(), text: "fix the typo in the README" }],
      }),
      context(),
      options(query),
    );
    const [call] = calls;
    const prompt = call!.prompt;
    expect(prompt).toContain("You are working on a request from a chat thread: fix the typo.");
    expect(prompt).toContain("## Request from your team\n> fix the typo in the README");
    expect(prompt).toContain("Finish with a short summary for the chat thread");
    expect(prompt).not.toContain("Linear");
    expect(prompt).not.toContain("## Status");
    expect(prompt).not.toContain("chat-1a2b3c4d");
    const system = JSON.stringify(call!.options.systemPrompt);
    expect(system).toContain("responding to a request in a chat thread");
    expect(system).toContain("posted to the chat thread");
    expect(system).not.toContain("Linear");
  });

  it("passes the repository's model and tool settings to the session, which only narrow ralph's policy", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield result({ summary: "Done." });
    });
    await runRequest(
      job({
        settings: {
          model: "sonnet",
          setupCommand: null,
          fallbackModel: "haiku",
          appendInstruction: "Always write a changelog entry.",
          allowedTools: ["Read", "Edit", "Bash(pnpm test:*)"],
          disallowedTools: ["WebFetch"],
        },
        qualityGates: ["pnpm verify", "pnpm test"],
      }),
      context(),
      options(query),
    );
    const [call] = calls;
    expect(call!.prompt).toContain("Always write a changelog entry.");
    expect(call!.prompt).toContain("- Quality gates: `pnpm verify`, `pnpm test`");
    expect(call!.options).toMatchObject({
      model: "sonnet",
      fallbackModel: "haiku",
      tools: ["Read", "Edit", "Bash"],
      allowedTools: ["Read", "Edit", "Bash(pnpm test:*)"],
      disallowedTools: ["WebFetch"],
      permissionMode: "dontAsk",
    });
    expect(call!.options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("takes replies into its live session and unregisters once the session ends", async () => {
    let inject: ((text: string) => boolean) | undefined;
    const registered: boolean[] = [];
    const ctx: JobContext = {
      ...context(),
      setMessageInjector: (fn) => {
        inject = fn;
        registered.push(fn !== undefined);
      },
    };
    const prompts: string[] = [];
    const query: SessionQueryFn = ({ prompt }) =>
      (async function* () {
        const input = prompt[Symbol.asyncIterator]();
        const first = await input.next();
        prompts.push(first.value!.message.content as string);
        expect(inject!("Also bump the version")).toBe(true);
        yield { ...result({ summary: "Half." }), user_message_uuids: [first.value!.uuid] };
        const reply = await input.next();
        prompts.push(reply.value!.message.content as string);
        expect(reply.value!.priority).toBe("next");
        yield {
          ...result({ summary: "Done, and bumped the version." }),
          user_message_uuids: [reply.value!.uuid],
        };
      })() as AsyncGenerator<SDKMessage>;

    const out = await runRequest(job(), ctx, options(query));

    expect(prompts[1]).toBe("Also bump the version");
    expect(out).toMatchObject({ summary: "Done, and bumped the version.", error: null });
    expect(registered).toEqual([true, false]);
    expect(inject).toBeUndefined();
  });

  // cyralph: "includes images from an @mention and reports failed downloads instead of guessing"
  it("lists the request's attachments and reports failed downloads once instead of guessing", async () => {
    const shot = "1".repeat(32);
    const broken = "2".repeat(32);
    const thoughts: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/attachments/${shot}`)) {
        return new Response("PNG", { headers: { "content-type": "image/png" } });
      }
      if (url.endsWith(`/attachments/${broken}`)) {
        return Response.json({ error: "download_failed", reason: "HTTP 401" }, { status: 502 });
      }
      const body = JSON.parse(String(init?.body)) as { type: string; body: string };
      if (body.type === "thought") thoughts.push(body.body);
      return Response.json({ forwarded: true });
    }) as typeof fetch;
    const { query, calls } = fakeQuery(async function* () {
      yield result({ summary: "They match." });
    });
    const attachments = [
      { id: shot, title: "screenshot.png", sources: ["Linear thread"] },
      { id: broken, title: "old.png", sources: ["Linear thread"] },
    ];
    await runRequest(job({ attachments }), context(), options(query, fetchFn));

    const dir = path.join(root, "workspace", ".attachments", "TOOL-32");
    expect(await readFile(path.join(dir, "screenshot.png"), "utf8")).toBe("PNG");
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("## Attachments");
    expect(prompt).toContain(
      `- **screenshot.png** (from Linear thread): \`${path.join(dir, "screenshot.png")}\``,
    );
    expect(prompt).toContain(
      "- **old.png** (from Linear thread): could not be downloaded (HTTP 401). Don't guess what it shows; say so if it matters.",
    );
    expect(calls[0]!.options.additionalDirectories).toContain(dir);
    expect(thoughts).toEqual([
      "I couldn't download 1 of 2 attachment(s) from Linear, so I can't see them:\n\n- old.png (Linear thread): HTTP 401",
    ]);

    // The next request tries again, but doesn't report the same failure twice.
    await runRequest(job({ attachments }), context(), options(query, fetchFn));
    expect(calls[1]!.prompt).toContain("could not be downloaded (HTTP 401)");
    expect(thoughts).toHaveLength(1);
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

  it("returns what the session did with the review findings, dropping unknown and repeated ones", async () => {
    const fixed = "0b0f6f5e-6d0a-4c39-9a37-6f2f3e9e0a11";
    const skipped = "7c1e2d3f-4a5b-4c6d-8e7f-901234567890";
    const { query } = fakeQuery(async function* () {
      yield result({
        summary: "Fixed one finding.",
        findings: [
          { id: ` ${fixed.toUpperCase()} `, outcome: "fixed", comment: "  Guarded `load()`. " },
          { id: fixed, outcome: "skipped", comment: "A repeat." },
          { id: skipped, outcome: "skipped", comment: "The value can't be null here." },
          { id: "finding-3", outcome: "fixed", comment: "Not an ID." },
          { id: skipped.replace("7c", "8c"), outcome: "fixed", comment: "   " },
        ],
      });
    });
    const out = await runRequest(job(), context(), options(query));
    expect(out.findings).toEqual([
      { findingId: fixed, outcome: "fixed", comment: "Guarded `load()`." },
      { findingId: skipped, outcome: "skipped", comment: "The value can't be null here." },
    ]);
    expect(RalphRequestResult.safeParse(out).success).toBe(true);

    const none = fakeQuery(async function* () {
      yield result({ summary: "Nothing to fix." });
    });
    expect((await runRequest(job(), context(), options(none.query))).findings).toBeUndefined();
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

  it("reports a session that stopped while still waiting for background work as an error", async () => {
    const { query } = fakeQuery(async function* () {
      yield result({ summary: "Checks running.", waiting: true });
    });
    const out = await runRequest(job(), context(), options(query));
    expect(out.error).toContain("stopped while it waited for background work");
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

  describe("/ship", () => {
    it("commits what the session prepared with its message, pushes the branch and opens the PR/MR", async () => {
      await repos.withBranchWorktree(repo, { branch, baseBranch: "main", env: ENV }, async (wt) =>
        writeFile(path.join(wt.path, "left.txt"), "from an earlier session\n"),
      );
      const { query, calls } = fakeQuery(async function* (call) {
        await writeFile(path.join(call.options.cwd!, "fix.txt"), "last fix\n");
        yield result({
          summary: "Shipping the priority work.",
          commit: { message: "Add priorities\n\nSorts stories by priority." },
        });
      });
      const out = await runRequest(
        job({ ship: true, prUrl: null, requests: [{ id: randomUUID(), text: "/ship" }] }),
        context(),
        options(query),
      );
      const [call] = calls;
      expect(call!.prompt).toContain("This is `/ship`");
      expect(JSON.stringify(call!.options.systemPrompt)).toContain("Don't run `git commit`");
      expect(out.error).toBeNull();
      expect(out.pushed).toBe(true);
      expect(out.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(out.stashSha).toBeUndefined();
      // The earlier session's leftovers are shipped too, not stashed away.
      expect(git(remote.bare, "show", "--name-only", "--format=%s", branch)).toContain("left.txt");
      expect(git(remote.bare, "log", "-1", "--format=%H%n%s%n%n%b", branch).trim()).toBe(
        `${out.commitSha}\nAdd priorities\n\nSorts stories by priority.`,
      );
      expect(out.pullRequest).toEqual({
        action: "open",
        title: "Add priorities",
        body: "Sorts stories by priority.",
      });
    });

    it("offers the run's request stashes and keeps the session's PR/MR change when one is open", async () => {
      await repos.withBranchWorktree(repo, { branch, baseBranch: "main", env: ENV }, async (wt) => {
        await writeFile(path.join(wt.path, "half.txt"), "half done\n");
        await wt.stashWork(`omniralph ralph ${runId} request unfinished`);
      });
      const { query, calls } = fakeQuery(async function* () {
        yield result({
          summary: "Nothing new.",
          pullRequest: { action: "update", title: "Better title" },
        });
      });
      const out = await runRequest(job({ ship: true }), context(), options(query));
      expect(calls[0]!.prompt).toContain(`request unfinished`);
      expect(calls[0]!.prompt).toContain("git stash apply <sha>");
      expect(out.commitSha).toBeUndefined();
      expect(out.pullRequest).toEqual({ action: "update", title: "Better title" });
    });

    it("reports an unexpected git failure instead of failing the job", async () => {
      const { query } = fakeQuery(async function* (call) {
        await writeFile(path.join(call.options.cwd!, "fix.txt"), "last fix\n");
        // Another git process holds the index: `git add` fails.
        const lock = git(
          call.options.cwd!,
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index.lock",
        );
        await writeFile(lock.trim(), "");
        yield result({ summary: "Ready.", commit: { message: "Fix it" } });
      });
      const out = await runRequest(job({ ship: true, prUrl: null }), context(), options(query));
      expect(out.error).toContain("shipping failed");
      expect(out.error).toContain("index.lock");
      expect(out.pushed).toBe(false);
      expect(out.commitSha).toBeUndefined();
      expect(git(remote.bare, "branch", "--list", branch)).toBe("");
    });

    it("commits nothing when the session leaves changes without a commit message", async () => {
      const { query } = fakeQuery(async function* (call) {
        await writeFile(path.join(call.options.cwd!, "fix.txt"), "last fix\n");
        yield result({ summary: "The gates fail." });
      });
      const out = await runRequest(job({ ship: true, prUrl: null }), context(), options(query));
      expect(out.error).toContain("no commit message");
      expect(out.pushed).toBe(false);
      expect(out.stashSha).toMatch(/^[0-9a-f]{40}$/);
      expect(git(remote.bare, "branch", "--list", branch)).toBe("");
      expect(out.pullRequest).toBeUndefined();
    });
  });

  describe("permission prompts of the repository's settings", () => {
    function permissionFetch(answers: string[]) {
      const requests: { method: string; url: string; body?: unknown }[] = [];
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          method,
          url,
          ...(typeof init?.body === "string" && { body: JSON.parse(init.body) }),
        });
        if (url.includes("/permissions/") && method === "GET") {
          return Response.json({ status: answers.shift() ?? "pending", answeredBy: null });
        }
        if (method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ status: "pending" });
      }) as typeof fetch;
      return { fetchFn, requests };
    }

    it("asks in Linear and lets the call run once a person allows it", async () => {
      const { fetchFn, requests } = permissionFetch(["pending", "allowed"]);
      let decision: unknown;
      const { query } = fakeQuery(async function* (call) {
        decision = await call.options.canUseTool!(
          "Bash",
          { command: "git commit -m 'Fix it'" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
            requestId: "req-1",
            title: "Claude wants to run git commit",
            matchedAskRule: {
              source: "projectSettings",
              toolName: "Bash",
              ruleContent: "git commit:*",
            },
          },
        );
        yield result({ summary: "Committed." });
      });
      await runRequest(job(), context(), {
        ...options(query, fetchFn),
        permissionPollIntervalMs: 5,
      });
      expect(decision).toMatchObject({ behavior: "allow" });
      const ask = requests.find((r) => r.method === "POST" && r.url.endsWith("/permissions"));
      expect(ask?.body).toMatchObject({
        tool: "Bash",
        detail: "git commit -m 'Fix it'",
        reason:
          "Claude wants to run git commit\nIt matches `Bash(git commit:*)` in the projectSettings settings.",
        timeoutSeconds: 1800,
      });
      expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    });

    it("denies the call and closes the question when nobody answers in time", async () => {
      const { fetchFn, requests } = permissionFetch([]);
      let decision: unknown;
      const { query } = fakeQuery(async function* (call) {
        decision = await call.options.canUseTool!(
          "Bash",
          { command: "git push" },
          { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "req-1" },
        );
        yield result({ summary: "Couldn't push." });
      });
      await runRequest(job(), context(), {
        ...options(query, fetchFn),
        permissionPollIntervalMs: 5,
        permissionTimeoutMs: 50,
      });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    });
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
