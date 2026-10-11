import { fence as tasksFence } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { fence } from "./prompt.js";

describe("fence agrees with @omniralph/tasks", () => {
  it.each([
    ["no backticks", "plain text", ""],
    ["a 3-backtick run", "a\n```\nb", ""],
    ["a 5-backtick run", "x ````` y `` z", ""],
    ["a trailing newline", "line\n", ""],
    ["an info string", "+added\n-removed", "diff"],
    ["everything", "```js\ncode\n```\n", "markdown"],
    ["empty content", "", ""],
  ])("matches the tasks package's fence() for %s", (_, content, info) => {
    expect(tasksFence(content, info)).toBe(fence(content, info));
  });
});
