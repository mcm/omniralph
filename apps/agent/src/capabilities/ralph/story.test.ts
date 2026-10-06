import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@omniralph/engine";
import type { JobPayload, JobRepository, RalphStoryPayload } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../logger.js";
import { ENV, git, Remote } from "../../test/git-remote.js";
import { RepoCache } from "../../workspace/repoCache.js";
import { RetryableJobError, type JobContext } from "../index.js";
import { createRalphCapability } from "./index.js";
import { createSessionRunner } from "./session.js";
import { runStory, stashPrefix, type StoryOptions } from "./story.js";

interface Call {
  prompt: string;
  options: Options;
}

/** A fake Agent SDK `query()`: `script` does the session's work and yields its messages. */
function fakeQuery(script: (call: Call) => AsyncGenerator<unknown>): {
  query: QueryFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const query = ((params: { prompt: string; options?: Options }) => {
    const call = { prompt: params.prompt, options: params.options ?? {} };
    calls.push(call);
    return script(call) as AsyncGenerator<SDKMessage>;
  }) as QueryFn;
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

describe("ralph.story", { timeout: 60_000 }, () => {
  let root: string;
  let workspaceRoot: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let posted: { url: string; auth: string | null; body: Record<string, unknown> }[];
  let activityStatus: number;
  const runId = randomUUID();
  const branch = "feat/tool-32";

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    posted.push({
      url: String(input),
      auth: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json(activityStatus === 200 ? { ok: true } : { error: "x" }, {
      status: activityStatus,
    });
  }) as typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-story-"));
    workspaceRoot = path.join(root, "workspace");
    remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "hello\n" });
    repo = { provider: "gitlab", fullPath: "group/app", cloneUrl: pathToFileURL(remote.bare).href };
    repos = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
    controller = new AbortController();
    posted = [];
    activityStatus = 200;
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
        throw new Error("ralph.story must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot,
      repos,
      logger: silentLogger(),
    };
  }

  function job(overrides: Partial<RalphStoryPayload> = {}): JobPayload {
    const payload: RalphStoryPayload = {
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
      storyId: randomUUID(),
      attempt: 1,
      epic: { identifier: "TOOL-32", title: "Ralph core", kind: "children", url: null, prd: PRD },
      story: {
        identifier: "TOOL-91",
        title: "Run a story",
        linearIssueId: "issue-91",
        url: null,
        description: "Run it.\n\n## Acceptance Criteria\n- [ ] it runs\n",
      },
      stories: [
        {
          identifier: "TOOL-90",
          title: "Start runs",
          status: "completed",
          manual: false,
          dependsOn: [],
        },
        {
          identifier: "TOOL-91",
          title: "Run a story",
          status: "open",
          manual: false,
          dependsOn: ["TOOL-90"],
        },
      ],
      commitMessage: "feat(TOOL-91): Run a story",
      qualityGates: ["test -f feature.txt", "true"],
      prdQualityGates: ["true"],
      progress: "# Ralph Progress Log\n",
      lastFeedback: null,
      guidance: [],
      ...overrides,
    };
    return {
      id: randomUUID(),
      capability: "ralph",
      type: "ralph.story",
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  function options(query: QueryFn, extra: StoryOptions = {}): StoryOptions {
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

  it("runs the session with ralph's policy, then gates, commits and pushes a complete story", async () => {
    const { query, calls } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      await appendFile(progressFileOf(call), "\n## TOOL-91: learned things\n");
      yield assistant({ type: "text", text: "Reading the PRD." });
      yield assistant(
        { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [] } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls -la" } },
      );
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });

    const storyJob = job();
    const out = await runStory(storyJob, context(), options(query));

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

    const [call] = calls;
    expect(call!.options).toMatchObject({
      cwd: worktreePath(),
      model: "opus",
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project", "local"],
      outputFormat: { type: "json_schema" },
      persistSession: false,
    });
    expect(call!.options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(JSON.stringify(call!.options.systemPrompt)).toContain("Never run git commit, git push");
    expect(call!.options.env?.OMNIRALPH_JOB_TOKEN).toBeUndefined();
    expect(call!.prompt).toContain("## Your Task: TOOL-91 - Run a story");
    expect(call!.prompt).toContain("- [ ] it runs");
    expect(call!.prompt).toContain("- [x] TOOL-90: Start runs");
    expect(call!.prompt).not.toContain("Stashed Work");

    expect(new Set(posted.map((p) => p.url))).toEqual(
      new Set([`https://omniralph.example.com/api/agent/jobs/${storyJob.id}/activities`]),
    );
    expect(posted.every((p) => p.auth === "Bearer job-token")).toBe(true);
    expect(posted.map((p) => p.body)).toEqual([
      { type: "thought", body: "Reading the PRD.", ephemeral: false },
      { type: "action", body: "Bash", parameter: "ls -la", ephemeral: true },
      { type: "action", body: "Quality gate", parameter: "test -f feature.txt", ephemeral: true },
      { type: "action", body: "Quality gate", parameter: "true", ephemeral: true },
    ]);
  });

  it("uses the repository's model and commits a single issue as `<ID>: <title>`", async () => {
    const { query, calls } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "single\n");
      yield result({ status: "complete", summary: "Done.", followUps: [] });
    });
    const out = await runStory(
      job({
        settings: {
          model: "sonnet",
          setupCommand: null,
          fallbackModel: null,
          appendInstruction: null,
          allowedTools: null,
          disallowedTools: null,
        },
        epic: { identifier: "TOOL-91", title: "Run a story", kind: "single", url: null, prd: "" },
        commitMessage: "TOOL-91: Run a story",
      }),
      context(),
      options(query),
    );
    expect(out.status).toBe("complete");
    expect(calls[0]!.options.model).toBe("sonnet");
    expect(git(remote.bare, "log", "-1", "--format=%B", `refs/heads/${branch}`)).toBe(
      "TOOL-91: Run a story",
    );
  });

  it("passes the repository's prompt, model and tool settings to the session, which only narrow ralph's policy", async () => {
    const { query, calls } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const out = await runStory(
      job({
        settings: {
          model: "sonnet",
          setupCommand: null,
          fallbackModel: "haiku",
          appendInstruction: "Always write a changelog entry.",
          allowedTools: [
            "Read",
            "Edit",
            "Bash(pnpm test:*)",
            "Bash(pnpm lint)",
            "mcp__docs__search",
          ],
          disallowedTools: ["WebFetch"],
        },
      }),
      context(),
      options(query),
    );
    expect(out.status).toBe("complete");
    const [call] = calls;
    expect(call!.prompt).toContain("Always write a changelog entry.");
    // The job's gates are the orchestrator's checks; the PRD's own gate isn't repeated as the agent's.
    expect(call!.prompt).toContain("### Checked by the Orchestrator");
    expect(call!.prompt).toContain("- `test -f feature.txt`");
    expect(call!.prompt).not.toContain("### Quality Gates");
    expect(call!.options).toMatchObject({
      model: "sonnet",
      fallbackModel: "haiku",
      tools: ["Read", "Edit", "Bash"],
      allowedTools: ["Read", "Edit", "Bash(pnpm test:*)", "Bash(pnpm lint)", "mcp__docs__search"],
      disallowedTools: ["WebFetch"],
      // Only the listed calls run: nothing else is approved without asking, and nobody can be asked.
      permissionMode: "dontAsk",
      settingSources: ["project", "local"],
    });
    expect(call!.options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("keeps ralph's whole policy when the repository restricts no tools", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield result({ status: "complete", summary: "Nothing to change.", followUps: [] });
    });
    await runStory(job(), context(), options(query));
    expect(calls[0]!.options).toMatchObject({
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: [],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
    });
    expect(calls[0]!.options.fallbackModel).toBeUndefined();
  });

  it("fails the attempt with the gate's output and stashes the work when a gate fails", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "broken\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const out = await runStory(
      job({
        qualityGates: ["true", "echo 'type error in feature.txt'; exit 3", "touch never-ran"],
      }),
      context(),
      options(query),
    );
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

  it("gives the session the last feedback and the guidance", async () => {
    const { query, calls } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield result({ status: "complete", summary: "Done.", followUps: [] });
    });
    await runStory(
      job({
        attempt: 2,
        lastFeedback: "The quality gate `pnpm test` failed (exit 1).",
        guidance: ["Use the v2 API.", "Keep commits small."],
      }),
      context(),
      options(query),
    );
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("The quality gate `pnpm test` failed (exit 1).");
    expect(prompt).toContain("- Use the v2 API.\n- Keep commits small.");
  });

  it("undoes the commit and fails the attempt when files are left uncommitted after it", async () => {
    const { query } = fakeQuery(async function* (call) {
      const cwd = cwdOf(call);
      await writeFile(path.join(cwd, "feature.txt"), "built\n");
      // A post-commit hook leaves a generated file behind.
      await mkdir(path.join(cwd, ".hooks"));
      await writeFile(
        path.join(cwd, ".hooks", "post-commit"),
        "#!/bin/sh\necho x > generated.txt\n",
      );
      await chmod(path.join(cwd, ".hooks", "post-commit"), 0o755);
      git(cwd, "config", "core.hooksPath", ".hooks");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const before = git(remote.bare, "rev-parse", "refs/heads/main");
    const out = await runStory(job(), context(), options(query));
    expect(out.status).toBe("failed");
    expect(out.commitSha).toBeUndefined();
    expect(out.feedback).toContain("these files were still uncommitted");
    expect(out.feedback).toContain("generated.txt");
    expect(git(worktreePath(), "rev-parse", "HEAD")).toBe(before);
    expect(() => git(remote.bare, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    expect(storyStashes()).toHaveLength(1);
  });

  it("undoes the commit and fails the attempt when the push is rejected", async () => {
    const hook = path.join(remote.bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "built\n");
      yield result({ status: "complete", summary: "Built it.", followUps: [] });
    });
    const before = git(remote.bare, "rev-parse", "refs/heads/main");
    const out = await runStory(job(), context(), options(query));
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

  it("stashes the work of an incomplete attempt and returns the summary as feedback, with follow-ups", async () => {
    activityStatus = 500; // relay failures never fail the job
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "half.txt"), "half\n");
      yield assistant({ type: "text", text: "Working." });
      yield result({
        status: "incomplete",
        summary: "Half done: the endpoint is missing.",
        followUps: [{ title: "Fix the flaky test", description: "- [ ] passes", manual: false }],
      });
    });
    const out = await runStory(job(), context(), options(query));
    expect(out).toMatchObject({
      status: "incomplete",
      summary: "Half done: the endpoint is missing.",
      followUps: [{ title: "Fix the flaky test", description: "- [ ] passes", manual: false }],
    });
    expect(out.feedback).toContain("reported the story incomplete");
    expect(out.feedback).toContain("> Half done: the endpoint is missing.");
    expect(posted).toHaveLength(1);
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(storyStashes()).toHaveLength(1);
  });

  it("commits and pushes a blocked story's work as wip once its gates pass", async () => {
    const first = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "from attempt 1\n");
      yield result({ status: "incomplete", summary: "Ran out of time.", followUps: [] });
    });
    await runStory(job(), context(), options(first.query));
    const [offered] = storyStashes()[0]!.split(" ");

    const { query } = fakeQuery(async function* (call) {
      execFileSync("git", ["stash", "apply", "--quiet", offered!], { cwd: cwdOf(call), env: ENV });
      yield result({
        status: "blocked",
        summary: "I need an API key for the payment sandbox.",
        appliedStashes: [offered!],
        commit: { summary: "Add the payment client" },
        followUps: [],
      });
    });
    const storyJob = job({ attempt: 2 });
    const out = await runStory(storyJob, context(), options(query));

    expect(out.status).toBe("blocked");
    const pushed = git(remote.bare, "rev-parse", `refs/heads/${branch}`);
    expect(out.commitSha).toBe(pushed);
    expect(git(remote.bare, "log", "-1", "--format=%B", pushed)).toBe(
      "wip(TOOL-91): Add the payment client\n\nEpic: TOOL-32 Ralph core",
    );
    expect(git(remote.bare, "show", `${pushed}:feature.txt`)).toBe("from attempt 1");
    expect(out.feedback).toContain("reported it was blocked");
    expect(out.feedback).toContain(`committed on the branch as \`${pushed.slice(0, 10)}\``);
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(storyStashes()).toEqual([]);
    expect(posted.map((p) => p.body)).toContainEqual({
      type: "thought",
      body: `Committed TOOL-91's work so far as \`${pushed.slice(0, 10)}\` (\`wip(TOOL-91): Add the payment client\`).`,
      ephemeral: false,
    });
  });

  it("names a blocked story's wip commit after the story when the session gives no summary", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "partial\n");
      yield result({ status: "blocked", summary: "Needs a decision.", followUps: [] });
    });
    const out = await runStory(job(), context(), options(query));
    expect(out.status).toBe("blocked");
    expect(git(remote.bare, "log", "-1", "--format=%s", `refs/heads/${branch}`)).toBe(
      "wip(TOOL-91): Run a story",
    );
  });

  it("stashes a blocked story's work instead of committing it when a gate fails", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "broken\n");
      yield result({
        status: "blocked",
        summary: "Needs a token.",
        commit: { summary: "Half a client" },
        followUps: [],
      });
    });
    const out = await runStory(
      job({ qualityGates: ["echo 'type error'; exit 2"] }),
      context(),
      options(query),
    );
    expect(out.status).toBe("blocked");
    expect(out.commitSha).toBeUndefined();
    expect(out.feedback).toContain("reported it was blocked");
    expect(out.feedback).toContain(
      "wasn't committed because the quality gate `echo 'type error'; exit 2` failed (exit 2)",
    );
    expect(() => git(remote.bare, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    const stashes = storyStashes();
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toContain("blocked (attempt 1)");
  });

  it("commits nothing and runs no gates for a blocked story with a clean tree", async () => {
    const { query } = fakeQuery(async function* () {
      yield result({ status: "blocked", summary: "Needs a token.", followUps: [] });
    });
    const before = git(remote.bare, "rev-parse", "refs/heads/main");
    const out = await runStory(job(), context(), options(query));
    expect(out.status).toBe("blocked");
    expect(out.commitSha).toBeUndefined();
    expect(out.feedback).not.toContain("committed");
    expect(git(worktreePath(), "rev-parse", "HEAD")).toBe(before);
    expect(() => git(remote.bare, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    expect(storyStashes()).toEqual([]);
    expect(posted.map((p) => p.body.body)).not.toContain("Quality gate");
  });

  it("stashes leftover work (pre-run), offers the stashes and drops them once the story is committed", async () => {
    const first = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "from attempt 1\n");
      yield result({ status: "incomplete", summary: "Ran out of time.", followUps: [] });
    });
    await runStory(job(), context(), options(first.query));
    const [incompleteSha] = storyStashes()[0]!.split(" ");
    // Something left behind outside a story attempt (e.g. a crashed delivery).
    await writeFile(path.join(worktreePath(), "leftover.txt"), "leftover\n");

    const second = fakeQuery(async function* (call) {
      execFileSync("git", ["stash", "apply", "--quiet", incompleteSha!], {
        cwd: cwdOf(call),
        env: ENV,
      });
      yield result({
        status: "complete",
        summary: "Finished it.",
        appliedStashes: [incompleteSha!.slice(0, 10)],
        followUps: [],
      });
    });
    const out = await runStory(
      job({ attempt: 2, lastFeedback: "It was incomplete." }),
      context(),
      options(second.query),
    );

    const prompt = second.calls[0]!.prompt;
    expect(prompt).toContain("## Stashed Work From Earlier Sessions");
    expect(prompt).toContain(incompleteSha);
    expect(prompt).toContain("pre-run (attempt 2)");
    expect(prompt).toContain("It was incomplete.");
    expect(posted[0]!.body).toMatchObject({ type: "thought" });
    expect(String(posted[0]!.body.body)).toContain("stashed them first");

    expect(out.status).toBe("complete");
    expect(git(remote.bare, "show", `${out.commitSha}:feature.txt`)).toBe("from attempt 1");
    expect(() => git(remote.bare, "show", `${out.commitSha}:leftover.txt`)).toThrow();
    expect(storyStashes()).toEqual([]);
  });

  it("stashes the work and rejects when the job is canceled mid-run", async () => {
    const { query } = fakeQuery(async function* (call) {
      await writeFile(path.join(cwdOf(call), "feature.txt"), "in progress\n");
      yield assistant({ type: "text", text: "Working." });
      controller.abort(new Error("canceled"));
      await new Promise<void>((_, reject) => {
        const signal = call.options.abortController!.signal;
        if (signal.aborted) reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    await expect(runStory(job(), context(), options(query))).rejects.toThrow("canceled");
    expect(() => git(remote.bare, "rev-parse", "--verify", `refs/heads/${branch}`)).toThrow();
    expect(git(worktreePath(), "status", "--porcelain", "--untracked-files=all")).toBe("");
    const stashes = storyStashes();
    expect(stashes).toHaveLength(1);
    expect(stashes[0]).toContain("stopped (attempt 1)");
  });

  it("throws RetryableJobError on a Claude rate limit", async () => {
    const { query } = fakeQuery(async function* () {
      yield { type: "rate_limit_event", rate_limit_info: { status: "rejected" } };
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["rate_limit_error"],
        modelUsage: {},
      };
    });
    const error = await runStory(
      job(),
      context(),
      options(query, { defaultRetryAfterSeconds: 120 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableJobError);
    expect((error as RetryableJobError).retryAfterSeconds).toBe(120);
  });

  it("fails an attempt whose session goes idle", async () => {
    const { query } = fakeQuery(async function* (call) {
      yield assistant({ type: "text", text: "Thinking." });
      await new Promise<void>((_, reject) => {
        call.options.abortController!.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    });
    const out = await runStory(job(), context(), options(query, { idleTimeoutMs: 50 }));
    expect(out.status).toBe("failed");
    expect(out.feedback).toContain("stopped: the session sent nothing for 0s");
  });

  it("is what the ralph capability runs for ralph.story jobs", async () => {
    const { query } = fakeQuery(async function* () {
      yield result({ status: "blocked", summary: "Needs a token.", followUps: [] });
    });
    const capability = createRalphCapability(options(query));
    const out = await capability.run(job(), context());
    expect(out).toMatchObject({ status: "blocked", summary: "Needs a token." });
    await expect(capability.run({ ...job(), payload: {} }, context())).rejects.toThrow(
      "invalid ralph.story payload",
    );
    expect(await readFile(path.join(remote.bare, "HEAD"), "utf8")).toContain("main");
  });
});
