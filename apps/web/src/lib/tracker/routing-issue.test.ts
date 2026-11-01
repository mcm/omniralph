import { FakeTrackerGateway, NO_CAPABILITIES } from "@omniralph/tracker/testing";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { readRoutingIssue } = await import("./routing-issue");

describe("readRoutingIssue on a tracker without Linear's routing read", () => {
  it("builds the issue's and its parent's fields from the issues", async () => {
    const tracker = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
    const epic = tracker.add({ identifier: "ENG-1", title: "Epic", projectName: "Web" });
    const story = tracker.add({
      identifier: "ENG-2",
      title: "Story",
      parentId: epic.id,
      labels: ["frontend"],
      priority: 1,
      assigneeId: "user-1",
    });

    const { issue, parent } = await readRoutingIssue(tracker, story.identifier);

    expect(issue).toMatchObject({
      id: story.id,
      identifier: "ENG-2",
      team: "ENG",
      teamId: "team-1",
      project: null,
      state: "Todo",
      stateType: "unstarted",
      priority: 1,
      assignee: "user-1",
      labels: ["frontend"],
      parent: "ENG-1",
      parentId: epic.id,
      projectMilestone: null,
      cycle: null,
    });
    expect(parent).toMatchObject({ id: epic.id, project: "Web", parent: null, parentId: null });
  });
});
