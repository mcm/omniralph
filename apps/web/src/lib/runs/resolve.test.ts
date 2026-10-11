import type * as Db from "@omniralph/db";
import {
  QUERY_TASKS_MIN_HARNESS_VERSION,
  REVIEW_TASKS_MIN_HARNESS_VERSION,
  SETUP_COMMANDS_MIN_HARNESS_VERSION,
  type JobToken,
  type ReviewProfileConfig,
  type RunSpecJobPayload,
} from "@omniralph/shared";
import {
  AgentDefinition,
  TaskDefinition,
  type AgentDefinitionInput,
  type TaskDefinitionInput,
} from "@omniralph/tasks";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  repository: null as unknown,
  profile: null as unknown,
}));
vi.mock("@omniralph/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  getRepositoryWithConnection: async (_db: unknown, id: string, organizationId: string) =>
    state.repository && id === REPO_ID && organizationId === ORG_ID
      ? {
          repository: state.repository,
          connection: { baseUrl: "https://api.github.com" },
        }
      : null,
  getRepositoryReviewSettings: async (_db: unknown, id: string) =>
    state.profile && id === REPO_ID ? { profile: state.profile, rules: [] } : null,
}));

const { BUILTIN_DEFINITIONS, RunSpecError, narrowTools, resolveRunSpec, runTokenBudget } =
  await import("./resolve");
const { runSpecJobInput } = await import("./job");

const ORG_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const REPO_ID = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";
const JOB_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const db = {} as Db.Database;

const agentInput: AgentDefinitionInput = {
  id: "builtin:code-reader",
  name: "Code reader",
  systemPrompt: "You read code.",
  taskTypes: ["query"],
  tools: { builtin: ["Read", "Grep", "Glob"] },
  model: "haiku",
  fallbackModel: "sonnet",
};

const taskInput: TaskDefinitionInput = {
  id: "builtin:reply-to-finding",
  name: "Reply",
  taskType: "query",
  agentId: "builtin:code-reader",
  triggers: ["finding.mention"],
  promptTemplate: "{{question}}",
  sink: "finding-thread",
  pool: "short",
  tokenBudget: { profileFraction: 0.1 },
};

const tokens: { lifecycle: JobToken; session: JobToken } = {
  lifecycle: { jobId: JOB_ID, token: "lifecycle-jwt", expiresIn: 900, kind: "lifecycle" },
  session: { jobId: JOB_ID, token: "session-jwt", expiresIn: 900, kind: "session" },
};

const payload: RunSpecJobPayload = {
  trigger: { kind: "finding.mention", context: { question: "Why?" } },
  repositoryId: REPO_ID,
  ref: "abc123",
  requireCheckout: true,
};

function definitions(
  task: Partial<TaskDefinitionInput> = {},
  agent: Partial<AgentDefinitionInput> = {},
) {
  const a = AgentDefinition.parse({ ...agentInput, ...agent });
  const t = TaskDefinition.parse({ ...taskInput, ...task });
  return {
    getAgent: (id: string) => (id === a.id ? a : null),
    getTask: (id: string) => (id === t.id ? t : null),
  };
}

function job(overrides: Partial<Db.Job> = {}) {
  return {
    id: JOB_ID,
    organizationId: ORG_ID,
    taskType: "query",
    pool: "short",
    taskId: "builtin:reply-to-finding",
    repositoryId: REPO_ID,
    payload,
    ...overrides,
  } as Db.Job;
}

function repository(ralphSettings: Record<string, unknown> = {}) {
  return { provider: "github", fullPath: "acme/app", ralphSettings };
}

beforeEach(() => {
  state.repository = repository();
  state.profile = { model: "opus", maxTokensPerReview: 200_000 };
});

describe("resolveRunSpec", () => {
  it("resolves the task, its agent, the trigger, the repository, ref and tokens", async () => {
    const spec = await resolveRunSpec(db, job(), tokens, definitions());
    expect(spec).toMatchObject({
      jobId: JOB_ID,
      taskType: "query",
      pool: "short",
      agent: { id: "builtin:code-reader", tools: { builtin: ["Read", "Grep", "Glob"] } },
      task: { id: "builtin:reply-to-finding" },
      trigger: payload.trigger,
      repository: {
        provider: "github",
        fullPath: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
      },
      ref: "abc123",
      requireCheckout: true,
      tools: { allowedTools: [], disallowedTools: [] },
      fallbackModel: "sonnet",
      tokens,
    });
  });

  describe("model precedence", () => {
    it("takes the task's model first", async () => {
      const spec = await resolveRunSpec(db, job(), tokens, definitions({ model: "sonnet" }));
      expect(spec.model).toBe("sonnet");
    });

    it("then the repository profile's", async () => {
      expect((await resolveRunSpec(db, job(), tokens, definitions())).model).toBe("opus");
    });

    it("then the agent's, without a repository", async () => {
      const spec = await resolveRunSpec(
        db,
        job({ repositoryId: null, payload: { trigger: payload.trigger } }),
        tokens,
        definitions({ tokenBudget: null }),
      );
      expect(spec).toMatchObject({ model: "haiku", repository: null, ref: null });
      expect(spec.requireCheckout).toBe(false);
    });

    it("is null when nothing sets one (the Claude Code default)", async () => {
      const spec = await resolveRunSpec(
        db,
        job({ repositoryId: null, payload: { trigger: payload.trigger } }),
        tokens,
        definitions({ tokenBudget: null }, { model: null }),
      );
      expect(spec.model).toBeNull();
    });
  });

  describe("token budget", () => {
    it("resolves a fraction against the repository profile's budget", async () => {
      expect((await resolveRunSpec(db, job(), tokens, definitions())).tokenBudget).toBe(20_000);
      state.profile = { model: "opus", maxTokensPerReview: 33_333 };
      expect((await resolveRunSpec(db, job(), tokens, definitions())).tokenBudget).toBe(3_333);
    });

    it("keeps a fixed budget and no budget as they are", async () => {
      const fixed = definitions({ tokenBudget: { tokens: 5000 } });
      expect((await resolveRunSpec(db, job(), tokens, fixed)).tokenBudget).toBe(5000);
      const none = definitions({ tokenBudget: null });
      expect((await resolveRunSpec(db, job(), tokens, none)).tokenBudget).toBeNull();
    });

    it("is what runTokenBudget computes, at least 1", () => {
      const task = { id: "builtin:reply-to-finding", tokenBudget: { profileFraction: 0.1 } };
      expect(runTokenBudget(task, { maxTokensPerReview: 200_000 })).toBe(20_000);
      expect(runTokenBudget(task, { maxTokensPerReview: 5 })).toBe(1);
      expect(runTokenBudget({ id: "builtin:x", tokenBudget: null }, null)).toBeNull();
      expect(() => runTokenBudget(task, null)).toThrow(RunSpecError);
    });

    it("fails a fractional budget without a repository", async () => {
      await expect(
        resolveRunSpec(
          db,
          job({ repositoryId: null, payload: { trigger: payload.trigger } }),
          tokens,
          definitions(),
        ),
      ).rejects.toThrow(RunSpecError);
    });
  });

  describe("repository narrowing", () => {
    it("removes a tool the repository's allowedTools don't name, and doesn't add one they do", async () => {
      state.repository = repository({
        allowedTools: ["Read", "Grep(src/**)", "Bash(pnpm test:*)"],
      });
      const spec = await resolveRunSpec(db, job(), tokens, definitions());
      expect(spec.agent.tools.builtin).toEqual(["Read", "Grep"]);
      expect(spec.tools).toEqual({
        allowedTools: ["Read", "Grep(src/**)", "Bash(pnpm test:*)"],
        disallowedTools: [],
      });
    });

    it("removes a tool the repository disallows outright, but not one it only restricts", async () => {
      state.repository = repository({ disallowedTools: ["Glob", "Grep(secrets/**)", "WebFetch"] });
      const spec = await resolveRunSpec(db, job(), tokens, definitions());
      expect(spec.agent.tools.builtin).toEqual(["Read", "Grep"]);
      expect(spec.tools.disallowedTools).toEqual(["Glob", "Grep(secrets/**)", "WebFetch"]);
    });

    it("narrowTools never widens", () => {
      expect(narrowTools([], { allowedTools: ["Bash"], disallowedTools: [] })).toEqual([]);
      expect(narrowTools(["Read"], { allowedTools: [], disallowedTools: [] })).toEqual(["Read"]);
    });
  });

  describe("failures", () => {
    it("fails an unknown task", async () => {
      const result = resolveRunSpec(db, job({ taskId: "builtin:gone" }), tokens, definitions());
      await expect(result).rejects.toThrow(RunSpecError);
      await expect(result).rejects.toThrow("Unknown task builtin:gone");
    });

    it("fails a trigger the task doesn't allow", async () => {
      const result = resolveRunSpec(
        db,
        job({ payload: { trigger: { kind: "chat.request", context: {} } } }),
        tokens,
        definitions(),
      );
      await expect(result).rejects.toThrow(
        new RunSpecError("Task builtin:reply-to-finding can't be triggered by chat.request"),
      );
    });

    it("fails an unknown agent, an invalid payload, a routing mismatch and an unknown repository", async () => {
      const cases: [Partial<Db.Job>, ReturnType<typeof definitions>, string][] = [
        [{}, definitions({ agentId: "builtin:nobody" }), "Unknown agent builtin:nobody"],
        [{ payload: { question: "Why?" } }, definitions(), "Invalid run payload"],
        [{ pool: "long" }, definitions(), "doesn't match task builtin:reply-to-finding"],
        [{}, definitions(), "Unknown repository"],
      ];
      for (const [overrides, defs, message] of cases) {
        if (message === "Unknown repository") state.repository = null;
        const result = resolveRunSpec(db, job(overrides), tokens, defs);
        await expect(result).rejects.toThrow(RunSpecError);
        await expect(result).rejects.toThrow(message);
      }
    });
  });
});

describe("resolveRunSpec for builtin:review-pr", () => {
  const PROFILES: Record<"quick" | "deep", ReviewProfileConfig> = {
    quick: {
      id: "quick",
      name: "Quick",
      model: "claude-haiku-5-5",
      maxTokensPerReview: 60_000,
      maxFiles: 15,
      allowRepoExploration: false,
    },
    deep: {
      id: "deep",
      name: "Deep",
      model: "claude-opus-5-5",
      maxTokensPerReview: 600_000,
      maxFiles: 100,
      allowRepoExploration: true,
    },
  };

  function reviewJob(profile: ReviewProfileConfig) {
    return job({
      taskType: "review",
      taskId: "builtin:review-pr",
      payload: {
        trigger: {
          kind: "pr.updated",
          context: {
            reviewConfig: { profile, customInstructions: null, rules: [], pathExcludes: [] },
          },
        },
        repositoryId: REPO_ID,
        ref: "c".repeat(40),
      },
    });
  }

  it("narrows a quick review to the diff: its model, budget and max files, no exploration tools", async () => {
    const spec = await resolveRunSpec(db, reviewJob(PROFILES.quick), tokens, BUILTIN_DEFINITIONS);
    expect(spec).toMatchObject({
      taskType: "review",
      pool: "short",
      task: { id: "builtin:review-pr", sink: "review" },
      agent: { id: "builtin:reviewer" },
      model: "claude-haiku-5-5",
      tokenBudget: 60_000,
      maxFiles: 15,
    });
    expect(spec.agent.tools.builtin).toEqual([]);
  });

  it("keeps the exploration tools of a deep review, with its model, budget and max files", async () => {
    const spec = await resolveRunSpec(db, reviewJob(PROFILES.deep), tokens, BUILTIN_DEFINITIONS);
    expect(spec).toMatchObject({ model: "claude-opus-5-5", tokenBudget: 600_000, maxFiles: 100 });
    expect(spec.agent.tools.builtin).toEqual(["Read", "Grep", "Glob"]);
  });

  it("still applies the repository's tool settings", async () => {
    state.repository = repository({ disallowedTools: ["Glob"] });
    const spec = await resolveRunSpec(db, reviewJob(PROFILES.deep), tokens, BUILTIN_DEFINITIONS);
    expect(spec.agent.tools.builtin).toEqual(["Read", "Grep"]);
  });

  it("falls back to the task's then the agent's model, and caps the budget by the task's", async () => {
    const review = getReviewDefinitions({ model: "sonnet", tokenBudget: { tokens: 50_000 } });
    const noModel = { ...PROFILES.deep, model: null };
    expect(await resolveRunSpec(db, reviewJob(noModel), tokens, review)).toMatchObject({
      model: "sonnet",
      tokenBudget: 50_000,
    });
    const fraction = getReviewDefinitions(
      { tokenBudget: { profileFraction: 0.5 } },
      { model: "haiku" },
    );
    expect(await resolveRunSpec(db, reviewJob(noModel), tokens, fraction)).toMatchObject({
      model: "haiku",
      tokenBudget: 300_000,
    });
  });

  it("fails a review run without a review configuration", async () => {
    const result = resolveRunSpec(
      db,
      job({
        taskType: "review",
        taskId: "builtin:review-pr",
        payload: { trigger: { kind: "pr.updated", context: {} }, repositoryId: REPO_ID },
      }),
      tokens,
      BUILTIN_DEFINITIONS,
    );
    await expect(result).rejects.toThrow(RunSpecError);
  });

  function getReviewDefinitions(
    task: Partial<TaskDefinitionInput>,
    agent: Partial<AgentDefinitionInput> = {},
  ) {
    const builtinTask = BUILTIN_DEFINITIONS.getTask("builtin:review-pr")!;
    const builtinAgent = BUILTIN_DEFINITIONS.getAgent("builtin:reviewer")!;
    const t = TaskDefinition.parse({ ...builtinTask, ...task });
    const a = AgentDefinition.parse({ ...builtinAgent, ...agent });
    return {
      getTask: (id: string) => (id === t.id ? t : null),
      getAgent: (id: string) => (id === a.id ? a : null),
    };
  }
});

describe("runSpecJobInput", () => {
  it("routes the job by its task and stores the run payload", () => {
    const task = TaskDefinition.parse(taskInput);
    expect(runSpecJobInput(task, payload)).toEqual({
      taskType: "query",
      pool: "short",
      taskId: "builtin:reply-to-finding",
      payload,
      repositoryId: REPO_ID,
      minHarnessVersion: QUERY_TASKS_MIN_HARNESS_VERSION,
    });
  });

  it("requires a harness with the review lifecycle for review tasks", () => {
    const task = TaskDefinition.parse({ ...taskInput, taskType: "review" });
    expect(runSpecJobInput(task, payload).minHarnessVersion).toBe(REVIEW_TASKS_MIN_HARNESS_VERSION);
  });

  it("sets no minimum harness version for coding tasks", () => {
    const task = TaskDefinition.parse({ ...taskInput, taskType: "coding", pool: "long" });
    expect(runSpecJobInput(task, payload).minHarnessVersion).toBeNull();
  });

  it("requires a harness that runs setup and teardown commands when the task has any", () => {
    const setup = TaskDefinition.parse({
      ...taskInput,
      setupCommands: [{ name: "lint", command: "semgrep --json ." }],
    });
    expect(runSpecJobInput(setup, payload).minHarnessVersion).toBe(
      SETUP_COMMANDS_MIN_HARNESS_VERSION,
    );
    const teardown = TaskDefinition.parse({
      ...taskInput,
      taskType: "review",
      teardownCommands: [{ command: "rm -rf .cache" }],
    });
    expect(runSpecJobInput(teardown, payload).minHarnessVersion).toBe(
      SETUP_COMMANDS_MIN_HARNESS_VERSION,
    );
  });
});
