import { readFileSync } from "node:fs";
import { getBuiltinAgent, getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { buildChatAskPrompt, CHAT_ASK_SYSTEM_PROMPT } from "./chatAsk.js";

/** The fixtures `@omniralph/tasks` renders `builtin:ask-about-code`'s template with, and its snapshots of the result. */
const TASKS_BUILTIN = new URL("../../tasks/src/builtin/", import.meta.url);
const FIXTURES = JSON.parse(
  readFileSync(new URL("__fixtures__/ask-about-code.json", TASKS_BUILTIN), "utf8"),
) as Record<
  string,
  {
    repository: string;
    branch: string;
    question: string;
    context: string | null;
    conventions: string | null;
  }
>;

const task = getBuiltinTask("builtin:ask-about-code")!;
const agent = getBuiltinAgent(task.agentId)!;

describe("builtin:ask-about-code agrees with the code question prompt builders", () => {
  it("has the agent's system prompt + the task's systemAppend = CHAT_ASK_SYSTEM_PROMPT", () => {
    expect(agent.systemPromptMode).toBe("replace");
    expect([agent.systemPrompt, task.systemAppend].join("\n\n")).toBe(CHAT_ASK_SYSTEM_PROMPT);
  });

  it.each(Object.keys(FIXTURES))(
    "renders buildChatAskPrompt's prompt for the %s fixture",
    (name) => {
      const fixture = FIXTURES[name]!;
      const snapshot = readFileSync(
        new URL(`__snapshots__/ask-about-code.${name}.md`, TASKS_BUILTIN),
        "utf8",
      );
      expect(snapshot).toBe(buildChatAskPrompt(fixture));
    },
  );
});
