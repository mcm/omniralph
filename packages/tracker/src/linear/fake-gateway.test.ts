import { describe, expect, it } from "vitest";
import { FakeLinearGateway } from "./fake-gateway.js";

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

    const first = await linear.sessions.createSessionOnIssue(issue.identifier);
    const second = await linear.sessions.createSessionOnIssue(issue.id);

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
      "createSessionOnIssue",
    ]) {
      linear.failures.set(method, new Error(`${method} down`));
    }
    await expect(linear.updateIssue(issue.id, { title: "X" })).rejects.toThrow("updateIssue down");
    await expect(linear.addIssueLabels(issue.id, ["l"])).rejects.toThrow("addIssueLabels down");
    await expect(linear.removeIssueLabel(issue.id, "l")).rejects.toThrow("removeIssueLabel down");
    await expect(linear.sessions.createSessionOnIssue(issue.id)).rejects.toThrow(
      "createSessionOnIssue down",
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

    await linear.delegation.delegateIssue(existing.identifier, "app-user");
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
    await expect(linear.delegation.delegateIssue(issue.id, "app-user")).rejects.toThrow(
      "delegateIssue down",
    );
    expect(linear.delegations).toEqual([]);
  });

  it("rejects delegating an unknown issue", async () => {
    await expect(
      new FakeLinearGateway().delegation.delegateIssue("nope", "app-user"),
    ).rejects.toThrow("No issue nope");
  });
});

describe("FakeLinearGateway read tools", () => {
  it("searches issues by identifier, title or description, up to `first`", async () => {
    const linear = new FakeLinearGateway();
    linear.add({ title: "Login page", identifier: "ENG-1" });
    linear.add({ title: "Billing", description: "the LOGIN flow", identifier: "ENG-2" });
    linear.add({ title: "Other", identifier: "ENG-3" });

    expect((await linear.searchIssues("login")).map((i) => i.identifier)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
    expect((await linear.searchIssues("login", { first: 1 })).map((i) => i.identifier)).toEqual([
      "ENG-1",
    ]);
    expect(linear.searches).toEqual([{ query: "login" }, { query: "login", first: 1 }]);
  });

  it("reads a document by ID or slug ID, and throws for an unknown one", async () => {
    const linear = new FakeLinearGateway();
    const document = {
      id: "doc-1",
      title: "Design",
      content: "# Design",
      url: "https://linear.app/acme/document/design-abc123",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    linear.documentsById.set(document.id, document);

    expect(await linear.documents.getDocument("doc-1")).toEqual(document);
    expect(await linear.documents.getDocument("abc123")).toEqual(document);
    await expect(linear.documents.getDocument("nope")).rejects.toThrow(/No document/);
  });
});

describe("FakeLinearGateway lists", () => {
  it("reads every page of labels and projects", async () => {
    const linear = new FakeLinearGateway();
    linear.pageSize = 2;
    linear.labels = ["a", "b", "c", "d", "e"].map((name, i) => ({
      id: `l${i}`,
      name,
      teamId: i % 2 ? "team-1" : null,
    }));
    linear.projects = [
      { id: "p1", name: "One" },
      { id: "p2", name: "Two" },
    ];

    expect((await linear.listLabels()).map((l) => l.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(await linear.listProjects()).toEqual(linear.projects);
    expect(linear.pageRequests).toEqual([
      { method: "listLabels", after: 0 },
      { method: "listLabels", after: 2 },
      { method: "listLabels", after: 4 },
      { method: "listProjects", after: 0 },
    ]);
  });

  it("reads one empty page when there is nothing", async () => {
    const linear = new FakeLinearGateway();
    expect(await linear.listProjects()).toEqual([]);
    expect(linear.pageRequests).toEqual([{ method: "listProjects", after: 0 }]);
  });

  it("fails each list on demand", async () => {
    const linear = new FakeLinearGateway();
    for (const method of ["listLabels", "listProjects"] as const) {
      linear.failures.set(method, new Error(method));
      await expect(linear[method]()).rejects.toThrow(method);
    }
  });
});
