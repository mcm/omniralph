import { readFileSync } from "node:fs";
import { getBuiltinRunSpec, getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { buildReplyPrompt, REPLY_SYSTEM_PROMPT, type ReplyFinding } from "./reply.js";

/** The fixtures `@omniralph/tasks` renders `builtin:reply-to-finding`'s template with, and its snapshots of the result. */
const TASKS_BUILTIN = new URL("../../tasks/src/builtin/", import.meta.url);
const FIXTURES = JSON.parse(
  readFileSync(new URL("__fixtures__/reply.json", TASKS_BUILTIN), "utf8"),
) as Record<string, { finding: ReplyFinding; hunk: string | null; question: string }>;

const task = getBuiltinTask("builtin:reply-to-finding")!;
const agent = getBuiltinRunSpec(task.id)!.agent;

describe("builtin:reply-to-finding agrees with the thread-reply prompt builders", () => {
  it("has the agent's system prompt + the task's systemAppend = REPLY_SYSTEM_PROMPT", () => {
    expect(agent.systemPromptMode).toBe("replace");
    expect([agent.systemPrompt, task.systemAppend].join("\n\n")).toBe(REPLY_SYSTEM_PROMPT);
  });

  it.each(Object.keys(FIXTURES))("renders buildReplyPrompt's prompt for the %s fixture", (name) => {
    const snapshot = readFileSync(new URL(`__snapshots__/reply.${name}.md`, TASKS_BUILTIN), "utf8");
    expect(snapshot).toBe(buildReplyPrompt(FIXTURES[name]!));
  });
});
