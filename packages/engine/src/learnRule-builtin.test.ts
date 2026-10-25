import { readFileSync } from "node:fs";
import { getBuiltinRunSpec, getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildLearnRulePrompt,
  LEARN_RULE_SYSTEM_PROMPT,
  parseLearnedRuleOutput,
  type LearnRuleFinding,
} from "./learnRule.js";

/** The fixtures `@omniralph/tasks` renders `builtin:learn-rule`'s template with, and its snapshots of the result. */
const TASKS_BUILTIN = new URL("../../tasks/src/builtin/", import.meta.url);
const FIXTURES = JSON.parse(
  readFileSync(new URL("__fixtures__/learn-rule.json", TASKS_BUILTIN), "utf8"),
) as Record<string, { finding: LearnRuleFinding; hunk: string | null; note: string | null }>;

const task = getBuiltinTask("builtin:learn-rule")!;
const agent = getBuiltinRunSpec(task.id)!.agent;

describe("builtin:learn-rule agrees with the rule-generation prompt builders", () => {
  it("has the agent's system prompt + the task's systemAppend = LEARN_RULE_SYSTEM_PROMPT", () => {
    expect(agent.systemPromptMode).toBe("replace");
    expect([agent.systemPrompt, task.systemAppend].join("\n\n")).toBe(LEARN_RULE_SYSTEM_PROMPT);
  });

  it.each(Object.keys(FIXTURES))(
    "renders buildLearnRulePrompt's prompt for the %s fixture",
    (name) => {
      const snapshot = readFileSync(
        new URL(`__snapshots__/learn-rule.${name}.md`, TASKS_BUILTIN),
        "utf8",
      );
      expect(snapshot).toBe(buildLearnRulePrompt(FIXTURES[name]!));
    },
  );

  it("has an output schema accepting what parseLearnedRuleOutput accepts", () => {
    const schema = z.fromJSONSchema(task.outputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    for (const value of [{ rule: "Do not flag X." }, { rule: null }, { rule: "" }]) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(parseLearnedRuleOutput(JSON.stringify(value)).status).not.toBe("rejected");
    }
    for (const value of [{}, { rule: 1 }, { rule: ["x"] }, "x", null]) {
      expect(schema.safeParse(value).success).toBe(false);
      expect(parseLearnedRuleOutput(JSON.stringify(value)).status).toBe("rejected");
    }
  });
});
