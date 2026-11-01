import { describe, expect, it, vi } from "vitest";
import { chatTools } from "./registry";
import { toAiTools, type ChatToolContext } from "./tools";

vi.mock("server-only", () => ({}));

const context = (trackerName?: string | null): ChatToolContext =>
  ({
    actor: { kind: "member", userId: "ada", role: "member", name: "Ada Lovelace" },
    trackerName,
  }) as unknown as ChatToolContext;

describe("toAiTools", () => {
  it("names the connected tracker in the tracker tools' descriptions", () => {
    const tools = toAiTools(chatTools, context("Acme Tracker"), () => undefined);

    expect(tools.draft_tracker_issue?.description).toContain(
      "Drafts a work item in Acme Tracker, the organization's tracker",
    );
    expect(tools.delegate_tracker_issue?.description).toContain(
      "Delegates an existing work item in Acme Tracker",
    );
    expect(tools.send_ralph_guidance?.description).toContain("also one started from Acme Tracker");
    for (const tool of Object.values(tools)) expect(tool.description).not.toContain("Linear");
  });

  it("says the tracker without a name when none is connected", () => {
    const tools = toAiTools(chatTools, context(null), () => undefined);

    expect(tools.draft_tracker_issue?.description).toContain("Drafts a work item in the tracker");
    expect(tools.list_ralph_runs?.description).toContain("work items in the tracker");
  });
});
