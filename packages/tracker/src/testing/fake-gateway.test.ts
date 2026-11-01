import { describe, expect, it } from "vitest";
import { hasCapability, requireCapability, trackerCapabilities } from "../capabilities.js";
import {
  TrackerCapabilityError,
  TrackerInvalidInputError,
  TrackerNotFoundError,
  type TrackerGateway,
} from "../types.js";
import { FakeTrackerGateway, NO_CAPABILITIES } from "./fake-gateway.js";

const variants = [
  { name: "with every capability", make: () => new FakeTrackerGateway() },
  {
    name: "with no optional capability",
    make: () => new FakeTrackerGateway({ capabilities: NO_CAPABILITIES }),
  },
];

describe.each(variants)("FakeTrackerGateway core operations $name", ({ make }) => {
  it("finds an issue by ID or identifier, ignoring the identifier's case", async () => {
    const fake = make();
    const issue = fake.add({ title: "Build it" });
    expect((await fake.getIssue(issue.id)).title).toBe("Build it");
    expect((await fake.getIssue(issue.identifier.toLowerCase())).id).toBe(issue.id);
    await expect(fake.getIssue("ENG-999")).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it("fills in the state ID, team name and project ID a tracker returns", async () => {
    const fake = make();
    fake.projects = [{ id: "project-1", name: "Launch" }];
    const issue = fake.add({ title: "A", stateType: "started", stateName: "started" });
    fake.add({ id: "b", title: "B", projectName: "Launch" });
    expect(await fake.getIssue(issue.id)).toMatchObject({
      stateId: "state-started",
      teamName: "Engineering",
    });
    expect((await fake.getIssue("b")).projectId).toBe("project-1");
  });

  it("returns copies, so callers can't change the fake's issues", async () => {
    const fake = make();
    const issue = fake.add({ title: "A", labels: ["bug"] });
    const copy = await fake.getIssue(issue.id);
    copy.title = "changed";
    copy.labels.push("feature");
    expect(await fake.getIssue(issue.id)).toMatchObject({ title: "A", labels: ["bug"] });
  });

  it("lists children, comments and blockers", async () => {
    const fake = make();
    const parent = fake.add({ title: "Epic" });
    const child = fake.add({ title: "Story", parentId: parent.id });
    const blocker = fake.add({ title: "First", stateType: "started", stateName: "Doing" });
    await fake.createBlocksRelation(blocker.id, child.id);
    await fake.createBlocksRelation(blocker.id, child.id);
    await fake.addComment(child.identifier, "Hello");

    expect((await fake.getChildren(parent.id)).map((i) => i.id)).toEqual([child.id]);
    expect(await fake.getBlockers(child.id)).toEqual([
      {
        id: blocker.id,
        identifier: blocker.identifier,
        title: "First",
        stateType: "started",
        stateName: "Doing",
      },
    ]);
    expect(await fake.getComments(child.id)).toEqual([
      expect.objectContaining({ body: "Hello", author: "Omniralph" }),
    ]);
  });

  it("searches identifiers, titles and descriptions, up to `first` results", async () => {
    const fake = make();
    fake.add({ title: "Fix login" });
    fake.add({ title: "Other", description: "The LOGIN page" });
    fake.add({ title: "Unrelated" });
    expect((await fake.searchIssues("login")).map((i) => i.title)).toEqual(["Fix login", "Other"]);
    expect(await fake.searchIssues("login", { first: 1 })).toHaveLength(1);
  });

  it("lists issues matching every filter condition, page by page", async () => {
    const fake = make();
    fake.labels = [{ id: "label-bug", name: "Bug", teamId: null }];
    fake.add({ title: "A", labels: ["bug"], stateType: "started" });
    fake.add({ title: "B", labels: ["bug"], stateType: "completed" });
    fake.add({ title: "C", labels: ["bug"], stateType: "started" });
    fake.add({ title: "D", stateType: "started" });

    const first = await fake.listIssues({
      labelIds: ["label-bug"],
      stateTypes: ["started"],
      first: 1,
    });
    expect(first.issues.map((i) => i.title)).toEqual(["A"]);
    const second = await fake.listIssues({
      labelNames: ["BUG"],
      stateTypes: ["started"],
      first: 1,
      after: first.endCursor,
    });
    expect(second).toMatchObject({ issues: [{ title: "C", blockers: [] }], endCursor: null });
  });

  it("matches states by type outside excepted teams, or by ID", async () => {
    const fake = make();
    fake.teams.push({ id: "team-2", key: "OPS", name: "Ops" });
    fake.add({ title: "A", stateType: "unstarted" });
    fake.add({ title: "B", teamId: "team-2", teamKey: "OPS", stateType: "unstarted" });
    fake.add({ title: "C", teamId: "team-2", teamKey: "OPS", stateId: "ops-ready" });
    const page = await fake.listIssues({
      stateMatch: { types: ["unstarted"], typesExceptTeamIds: ["team-2"], ids: ["ops-ready"] },
      first: 10,
    });
    expect(page.issues.map((i) => i.title)).toEqual(["A", "C"]);
  });

  it("finds a team label before a workspace one and refuses a taken name", async () => {
    const fake = make();
    fake.labels = [
      { id: "ws", name: "Ralph", teamId: null },
      { id: "team", name: "ralph", teamId: "team-1" },
    ];
    expect((await fake.findLabel("team-1", "RALPH"))?.id).toBe("team");
    expect((await fake.findLabel("team-2", "ralph"))?.id).toBe("ws");
    expect(await fake.findLabel("team-1", "missing")).toBeNull();
    await expect(fake.createLabel("team-2", "Ralph")).rejects.toBeInstanceOf(
      TrackerInvalidInputError,
    );
    const created = await fake.createLabel("team-1", "New");
    expect(await fake.listLabels()).toContainEqual(created);
  });

  it("creates an issue in the team and project, creating labels it lacks", async () => {
    const fake = make();
    fake.projects = [{ id: "project-1", name: "Launch" }];
    const parent = fake.add({ title: "Epic" });
    const issue = await fake.createIssue({
      teamId: "team-1",
      title: "Story",
      description: "Do it",
      parentId: parent.id,
      projectName: "launch",
      labels: ["ralph"],
      priority: 2,
    });
    expect(issue).toMatchObject({
      teamKey: "ENG",
      parentId: parent.id,
      projectId: "project-1",
      projectName: "Launch",
      labels: ["ralph"],
      priority: 2,
    });
    expect(await fake.findLabel("team-1", "ralph")).not.toBeNull();
    await expect(
      fake.createIssue({ teamId: "nope", title: "X", description: "" }),
    ).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it("updates only the given fields, moving `updatedAt` on only when something changed", async () => {
    const fake = make();
    const issue = fake.add({ title: "A", description: "old" });
    await fake.updateIssue(issue.id, {});
    expect((await fake.getIssue(issue.id)).updatedAt).toBe(issue.updatedAt);
    await fake.updateIssue(issue.id, { title: "B" });
    const updated = await fake.getIssue(issue.id);
    expect(updated).toMatchObject({ title: "B", description: "old" });
    expect(updated.updatedAt! > issue.updatedAt!).toBe(true);
  });

  it("moves an issue to the state of the ID, else the name, else the type", async () => {
    const fake = make();
    fake.workflowStates.push({ id: "review", name: "In Review", type: "started", position: 9 });
    const issue = fake.add({ title: "A" });
    await fake.setIssueState(issue.id, { id: "missing", name: "in review", type: "completed" });
    expect(await fake.getIssue(issue.id)).toMatchObject({
      stateId: "review",
      stateType: "started",
    });
    await fake.setIssueState(issue.id, { type: "completed" });
    expect(await fake.getIssue(issue.id)).toMatchObject({ stateId: "state-completed" });
    await fake.setIssueState(issue.id, { name: "nowhere" });
    expect((await fake.getIssue(issue.id)).stateId).toBe("state-completed");
  });

  it("adds labels by ID without duplicates and removes them", async () => {
    const fake = make();
    fake.labels = [{ id: "label-1", name: "ralph", teamId: null }];
    const issue = fake.add({ title: "A", labels: ["bug"] });
    await fake.addIssueLabels(issue.id, ["label-1", "label-1"]);
    expect((await fake.getIssue(issue.id)).labels).toEqual(["bug", "ralph"]);
    await fake.removeIssueLabel(issue.id, "label-1");
    expect((await fake.getIssue(issue.id)).labels).toEqual(["bug"]);
  });

  it("updates the link of a URL linked again", async () => {
    const fake = make();
    const issue = fake.add({ title: "A" });
    await fake.linkUrl(issue.id, "https://example.test/pr/1", "PR");
    await fake.linkUrl(issue.id, "https://example.test/pr/1", "PR #1");
    expect(fake.links).toEqual([
      { issueId: issue.id, url: "https://example.test/pr/1", title: "PR #1" },
    ]);
  });

  it("fails the methods a test asks it to", async () => {
    const fake = make();
    fake.failures.set("listTeams", new Error("down"));
    await expect(fake.listTeams()).rejects.toThrow("down");
    expect(await fake.getViewer()).toEqual(fake.viewer);
  });
});

describe("FakeTrackerGateway optional capabilities", () => {
  it("has every capability by default and none with NO_CAPABILITIES", () => {
    expect(Object.values(trackerCapabilities(new FakeTrackerGateway()))).not.toContain(false);
    const bare = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
    expect(Object.values(trackerCapabilities(bare))).not.toContain(true);
  });

  it("switches each capability off on its own", () => {
    const fake = new FakeTrackerGateway({ capabilities: { documents: false } });
    expect(trackerCapabilities(fake)).toEqual({
      sessions: true,
      delegation: true,
      documents: false,
      uploads: true,
    });
  });

  it("records a session's activities and plans", async () => {
    const fake = new FakeTrackerGateway();
    const issue = fake.add({ title: "A" });
    const sessions = requireCapability(fake, "sessions");
    const sessionId = await sessions.createSessionOnIssue(issue.identifier);
    await sessions.createActivity(sessionId, { type: "thought", body: "Thinking" });
    await sessions.createActivity(
      sessionId,
      { type: "response", body: "Done" },
      { ephemeral: false },
    );
    await sessions.updatePlan(sessionId, [{ content: "Step", status: "inProgress" }]);
    await sessions.updatePlan(sessionId, [{ content: "Step", status: "completed" }]);
    await sessions.addExternalUrl(sessionId, "Run", "https://example.test/run");

    expect(fake.sessionsCreated).toEqual([{ issueId: issue.id, sessionId }]);
    expect(fake.bodies(sessionId, "thought")).toEqual(["Thinking"]);
    expect(fake.plan(sessionId)).toEqual([{ content: "Step", status: "completed" }]);
    await expect(
      sessions.createActivity("session-unknown", { type: "thought", body: "x" }),
    ).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it("delegates issues and filters by delegate", async () => {
    const fake = new FakeTrackerGateway();
    const a = fake.add({ title: "A" });
    const b = await fake.createIssue({
      teamId: "team-1",
      title: "B",
      description: "",
      delegateId: "app-user",
    });
    await requireCapability(fake, "delegation").delegateIssue(a.id, "app-user");
    await requireCapability(fake, "delegation").delegateIssue(a.id, null);

    expect((await fake.getIssue(b.id)).delegateId).toBe("app-user");
    expect((await fake.getIssue(a.id)).delegateId).toBeUndefined();
    const delegated = await fake.listIssues({ delegateId: "app-user", first: 10 });
    expect(delegated.issues.map((i) => i.id)).toEqual([b.id]);
    const others = await fake.listIssues({ notDelegateId: "app-user", first: 10 });
    expect(others.issues.map((i) => i.id)).toEqual([a.id]);
  });

  it("finds documents by ID or slug", async () => {
    const fake = new FakeTrackerGateway();
    fake.documentsById.set("doc-1", {
      id: "doc-1",
      title: "PRD",
      content: "# PRD",
      url: "https://tracker.test/doc/prd-abc123",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const documents = requireCapability(fake, "documents");
    expect((await documents.getDocument("abc123")).title).toBe("PRD");
    await expect(documents.getDocument("missing")).rejects.toBeInstanceOf(TrackerNotFoundError);
  });

  it("downloads what it uploaded and refuses URLs that aren't uploads", async () => {
    const fake = new FakeTrackerGateway();
    const uploads = requireCapability(fake, "uploads");
    const url = await uploads.uploadFile({
      filename: "shot one.png",
      contentType: "image/png",
      data: new TextEncoder().encode("png"),
    });
    expect(uploads.isUploadUrl(url)).toBe(true);
    const download = await uploads.downloadUpload(url);
    expect(download).toMatchObject({
      ok: true,
      status: 200,
      contentType: "image/png",
      contentLength: 3,
    });
    expect(await new Response(download.body).text()).toBe("png");

    const missing = await uploads.downloadUpload(`${url}-gone`);
    expect(missing).toMatchObject({ ok: false, status: 404, body: null });
    expect(uploads.isUploadUrl("https://elsewhere.test/a.png")).toBe(false);
    await expect(uploads.downloadUpload("https://elsewhere.test/a.png")).rejects.toBeInstanceOf(
      TrackerInvalidInputError,
    );
  });

  it("without delegation, rejects inputs that need it", async () => {
    const fake = new FakeTrackerGateway({ capabilities: { delegation: false } });
    await expect(
      fake.createIssue({ teamId: "team-1", title: "A", description: "", delegateId: "app-user" }),
    ).rejects.toBeInstanceOf(TrackerCapabilityError);
    await expect(fake.listIssues({ delegateId: "app-user", first: 10 })).rejects.toBeInstanceOf(
      TrackerCapabilityError,
    );
    expect(fake.issues.size).toBe(0);
  });

  it("without any capability, a caller that checks first falls back to comments", async () => {
    const fake = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
    const issue = fake.add({ title: "A" });
    await report(fake, issue.id, "Working on it");
    expect(fake.comments).toEqual([{ issueId: issue.id, body: "Working on it" }]);
    expect(fake.activities).toEqual([]);

    const full = new FakeTrackerGateway();
    const other = full.add({ title: "B" });
    await report(full, other.id, "Working on it");
    expect(full.comments).toEqual([]);
    expect(full.bodies("session-1", "thought")).toEqual(["Working on it"]);
  });
});

describe("capability checks", () => {
  it("requireCapability names the provider and capability it lacks", () => {
    const fake = new FakeTrackerGateway({ capabilities: { uploads: false } });
    expect(() => requireCapability(fake, "uploads")).toThrow(
      new TrackerCapabilityError("linear", "uploads"),
    );
    expect(() => requireCapability(fake, "sessions")).not.toThrow();
  });
});

/** A caller that posts a session activity when it can and a comment otherwise. */
async function report(gateway: TrackerGateway, issueId: string, body: string): Promise<void> {
  if (hasCapability(gateway, "sessions")) {
    const sessionId = await gateway.sessions.createSessionOnIssue(issueId);
    await gateway.sessions.createActivity(sessionId, { type: "thought", body });
  } else {
    await gateway.addComment(issueId, body);
  }
}
