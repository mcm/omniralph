import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENTS,
  BUILTIN_TASKS,
  builtinProblems,
  getBuiltinAgent,
  getBuiltinTask,
  type AgentDefinitionInput,
  type TaskDefinitionInput,
} from "./index.js";

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
  promptTemplate: "{{finding.title}}: {{dismissal.note}}",
  sink: "learned-rule",
  pool: "short",
};

describe("the built-in registry", () => {
  it("has no problems: every built-in parses, has a builtin: ID, fits its agent and has a valid template", () => {
    expect(builtinProblems(BUILTIN_AGENTS, BUILTIN_TASKS)).toEqual([]);
  });

  it("finds every built-in by ID", () => {
    for (const a of BUILTIN_AGENTS) expect(getBuiltinAgent(a.id)).toBe(a);
    for (const t of BUILTIN_TASKS) {
      expect(getBuiltinTask(t.id)).toBe(t);
      expect(getBuiltinAgent(t.agentId)).not.toBeNull();
    }
  });

  it("returns null for unknown IDs", () => {
    expect(getBuiltinAgent("builtin:nope")).toBeNull();
    expect(getBuiltinTask("builtin:nope")).toBeNull();
  });
});

describe("builtinProblems", () => {
  it("accepts a fitting agent and task", () => {
    expect(builtinProblems([agent], [task])).toEqual([]);
  });

  it("reports definitions that don't parse", () => {
    expect(builtinProblems([{ ...agent, taskTypes: [] }], [])).toEqual([
      expect.stringMatching(/^Agent #1 doesn't parse/),
    ]);
    expect(builtinProblems([agent], [{ ...task, sink: "nowhere" }])).toEqual([
      expect.stringMatching(/^Task #1 doesn't parse/),
    ]);
  });

  it("reports IDs that aren't builtin: or are defined twice", () => {
    const uuid = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";
    expect(builtinProblems([{ ...agent, id: uuid }, agent, agent], [])).toEqual([
      `Agent ${uuid} doesn't have a builtin: ID.`,
      "Agent builtin:reviewer is defined twice.",
    ]);
    expect(builtinProblems([agent], [task, task])).toEqual([
      "Task builtin:learn-rule is defined twice.",
    ]);
  });

  it("reports a task on an unknown agent or an agent that doesn't fit", () => {
    expect(builtinProblems([], [task])).toEqual([
      "Task builtin:learn-rule references the unknown agent builtin:reviewer.",
    ]);
    expect(builtinProblems([{ ...agent, taskTypes: ["coding"] }], [task])).toEqual([
      expect.stringMatching(/^Task builtin:learn-rule: Agent builtin:reviewer suits coding tasks/),
    ]);
  });

  it("reports template variables the task's type and triggers don't provide, and parse errors", () => {
    expect(builtinProblems([agent], [{ ...task, promptTemplate: "{{issue.title}}" }])).toEqual([
      "Task builtin:learn-rule template (1:1): unknown variable issue.title",
    ]);
    expect(builtinProblems([agent], [{ ...task, promptTemplate: "{{> partial}}" }])).toEqual([
      expect.stringMatching(/^Task builtin:learn-rule template \(1:1\): /),
    ]);
  });

  it("reports a coding task that may run without an epic but renders one, or can't be timed or described", () => {
    const engineer: AgentDefinitionInput = {
      id: "builtin:coder",
      name: "Coder",
      systemPrompt: "You write code.",
      taskTypes: ["coding"],
    };
    const coding: TaskDefinitionInput = {
      id: "builtin:handle",
      name: "Handle a request",
      taskType: "coding",
      agentId: "builtin:coder",
      triggers: ["linear.mention", "chat.request"],
      promptTemplate: "{{#epic.prd}}{{epic.prd}}{{/epic.prd}} on {{branch}}",
      sink: "ralph-run",
      pool: "long",
      prDescriptionTaskId: "builtin:describe-pr",
    };
    const describer: TaskDefinitionInput = {
      ...task,
      id: "builtin:describe-pr",
      triggers: ["run.invoked"],
      promptTemplate: "Describe {{branch}}.",
      sink: "run-result",
    };
    expect(builtinProblems([agent, engineer], [coding, describer])).toEqual([]);
    expect(
      builtinProblems(
        [agent, engineer],
        [
          {
            ...coding,
            promptTemplate: "{{epic.prd}} on {{branch}}",
            pushTiming: "end",
            draftPullRequest: "early",
            prDescriptionTaskId: "builtin:learn-rule",
          },
          describer,
          task,
        ],
      ),
    ).toEqual([
      expect.stringMatching(/^Task builtin:handle draftPullRequest: An early draft PR needs/),
      "Task builtin:handle prDescriptionTaskId: builtin:learn-rule isn't a query task started by run.invoked.",
      expect.stringMatching(
        /^Task builtin:handle promptTemplate: A request \(linear\.mention, chat\.request\) may have no epic or story: put \{\{epic\.prd\}\} in an optional section/,
      ),
    ]);
  });
});
