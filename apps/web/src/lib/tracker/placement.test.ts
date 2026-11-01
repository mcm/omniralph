import { FakeTrackerGateway, NO_CAPABILITIES } from "@omniralph/tracker/testing";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { describe, expect, it } from "vitest";
import { createIssueWithExtras, readIssuePlacement } from "./placement";

describe("readIssuePlacement", () => {
  it("reads a tracker's issue fields, with no extras", async () => {
    const tracker = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
    tracker.projects = [{ id: "project-1", name: "Web" }];
    const issue = tracker.add({
      title: "Story",
      projectId: "project-1",
      projectName: "Web",
      priority: 2,
      labels: ["backend"],
    });
    expect(await readIssuePlacement(tracker, issue.id)).toEqual({
      teamId: "team-1",
      projectId: "project-1",
      projectName: "Web",
      priority: 2,
      labels: ["backend"],
      extras: {},
    });
  });

  it("carries Linear's milestone and cycle as extras", async () => {
    const linear = new FakeLinearGateway();
    const issue = linear.add({ title: "Story", priority: 3, labels: ["api"] });
    linear.routingFields.set(issue.id, { projectMilestoneId: "milestone-1", cycle: "cycle-1" });
    expect(await readIssuePlacement(linear, issue.id)).toMatchObject({
      teamId: "team-1",
      priority: 3,
      labels: ["api"],
      extras: { projectMilestoneId: "milestone-1", cycleId: "cycle-1" },
    });
  });
});

describe("createIssueWithExtras", () => {
  it("leaves the extras out on a tracker without any", async () => {
    const tracker = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
    const input = { teamId: "team-1", title: "Follow-up", description: "" };
    const { issue, extras } = await createIssueWithExtras(tracker, input, {});
    expect(issue.title).toBe("Follow-up");
    expect(extras).toEqual({});
    expect(tracker.created).toEqual([input]);
  });

  it("files a Linear issue without a cycle Linear refuses, and drops it for later issues", async () => {
    const linear = new FakeLinearGateway();
    linear.closedCycles.add("cycle-done");
    const input = { teamId: "team-1", title: "Follow-up", description: "" };
    const { extras } = await createIssueWithExtras(linear, input, {
      projectMilestoneId: "milestone-1",
      cycleId: "cycle-done",
    });
    expect(extras).toEqual({ projectMilestoneId: "milestone-1" });
    expect(linear.created.at(-1)).toEqual({ ...input, projectMilestoneId: "milestone-1" });
  });
});
