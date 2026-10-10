import { describe, expect, it } from "vitest";
import { FakeLinearGateway } from "./fake-gateway";

describe("FakeLinearGateway triage methods", () => {
  it("updates title, description and priority, reflected in getIssue", async () => {
    const linear = new FakeLinearGateway();
    const issue = linear.add({ title: "Rough", description: "one line", priority: 0 });

    await linear.updateIssue(issue.id, { title: "PRD", description: "## Introduction" });
    await linear.updateIssue(issue.identifier, { priority: 2 });

    expect(await linear.getIssue(issue.id)).toMatchObject({
      title: "PRD",
      description: "## Introduction",
      priority: 2,
    });
    expect(linear.issueUpdates).toEqual([
      { issueId: issue.id, input: { title: "PRD", description: "## Introduction" } },
      { issueId: issue.identifier, input: { priority: 2 } },
    ]);
  });

  it("adds labels by ID without duplicates and removes one, reflected in getIssue", async () => {
    const linear = new FakeLinearGateway();
    const triage = await linear.createLabel("team-1", "ralph:triage");
    const backend = await linear.createLabel("team-1", "backend");
    const issue = linear.add({ title: "T", labels: ["Backend"] });

    await linear.addIssueLabels(issue.id, [triage.id, backend.id]);
    expect((await linear.getIssue(issue.id)).labels).toEqual(["Backend", "ralph:triage"]);

    await linear.removeIssueLabel(issue.id, triage.id);
    expect((await linear.getIssue(issue.id)).labels).toEqual(["Backend"]);
    expect(linear.labelChanges).toEqual([
      { issueId: issue.id, added: [triage.id, backend.id] },
      { issueId: issue.id, removed: [triage.id] },
    ]);
  });

  it("opens agent sessions on issues with distinct IDs", async () => {
    const linear = new FakeLinearGateway();
    const issue = linear.add({ title: "T" });

    const first = await linear.createAgentSessionOnIssue(issue.identifier);
    const second = await linear.createAgentSessionOnIssue(issue.id);

    expect(first).not.toBe(second);
    expect(linear.sessionsCreated).toEqual([
      { issueId: issue.id, sessionId: first },
      { issueId: issue.id, sessionId: second },
    ]);
  });

  it("fails each new method on demand", async () => {
    const linear = new FakeLinearGateway();
    const issue = linear.add({ title: "T" });
    for (const method of [
      "updateIssue",
      "addIssueLabels",
      "removeIssueLabel",
      "createAgentSessionOnIssue",
    ]) {
      linear.failures.set(method, new Error(`${method} down`));
    }
    await expect(linear.updateIssue(issue.id, { title: "X" })).rejects.toThrow("updateIssue down");
    await expect(linear.addIssueLabels(issue.id, ["l"])).rejects.toThrow("addIssueLabels down");
    await expect(linear.removeIssueLabel(issue.id, "l")).rejects.toThrow("removeIssueLabel down");
    await expect(linear.createAgentSessionOnIssue(issue.id)).rejects.toThrow(
      "createAgentSessionOnIssue down",
    );
    expect((await linear.getIssue(issue.id)).title).toBe("T");
  });
});
