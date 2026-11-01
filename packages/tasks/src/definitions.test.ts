import { describe, expect, it } from "vitest";
import {
  CODING_DEFAULTS,
  CODING_MAX_FIX_ROUNDS,
  DEFAULT_COMMAND_OUTPUT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_SECONDS,
  RunSpecAgent,
  TaskDefinition,
  agentToolsProblem,
  type RunSpecAgentInput,
  type TaskDefinitionInput,
} from "./index.js";

const UUID = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";

const agent: RunSpecAgentInput = {
  id: "builtin:reviewer",
  name: "Reviewer",
  systemPrompt: "You review code.",
};

const task: TaskDefinitionInput = {
  id: "builtin:learn-rule",
  name: "Learn a rule",
  taskType: "query",
  agentId: "builtin:reviewer",
  triggers: ["finding.dismissed"],
  promptTemplate: "{{finding.title}}",
  outputSchema: { type: "object", properties: { rule: { type: ["string", "null"] } } },
  sink: "learned-rule",
  tokenBudget: { tokens: 5000 },
};

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

describe("RunSpecAgent", () => {
  it("fills defaults", () => {
    const parsed = RunSpecAgent.parse(agent);
    expect(parsed).toEqual({
      ...agent,
      description: "",
      systemPromptMode: "append",
      tools: { builtin: [], agent: [], tracker: [], mcpServers: [] },
      referenceDocs: [],
      model: null,
      fallbackModel: null,
    });
  });

  it("accepts a full agent", () => {
    const full = {
      ...agent,
      id: UUID,
      description: "Answers questions about findings.",
      systemPromptMode: "replace",
      tools: {
        builtin: ["Read", "Grep", "Glob"],
        agent: ["post_activity"],
        tracker: ["tracker_get_issue"],
        mcpServers: ["code-graph"],
      },
      referenceDocs: [{ name: "rubric", content: "Be precise." }],
      model: "claude-opus-5-5",
      fallbackModel: "claude-sonnet-5-5",
    } as const;
    expect(RunSpecAgent.parse(full)).toEqual(full);
  });

  it("passes fields it doesn't know through (the taskTypes older agents require)", () => {
    expect(RunSpecAgent.parse({ ...agent, taskTypes: ["query"] })).toMatchObject({
      taskTypes: ["query"],
    });
  });

  it("accepts an installable's MCP servers as <package>:<server> and rejects malformed ones", () => {
    const tools = (mcpServers: string[]) =>
      RunSpecAgent.safeParse({ ...agent, tools: { mcpServers } });
    expect(tools(["github", "@omniralph/code-graph:graph"]).success).toBe(true);
    expect(issues(tools(["github", "code graph:graph", "pkg:"]))).toEqual([
      "tools.mcpServers.1",
      "tools.mcpServers.2",
    ]);
  });

  it("rejects bad agents", () => {
    expect(issues(RunSpecAgent.safeParse({ ...agent, id: "reviewer" }))).toEqual(["id"]);
    expect(issues(RunSpecAgent.safeParse({ ...agent, systemPromptMode: "prepend" }))).toEqual([
      "systemPromptMode",
    ]);
    expect(issues(RunSpecAgent.safeParse({ ...agent, tools: { agent: ["delete_repo"] } }))).toEqual(
      ["tools.agent.0"],
    );
    expect(
      issues(RunSpecAgent.safeParse({ ...agent, tools: { tracker: ["linear_save_issue"] } })),
    ).toEqual(["tools.tracker.0"]);
  });
});

describe("TaskDefinition", () => {
  it("fills defaults", () => {
    const parsed = TaskDefinition.parse(task);
    expect(parsed).toMatchObject({
      description: "",
      setupCommands: [],
      teardownCommands: [],
      toolSettings: { shell: false, trackerRead: false, network: false },
      tokenBudget: { tokens: 5000 },
    });
    expect(parsed.systemAppend).toBeUndefined();
    expect(parsed.maxTurns).toBeUndefined();
    expect(TaskDefinition.parse({ ...task, tokenBudget: undefined }).tokenBudget).toBeNull();
  });

  it("takes required installables and host tools, checking their names", () => {
    expect(TaskDefinition.parse(task).requires).toBeUndefined();
    expect(
      TaskDefinition.parse({ ...task, requires: { hostTools: ["opengrep"] } }).requires,
    ).toEqual({ installables: [], hostTools: ["opengrep"] });
    expect(
      issues(
        TaskDefinition.safeParse({
          ...task,
          requires: { installables: ["@omniralph/code-graph", "-x"], hostTools: ["Open Grep"] },
        }),
      ),
    ).toEqual(["requires.installables.1", "requires.hostTools.0"]);
  });

  it("accepts a fixed token budget or null (No limit), nothing else", () => {
    for (const tokenBudget of [{ tokens: 1 }, null]) {
      expect(TaskDefinition.safeParse({ ...task, tokenBudget }).success).toBe(true);
    }
    for (const tokenBudget of [
      { tokens: 0 },
      { fraction: 0.25 },
      { tokens: 10, fraction: 0.5 },
      {},
    ]) {
      expect(issues(TaskDefinition.safeParse({ ...task, tokenBudget }))[0]).toMatch(/^tokenBudget/);
    }
  });

  it("allows outputSchema only on query tasks", () => {
    const review = { ...task, taskType: "review", sink: "review", triggers: ["pr.updated"] };
    expect(issues(TaskDefinition.safeParse(review))).toEqual(["outputSchema"]);
    const { outputSchema: _, ...withoutSchema } = review;
    expect(TaskDefinition.safeParse(withoutSchema).success).toBe(true);
  });

  describe("coding-only fields", () => {
    const { outputSchema: _, ...rest } = task;
    const coding = {
      ...rest,
      taskType: "coding",
      triggers: ["linear.delegated"],
      sink: "ralph-run",
      maxTurns: 200,
      idleTimeoutMs: 600_000,
    };

    it("fills their defaults on coding tasks, leaving draftPullRequest unset", () => {
      const parsed = TaskDefinition.parse(coding);
      expect(parsed).toMatchObject({
        maxAttemptsPerStory: 3,
        maxRoundsPerStory: 8,
        stallRounds: 3,
        maxIterationsPerRun: 50,
        maxReviewRounds: 3,
        maxFixRounds: 3,
        pushTiming: "per-story",
        prDescriptionTaskId: "builtin:describe-pr",
        verifyCommands: [],
        worktreeSetupCommand: null,
        runPrdQualityGates: true,
        allowPreparation: true,
        epicCompletedState: null,
        cleanupMergedWorktrees: true,
        unmergedBranchTimeoutMinutes: 60,
      });
      expect(parsed).not.toHaveProperty("draftPullRequest");
      expect(CODING_DEFAULTS.maxFixRounds).toBe(3);
    });

    it("keeps the values a coding task sets", () => {
      const set = {
        ...coding,
        maxAttemptsPerStory: 5,
        maxRoundsPerStory: 12,
        stallRounds: 4,
        maxIterationsPerRun: 10,
        maxReviewRounds: 1,
        maxFixRounds: 0,
        pushTiming: "end",
        draftPullRequest: "end",
        prDescriptionTaskId: UUID,
        verifyCommands: ["pnpm test"],
        worktreeSetupCommand: "pnpm install",
        runPrdQualityGates: false,
        allowPreparation: false,
        epicCompletedState: "In Review",
        cleanupMergedWorktrees: false,
        unmergedBranchTimeoutMinutes: 30,
      };
      expect(TaskDefinition.parse(set)).toMatchObject(set);
      // Parsing a parsed task again changes nothing (run specs carry parsed tasks).
      const parsed = TaskDefinition.parse(coding);
      expect(TaskDefinition.parse(parsed)).toEqual(parsed);
    });

    it("rejects them on other task types, and out-of-range values", () => {
      const fields = {
        maxAttemptsPerStory: 3,
        maxRoundsPerStory: 8,
        stallRounds: 3,
        maxIterationsPerRun: 50,
        maxReviewRounds: 2,
        maxFixRounds: 2,
        pushTiming: "per-story",
        draftPullRequest: "early",
        prDescriptionTaskId: "builtin:describe-pr",
        verifyCommands: ["pnpm test"],
        cleanupMergedWorktrees: true,
      };
      expect(issues(TaskDefinition.safeParse({ ...task, ...fields })).sort()).toEqual(
        Object.keys(fields).sort(),
      );
      expect(TaskDefinition.parse(task)).not.toHaveProperty("pushTiming");
      for (const [field, value] of [
        ["maxAttemptsPerStory", 0],
        ["maxRoundsPerStory", 0],
        ["stallRounds", 0],
        ["maxIterationsPerRun", 0],
        ["maxReviewRounds", CODING_MAX_FIX_ROUNDS + 1],
        ["maxFixRounds", -1],
        ["pushTiming", "never"],
        ["draftPullRequest", "late"],
        ["prDescriptionTaskId", "pr"],
        ["verifyCommands", "pnpm test"],
        ["worktreeSetupCommand", "two\nlines"],
        ["unmergedBranchTimeoutMinutes", 0],
      ] as const) {
        expect(issues(TaskDefinition.safeParse({ ...coding, [field]: value }))).toEqual([field]);
      }
    });
  });

  it("rejects unknown triggers and sinks", () => {
    expect(issues(TaskDefinition.safeParse({ ...task, triggers: ["pr.opened"] }))).toEqual([
      "triggers.0",
    ]);
    expect(issues(TaskDefinition.safeParse({ ...task, triggers: [] }))).toEqual(["triggers"]);
    expect(issues(TaskDefinition.safeParse({ ...task, sink: "email" }))).toEqual(["sink"]);
  });

  it("drops a stored pool: a task's pool follows from its task type", () => {
    expect(TaskDefinition.parse({ ...task, pool: "long" })).not.toHaveProperty("pool");
  });

  it("accepts setup and teardown commands and fills their defaults", () => {
    const parsed = TaskDefinition.parse({
      ...task,
      setupCommands: [
        { name: "semgrep", command: "semgrep --json .", fence: "json", optional: true },
        { name: "code_graph", command: "graph build", timeoutSeconds: 60, maxOutputBytes: 500 },
      ],
      teardownCommands: [{ name: "clean", command: "rm -rf .graph" }],
    });
    expect(parsed.setupCommands).toEqual([
      {
        name: "semgrep",
        command: "semgrep --json .",
        timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
        maxOutputBytes: DEFAULT_COMMAND_OUTPUT_BYTES,
        fence: "json",
        optional: true,
      },
      {
        name: "code_graph",
        command: "graph build",
        timeoutSeconds: 60,
        maxOutputBytes: 500,
        fence: "",
        optional: false,
      },
    ]);
    expect(parsed.teardownCommands).toEqual([
      {
        name: "clean",
        command: "rm -rf .graph",
        timeoutSeconds: DEFAULT_COMMAND_TIMEOUT_SECONDS,
        maxOutputBytes: DEFAULT_COMMAND_OUTPUT_BYTES,
      },
    ]);
  });

  it("rejects bad setup and teardown commands", () => {
    const setup = (command: Record<string, unknown>) =>
      issues(
        TaskDefinition.safeParse({
          ...task,
          setupCommands: [{ name: "x", command: "true", ...command }],
        }),
      );
    expect(setup({ name: "1st" })).toEqual(["setupCommands.0.name"]);
    expect(setup({ name: "a.b" })).toEqual(["setupCommands.0.name"]);
    expect(setup({ name: "Semgrep" })).toEqual(["setupCommands.0.name"]);
    expect(setup({ name: "code-graph" })).toEqual(["setupCommands.0.name"]);
    expect(setup({ name: "_x" })).toEqual(["setupCommands.0.name"]);
    expect(setup({ command: " " })).toEqual(["setupCommands.0.command"]);
    expect(setup({ timeoutSeconds: 0 })).toEqual(["setupCommands.0.timeoutSeconds"]);
    expect(setup({ timeoutSeconds: MAX_COMMAND_TIMEOUT_SECONDS + 1 })).toEqual([
      "setupCommands.0.timeoutSeconds",
    ]);
    expect(setup({ maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES + 1 })).toEqual([
      "setupCommands.0.maxOutputBytes",
    ]);
    expect(setup({ maxOutputBytes: 1.5 })).toEqual(["setupCommands.0.maxOutputBytes"]);
    expect(setup({ optional: "yes" })).toEqual(["setupCommands.0.optional"]);
    expect(setup({ fence: "a b" })).toEqual(["setupCommands.0.fence"]);
    expect(issues(TaskDefinition.safeParse({ ...task, setupCommands: ["pnpm i"] }))).toEqual([
      "setupCommands.0",
    ]);
    expect(
      issues(
        TaskDefinition.safeParse({
          ...task,
          setupCommands: [
            { name: "x", command: "a" },
            { name: "x", command: "b" },
          ],
        }),
      ),
    ).toEqual(["setupCommands.1.name"]);
    expect(issues(TaskDefinition.safeParse({ ...task, teardownCommands: [{}] }))).toEqual([
      "teardownCommands.0.name",
      "teardownCommands.0.command",
    ]);
    expect(
      issues(
        TaskDefinition.safeParse({
          ...task,
          teardownCommands: [{ name: "clean", command: "true", timeoutSeconds: 100_000 }],
        }),
      ),
    ).toEqual(["teardownCommands.0.timeoutSeconds"]);
  });

  it("rejects bad tool settings and limits", () => {
    expect(issues(TaskDefinition.safeParse({ ...task, toolSettings: { shell: "yes" } }))).toEqual([
      "toolSettings.shell",
    ]);
    expect(issues(TaskDefinition.safeParse({ ...task, maxTurns: 0 }))).toEqual(["maxTurns"]);
    expect(issues(TaskDefinition.safeParse({ ...task, idleTimeoutMs: 1.5 }))).toEqual([
      "idleTimeoutMs",
    ]);
    expect(issues(TaskDefinition.safeParse({ ...task, promptTemplate: "" }))).toEqual([
      "promptTemplate",
    ]);
  });
});

describe("agentToolsProblem", () => {
  it("accepts agent tools the task type allows", () => {
    expect(agentToolsProblem({ agent: ["post_activity", "get_attachment"] }, "query")).toBeNull();
    expect(agentToolsProblem({ agent: ["post_activity", "ship"] }, "coding")).toBeNull();
  });

  it("reports agent tools the task type doesn't allow", () => {
    expect(agentToolsProblem({ agent: ["post_activity", "ship"] }, "query")).toBe(
      "query runs can't use the agent tool ship.",
    );
    expect(agentToolsProblem({ agent: ["ship", "ship"] }, "review")).toBe(
      "review runs can't use the agent tools ship, ship.",
    );
  });
});
