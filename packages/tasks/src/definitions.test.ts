import { describe, expect, it } from "vitest";
import {
  AgentDefinition,
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

  it("allows describePrTaskId only on coding tasks", () => {
    expect(issues(TaskDefinition.safeParse({ ...task, describePrTaskId: UUID }))).toEqual([
      "describePrTaskId",
    ]);
    const { outputSchema: _, ...rest } = task;
    const coding = {
      ...rest,
      taskType: "coding",
      triggers: ["linear.delegated"],
      sink: "run-result",
      pool: "long",
      describePrTaskId: "builtin:describe-pr",
      maxTurns: 200,
      idleTimeoutMs: 600_000,
    };
    expect(TaskDefinition.safeParse(coding).success).toBe(true);
    expect(issues(TaskDefinition.safeParse({ ...coding, describePrTaskId: "pr" }))).toEqual([
      "describePrTaskId",
    ]);
  });

  it("rejects unknown triggers, sinks and pools", () => {
    expect(issues(TaskDefinition.safeParse({ ...task, triggers: ["pr.opened"] }))).toEqual([
      "triggers.0",
    ]);
    expect(issues(TaskDefinition.safeParse({ ...task, triggers: [] }))).toEqual(["triggers"]);
    expect(issues(TaskDefinition.safeParse({ ...task, sink: "email" }))).toEqual(["sink"]);
    expect(issues(TaskDefinition.safeParse({ ...task, pool: "medium" }))).toEqual(["pool"]);
  });

  it("rejects setup commands for now", () => {
    expect(issues(TaskDefinition.safeParse({ ...task, setupCommands: ["pnpm i"] }))).toEqual([
      "setupCommands",
    ]);
    expect(issues(TaskDefinition.safeParse({ ...task, teardownCommands: ["rm -rf x"] }))).toEqual([
      "teardownCommands",
    ]);
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
