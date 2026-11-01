import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  AGENT_TOOLS_BY_TASK_TYPE,
  TRACKER_TOOLS,
  SINK_KINDS,
  TASK_TYPES,
  TRIGGER_KINDS,
} from "./index.js";

describe("vocabularies", () => {
  it("lists the task types, sinks and tools", () => {
    expect(TASK_TYPES).toEqual(["query", "review", "coding"]);
    expect(TRIGGER_KINDS).toHaveLength(13);
    expect(SINK_KINDS).toContain("learned-rule");
    expect(AGENT_TOOLS).toEqual(["post_activity", "ask_permission", "get_attachment", "ship"]);
    expect(TRACKER_TOOLS).toEqual([
      "tracker_get_issue",
      "tracker_list_comments",
      "tracker_search_issues",
      "tracker_get_document",
    ]);
  });

  it("allows ship on coding tasks only", () => {
    expect(AGENT_TOOLS_BY_TASK_TYPE.coding).toContain("ship");
    expect(AGENT_TOOLS_BY_TASK_TYPE.query).not.toContain("ship");
    expect(AGENT_TOOLS_BY_TASK_TYPE.review).not.toContain("ship");
  });
});
