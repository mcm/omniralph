import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  McpSdkServerConfigWithInstance,
  Options,
  SdkMcpToolDefinition,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  RalphRequestResult,
  RunSpec,
  type JobRepository,
  type RalphRequestPayload,
  type RalphStoryPayload,
  type RalphStoryResult,
} from "@omniralph/shared";
import { getBuiltinRunSpec, getBuiltinTask } from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobContext } from "../capabilities/index.js";
import { silentLogger } from "../logger.js";
import { createSessionRunner, type SessionQueryFn } from "../session/session.js";
import { firstPrompt } from "../test/fake-query.js";
import { ENV, git, Remote } from "../test/git-remote.js";
import { basicAuth, startGitHttpServer, type GitHttpServer } from "../test/git-http.js";
import { defaultCredentialHelper } from "../workspace/git.js";
import { PUSH_GUARD_HOOK, RepoCache } from "../workspace/repoCache.js";
import { requestRunPrompt, runCodingTask, type CodingTaskOptions } from "./coding.js";

interface Call {
  prompt: string;
  options: Options;
}

/** A fake Agent SDK `query()`: `script` does the session's work and yields its messages. */
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

type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

/** The agent tools the session was given (`mcp__omniralph__<tool>`). */
function agentTools(call: Call): string[] {
  return (call.options.allowedTools ?? []).filter((t) => t.startsWith("mcp__omniralph__"));
}

/** Calls an agent tool of the session's in-process `omniralph` server, as Claude would. */
async function callAgentTool(
  call: Call,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = call.options.mcpServers?.omniralph as McpSdkServerConfigWithInstance | undefined;
  const tools = (
    server?.instance as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }
      >;
    }
  )?._registeredTools;
  const tool = tools?.[name];
  if (!tool) throw new Error(`${name} isn't offered`);
  return tool.handler(args, {});
}

/** `ship`'s outcome, as the session reads it. */
async function ship(call: Call, args: Record<string, unknown>) {
  const out = await callAgentTool(call, "ship", args);
  const text = out.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return {
    isError: out.isError === true,
    outcome: JSON.parse(text) as {
      commitSha: string | null;
      pushed: boolean;
      error: string | null;
    },
  };
}

const engineer = getBuiltinRunSpec("builtin:implement-story")!.agent;
const requestTask = getBuiltinTask("builtin:handle-request")!;
const storyTask = getBuiltinTask("builtin:implement-story")!;

function runSpec(
  repo: JobRepository,
  trigger: RalphRequestPayload,
  overrides: Partial<RunSpec> = {},
): RunSpec {
  const jobId = randomUUID();
  const token = (value: string, kind: "lifecycle" | "session") => ({
    jobId,
    token: value,
    expiresIn: 600,
    kind,
  });
  return RunSpec.parse({
    jobId,
    taskType: "coding",
    pool: "long",
    agent: engineer,
    task: requestTask,
    trigger: {
      kind: trigger.source === "chat" ? "chat.request" : "tracker.mention",
      context: trigger,
    },
    repository: repo,
    ref: null,
    requireCheckout: false,
    tools: { allowedTools: [], disallowedTools: [] },
    model: "opus",
    fallbackModel: null,
    tokenBudget: null,
    tokens: {
      lifecycle: token("lifecycle-token", "lifecycle"),
      session: token("session-token", "session"),
    },
    ...overrides,
  });
}

function requestPayload(
  repo: JobRepository,
  runId: string,
  branch: string,
  overrides: Partial<RalphRequestPayload> = {},
): RalphRequestPayload {
  return {
    runId,
    source: "tracker",
    trackerProvider: "linear",
    trackerName: "Linear",
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
    epic: { identifier: "TOOL-32", title: "Ralph core", kind: "children", url: null, prd: "" },
    stories: [],
    requests: [{ id: randomUUID(), text: "rename the button and push it" }],
    prUrl: null,
    progress: "# Ralph Progress Log\n",
    qualityGates: ["true"],
    historyRewrite: "when-asked",
    resumeSessionId: null,
    attachments: [],
    ship: false,
    ...overrides,
  };
}

function storyPayload(repo: JobRepository, runId: string, branch: string): RalphStoryPayload {
  return {
    runId,
    repositoryId: randomUUID(),
    repository: repo,
    branch,
    baseBranch: "main",
    settings: requestPayload(repo, runId, branch).settings,
    trackerProvider: "linear",
    trackerName: "Linear",
    storyId: randomUUID(),
    attempt: 1,
    epic: { identifier: "TOOL-32", title: "Ralph core", kind: "children", url: null, prd: "" },
    story: {
      identifier: "TOOL-91",
      title: "Run a story",
      trackerIssueId: "issue-91",
      url: null,
      description: "Run it.",
      kind: "story",
    },
    stories: [],
    commitMessage: "feat(TOOL-91): Run a story",
    qualityGates: [],
    prdQualityGates: [],
    progress: "",
    lastFeedback: null,
    guidance: [],
    attachments: [],
  };
}

describe("coding runs of a request task", { timeout: 60_000 }, () => {
  let root: string;
  let workspaceRoot: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let posted: { url: string; method: string; auth: string | null; body: unknown }[];
  const runId = randomUUID();
  const branch = "feat/tool-32";

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    posted.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json({ ok: true });
  }) as typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-coding-request-"));
    workspaceRoot = path.join(root, "workspace");
    remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "hello\n" });
    repo = { provider: "github", fullPath: "acme/app", cloneUrl: pathToFileURL(remote.bare).href };
    repos = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
    controller = new AbortController();
    posted = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(extra: Partial<JobContext> = {}): JobContext {
    return {
      signal: controller.signal,
      jobToken: () => "lifecycle-token",
      sessionToken: () => "session-token",
      env: (more) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "lifecycle-token", ...more }),
      sessionEnv: (more) => ({
        ...ENV,
        OMNIRALPH_JOB_TOKEN: "session-token",
        OMNIRALPH_JOB_TOKEN_FILE: path.join(root, "session-token"),
        ...more,
      }),
      spawn: () => {
        throw new Error("coding runs must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot,
      repos,
      logger: silentLogger(),
      ...extra,
    };
  }

  const payload = (overrides: Partial<RalphRequestPayload> = {}) =>
    requestPayload(repo, runId, branch, overrides);
  const spec = (trigger = payload(), overrides: Partial<RunSpec> = {}) =>
    runSpec(repo, trigger, overrides);

  function options(query: SessionQueryFn, extra: CodingTaskOptions = {}): CodingTaskOptions {
    return { runSession: createSessionRunner(query), fetch: fetchFn, ...extra };
  }

  /** A coding run of a request task: its result is a request's. */
  async function run(
    runSpecValue: RunSpec,
    query: SessionQueryFn,
    extra: CodingTaskOptions = {},
    ctx: JobContext = context(),
  ): Promise<RalphRequestResult> {
    const out = await runCodingTask(runSpecValue, ctx, options(query, extra));
    expect(RalphRequestResult.safeParse(out).success).toBe(true);
    return out as RalphRequestResult;
  }

  const worktreePath = () => repos.branchWorktreePath(repo, branch);
  const remoteHead = () => {
    try {
      return git(remote.bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    } catch {
      return null;
    }
  };

  it("runs one session in the lane's worktree with the task's prompt, the agent's system prompt and the session token", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield result({ summary: "Nothing to change." });
    });
    const runSpecValue = spec(
      payload({ settings: { ...payload().settings, setupCommand: `touch '${root}/setup-ran'` } }),
    );
    const out = await run(runSpecValue, query);

    expect(out).toEqual({
      summary: "Nothing to change.",
      error: null,
      sessionId: "claude-req-1",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        // The fake result's `modelUsage` key: an alias, never streamed.
        byModel: [
          {
            model: "opus",
            canonicalModel: null,
            inputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheWrite1hInputTokens: 0,
            outputTokens: 20,
            largestRequestInputTokens: null,
            fastMode: false,
          },
        ],
      },
      durationMs: expect.any(Number),
    });
    const [call] = calls;
    expect(call!.options).toMatchObject({
      cwd: worktreePath(),
      model: "opus",
      permissionMode: "bypassPermissions",
      persistSession: true,
      outputFormat: { type: "json_schema" },
    });
    expect(call!.options.resume).toBeUndefined();
    // The repository's setup command ran; the pre-push guard is installed.
    expect(await readFile(path.join(root, "setup-ran"), "utf8")).toBe("");
    const common = git(worktreePath(), "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(await readFile(path.join(common, "hooks", "pre-push"), "utf8")).toBe(PUSH_GUARD_HOOK);

    // The prompt is the task's template over the request's trigger context.
    const progressFile = path.join(call!.options.additionalDirectories![0]!, "progress.md");
    expect(call!.prompt).toBe(
      requestRunPrompt(runSpecValue, runSpecValue.trigger.context as RalphRequestPayload, {
        progressFile,
        shipStashes: [],
      }),
    );
    expect(call!.prompt).toContain("You are working on Linear TOOL-32: Ralph core.");
    expect(call!.prompt).toContain("call the `ship` tool");
    expect(call!.prompt).not.toContain("git push -u");
    expect(call!.options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: engineer.systemPrompt,
    });
    // The playbook's Omniralph tools, `ship` included.
    expect(agentTools(call!).sort()).toEqual(
      [
        "mcp__omniralph__ask_permission",
        "mcp__omniralph__get_attachment",
        "mcp__omniralph__post_activity",
        "mcp__omniralph__ship",
      ].sort(),
    );
    // Only the session token reaches the session, its git credential helper included.
    const env = call!.options.env!;
    expect(env.OMNIRALPH_JOB_TOKEN).toBe("session-token");
    expect(env.OMNIRALPH_JOB_TOKEN_FILE).toBe(path.join(root, "session-token"));
    expect(Object.values(env).some((value) => value?.includes("lifecycle-token"))).toBe(false);
    expect(git(worktreePath(), "stash", "list")).toBe("");
  });

  it("is told apart from a story run: story runs never get `ship`", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield result({ status: "incomplete", summary: "Not yet.", followUps: [] });
    });
    const story = storyPayload(repo, runId, branch);
    const storySpec = RunSpec.parse({
      ...spec(),
      task: storyTask,
      trigger: { kind: "tracker.delegated", context: story },
    });
    await runCodingTask(storySpec, context(), options(query));
    expect(agentTools(calls[0]!)).not.toContain("mcp__omniralph__ship");
    expect(agentTools(calls[0]!)).toContain("mcp__omniralph__post_activity");
  });

  it("ships through the `ship` tool: commits with the message, pushes with the lifecycle token, and reports the PR action", async () => {
    const seen = path.join(root, "push-env");
    const hook = path.join(remote.bare, "hooks", "pre-receive");
    await writeFile(
      hook,
      `#!/bin/sh\n{ echo "env=\${OMNIRALPH_JOB_TOKEN:-none}"; echo "file=$(cat "$OMNIRALPH_JOB_TOKEN_FILE")"; } > '${seen}'\n`,
    );
    await chmod(hook, 0o755);
    let shipped: Awaited<ReturnType<typeof ship>> | undefined;
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(call.options.cwd!, "button.txt"), "renamed\n");
      shipped = await ship(call, {
        message: "Rename the button\n\nIt says Save now.",
        pullRequest: { action: "open", title: "Rename the button", body: "It says Save now." },
      });
      yield result({ summary: "Renamed and pushed." });
    });
    const out = await run(spec(), query);

    const head = remoteHead();
    expect(shipped).toEqual({
      isError: false,
      outcome: { commitSha: head, pushed: true, error: null },
    });
    expect(git(remote.bare, "log", "-1", "--format=%s%n%n%b", branch).trim()).toBe(
      "Rename the button\n\nIt says Save now.",
    );
    expect(git(remote.bare, "show", `${head}:button.txt`)).toBe("renamed");
    // The lifecycle token, from a file: never the session's, never in the environment.
    expect(await readFile(seen, "utf8")).toBe("env=none\nfile=lifecycle-token\n");
    expect(git(worktreePath(), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      `origin/${branch}`,
    );
    expect(out).toMatchObject({
      summary: "Renamed and pushed.",
      error: null,
      commitSha: head,
      pushed: true,
      pullRequest: { action: "open", title: "Rename the button", body: "It says Save now." },
    });
  });

  it("starts from the run's hidden ref when the story task pushes only at the end, and ships on top of it", async () => {
    const hiddenRef = `refs/omniralph/runs/${runId}`;
    const story = await remote.commit({ "story.txt": "from a story\n" }, "story-work");
    remote.hideBranch("story-work", hiddenRef);
    expect(remoteHead()).toBeNull();
    let seen: string | null = null;
    const { query } = fakeQuery(async function* (call) {
      seen = await readFile(path.join(call.options.cwd!, "story.txt"), "utf8");
      await writeFile(path.join(call.options.cwd!, "button.txt"), "renamed\n");
      await ship(call, { message: "Rename the button" });
      yield result({ summary: "Renamed and pushed." });
    });
    const out = await run(spec(payload({ hiddenRef })), query);

    expect(seen).toBe("from a story\n");
    const head = remoteHead();
    expect(out).toMatchObject({ commitSha: head, pushed: true });
    expect(git(remote.bare, "rev-parse", `${head}^`)).toBe(story);
  });

  it("ships without a PR action, and lets the structured result's PR change win", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(call.options.cwd!, "a.txt"), "a\n");
      await ship(call, { message: "Add a" });
      await writeFile(path.join(call.options.cwd!, "b.txt"), "b\n");
      await ship(call, { message: "Add b", pullRequest: { action: "update", title: "A and b" } });
      yield result({ summary: "Pushed.", pullRequest: { action: "ready" } });
    });
    const out = await run(spec(payload({ prUrl: "https://github.com/acme/app/pull/3" })), query);
    expect(out.pullRequest).toEqual({ action: "ready" });
    expect(out.commitSha).toBe(remoteHead());
    expect(git(remote.bare, "log", "--format=%s", `main..${branch}`)).toBe("Add b\nAdd a");

    const plain = fakeQuery(async function* (call) {
      await writeFile(path.join(call.options.cwd!, "c.txt"), "c\n");
      await ship(call, { message: "Add c" });
      yield result({ summary: "Pushed." });
    });
    const second = await run(spec(), plain.query);
    expect(second.pullRequest).toBeUndefined();
    expect(second.pushed).toBe(true);
  });

  it("undoes the commit when the push fails and returns the error to the session", async () => {
    const hook = path.join(remote.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const before = git(remote.bare, "rev-parse", "refs/heads/main");
    let shipped: Awaited<ReturnType<typeof ship>> | undefined;
    let status = "";
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(call.options.cwd!, "button.txt"), "renamed\n");
      shipped = await ship(call, {
        message: "Rename the button",
        pullRequest: { action: "open", title: "Rename" },
      });
      status = git(call.options.cwd!, "status", "--porcelain");
      yield result({ summary: "The push was refused." });
    });
    const out = await run(spec(), query);

    expect(shipped!.isError).toBe(true);
    expect(shipped!.outcome).toMatchObject({ commitSha: null, pushed: false });
    expect(shipped!.outcome.error).toContain("pushing it failed, so the commit was undone");
    expect(shipped!.outcome.error).toContain("protected branch");
    // The commit was undone: the changes are back in the worktree for the session.
    expect(status).toBe("?? button.txt");
    expect(git(worktreePath(), "rev-parse", "HEAD")).toBe(before);
    expect(remoteHead()).toBeNull();
    // A failed `ship` asks for no PR change; what the session left is stashed.
    expect(out).toMatchObject({ error: null, pushed: false });
    expect(out.pullRequest).toBeUndefined();
    expect(out.commitSha).toBeUndefined();
    expect(out.stashSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses `forceWithLease` when history rewrites are off, and force-pushes the rebased branch when they're allowed", async () => {
    await remote.commit({ "feature.txt": "v1\n" }, branch);
    const published = remoteHead();
    const rewrite = (historyRewrite: "never" | "when-asked" | "always") =>
      fakeQuery(async function* (call) {
        const cwd = call.options.cwd!;
        await writeFile(path.join(cwd, "feature.txt"), `${historyRewrite}\n`);
        git(cwd, "commit", "--quiet", "-a", "--amend", "-m", "Squashed");
        const out = await ship(call, { forceWithLease: true });
        // Refused: the session gives up its rewrite.
        if (out.outcome.error) git(cwd, "reset", "--quiet", "--hard", `origin/${branch}`);
        yield result({ summary: `${historyRewrite}: ${out.outcome.error ?? "pushed"}` });
      });

    const never = rewrite("never");
    const refused = await run(spec(payload({ historyRewrite: "never" })), never.query);
    expect(refused.summary).toContain("history rewrites are disabled for this repository");
    expect(remoteHead()).toBe(published);

    const allowed = rewrite("when-asked");
    const out = await run(spec(), allowed.query);
    expect(out.summary).toBe("when-asked: pushed");
    expect(remoteHead()).not.toBe(published);
    expect(git(remote.bare, "log", "-1", "--format=%s", branch)).toBe("Squashed");

    const pushedOnce = remoteHead();
    const always = rewrite("always");
    const again = await run(spec(payload({ historyRewrite: "always" })), always.query);
    expect(again.summary).toBe("always: pushed");
    expect(remoteHead()).not.toBe(pushedOnce);
  });

  it("only ever ships the run's branch", async () => {
    const { query } = fakeQuery(async function* (call) {
      const cwd = call.options.cwd!;
      git(cwd, "checkout", "--quiet", "-b", "other");
      await writeFile(path.join(cwd, "x.txt"), "x\n");
      const out = await ship(call, { message: "Elsewhere" });
      git(cwd, "checkout", "--quiet", "-f", branch);
      yield result({ summary: out.outcome.error ?? "pushed" });
    });
    const out = await run(spec(), query);
    expect(out.summary).toContain("not `feat/tool-32`: only `feat/tool-32` is shipped");
    expect(git(remote.bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("runs the task's setup commands in the worktree without a token before the prompt, and its teardown commands after", async () => {
    const command = (name: string, line: string) => ({
      name,
      command: line,
      timeoutSeconds: 30,
      maxOutputBytes: 20_000,
      fence: "",
      optional: false,
    });
    const tornDown = path.join(root, "torn-down");
    const { query, calls } = fakeQuery(async function* () {
      yield result({ summary: "Nothing to change." });
    });
    const out = await run(
      spec(payload(), {
        task: {
          ...requestTask,
          promptTemplate: `${requestTask.promptTemplate}\n\nThe service: {{setup.service}}`,
          setupCommands: [
            command(
              "service",
              "echo \"$(pwd) $(env | grep -cE '^(OMNIRALPH_|GIT_CONFIG_(COUNT|KEY_|VALUE_))')\"",
            ),
          ],
          teardownCommands: [command("stop", `pwd > '${tornDown}'`)],
        } as RunSpec["task"],
      }),
      query,
    );
    expect(out.error).toBeNull();
    // The worktree, and no token or credential helper override in the command's environment.
    expect(calls[0]!.prompt).toContain(`${worktreePath()} 0`);
    expect(await readFile(tornDown, "utf8")).toBe(`${worktreePath()}\n`);
  });

  it("resumes the lane's request conversation, and starts fresh when the resume fails", async () => {
    const resumed = fakeQuery(async function* () {
      yield result({ summary: "Shorter." }, "claude-req-2");
    });
    const out = await run(spec(payload({ resumeSessionId: "claude-req-1" })), resumed.query);
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
    const fresh = await run(spec(payload({ resumeSessionId: "gone" })), failing.query);
    expect(failing.calls.map((c) => c.options.resume)).toEqual(["gone", undefined]);
    expect(fresh).toMatchObject({ summary: "Fresh.", sessionId: "claude-req-3", error: null });
  });

  it("takes follow-up messages into its live session", async () => {
    let inject: ((text: string) => boolean) | undefined;
    const registered: boolean[] = [];
    const ctx = context({
      setMessageInjector: (fn) => {
        inject = fn;
        registered.push(fn !== undefined);
      },
    });
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
        yield {
          ...result({ summary: "Done, and bumped the version." }),
          user_message_uuids: [reply.value!.uuid],
        };
      })() as AsyncGenerator<SDKMessage>;

    const out = await run(spec(), query, {}, ctx);
    expect(prompts[1]).toBe("Also bump the version");
    expect(out).toMatchObject({ summary: "Done, and bumped the version.", error: null });
    expect(registered).toEqual([true, false]);
  });

  describe("permission prompts of the repository's settings", () => {
    function permissionFetch(answers: string[]) {
      const requests: { method: string; url: string; auth: string | null; body?: unknown }[] = [];
      const fn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          method,
          url,
          auth: new Headers(init?.headers).get("authorization"),
          ...(typeof init?.body === "string" && { body: JSON.parse(init.body) }),
        });
        if (url.includes("/permissions/") && method === "GET") {
          return Response.json({ status: answers.shift() ?? "pending", answeredBy: null });
        }
        if (method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ status: "pending" });
      }) as typeof fetch;
      return { fn, requests };
    }

    const askCommit = (call: Call) =>
      call.options.canUseTool!(
        "Bash",
        { command: "git commit -m 'Fix it'" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-1",
          requestId: "req-1",
          title: "Claude wants to run git commit",
        },
      );

    it("asks a person with the session token and lets the call run once allowed", async () => {
      const { fn, requests } = permissionFetch(["pending", "allowed"]);
      let decision: unknown;
      const { query } = fakeQuery(async function* (call) {
        decision = await askCommit(call);
        yield result({ summary: "Committed." });
      });
      const runSpecValue = spec();
      await run(runSpecValue, query, { fetch: fn, permissionPollIntervalMs: 5 });
      expect(decision).toMatchObject({ behavior: "allow" });
      const asks = requests.filter((r) => r.url.includes("/permissions"));
      expect(asks[0]).toMatchObject({
        method: "POST",
        url: `https://omniralph.example.com/api/agent/jobs/${runSpecValue.jobId}/permissions`,
        auth: "Bearer session-token",
        body: { tool: "Bash", detail: "git commit -m 'Fix it'" },
      });
      expect(asks.every((r) => r.auth === "Bearer session-token")).toBe(true);
    });

    it("denies the call without asking when the agent has no `ask_permission`", async () => {
      const { fn, requests } = permissionFetch(["allowed"]);
      let decision: unknown;
      const { query } = fakeQuery(async function* (call) {
        decision = await askCommit(call);
        yield result({ summary: "Couldn't commit." });
      });
      const base = spec();
      const agent = { ...base.agent, tools: { ...base.agent.tools, agent: ["ship" as const] } };
      await run(spec(payload(), { agent }), query, {
        fetch: fn,
        permissionPollIntervalMs: 5,
      });
      expect(decision).toMatchObject({ behavior: "deny" });
      expect(requests.some((r) => r.url.includes("/permissions"))).toBe(false);
    });
  });

  describe("/ship", () => {
    it("keeps today's flow: no `ship` tool, the lifecycle commits with the session's message and pushes", async () => {
      const { query, calls } = fakeQuery(async function* (call) {
        await writeFile(path.join(call.options.cwd!, "fix.txt"), "last fix\n");
        yield result({
          summary: "Shipping.",
          commit: { message: "Add priorities\n\nSorts stories by priority." },
        });
      });
      const out = await run(
        spec(payload({ ship: true, requests: [{ id: randomUUID(), text: "/ship" }] })),
        query,
      );
      const [call] = calls;
      expect(call!.prompt).toContain("This is `/ship`");
      expect(agentTools(call!)).not.toContain("mcp__omniralph__ship");
      expect(out).toMatchObject({
        error: null,
        pushed: true,
        commitSha: remoteHead(),
        pullRequest: {
          action: "open",
          title: "Add priorities",
          body: "Sorts stories by priority.",
        },
      });
      expect(git(remote.bare, "log", "-1", "--format=%s", branch)).toBe("Add priorities");
    });
  });
});

describe("a coding run's session pushing by itself", { timeout: 120_000 }, () => {
  const READ_TOKEN = "ghs_contents_read";
  const WRITE_TOKEN = "ghs_contents_write";
  let root: string;
  let gitServer: GitHttpServer;
  let broker: Server;
  let brokerUrl: string;
  const brokered: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-coding-push-"));
    const remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "hello\n" });
    // The code host: the read token fetches, only the write token pushes.
    gitServer = await startGitHttpServer(root, (request) => {
      const write = request.authorization === basicAuth("x-access-token", WRITE_TOKEN);
      const read = request.authorization === basicAuth("x-access-token", READ_TOKEN);
      return request.push ? write : write || read;
    });
    // The control panel's credential broker: the lifecycle token gets a write credential, the session token a read-only one.
    broker = createServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      brokered.push(auth);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          cloneUrl: `${gitServer.url}/remote.git`,
          username: "x-access-token",
          password: auth === "Bearer lifecycle-token" ? WRITE_TOKEN : READ_TOKEN,
          expiresAt: new Date(Math.floor(Date.now() / 1000 + 3600) * 1000).toISOString(),
        }),
      );
    });
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
    brokerUrl = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await gitServer.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  /** A coding run's context against the smart-HTTP remote, with the real CLI credential helper. */
  async function pushRun() {
    const workspaceRoot = path.join(root, "workspace");
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const repos = new RepoCache({
      workspaceRoot,
      credentialHelper: defaultCredentialHelper(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--conditions=@omniralph/source"],
        cli,
      ),
      lockRetryMs: 20,
    });
    const sessionTokenFile = path.join(root, "session-token");
    await writeFile(sessionTokenFile, "session-token");
    const repo: JobRepository = {
      provider: "github",
      fullPath: "acme/app",
      cloneUrl: `${gitServer.url}/remote.git`,
    };
    const bare = path.join(root, "remote.git");
    const branch = "feat/tool-32";
    const ctx: JobContext = {
      signal: new AbortController().signal,
      jobToken: () => "lifecycle-token",
      sessionToken: () => "session-token",
      env: (more) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "lifecycle-token", ...more }),
      sessionEnv: (more) => ({
        ...ENV,
        OMNIRALPH_SERVER: brokerUrl,
        OMNIRALPH_JOB_TOKEN: "session-token",
        OMNIRALPH_JOB_TOKEN_FILE: sessionTokenFile,
        ...more,
      }),
      spawn: () => {
        throw new Error("coding runs must not spawn processes through the context");
      },
      server: brokerUrl,
      workspaceRoot,
      repos,
      logger: silentLogger(),
    };
    const remoteBranch = () => {
      try {
        return git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      } catch {
        return null;
      }
    };
    const options = (query: SessionQueryFn): CodingTaskOptions => ({
      runSession: createSessionRunner(query),
      fetch: (async () => Response.json({ ok: true })) as typeof fetch,
    });
    return { repos, repo, branch, ctx, remoteBranch, options };
  }

  /** Runs `git` in the session's environment (its own credential helper and token). */
  function sessionGit(
    call: Call,
    args: string[],
    input?: string,
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        "git",
        args,
        {
          cwd: call.options.cwd!,
          env: { ...call.options.env, GIT_TERMINAL_PROMPT: "0" },
          timeout: 60_000,
        },
        (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }),
      );
      child.stdin?.end(input ?? "");
    });
  }

  /** What the session's git credential helper resolves for the remote. */
  async function sessionCredential(call: Call): Promise<string | undefined> {
    const url = new URL(gitServer.url);
    const filled = await sessionGit(
      call,
      ["credential", "fill"],
      `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\npath=remote.git\n\n`,
    );
    return /^password=(.*)$/m.exec(filled.stdout)?.[1];
  }

  /** The session's own push of its commit; the remote must refuse it. */
  async function expectOwnPushRefused(
    call: Call,
    branch: string,
    remoteBranch: () => string | null,
  ) {
    brokered.length = 0;
    expect(await sessionCredential(call)).toBe(READ_TOKEN);
    expect(brokered).toEqual(["Bearer session-token"]);
    const own = await sessionGit(call, ["push", "origin", `HEAD:refs/heads/${branch}`]);
    expect(own.ok).toBe(false);
    expect(brokered.every((auth) => auth === "Bearer session-token")).toBe(true);
    expect(remoteBranch()).toBeNull();
    expect(
      gitServer.requests.some(
        (r) => r.push && r.authorization === basicAuth("x-access-token", READ_TOKEN),
      ),
    ).toBe(true);
  }

  it("of a story run: its credential helper resolves a read-only credential, its push is refused, the lifecycle's push succeeds", async () => {
    const { repos, repo, branch, ctx, remoteBranch, options } = await pushRun();
    const { query } = fakeQuery(async function* (call) {
      const cwd = call.options.cwd!;
      await writeFile(path.join(cwd, "story.txt"), "done\n");
      git(cwd, "add", "-A");
      git(cwd, "commit", "--quiet", "-m", "Do the story");
      await expectOwnPushRefused(call, branch, remoteBranch);
      // The lifecycle commits the story itself: leave the work uncommitted.
      git(cwd, "reset", "--quiet", "--soft", "HEAD~1");
      brokered.length = 0;
      yield result({ status: "complete", summary: "Done.", followUps: [] });
    });
    const spec = RunSpec.parse({
      ...runSpec(repo, requestPayload(repo, randomUUID(), branch)),
      task: storyTask,
      trigger: { kind: "tracker.delegated", context: storyPayload(repo, randomUUID(), branch) },
    });
    const out = (await runCodingTask(spec, ctx, options(query))) as RalphStoryResult;

    expect(out).toMatchObject({ status: "complete", commitSha: expect.any(String) });
    expect(brokered).toContain("Bearer lifecycle-token");
    expect(brokered).not.toContain("Bearer session-token");
    const pushed = remoteBranch();
    expect(pushed).toBe(git(repos.branchWorktreePath(repo, branch), "rev-parse", "HEAD"));
    expect(git(path.join(root, "remote.git"), "show", `${pushed}:story.txt`)).toBe("done");
  });

  it("of a request run: its credential helper resolves a read-only credential, its push is refused, `ship` pushes", async () => {
    const { repos, repo, branch, ctx, remoteBranch, options } = await pushRun();
    let shipped: Awaited<ReturnType<typeof ship>> | undefined;
    const { query } = fakeQuery(async function* (call) {
      const cwd = call.options.cwd!;
      await writeFile(path.join(cwd, "button.txt"), "renamed\n");
      git(cwd, "add", "-A");
      git(cwd, "commit", "--quiet", "-m", "Rename the button");
      await expectOwnPushRefused(call, branch, remoteBranch);
      brokered.length = 0;
      shipped = await ship(call, {});
      yield result({ summary: "Pushed through ship." });
    });
    const out = (await runCodingTask(
      runSpec(repo, requestPayload(repo, randomUUID(), branch)),
      ctx,
      options(query),
    )) as RalphRequestResult;

    // `ship` pushes with the lifecycle token's write credential.
    expect(shipped).toMatchObject({ isError: false, outcome: { pushed: true, error: null } });
    expect(brokered).toContain("Bearer lifecycle-token");
    expect(brokered).not.toContain("Bearer session-token");
    expect(remoteBranch()).toBe(git(repos.branchWorktreePath(repo, branch), "rev-parse", "HEAD"));
    expect(out).toMatchObject({ error: null, pushed: true });
  });
});
