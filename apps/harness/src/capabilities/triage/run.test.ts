import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TRIAGE_HEADING, TRIAGE_SYSTEM_APPEND, type TriageAgentOutput } from "@omniralph/ralph";
import {
  TriageRunResult,
  type JobPayload,
  type JobRepository,
  type TriageRunPayload,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../logger.js";
import { firstPrompt } from "../../test/fake-query.js";
import { ENV, exists, Remote } from "../../test/git-remote.js";
import { RepoCache } from "../../workspace/repoCache.js";
import { RetryableJobError, type JobContext } from "../index.js";
import { createSessionRunner, type SessionQueryFn } from "../ralph/session.js";
import { createTriageCapability } from "./index.js";
import { runTriage, type TriageOptions } from "./run.js";

interface Call {
  prompt: string;
  options: Options;
  /** What the session's working directory held while it ran. */
  readme: string | null;
}

/** A fake Agent SDK `query()` that yields `messages`. */
function fakeQuery(messages: unknown[]): { query: SessionQueryFn; calls: Call[] } {
  const calls: Call[] = [];
  const query: SessionQueryFn = (params) =>
    (async function* () {
      const options = params.options ?? {};
      const readme = await readFile(path.join(options.cwd!, "README.md"), "utf8").catch(() => null);
      calls.push({ prompt: await firstPrompt(params.prompt), options, readme });
      for (const m of messages) yield m;
    })() as AsyncGenerator<SDKMessage>;
  return { query, calls };
}

function result(structured: unknown, subtype = "success") {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: "Triaged.",
    errors: subtype === "success" ? undefined : ["boom"],
    structured_output: structured,
    modelUsage: {
      opus: {
        inputTokens: 70,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
}

const PRD = `# PRD: Task priorities

## Introduction

Tasks get a priority.

## Quality Gates

- \`pnpm test\` - Unit tests

## Functional Requirements

- FR-1: Tasks have a priority

## Acceptance Criteria

- [ ] Tasks have a priority column`;

const OUTPUT: TriageAgentOutput = {
  outcome: "prd",
  title: "  Task priorities ",
  description: PRD,
  size: "S",
  openQuestions: ["Which priorities?", "Which priorities?"],
  stories: [],
  subIssueUpdates: [],
  summary: "Sized S; one open question.",
};

describe("triage.run", { timeout: 60_000 }, () => {
  let root: string;
  let remote: Remote;
  let repo: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-triage-test-"));
    remote = new Remote(root);
    remote.init();
    await remote.commit({ "README.md": "main\n" });
    await remote.commit({ "README.md": "other\n" }, "other");
    repo = { provider: "github", fullPath: "acme/app", cloneUrl: pathToFileURL(remote.bare).href };
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
      sessionToken: () => "job-token",
      env: (extra) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "job-token", ...extra }),
      sessionEnv: (extra) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "job-token", ...extra }),
      spawn: () => {
        throw new Error("triage.run must not spawn processes through the context");
      },
      server: "https://omniralph.example.com",
      workspaceRoot: path.join(root, "workspace"),
      repos,
      logger: silentLogger(),
    };
  }

  function job(overrides: Partial<TriageRunPayload> = {}): JobPayload {
    const payload: TriageRunPayload = {
      triageRunId: randomUUID(),
      issue: {
        id: "issue-1",
        identifier: "TOOL-300",
        title: "Priorities",
        description: "Tasks need priorities.",
        stateType: "backlog",
        creator: { id: "user-1", name: "Ada" },
        url: null,
      },
      comments: [],
      children: [],
      blockers: [],
      repository: { repositoryId: randomUUID(), repository: repo, defaultBranch: "main" },
      reply: null,
      previousResult: null,
      ...overrides,
    };
    return {
      id: randomUUID(),
      type: "triage.run",
      taskType: "query",
      pool: "short",
      taskId: null,
      repositoryId: payload.repository?.repositoryId ?? null,
      payload,
      deliveryCount: 1,
    };
  }

  const options = (query: SessionQueryFn, extra: TriageOptions = {}): TriageOptions => ({
    runSession: createSessionRunner(query),
    ...extra,
  });

  it("runs one read-only session in a checkout of the default branch and returns the outcome", async () => {
    const { query, calls } = fakeQuery([result(OUTPUT)]);
    const triage = job();
    const output = await createTriageCapability(options(query)).run(triage, context());

    expect(TriageRunResult.parse(output)).toEqual({
      summary: "Sized S; one open question.",
      error: null,
      outcome: {
        outcome: "prd",
        title: "Task priorities",
        description: PRD,
        size: "S",
        openQuestions: ["Which priorities?"],
        stories: [],
        subIssueUpdates: [],
      },
      usage: { inputTokens: 70, outputTokens: 20 },
      durationMs: expect.any(Number) as number,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.readme).toBe("main\n");
    expect(call!.options.cwd).toBe(path.join(root, "workspace", ".worktrees", triage.id));
    expect(await exists(call!.options.cwd!)).toBe(false);
    expect(call!.options.model).toBe("opus");
    expect(call!.options.permissionMode).toBe("dontAsk");
    expect(call!.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(call!.options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(call!.options.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(call!.options.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch", "WebSearch"]),
    );
    expect(call!.options.settingSources).toEqual([]);
    expect(call!.options.mcpServers).toEqual({});
    expect(call!.options.hooks?.PreToolUse).toHaveLength(1);
    expect(call!.options.outputFormat).toMatchObject({ type: "json_schema" });
    expect(call!.options.systemPrompt).toMatchObject({ append: TRIAGE_SYSTEM_APPEND });
    expect(call!.options.env?.OMNIRALPH_JOB_TOKEN).toBeUndefined();
    expect(call!.prompt).toContain(TRIAGE_HEADING);
    expect(call!.prompt).toContain("acme/app");
    expect(call!.prompt).toContain("Tasks need priorities.");
  });

  it("checks out the repository's default branch, whatever it is called", async () => {
    const { query, calls } = fakeQuery([result(OUTPUT)]);
    await runTriage(
      job({ repository: { repositoryId: randomUUID(), repository: repo, defaultBranch: "other" } }),
      context(),
      options(query),
    );
    expect(calls[0]!.readme).toBe("other\n");
  });

  it("runs without a checkout when no repository is routed", async () => {
    const { query, calls } = fakeQuery([result(OUTPUT)]);
    const output = await runTriage(job({ repository: null }), context(), options(query));
    expect(output.error).toBeNull();
    const [call] = calls;
    expect(call!.readme).toBeNull();
    expect(call!.options.cwd!.startsWith(path.join(root, "workspace"))).toBe(false);
    expect(await exists(call!.options.cwd!)).toBe(false);
    expect(call!.options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(call!.prompt).toContain("No repository is routed");
    expect(await exists(path.join(root, "workspace"))).toBe(false);
  });

  it("runs without a checkout when the default branch doesn't exist", async () => {
    const { query, calls } = fakeQuery([result(OUTPUT)]);
    await runTriage(
      job({ repository: { repositoryId: randomUUID(), repository: repo, defaultBranch: "nope" } }),
      context(),
      options(query),
    );
    expect(calls[0]!.readme).toBeNull();
    expect(calls[0]!.prompt).toContain("No repository is routed");
  });

  it("returns an error result when the structured result isn't valid", async () => {
    for (const structured of [
      undefined,
      { ...OUTPUT, description: "No gates here." },
      { ...OUTPUT, size: "L" },
    ]) {
      const { query } = fakeQuery([result(structured)]);
      const output = await runTriage(job(), context(), options(query));
      expect(output.outcome).toBeNull();
      expect(output.error).toMatch(/without a valid result/);
      expect(output.summary).toBe(output.error);
      expect(output.usage).toEqual({ inputTokens: 70, outputTokens: 20 });
    }
  });

  it("returns an error result when the session fails", async () => {
    const { query } = fakeQuery([result(undefined, "error_during_execution")]);
    const output = await runTriage(job(), context(), options(query));
    expect(TriageRunResult.parse(output)).toMatchObject({
      outcome: null,
      error: "The triage session failed: error_during_execution: boom",
    });
  });

  it("retries on a Claude rate limit", async () => {
    const { query } = fakeQuery([
      {
        type: "assistant",
        parent_tool_use_id: null,
        error: "rate_limit",
        message: { content: [] },
      },
    ]);
    const error = await runTriage(
      job(),
      context(),
      options(query, { defaultRetryAfterSeconds: 42 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableJobError);
    expect((error as RetryableJobError).retryAfterSeconds).toBe(42);
  });

  it("rethrows when the job is aborted", async () => {
    const { query } = fakeQuery([result(OUTPUT)]);
    controller.abort(new Error("canceled"));
    await expect(runTriage(job({ repository: null }), context(), options(query))).rejects.toThrow(
      "canceled",
    );
  });

  it("rejects an invalid payload or job type", async () => {
    const { query } = fakeQuery([]);
    const capability = createTriageCapability(options(query));
    await expect(capability.run({ ...job(), payload: { issue: {} } }, context())).rejects.toThrow(
      /invalid triage.run payload/,
    );
    await expect(capability.run({ ...job(), type: "triage.other" }, context())).rejects.toThrow(
      /not supported/,
    );
  });
});
