import {
  getBuiltinRunSpec,
  getBuiltinTask,
  playbookRunSpec,
  RunSpecAgent,
  TaskDefinition,
  type TaskDefinitionInput,
} from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { customPlaybook, customTaskRole } from "./custom-playbooks";

const TASK_ID = "0b6f7a0e-8a3d-4e43-9a51-2a8c55a1f6e2";
const AGENT_ID = "6f1c0f4e-1d2b-4c1a-9a55-3b7f2f3c9d10";

/** A custom copy of built-in task `id`, with `overrides`. */
function custom(id: string, overrides: Partial<TaskDefinitionInput> = {}): TaskDefinition {
  return TaskDefinition.parse({ ...getBuiltinTask(id)!, id: TASK_ID, ...overrides });
}

const agent = RunSpecAgent.parse({
  id: AGENT_ID,
  name: "Security reviewer",
  systemPrompt: "You look for leaks.",
  systemPromptMode: "replace",
  tools: { builtin: ["Read"], mcpServers: ["@omniralph/code-graph:graph"] },
  model: "claude-haiku-5-5",
  fallbackModel: "claude-sonnet-5-5",
});

describe("customTaskRole", () => {
  it("is the role its task type, sink, triggers and output fit", () => {
    expect(customTaskRole(custom("builtin:review-pr"))).toBe("review");
    expect(customTaskRole(custom("builtin:summarize-pr"))).toBe("review-summary");
    expect(customTaskRole(custom("builtin:correlate-findings"))).toBe("correlation");
    expect(customTaskRole(custom("builtin:describe-pr"))).toBe("pr-description");
    expect(customTaskRole(custom("builtin:ask-about-code"))).toBe("chat-ask");
    expect(customTaskRole(custom("builtin:implement-story"))).toBe("story");
    expect(customTaskRole(custom("builtin:handle-request"))).toBe("request");
  });

  it("is null for a built-in-only role or a task that fits none", () => {
    expect(customTaskRole(custom("builtin:triage"))).toBeNull();
    expect(customTaskRole(custom("builtin:learn-rule"))).toBeNull();
    expect(customTaskRole(custom("builtin:reply-to-finding"))).toBeNull();
    // A run-result query task whose output is neither a correlation's nor a PR description's.
    expect(customTaskRole(custom("builtin:describe-pr", { outputSchema: undefined }))).toBeNull();
    // A coding task that takes some request triggers but not the story trigger.
    expect(
      customTaskRole(custom("builtin:handle-request", { triggers: ["chat.request"] })),
    ).toBeNull();
  });
});

describe("customPlaybook", () => {
  it("is the agent's persona with the task's prompt and settings, under the task's ID and name", () => {
    const task = custom("builtin:ask-about-code", { name: "Explain", model: undefined });
    const playbook = customPlaybook(task, agent)!;
    expect(playbook).toMatchObject({
      id: TASK_ID,
      name: "Explain",
      role: "chat-ask",
      systemPrompt: "You look for leaks.",
      systemPromptMode: "replace",
      promptTemplate: task.promptTemplate,
      systemAppend: task.systemAppend,
      tools: { builtin: ["Read"], mcpServers: ["@omniralph/code-graph:graph"] },
      model: "claude-haiku-5-5",
      fallbackModel: "claude-sonnet-5-5",
      tokenBudget: { tokens: 50_000 },
      maxTurns: 30,
    });
    // The task's model wins over the agent's.
    expect(customPlaybook(custom("builtin:ask-about-code"), agent)?.model).toBe(
      "claude-sonnet-5-5",
    );
  });

  it("runs like the task on the agent did", () => {
    const task = custom("builtin:implement-story", { maxAttemptsPerStory: 2 });
    const { agent: runAgent, task: runTask } = playbookRunSpec(customPlaybook(task, agent)!);
    expect(runAgent).toMatchObject({ systemPrompt: agent.systemPrompt, tools: agent.tools });
    expect(runTask).toMatchObject({
      taskType: "coding",
      triggers: ["linear.delegated"],
      sink: "ralph-run",
      promptTemplate: task.promptTemplate,
      maxAttemptsPerStory: 2,
      prDescriptionTaskId: "builtin:describe-pr",
    });
  });

  it("leaves a review playbook's model to the review depth", () => {
    expect(customPlaybook(custom("builtin:review-pr"), agent)?.model).toBeNull();
  });

  it("is null when the pair doesn't make a valid playbook", () => {
    const freeText = RunSpecAgent.parse({ ...agent, tools: { mcpServers: ["github"] } });
    expect(customPlaybook(custom("builtin:review-pr"), freeText)).toBeNull();
    const reviewer = getBuiltinRunSpec("builtin:review-pr")!.agent;
    expect(customPlaybook(custom("builtin:triage"), reviewer)).toBeNull();
  });
});
