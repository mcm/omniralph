import { describe, expect, it } from "vitest";
import { locateTask, parseTaskList, setTaskChecked } from "./task-list";

const DESCRIPTION = [
  "Rotate the staging certificates.",
  "",
  "- [ ] Export the old cert",
  "* [x] Request a new one from **IT**",
  "  - [ ] Nested: confirm the SANs",
  "1. [X] Numbered item",
  "> - [ ] Quoted task",
  "- not a task",
  "- [ ]",
  "```md",
  "- [ ] In a code block",
  "```",
  "+ [ ] Upload it",
].join("\n");

describe("parseTaskList", () => {
  it("finds the tasks in order with their state, text and nesting, skipping fenced code", () => {
    expect(parseTaskList(DESCRIPTION)).toEqual([
      { index: 0, checked: false, text: "Export the old cert", depth: 0 },
      { index: 1, checked: true, text: "Request a new one from **IT**", depth: 0 },
      { index: 2, checked: false, text: "Nested: confirm the SANs", depth: 1 },
      { index: 3, checked: true, text: "Numbered item", depth: 0 },
      { index: 4, checked: false, text: "Quoted task", depth: 0 },
      { index: 5, checked: false, text: "Upload it", depth: 0 },
    ]);
  });

  it("keeps a fence open until one of the same kind and length closes it", () => {
    const text = ["~~~~", "```", "- [ ] still code", "~~~~", "- [ ] real"].join("\n");
    expect(parseTaskList(text).map((task) => task.text)).toEqual(["real"]);
  });
});

describe("setTaskChecked", () => {
  it("changes only the chosen task's mark, keeping every other byte", () => {
    const next = setTaskChecked(DESCRIPTION, 2, true);
    expect(next).toBe(DESCRIPTION.replace("  - [ ] Nested", "  - [x] Nested"));
    expect(setTaskChecked(next, 1, false)).toBe(next.replace("* [x] Request", "* [ ] Request"));
  });

  it("keeps CRLF line endings", () => {
    const text = "intro\r\n- [ ] one\r\n- [ ] two\r\n";
    expect(setTaskChecked(text, 1, true)).toBe("intro\r\n- [ ] one\r\n- [x] two\r\n");
  });

  it("leaves the text alone for an unknown task, or one already in that state", () => {
    expect(setTaskChecked(DESCRIPTION, 99, true)).toBe(DESCRIPTION);
    expect(setTaskChecked(DESCRIPTION, 3, true)).toBe(DESCRIPTION);
  });

  it("never touches a task-like line inside a code block", () => {
    const text = ["```", "- [ ] code", "```", "- [ ] real"].join("\n");
    expect(setTaskChecked(text, 0, true)).toBe(
      ["```", "- [ ] code", "```", "- [x] real"].join("\n"),
    );
  });
});

describe("locateTask", () => {
  const tasks = parseTaskList("- [ ] a\n- [ ] b\n- [ ] c\n- [ ] c");

  it("keeps the position while its text still matches", () => {
    expect(locateTask(tasks, { index: 1, text: "b" })).toBe(1);
  });

  it("follows a task that moved, by its text", () => {
    expect(locateTask(tasks, { index: 0, text: "b" })).toBe(1);
  });

  it("gives up when the text is gone or no longer unique", () => {
    expect(locateTask(tasks, { index: 0, text: "z" })).toBeNull();
    expect(locateTask(tasks, { index: 0, text: "c" })).toBeNull();
  });
});
