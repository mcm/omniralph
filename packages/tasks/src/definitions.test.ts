import { describe, expect, it } from "vitest";
import {
  AgentDefinition,
  CODING_DEFAULTS,
  CODING_MAX_FIX_ROUNDS,
  DEFAULT_COMMAND_OUTPUT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_TIMEOUT_SECONDS,
  TaskDefinition,
  validateAgentForTask,
  type AgentDefinitionInput,
  type TaskDefinitionInput,
} from "./index.js";

const UUID = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";

const agent: AgentDefinitionInput = {
  id: "builtin:reviewer",
  name: "Reviewer",
  systemPrompt: "You review code.",
  taskTypes: ["query"],
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
  pool: "short",
  tokenBudget: { tokens: 5000 },
};

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
}

describe("AgentDefinition", () => {
  it("fills defaults", () => {
    const parsed = AgentDefinition.parse(agent);
    expect(parsed).toEqual({
      ...agent,
      description: "",
      systemPromptMode: "append",
      tools: { builtin: [], harness: [], linear: [], mcpServers: [] },
      skills: [],
      referenceDocs: [],
      model: null,
      fallbackModel: null,
    });
  });

  it("accepts a full definition", () => {
    const full = {
      ...agent,
      id: UUID,
      description: "Answers questions about findings.",
      systemPromptMode: "replace",
      tools: {
        builtin: ["Read", "Grep", "Glob"],
        harness: ["post_activity"],
        linear: ["linear_get_issue"],
        mcpServers: ["code-graph"],
      },
      skills: [{ name: "review", content: "# Review" }],
      referenceDocs: [{ name: "rubric", content: "Be precise." }],
      model: "claude-opus-5-5",
      fallbackModel: "claude-sonnet-5-5",
      taskTypes: ["query", "review"],
    } as const;
    expect(AgentDefinition.parse(full)).toEqual(full);
  });

  it("rejects bad definitions", () => {
    expect(issues(AgentDefinition.safeParse({ ...agent, taskTypes: [] }))).toEqual(["taskTypes"]);
    expect(issues(AgentDefinition.safeParse({ ...agent, taskTypes: ["deploy"] }))).toEqual([
      "taskTypes.0",
    ]);
    expect(issues(AgentDefinition.safeParse({ ...agent, id: "reviewer" }))).toEqual(["id"]);
    expect(issues(AgentDefinition.safeParse({ ...agent, systemPromptMode: "prepend" }))).toEqual([
      "systemPromptMode",
    ]);
    expect(
      issues(AgentDefinition.safeParse({ ...agent, tools: { harness: ["delete_repo"] } })),
    ).toEqual(["tools.harness.0"]);
    expect(
      issues(AgentDefinition.safeParse({ ...agent, tools: { linear: ["linear_save_issue"] } })),
    ).toEqual(["tools.linear.0"]);
    expect(issues(AgentDefinition.safeParse({ ...agent, skills: [{ name: "x" }] }))).toEqual([
      "skills.0.content",
    ]);
  });
});

describe("TaskDefinition", () => {
  it("fills defaults", () => {
    const parsed = TaskDefinition.parse(task);
    expect(parsed).toMatchObject({
      description: "",
      setupCommands: [],
      teardownCommands: [],
      toolSettings: { shell: false, linearRead: false, network: false },
      tokenBudget: { tokens: 5000 },
    });
    expect(parsed.systemAppend).toBeUndefined();
    expect(parsed.maxTurns).toBeUndefined();
    expect(TaskDefinition.parse({ ...task, tokenBudget: undefined }).tokenBudget).toBeNull();
  });

  it("accepts the token budget forms", () => {
    for (const tokenBudget of [
      { tokens: 1 },
      { profileFraction: 0.25 },
      { profileFraction: 1 },
      null,
    ]) {
      expect(TaskDefinition.safeParse({ ...task, tokenBudget }).success).toBe(true);
    }
    for (const tokenBudget of [
      { tokens: 0 },
      { profileFraction: 0 },
      { profileFraction: 1.5 },
      { tokens: 10, profileFraction: 0.5 },
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
      sink: "run-result",
      pool: "long",
      maxTurns: 200,
      idleTimeoutMs: 600_000,
    };

    it("fills their defaults on coding tasks, leaving draftPullRequest unset", () => {
      const parsed = TaskDefinition.parse(coding);
      expect(parsed).toMatchObject({
        maxAttemptsPerStory: 3,
        maxIterationsPerRun: 50,
        maxReviewRounds: CODING_MAX_FIX_ROUNDS,
        maxFixRounds: CODING_MAX_FIX_ROUNDS,
        pushTiming: "per-story",
        prDescriptionTaskId: "builtin:describe-pr",
      });
      expect(parsed).not.toHaveProperty("draftPullRequest");
      expect(CODING_DEFAULTS.maxFixRounds).toBe(20);
    });

    it("keeps the values a coding task sets", () => {
      const set = {
        ...coding,
        maxAttemptsPerStory: 5,
        maxIterationsPerRun: 10,
        maxReviewRounds: 1,
        maxFixRounds: 0,
        pushTiming: "end",
        draftPullRequest: "end",
        prDescriptionTaskId: UUID,
      };
      expect(TaskDefinition.parse(set)).toMatchObject(set);
      // Parsing a parsed task again changes nothing (run specs carry parsed tasks).
      const parsed = TaskDefinition.parse(coding);
      expect(TaskDefinition.parse(parsed)).toEqual(parsed);
    });

    it("rejects them on other task types, and out-of-range values", () => {
      const fields = {
        maxAttemptsPerStory: 3,
        maxIterationsPerRun: 50,
        maxReviewRounds: 2,
        maxFixRounds: 2,
        pushTiming: "per-story",
        draftPullRequest: "early",
        prDescriptionTaskId: "builtin:describe-pr",
      };
      expect(issues(TaskDefinition.safeParse({ ...task, ...fields })).sort()).toEqual(
        Object.keys(fields).sort(),
      );
      expect(TaskDefinition.parse(task)).not.toHaveProperty("pushTiming");
      for (const [field, value] of [
        ["maxAttemptsPerStory", 0],
        ["maxIterationsPerRun", 0],
        ["maxReviewRounds", CODING_MAX_FIX_ROUNDS + 1],
        ["maxFixRounds", -1],
        ["pushTiming", "never"],
        ["draftPullRequest", "late"],
        ["prDescriptionTaskId", "pr"],
      ] as const) {
        expect(issues(TaskDefinition.safeParse({ ...coding, [field]: value }))).toEqual([field]);
      }
    });
  });

  it("rejects unknown triggers, sinks and pools", () => {
    expect(issues(TaskDefinition.safeParse({ ...task, triggers: ["pr.opened"] }))).toEqual([
      "triggers.0",
    ]);
    expect(issues(TaskDefinition.safeParse({ ...task, triggers: [] }))).toEqual(["triggers"]);
    expect(issues(TaskDefinition.safeParse({ ...task, sink: "email" }))).toEqual(["sink"]);
    expect(issues(TaskDefinition.safeParse({ ...task, pool: "medium" }))).toEqual(["pool"]);
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

describe("validateAgentForTask", () => {
  it("accepts an agent that suits the task", () => {
    const parsedAgent = AgentDefinition.parse({
      ...agent,
      tools: { harness: ["post_activity", "get_attachment"] },
    });
    expect(validateAgentForTask(parsedAgent, TaskDefinition.parse(task))).toEqual([]);
  });

  it("reports an agent whose task types don't include the task's", () => {
    const coder = AgentDefinition.parse({ ...agent, taskTypes: ["coding"] });
    expect(validateAgentForTask(coder, TaskDefinition.parse(task))).toEqual([
      "Agent builtin:reviewer suits coding tasks, not query.",
    ]);
  });

  it("reports harness tools the task type doesn't allow", () => {
    const shipper = AgentDefinition.parse({
      ...agent,
      taskTypes: ["query", "coding"],
      tools: { harness: ["post_activity", "ship"] },
    });
    expect(validateAgentForTask(shipper, TaskDefinition.parse(task))).toEqual([
      "query tasks can't use the harness tool ship.",
    ]);
    expect(validateAgentForTask(shipper, { taskType: "coding" })).toEqual([]);
    expect(validateAgentForTask(shipper, { taskType: "review" })).toHaveLength(2);
  });
});
