import { describe, expect, it } from "vitest";
import { selectNextStory, waitingOnFor, withoutOutsideBlockers } from "./selection.js";
import type { Story } from "./types.js";

const story = (key: string, over: Partial<Story> = {}): Story => ({
  key,
  storyId: key,
  issueId: key,
  identifier: key,
  title: `Story ${key}`,
  description: "",
  acceptanceCriteria: [],
  priority: 3,
  dependsOn: [],
  status: "open",
  ...over,
});

describe("waitingOnFor", () => {
  it("lists open outside blockers and manual stories that hold up unfinished stories", () => {
    const stories = [
      story("A", { dependsOn: ["external:x1"] }),
      story("M", { manual: true }),
      story("B", { dependsOn: ["C"] }),
      story("C", { dependsOn: ["M", "external:x2"] }),
      story("D", { status: "completed", dependsOn: ["external:x3"] }),
    ];
    expect(waitingOnFor({ stories, externalIssues: { x1: "EXT-1", x2: "EXT-2" } })).toEqual({
      blockers: [
        { id: "x1", identifier: "EXT-1" },
        { id: "x2", identifier: "EXT-2" },
      ],
      manual: [{ id: "M", identifier: "M" }],
    });
  });

  it("is empty when nothing outside the agent's reach holds the epic up", () => {
    const stories = [story("A"), story("M", { manual: true, status: "completed" })];
    expect(waitingOnFor({ stories })).toEqual({ blockers: [], manual: [] });
  });
});

describe("withoutOutsideBlockers", () => {
  it("drops outside blockers and manual dependencies, keeping the rest", () => {
    const stories = [
      story("M", { manual: true }),
      story("A", { dependsOn: ["M", "external:x", "B"] }),
      story("B", { priority: 4 }),
    ];
    const freed = withoutOutsideBlockers(stories);
    expect(freed[1]!.dependsOn).toEqual(["B"]);
    expect(stories[1]!.dependsOn).toEqual(["M", "external:x", "B"]);
    expect(selectNextStory(freed)?.key).toBe("B");
  });
});
