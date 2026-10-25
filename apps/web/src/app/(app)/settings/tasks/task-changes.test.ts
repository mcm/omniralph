import { describe, expect, it } from "vitest";
import { getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
import { taskChanges, taskDraft, type TaskDraft } from "./task-changes";

const TASK: TaskDefinition = {
  ...getBuiltinTask("builtin:review-pr")!,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Security review",
  agentId: "builtin:reviewer",
  promptTemplate: "Review the change for vulnerabilities.",
  model: "claude-opus-5-5",
  tokenBudget: { tokens: 50_000 },
};

const NAMES = {
  agents: new Map([
    ["builtin:reviewer", "Reviewer"],
    ["11111111-1111-4111-8111-111111111111", "Custom reviewer"],
  ]),
  tasks: new Map([["builtin:describe-pr", "Describe a PR"]]),
};

const saved = taskDraft(TASK);
const changesTo = (change: Partial<TaskDraft>) =>
  taskChanges(saved, { ...saved, ...change }, NAMES);

describe("taskChanges", () => {
  it("has none for the saved task", () => {
    expect(taskChanges(saved, taskDraft(TASK), NAMES)).toEqual([]);
  });

  it("ignores whitespace the save trims", () => {
    expect(changesTo({ name: " Security review ", model: "claude-opus-5-5 " })).toEqual([]);
    expect(changesTo({ requiredInstallables: [...saved.requiredInstallables] })).toEqual([]);
  });

  it("lists each changed setting old → new, in form order, agents by name", () => {
    expect(
      changesTo({
        agentId: "11111111-1111-4111-8111-111111111111",
        name: "Security audit",
      }),
    ).toEqual([
      { key: "name", label: "Name", from: "Security review", to: "Security audit" },
      { key: "agentId", label: "Agent", from: "Reviewer", to: "Custom reviewer" },
    ]);
  });

  it("words the token budget and empty values", () => {
    expect(changesTo({ budgetMode: "profileFraction", budgetAmount: "40", model: "" })).toEqual([
      { key: "model", label: "Model override", from: "claude-opus-5-5", to: "Not set" },
      {
        key: "tokenBudget",
        label: "Token budget",
        from: "50,000 tokens",
        to: "40% of the profile budget",
      },
    ]);
    expect(changesTo({ budgetMode: "profile" })).toEqual([
      { key: "tokenBudget", label: "Token budget", from: "50,000 tokens", to: "Profile budget" },
    ]);
  });

  it("keeps a prompt whole and lists commands one per line", () => {
    const [prompt, setup] = changesTo({
      promptTemplate: "Review the change.\nList each vulnerability.",
      setupCommands: [
        {
          name: "diff",
          command: "git diff",
          timeoutSeconds: "60",
          maxOutputBytes: "",
          fence: "diff",
          optional: true,
        },
      ],
    });
    expect(prompt).toEqual({
      key: "promptTemplate",
      label: "Prompt template",
      from: "Review the change for vulnerabilities.",
      to: "Review the change.\nList each vulnerability.",
    });
    expect(setup).toEqual({
      key: "setupCommands",
      label: "Setup commands",
      from: "Not set",
      to: "diff: git diff (timeout 60s, fence diff, optional)",
    });
  });

  it("shows a coding task's limits and timing, with an empty limit as its default", () => {
    const coding = taskDraft({ ...TASK, taskType: "coding", maxAttemptsPerStory: 5 });
    const changes = taskChanges(
      coding,
      {
        ...coding,
        coding: { ...coding.coding, maxAttemptsPerStory: "", pushTiming: "end" },
      },
      NAMES,
    );
    expect(changes).toEqual([
      { key: "pushTiming", label: "Push", from: "After each story", to: "Once at the end" },
      { key: "maxAttemptsPerStory", label: "Attempts per story", from: "5", to: "Default (3)" },
    ]);
  });

  it("doesn't count the settings of other task types", () => {
    // A review task's (hidden) output schema and coding settings aren't saved.
    expect(changesTo({ outputSchema: '{"type":"object"}' })).toEqual([]);
    expect(changesTo({ coding: { ...saved.coding, pushTiming: "end" } })).toEqual([]);
  });
});
