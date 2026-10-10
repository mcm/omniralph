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

describe("FakeLinearGateway teams and delegation", () => {
  it("lists teams and reads the viewer, as arranged", async () => {
    const linear = new FakeLinearGateway();
    expect(await linear.listTeams()).toEqual([{ id: "team-1", key: "ENG", name: "Engineering" }]);
    expect(await linear.getViewer()).toEqual({ id: "app-user", name: "Omniralph" });

    linear.teams = [{ id: "t2", key: "OPS", name: "Operations" }];
    linear.viewer = { id: "bot", name: "Bot" };
    expect(await linear.listTeams()).toEqual([{ id: "t2", key: "OPS", name: "Operations" }]);
    expect(await linear.getViewer()).toEqual({ id: "bot", name: "Bot" });
  });

  it("records delegations from delegateIssue and createIssue", async () => {
    const linear = new FakeLinearGateway();
    const existing = linear.add({ title: "Existing" });

    await linear.delegateIssue(existing.identifier, "app-user");
    const created = await linear.createIssue({
      teamId: "team-1",
      title: "New",
      description: "",
      delegateId: "app-user",
    });
    await linear.createIssue({ teamId: "team-1", title: "Plain", description: "" });

    expect(linear.delegations).toEqual([
      { issueId: existing.id, delegateId: "app-user" },
      { issueId: created.id, delegateId: "app-user" },
    ]);
  });

  it("fails each on demand", async () => {
    const linear = new FakeLinearGateway();
    const issue = linear.add({ title: "T" });
    for (const method of ["listTeams", "getViewer", "delegateIssue"]) {
      linear.failures.set(method, new Error(`${method} down`));
    }
    await expect(linear.listTeams()).rejects.toThrow("listTeams down");
    await expect(linear.getViewer()).rejects.toThrow("getViewer down");
    await expect(linear.delegateIssue(issue.id, "app-user")).rejects.toThrow("delegateIssue down");
    expect(linear.delegations).toEqual([]);
  });

  it("rejects delegating an unknown issue", async () => {
    await expect(new FakeLinearGateway().delegateIssue("nope", "app-user")).rejects.toThrow(
      "no issue nope",
    );
  });
});
