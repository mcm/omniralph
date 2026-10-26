import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  AGENT_TOOLS_BY_TASK_TYPE,
  LINEAR_TOOLS,
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
    expect(LINEAR_TOOLS).toEqual([
      "linear_get_issue",
      "linear_list_comments",
      "linear_search_issues",
      "linear_get_document",
    ]);
  });

  it("allows ship on coding tasks only", () => {
    expect(AGENT_TOOLS_BY_TASK_TYPE.coding).toContain("ship");
    expect(AGENT_TOOLS_BY_TASK_TYPE.query).not.toContain("ship");
    expect(AGENT_TOOLS_BY_TASK_TYPE.review).not.toContain("ship");
  });
});
