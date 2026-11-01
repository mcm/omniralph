import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RALPH_SYSTEM_APPEND, STORY_OUTPUT_SCHEMA, storyTemplateContext } from "@omniralph/ralph";
import {
  RalphPushResult,
  RalphStoryResult,
  RunSpec,
  type JobRepository,
  type RalphPushPayload,
  type RalphStoryPayload,
} from "@omniralph/shared";
import { getBuiltinRunSpec, getBuiltinTask, renderTemplate, taskCatalog } from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobTail } from "../attempts/tail.js";
import type { JobContext } from "../capabilities/index.js";
import { silentLogger } from "../logger.js";
import { createSessionRunner, sessionTee, type SessionQueryFn } from "../session/session.js";
import { firstPrompt } from "../test/fake-query.js";
import { ENV, git, Remote } from "../test/git-remote.js";
import { placeInstallable } from "../test/installables.js";
import { PUSH_GUARD_HOOK, RepoCache } from "../workspace/repoCache.js";
import {
  runCodingTask,
  storyRunPrompt,
  withPlaybookSettings,
  type CodingTaskOptions,
} from "./coding.js";
import { promptEpic, stashPrefix } from "./story-attempt.js";

/** A coding run of a story task: its result is a story's. */
const runStoryCoding = (...args: Parameters<typeof runCodingTask>) =>
  runCodingTask(...args) as Promise<RalphStoryResult>;

interface Call {
  prompt: string;
  options: Options;
}

/** A fake Agent SDK `query()`: `script` does the session's work and yields its messages. */
function fakeQuery(script: (call: Call) => AsyncGenerator<unknown>): {
  query: SessionQueryFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query: SessionQueryFn = (params) =>
    (async function* () {
      const call = { prompt: await firstPrompt(params.prompt), options: params.options ?? {} };
      calls.push(call);
      yield* script(call) as AsyncGenerator<SDKMessage>;
    })();
  return { query, calls };
}

function assistant(...content: unknown[]) {
  return { type: "assistant", parent_tool_use_id: null, message: { content } };
}

function result(structured: unknown) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    structured_output: structured,
    modelUsage: {
      opus: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
      },
    },
  };
}

function cwdOf(call: Call): string {
  return call.options.cwd!;
}

function progressFileOf(call: Call): string {
  return path.join(call.options.additionalDirectories![0]!, "progress.md");
}

const PRD = `# PRD: Ralph core

## Quality Gates
- \`true\`
`;

const engineer = getBuiltinRunSpec("builtin:implement-story")!.agent;
const storyTask = getBuiltinTask("builtin:implement-story")!;

describe("withPlaybookSettings", () => {
  const settings = {
    model: "opus",
    setupCommand: "npm ci",
    fallbackModel: null,
    appendInstruction: "Always rebase.",
    allowedTools: null,
    disallowedTools: null,
  };
  const story = getBuiltinRunSpec("builtin:implement-story")!;

  it("takes the worktree setup command and models from the story or request playbook", () => {
    const spec = {
      task: { ...story.task, worktreeSetupCommand: "pnpm install" },
      model: "claude-sonnet-5-5",
      fallbackModel: "claude-haiku-5-5",
    };
    expect(withPlaybookSettings(spec, { settings, branch: "b" })).toEqual({
      branch: "b",
      settings: {
        ...settings,
        setupCommand: "pnpm install",
        model: "claude-sonnet-5-5",
        fallbackModel: "claude-haiku-5-5",
      },
    });
  });

  it("keeps the payload's when the run spec has none (an older control panel)", () => {
    const { worktreeSetupCommand: _none, ...older } = story.task;
    const spec = { task: older, model: null, fallbackModel: null };
    expect(withPlaybookSettings(spec, { settings })).toEqual({ settings });
  });
});

describe("coding runs of a story task", { timeout: 60_000 }, () => {
  let root: string;
  let workspaceRoot: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let posted: { url: string; auth: string | null; body: Record<string, unknown> }[];
  const runId = randomUUID();
  const branch = "feat/tool-32";

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    posted.push({
      url: String(input),
      auth: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ ok: true });
  }) as typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-coding-"));
    workspaceRoot = path.join(root, "workspace");
    remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "hello\n" });
    repo = { provider: "gitlab", fullPath: "group/app", cloneUrl: pathToFileURL(remote.bare).href };
    repos = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
    controller = new AbortController();
    posted = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(cache = repos): JobContext {
    return {
      signal: controller.signal,
      jobToken: () => "lifecycle-token",
      sessionToken: () => "session-token",
      env: (extra) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "lifecycle-token", ...extra }),
      sessionEnv: (extra) => ({
        ...ENV,
        OMNIRALPH_JOB_TOKEN: "session-token",
        OMNIRALPH_JOB_TOKEN_FILE: path.join(root, "session-token"),
        ...extra,
      }),
      spawn: () => {
        throw new Error("coding runs must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot: cache === repos ? workspaceRoot : path.join(root, "other-workspace"),
      repos: cache,
      logger: silentLogger(),
    };
  }

  function payload(overrides: Partial<RalphStoryPayload> = {}): RalphStoryPayload {
    return {
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
      trackerProvider: "linear",
      trackerName: "Linear",
      storyId: randomUUID(),
      attempt: 1,
      epic: { identifier: "TOOL-32", title: "Ralph core", kind: "children", url: null, prd: PRD },
      story: {
        identifier: "TOOL-91",
        title: "Run a story",
        trackerIssueId: "issue-91",
        url: null,
        description: "Run it.\n\n## Acceptance Criteria\n- [ ] it runs\n",
        kind: "story",
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
          dependsOn: ["TOOL-90"],
          repository: null,
        },
      ],
      commitMessage: "feat(TOOL-91): Run a story",
      qualityGates: ["test -f feature.txt", "true"],
      prdQualityGates: ["true"],
      progress: "# Ralph Progress Log\n",
      lastFeedback: null,
      guidance: [],
      attachments: [],
      ...overrides,
    };
  }

  function spec(trigger: RalphStoryPayload = payload(), overrides: Partial<RunSpec> = {}): RunSpec {
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
      task: storyTask,
      trigger: { kind: "tracker.delegated", context: trigger },
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

  function options(query: SessionQueryFn, extra: CodingTaskOptions = {}): CodingTaskOptions {
    return { runSession: createSessionRunner(query), fetch: fetchFn, ...extra };
  }

  function worktreePath(): string {
    return repos.branchWorktreePath(repo, branch);
  }

  function storyStashes(): string[] {
    const list = git(worktreePath(), "stash", "list", "--format=%H %gs");
    return list
      .split("\n")
      .filter((line) =>
        line.includes(stashPrefix({ runId, story: { identifier: "TOOL-91" } as never })),
      );
  }

  it("renders the task's template, runs the agent's session, then gates, commits and pushes", async () => {
    const { query, calls } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      await appendFile(progressFileOf(call), "\n## TOOL-91: learned things\n");
      yield assistant({ type: "text", text: "Reading the PRD." });
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const run = spec(
      payload({ settings: { ...payload().settings, setupCommand: `touch '${root}/setup-ran'` } }),
    );
    const now = new Date("2026-10-11T12:00:00Z");
    const out = await runStoryCoding(run, context(), options(query, { now: () => now }));

    expect(RalphStoryResult.safeParse(out).success).toBe(true);
    // The built-in story task pushes the branch after each story.
    expect(run.task.pushTiming).toBe("per-story");
    expect(out.hiddenRef).toBeUndefined();
    expect(git(remote.bare, "for-each-ref", "refs/omniralph")).toBe("");
    expect(out).toMatchObject({
      status: "complete",
      summary: "Built it.",
      feedback: null,
      followUps: [],
      usage: { inputTokens: 105, outputTokens: 20 },
      progress: "# Ralph Progress Log\n\n## TOOL-91: learned things\n",
    });
    const pushed = git(remote.bare, "rev-parse", `refs/heads/${branch}`);
    expect(out.commitSha).toBe(pushed);
    expect(git(remote.bare, "log", "-1", "--format=%B", pushed)).toBe(
      "feat(TOOL-91): Run a story\n\nEpic: TOOL-32 Ralph core",
    );
    expect(git(remote.bare, "show", `${pushed}:feature.txt`)).toBe("built");
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(worktreePath(), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      `origin/${branch}`,
    );
    // The repository's setup command ran in the new worktree; the pre-push guard is installed.
    expect(await readFile(path.join(root, "setup-ran"), "utf8")).toBe("");
    const hooks = git(worktreePath(), "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(await readFile(path.join(hooks, "hooks", "pre-push"), "utf8")).toBe(PUSH_GUARD_HOOK);

    const [call] = calls;
    // The prompt is the task's template over the story's trigger and task-type variables.
    const progressFile = progressFileOf(call!);
    const { epic, story } = promptEpic(run.trigger.context as RalphStoryPayload);
    expect(call!.prompt).toBe(
      renderTemplate(
        storyTask.promptTemplate,
        {
          ...storyTemplateContext({
            trackerName: "Linear",
            epic,
            story,
            progressFile,
            progress: "# Ralph Progress Log\n",
            guidance: [],
            attempt: 1,
            maxAttempts: 3,
            followUps: true,
            checks: ["test -f feature.txt", "true"],
            stashes: [],
            now,
          }),
        },
        taskCatalog(storyTask),
      ),
    );
    expect(call!.prompt).toBe(
      storyRunPrompt(
        run,
        run.trigger.context as RalphStoryPayload,
        { offered: [], progressFile },
        now,
      ),
    );
    expect(call!.prompt).toContain("## Your Task: TOOL-91 - Run a story");
    expect(call!.prompt).toContain("Never run git commit, git push");
    // The payload's kind is printed under the issue line: a Story here, a Fix for a fix.
    expect(call!.prompt).toContain("\nKind: Story\n");
    const delegated = run.trigger.context as RalphStoryPayload;
    const fix = storyRunPrompt(
      run,
      { ...delegated, story: { ...delegated.story, kind: "fix" } },
      { offered: [], progressFile },
      now,
    );
    expect(fix).toContain("\nKind: Fix\n");
    expect(fix).not.toContain("Kind: Story");
    // The system prompt is the agent's, not ralph's story system prompt.
    expect(call!.options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: engineer.systemPrompt,
    });
    expect(JSON.stringify(call!.options.systemPrompt)).not.toContain(
      RALPH_SYSTEM_APPEND.slice(0, 60),
    );
    expect(call!.options).toMatchObject({
      cwd: worktreePath(),
      model: "opus",
      permissionMode: "bypassPermissions",
      outputFormat: { type: "json_schema", schema: STORY_OUTPUT_SCHEMA },
    });
    expect(Object.keys(call!.options.mcpServers ?? {})).toEqual(["omniralph"]);

    // Activities are relayed with the session token (the lifecycle token has no `run:activity`), for the run's job.
    expect(new Set(posted.map((p) => p.url))).toEqual(
      new Set([`https://omniralph.example.com/api/agent/jobs/${run.jobId}/activities`]),
    );
    expect(posted.every((p) => p.auth === "Bearer session-token")).toBe(true);
  });

  it("tees the story session's events into the attempt's tail and still relays them", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield assistant(
        { type: "text", text: "Reading the PRD." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
      );
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const tail = new JobTail({ now: () => new Date("2026-10-28T10:00:00Z") });
    const ctx = { ...context(), sessions: sessionTee((event) => tail.event(event)) };
    const out = await runStoryCoding(spec(), ctx, options(query));

    expect(out.status).toBe("complete");
    expect(tail.events()).toEqual([
      {
        type: "thought",
        body: "Reading the PRD.",
        parameter: null,
        at: "2026-10-28T10:00:00.000Z",
      },
      { type: "action", body: "Bash", parameter: "pnpm test", at: "2026-10-28T10:00:00.000Z" },
    ]);
    // Relaying to the control panel is unchanged (the quality gates follow).
    expect(posted.map((p) => p.body).slice(0, 2)).toEqual([
      { type: "thought", body: "Reading the PRD.", ephemeral: false },
      { type: "action", body: "Bash", parameter: "pnpm test", ephemeral: true },
    ]);
  });

  it("gives the session the session token only, its git credential helper included", async () => {
    const { query, calls } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const out = await runStoryCoding(spec(), context(), options(query));
    expect(out.status).toBe("complete");
    const env = calls[0]!.options.env!;
    expect(env.OMNIRALPH_JOB_TOKEN).toBe("session-token");
    expect(env.OMNIRALPH_JOB_TOKEN_FILE).toBe(path.join(root, "session-token"));
    expect(Object.values(env).some((value) => value?.includes("lifecycle-token"))).toBe(false);
    // The credential helper is the agent's, which reads the session's token file.
    const keys = Object.keys(env).filter((name) => name.startsWith("GIT_CONFIG_KEY_"));
    const helpers = keys
      .filter((key) => env[key] === "credential.helper")
      .map((key) => env[key.replace("KEY", "VALUE")]);
    expect(helpers).toEqual(["", "!true"]);
  });

  it("downloads its attachments with the session token and points the session at them", async () => {
    const id = "a".repeat(32);
    const downloads: { url: string; auth: string | null }[] = [];
    const withUploads = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!/\/attachments\/[^/]+$/.test(String(input))) return fetchFn(input, init);
      downloads.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response("PNGDATA", { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const { query, calls } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const run = spec(
      payload({
        attachments: [{ id, title: "mockup.png", sources: ["TOOL-91 description"] }],
      }),
    );
    const out = await runStoryCoding(run, context(), options(query, { fetch: withUploads }));
    expect(out.status).toBe("complete");

    expect(downloads).toEqual([
      {
        url: `https://omniralph.example.com/api/agent/jobs/${run.jobId}/attachments/${id}`,
        auth: "Bearer session-token",
      },
    ]);
    const dir = path.join(workspaceRoot, ".attachments", "TOOL-32");
    const file = path.join(dir, "mockup.png");
    expect(await readFile(file, "utf8")).toBe("PNGDATA");
    const [call] = calls;
    expect(call!.prompt).toContain("### Attachments");
    expect(call!.prompt).toContain(`- **mockup.png** (from TOOL-91 description): \`${file}\``);
    expect(call!.options.additionalDirectories).toContain(dir);
    // Nothing of the attachment ends up in the story's commit.
    expect(git(remote.bare, "ls-tree", "-r", "--name-only", `refs/heads/${branch}`)).toBe(
      "README.md\nfeature.txt",
    );
  });

  it("pushes with the lifecycle token, read from a file", async () => {
    const seen = path.join(root, "push-env");
    const hook = path.join(remote.bare, "hooks", "pre-receive");
    await writeFile(
      hook,
      `#!/bin/sh\n{ echo "env=\${OMNIRALPH_JOB_TOKEN:-none}"; echo "file=$(cat "$OMNIRALPH_JOB_TOKEN_FILE")"; } > '${seen}'\n`,
    );
    await chmod(hook, 0o755);
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const out = await runStoryCoding(spec(), context(), options(query));
    expect(out.status).toBe("complete");
    expect(await readFile(seen, "utf8")).toBe("env=none\nfile=lifecycle-token\n");
  });

  it("fails the attempt with the gate's output and stashes the work when a gate fails", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "broken\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const out = await runStoryCoding(
      spec(payload({ qualityGates: ["true", "echo 'type error in feature.txt'; exit 3"] })),
      context(),
      options(query),
    );
    expect(RalphStoryResult.safeParse(out).success).toBe(true);
    expect(out.status).toBe("failed");
    expect(out.commitSha).toBeUndefined();
    expect(out.feedback).toContain(
      "quality gate `echo 'type error in feature.txt'; exit 3` failed (exit 3)",
    );
    expect(out.feedback).toContain("type error in feature.txt");
    expect(() => git(remote.bare, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    const stashes = storyStashes();
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toContain("unverified (attempt 1)");
  });

  it("commits and pushes a blocked story's work as wip once its gates pass", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "partial\n");
      yield result({
        status: "blocked",
        summary: "I need an API key for the payment sandbox.",
        commit: { summary: "Add the payment client" },
        followUps: [{ title: "Get a sandbox key", description: "We need one.", manual: true }],
        recommendations: [{ title: "Fix it upstream", description: "In acme/sdk: drop our shim." }],
        metric: { name: "critique score", value: 26, direction: "higher" },
      });
    });
    const out = await runStoryCoding(spec(), context(), options(query));
    expect(RalphStoryResult.safeParse(out).success).toBe(true);
    expect(out.status).toBe("blocked");
    const pushed = git(remote.bare, "rev-parse", `refs/heads/${branch}`);
    expect(out.commitSha).toBe(pushed);
    expect(git(remote.bare, "log", "-1", "--format=%B", pushed)).toBe(
      "wip(TOOL-91): Add the payment client\n\nEpic: TOOL-32 Ralph core",
    );
    expect(out.feedback).toContain("reported it was blocked");
    expect(out.followUps).toEqual([
      { title: "Get a sandbox key", description: "We need one.", manual: true },
    ]);
    expect(out.recommendations).toEqual([
      { title: "Fix it upstream", description: "In acme/sdk: drop our shim." },
    ]);
    expect(out.metric).toEqual({ name: "critique score", value: 26, direction: "higher" });
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("undoes the commit, stashes the work and fails the attempt when the push is rejected", async () => {
    const hook = path.join(remote.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const before = git(remote.bare, "rev-parse", "refs/heads/main");
    const out = await runStoryCoding(spec(), context(), options(query));
    expect(out.status).toBe("failed");
    expect(out.commitSha).toBeUndefined();
    expect(out.feedback).toContain("pushing it failed, so the commit was undone");
    expect(out.feedback).toContain("protected branch");
    expect(git(worktreePath(), "rev-parse", "HEAD")).toBe(before);
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    const stashes = storyStashes();
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toContain("push-failed");
  });

  it("offers the run's stashes with the last feedback, and drops the applied ones", async () => {
    const first = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "from attempt 1\n");
      yield result({ status: "incomplete", summary: "Ran out of time.", followUps: [] });
    });
    const firstOut = await runStoryCoding(spec(), context(), options(first.query));
    expect(firstOut.status).toBe("incomplete");
    const [offered] = storyStashes()[0]!.split(" ");

    const second = fakeQuery(async function* (call) {
      execFileSync("git", ["stash", "apply", "--quiet", offered!], { cwd: cwdOf(call), env: ENV });
      yield result({
        status: "complete",
        summary: "Finished it.",
        appliedStashes: [offered!.slice(0, 10)],
        followUps: [],
      });
    });
    const out = await runStoryCoding(
      spec(payload({ attempt: 2, lastFeedback: firstOut.feedback })),
      context(),
      options(second.query),
    );

    const prompt = second.calls[0]!.prompt;
    expect(prompt).toContain("## Stashed Work From Earlier Sessions");
    expect(prompt).toContain(offered);
    expect(prompt).toContain("reported the story incomplete");
    expect(prompt).toContain("(attempt 2 of 3)");
    expect(out.status).toBe("complete");
    expect(git(remote.bare, "show", `${out.commitSha}:feature.txt`)).toBe("from attempt 1");
    expect(storyStashes()).toEqual([]);
  });

  describe("with pushTiming end", () => {
    const hiddenRef = `refs/omniralph/runs/${runId}`;
    const endSpec = (trigger: RalphStoryPayload = payload()) =>
      spec(trigger, { task: { ...storyTask, pushTiming: "end" } });
    const onRemote = (ref: string) =>
      git(remote.bare, "for-each-ref", "--format=%(objectname)", ref) || null;

    it("commits locally and force-pushes HEAD to the run's hidden ref, not the branch", async () => {
      const { query } = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      const run = endSpec();
      expect(run.task.pushTiming).toBe("end");
      const out = await runStoryCoding(run, context(), options(query));

      expect(RalphStoryResult.safeParse(out).success).toBe(true);
      expect(out.status).toBe("complete");
      const head = git(worktreePath(), "rev-parse", "HEAD");
      expect(out.commitSha).toBe(head);
      expect(out.hiddenRef).toEqual({ ref: hiddenRef, sha: head });
      expect(onRemote(hiddenRef)).toBe(head);
      expect(git(remote.bare, "show", `${hiddenRef}:feature.txt`)).toBe("built");
      // The branch on origin isn't touched.
      expect(onRemote(`refs/heads/${branch}`)).toBeNull();
      expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    });

    it("lets another agent start the next story from the hidden ref", async () => {
      const first = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      const firstOut = await runStoryCoding(endSpec(), context(), options(first.query));
      expect(firstOut.status).toBe("complete");

      // Another agent: its own cache root, no worktree for the branch yet.
      const other = new RepoCache({
        workspaceRoot: path.join(root, "other-workspace"),
        credentialHelper: "!true",
        lockRetryMs: 20,
      });
      let seen: string | null = null;
      const second = fakeQuery(async function* (call) {
        seen = await readFile(path.join(cwdOf(call), "feature.txt"), "utf8");
        await writeFile(path.join(cwdOf(call), "second.txt"), "more\n");
        yield result({ status: "complete", summary: "Built more.", followUps: [] });
      });
      const next = payload({
        story: { ...payload().story, identifier: "TOOL-92", title: "Run another story" },
        commitMessage: "feat(TOOL-92): Run another story",
        qualityGates: ["test -f second.txt"],
      });
      const out = await runStoryCoding(endSpec(next), context(other), options(second.query));

      expect(seen).toBe("built\n");
      expect(out.status).toBe("complete");
      expect(out.hiddenRef).toEqual({ ref: hiddenRef, sha: out.commitSha });
      expect(git(remote.bare, "rev-parse", `${out.commitSha}^`)).toBe(firstOut.commitSha);
      expect(onRemote(hiddenRef)).toBe(out.commitSha);
      expect(onRemote(`refs/heads/${branch}`)).toBeNull();

      // The first agent's reused worktree catches up with the hidden ref.
      const third = fakeQuery(async function* (call) {
        seen = await readFile(path.join(cwdOf(call), "second.txt"), "utf8");
        yield result({ status: "incomplete", summary: "Looked around.", followUps: [] });
      });
      await runStoryCoding(endSpec(), context(), options(third.query));
      expect(seen).toBe("more\n");
      expect(git(worktreePath(), "rev-parse", "HEAD")).toBe(out.commitSha);
    });

    it("pushes a blocked story's wip commit to the hidden ref", async () => {
      const { query } = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "partial\n");
        yield result({
          status: "blocked",
          summary: "I need an API key.",
          commit: { summary: "Add the payment client" },
          followUps: [],
        });
      });
      const out = await runStoryCoding(endSpec(), context(), options(query));
      expect(out.status).toBe("blocked");
      expect(out.commitSha).toBeDefined();
      expect(out.hiddenRef).toEqual({ ref: hiddenRef, sha: out.commitSha });
      expect(git(remote.bare, "log", "-1", "--format=%s", hiddenRef)).toBe(
        "wip(TOOL-91): Add the payment client",
      );
      expect(onRemote(`refs/heads/${branch}`)).toBeNull();
    });

    it("undoes the commit and stashes the work when the hidden ref push is rejected", async () => {
      const hook = path.join(remote.bare, "hooks", "pre-receive");
      await writeFile(hook, "#!/bin/sh\necho 'hidden refs are not allowed' >&2\nexit 1\n");
      await chmod(hook, 0o755);
      const { query } = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      const before = git(remote.bare, "rev-parse", "refs/heads/main");
      const out = await runStoryCoding(endSpec(), context(), options(query));
      expect(out.status).toBe("failed");
      expect(out.commitSha).toBeUndefined();
      expect(out.hiddenRef).toBeUndefined();
      expect(out.feedback).toContain("pushing it failed, so the commit was undone");
      expect(out.feedback).toContain("hidden refs are not allowed");
      expect(git(worktreePath(), "rev-parse", "HEAD")).toBe(before);
      expect(onRemote(hiddenRef)).toBeNull();
      expect(storyStashes()[0]).toContain("push-failed");
    });

    /** The push run before the lane is described: the story task, with a push trigger context. */
    const pushSpec = (overrides: Partial<RalphPushPayload> = {}) => {
      const { runId: id, repositoryId, repository, baseBranch, settings } = payload();
      const context: RalphPushPayload = {
        runId: id,
        repositoryId,
        repository,
        branch,
        baseBranch,
        settings,
        hiddenRef,
        ...overrides,
      };
      return { ...endSpec(), trigger: { kind: "tracker.delegated" as const, context } };
    };

    it("pushes the branch once at the end, from the hidden ref, with no session", async () => {
      const first = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      const story = await runStoryCoding(endSpec(), context(), options(first.query));
      expect(onRemote(`refs/heads/${branch}`)).toBeNull();

      // Another agent: no worktree yet, so it is created (with the setup command) from the hidden ref.
      const other = new RepoCache({
        workspaceRoot: path.join(root, "other-workspace"),
        credentialHelper: "!true",
        lockRetryMs: 20,
      });
      const none = fakeQuery(async function* () {
        yield result({ status: "complete", summary: "x", followUps: [] });
      });
      const run = pushSpec({
        settings: { ...payload().settings, setupCommand: `touch '${root}/setup-ran'` },
      });
      const out = await runCodingTask(run, context(other), options(none.query));

      expect(RalphPushResult.safeParse(out).success).toBe(true);
      expect(out).toMatchObject({ pushed: { branch, sha: story.commitSha } });
      expect(none.calls).toEqual([]);
      expect(onRemote(`refs/heads/${branch}`)).toBe(story.commitSha);
      expect(git(remote.bare, "show", `${branch}:feature.txt`)).toBe("built");
      await expect(readFile(path.join(root, "setup-ran"), "utf8")).resolves.toBe("");
      const otherWorktree = other.branchWorktreePath(repo, branch);
      expect(git(otherWorktree, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
        `origin/${branch}`,
      );

      // The first agent's own worktree pushes the same head again: nothing changes.
      const again = await runCodingTask(pushSpec(), context(), options(none.query));
      expect(again).toMatchObject({ pushed: { branch, sha: story.commitSha } });
      expect(none.calls).toEqual([]);
    });

    it("fails a push the remote rejects, leaving the branch alone", async () => {
      const first = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      await runStoryCoding(endSpec(), context(), options(first.query));
      const hook = path.join(remote.bare, "hooks", "pre-receive");
      await writeFile(hook, "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n");
      await chmod(hook, 0o755);
      const none = fakeQuery(async function* () {
        yield result({ status: "complete", summary: "x", followUps: [] });
      });
      await expect(runCodingTask(pushSpec(), context(), options(none.query))).rejects.toThrow(
        "branch is protected",
      );
      expect(onRemote(`refs/heads/${branch}`)).toBeNull();
    });
  });

  describe("the task's setup and teardown commands", () => {
    const command = (name: string, line: string, extra: { optional?: boolean } = {}) => ({
      name,
      command: line,
      timeoutSeconds: 30,
      maxOutputBytes: 20_000,
      fence: "",
      optional: false,
      ...extra,
    });
    // What a command saw: its directory, the branch it's on and any token or credential helper override.
    const probe = (file: string) =>
      `{ pwd; git rev-parse --abbrev-ref HEAD; env | grep -E '^(OMNIRALPH_|GIT_CONFIG_(COUNT|KEY_|VALUE_))' | cut -d= -f1 | sort; } > '${file}'`;

    function withCommands(setup: unknown[], teardown: unknown[], trigger = payload()): RunSpec {
      return spec(trigger, {
        task: {
          ...storyTask,
          promptTemplate: `${storyTask.promptTemplate}\n\nThe branch: {{setup.branch}}\n\nThe lint: {{setup.lint}}`,
          setupCommands: setup,
          teardownCommands: teardown,
        } as RunSpec["task"],
      });
    }

    it("runs the setup commands in the branch worktree without a token before rendering the prompt, and passes their output as setup.<name>", async () => {
      const seen = path.join(root, "setup-env");
      const { query, calls } = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      const run = withCommands(
        [
          command(
            "branch",
            `test -f '${root}/repo-setup-ran' || exit 9; ${probe(seen)}; echo "on $(git rev-parse --abbrev-ref HEAD)"`,
          ),
          command("lint", "echo nope >&2; exit 2", { optional: true }),
        ],
        [],
        // The repository's setup command runs first, when the worktree is created.
        payload({
          settings: { ...payload().settings, setupCommand: `touch '${root}/repo-setup-ran'` },
        }),
      );
      const out = await runStoryCoding(run, context(), options(query));
      expect(out.status).toBe("complete");

      // The worktree, on the run's branch, after the repository's setup command; no token, no credential helper.
      expect(await readFile(seen, "utf8")).toBe(`${worktreePath()}\n${branch}\n`);
      const [call] = calls;
      expect(call!.prompt).toContain(`on ${branch}`);
      expect(call!.prompt).toContain("(The setup command lint failed: it exited with code 2.)");
      expect(call!.prompt).toBe(
        storyRunPrompt(
          run,
          run.trigger.context as RalphStoryPayload,
          { offered: [], progressFile: progressFileOf(call!) },
          undefined,
          {
            branch: `on ${branch}\n`,
            lint: "(The setup command lint failed: it exited with code 2.)",
          },
        ),
      );
    });

    it("runs the task's host tools and installable commands by absolute path, and attaches the agent's installable MCP servers", async () => {
      const dataDir = path.join(root, "data");
      const graphDir = await placeInstallable(
        dataDir,
        {
          name: "@omniralph/graph",
          version: "1.0.0",
          omniralph: {
            commands: [{ name: "graph-index", bin: "bin/index.sh" }],
            mcpServers: [{ name: "graph", command: "bin/server.sh" }],
          },
        },
        { "bin/index.sh": "#!/bin/sh\necho indexed\n", "bin/server.sh": "#!/bin/sh\n" },
      );
      const hostTool = path.join(root, "opengrep");
      await writeFile(hostTool, "#!/bin/sh\necho negotiated\n");
      await chmod(hostTool, 0o755);
      // Executables of the same names, first on the run's PATH.
      const planted = path.join(root, "planted");
      await mkdir(planted);
      for (const name of ["opengrep", "graph-index"]) {
        await writeFile(path.join(planted, name), "#!/bin/sh\necho planted\n");
        await chmod(path.join(planted, name), 0o755);
      }
      const teardownLog = path.join(root, "teardown-log");
      const { query, calls } = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      const run = withCommands(
        [command("branch", "opengrep"), command("lint", "graph-index")],
        [command("index", `graph-index >> '${teardownLog}'`)],
      );
      run.task.requires = { installables: [], hostTools: ["opengrep"] };
      run.agent.tools.mcpServers = ["@omniralph/graph:graph"];
      const out = await runStoryCoding(
        run,
        {
          ...context(),
          env: (extra) => ({
            ...context().env(extra),
            PATH: `${planted}:${process.env.PATH ?? ""}`,
          }),
          hostToolPath: (name) => (name === "opengrep" ? hostTool : null),
          dataDir,
        },
        options(query),
      );
      expect(out.status).toBe("complete");
      const [call] = calls;
      expect(call!.prompt).toContain("The branch: ```\nnegotiated\n```");
      expect(call!.prompt).toContain("The lint: ```\nindexed\n```");
      expect(await readFile(teardownLog, "utf8")).toBe("indexed\n");
      expect(Object.keys(call!.options.mcpServers ?? {}).sort()).toEqual([
        "omniralph",
        "omniralph_graph_graph",
      ]);
      expect(call!.options.mcpServers?.omniralph_graph_graph).toEqual({
        type: "stdio",
        command: path.join(graphDir, "bin/server.sh"),
        args: [],
      });
    });

    it("fails the run without a session when a required setup command fails, and still runs the teardown commands", async () => {
      const tornDown = path.join(root, "torn-down");
      const { query, calls } = fakeQuery(async function* () {
        yield result({ status: "complete", summary: "x", followUps: [] });
      });
      const run = withCommands(
        [command("branch", "echo 'no database' >&2; exit 4"), command("lint", "true")],
        [command("stop_db", probe(tornDown))],
      );
      await expect(runStoryCoding(run, context(), options(query))).rejects.toThrow(
        "setup command branch failed: it exited with code 4: no database",
      );
      expect(calls).toEqual([]);
      expect(await readFile(tornDown, "utf8")).toBe(`${worktreePath()}\n${branch}\n`);
    });

    it("runs the teardown commands in the worktree after the attempt, whatever happened, a failing one not stopping the next", async () => {
      const log = path.join(root, "teardown-log");
      const teardown = [
        command("first", `echo first >> '${log}'; exit 1`),
        command("second", `${probe(path.join(root, "teardown-env"))}; echo second >> '${log}'`),
      ];
      const setup = [command("branch", "true"), command("lint", "true")];

      // A completed story: after the commit and the push.
      const done = fakeQuery(async function* (call) {
        await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
        yield result({ status: "complete", summary: "Built it.", followUps: [] });
      });
      const out = await runStoryCoding(
        withCommands(setup, teardown),
        context(),
        options(done.query),
      );
      expect(out.status).toBe("complete");
      expect(await readFile(log, "utf8")).toBe("first\nsecond\n");
      expect(await readFile(path.join(root, "teardown-env"), "utf8")).toBe(
        `${worktreePath()}\n${branch}\n`,
      );

      // A failed attempt.
      const failed = fakeQuery(async function* () {
        yield result({ status: "incomplete", summary: "Not yet.", followUps: [] });
      });
      const notDone = await runStoryCoding(
        withCommands(setup, teardown),
        context(),
        options(failed.query),
      );
      expect(notDone.status).toBe("incomplete");
      expect(await readFile(log, "utf8")).toBe("first\nsecond\n".repeat(2));

      // A stopped run: the teardown commands still run to the end.
      const stopped = fakeQuery(async function* () {
        controller.abort(new Error("canceled"));
        yield result({ status: "complete", summary: "x", followUps: [] });
      });
      await expect(
        runStoryCoding(withCommands(setup, teardown), context(), options(stopped.query)),
      ).rejects.toThrow("canceled");
      expect(await readFile(log, "utf8")).toBe("first\nsecond\n".repeat(3));
    });
  });

  it("rejects a run whose trigger context is neither a story, a request nor a push", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield result({ status: "complete", summary: "x", followUps: [] });
    });
    const run = { ...spec(), trigger: { kind: "tracker.delegated" as const, context: {} } };
    await expect(runCodingTask(run, context(), options(query))).rejects.toThrow(
      "the coding run's trigger context is neither a story, a request nor a push",
    );
    expect(calls).toEqual([]);
  });
});
