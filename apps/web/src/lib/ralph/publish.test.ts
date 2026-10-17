import { describe, expect, it, vi } from "vitest";
import { templatedPullRequest, tickStories } from "./publish";

vi.mock("server-only", () => ({}));

describe("tickStories", () => {
  it("checks the unchecked task lines naming a story, and nothing else", () => {
    const body = [
      "Intro mentioning TOOL-1.",
      "",
      "- [ ] TOOL-1: First",
      "- [ ] TOOL-2: Second",
      "- [x] TOOL-3: Third",
      "* [ ] TOOL-1 in a star list",
      "  - [ ] nested TOOL-1 (indented)",
      "- TOOL-1 not a task",
    ].join("\n");
    expect(tickStories(body, ["TOOL-1", "TOOL-3"])).toBe(
      [
        "Intro mentioning TOOL-1.",
        "",
        "- [x] TOOL-1: First",
        "- [ ] TOOL-2: Second",
        "- [x] TOOL-3: Third",
        "* [ ] TOOL-1 in a star list",
        "  - [x] nested TOOL-1 (indented)",
        "- TOOL-1 not a task",
      ].join("\n"),
    );
  });

  it("doesn't take an identifier for a longer one it prefixes", () => {
    const body =
      "- [ ] TOOL-12: Twelve\n- [ ] TOOL-1: One\n- [ ] XTOOL-1: Other team\n- [ ] TOOL-1-b";
    expect(tickStories(body, ["TOOL-1"])).toBe(
      "- [ ] TOOL-12: Twelve\n- [x] TOOL-1: One\n- [ ] XTOOL-1: Other team\n- [ ] TOOL-1-b",
    );
    expect(tickStories(body, ["TOOL-12"])).toBe(
      "- [x] TOOL-12: Twelve\n- [ ] TOOL-1: One\n- [ ] XTOOL-1: Other team\n- [ ] TOOL-1-b",
    );
  });

  it("keeps an edited body byte for byte, CRLF line endings included", () => {
    const body =
      "## Notes\r\nSomeone wrote this.\r\n\r\n- [ ] Ship [TOOL-7](https://linear.app/x/issue/TOOL-7) and docs\r\n- [ ] TOOL-8\r\n";
    expect(tickStories(body, ["TOOL-7"])).toBe(
      "## Notes\r\nSomeone wrote this.\r\n\r\n- [x] Ship [TOOL-7](https://linear.app/x/issue/TOOL-7) and docs\r\n- [ ] TOOL-8\r\n",
    );
  });

  it("returns the body as it was when nothing changes", () => {
    const body = "- [x] TOOL-1: done\n- [ ] TOOL-2";
    expect(tickStories(body, ["TOOL-1"])).toBe(body);
    expect(tickStories(body, [])).toBe(body);
    expect(tickStories(body, ["TOOL-9"])).toBe(body);
  });

  it("treats identifiers literally", () => {
    expect(tickStories("- [ ] A.B\n- [ ] AxB", ["A.B"])).toBe("- [x] A.B\n- [ ] AxB");
  });

  it("ticks what templatedPullRequest leaves unchecked", () => {
    const { body } = templatedPullRequest(
      { identifier: "TOOL-100", title: "Epic" },
      [
        { identifier: "TOOL-1", title: "One", status: "completed" },
        { identifier: "TOOL-10", title: "Ten", status: "pending" },
        { identifier: "TOOL-11", title: "Eleven", status: "pending" },
      ],
      "github",
    );
    const ticked = tickStories(body, ["TOOL-10"]);
    expect(ticked).toContain("- [x] TOOL-1: One\n- [x] TOOL-10: Ten\n- [ ] TOOL-11: Eleven");
    expect(ticked.replace("- [x] TOOL-10", "- [ ] TOOL-10")).toBe(body);
  });
});
