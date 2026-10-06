import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SdkLinearGateway, LinearMutationError } = await import("./gateway");

const API = "https://api.linear.app/graphql";

interface GraphQLCall {
  operation: string;
  query: string;
  variables: Record<string, unknown>;
  authorization: string | null;
}

const calls: GraphQLCall[] = [];
let resolvers: Record<string, (variables: Record<string, unknown>) => unknown> = {};

const server = setupServer(
  http.post(API, async ({ request }) => {
    const body = (await request.json()) as { query: string; variables?: Record<string, unknown> };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "?";
    const variables = body.variables ?? {};
    calls.push({
      operation,
      query: body.query,
      variables,
      authorization: request.headers.get("authorization"),
    });
    const resolve = resolvers[operation];
    if (!resolve) return HttpResponse.json({ errors: [{ message: `unexpected ${operation}` }] });
    return HttpResponse.json({ data: resolve(variables) });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  calls.length = 0;
  resolvers = {};
});
afterAll(() => server.close());

const gateway = () => new SdkLinearGateway("lin_oauth_token");

function issueNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    identifier: `TOOL-${id}`,
    title: `Issue ${id}`,
    description: `Body ${id}`,
    url: `https://linear.app/acme/issue/TOOL-${id}`,
    branchName: `steve/tool-${id}`,
    priority: 2,
    subIssueSortOrder: 1.5,
    parent: { id: "epic" },
    assignee: { id: "user-1" },
    team: { id: "team-1", key: "TOOL" },
    state: { name: "Todo", type: "unstarted" },
    labels: { nodes: [{ name: "backend" }] },
    project: { name: "Omniralph" },
    ...overrides,
  };
}

describe("SdkLinearGateway reads", () => {
  it("authenticates with the OAuth token and reads the organization", async () => {
    resolvers.Organization = () => ({ organization: { id: "org-1", name: "Acme" } });
    expect(await gateway().getOrganization()).toEqual({ id: "org-1", name: "Acme" });
    expect(calls[0]?.authorization).toBe("Bearer lin_oauth_token");
  });

  it("reads an issue as a summary in one request", async () => {
    resolvers.Issue = (v) => ({ issue: issueNode(String(v.id)) });
    expect(await gateway().getIssue("42")).toEqual({
      id: "42",
      identifier: "TOOL-42",
      title: "Issue 42",
      description: "Body 42",
      url: "https://linear.app/acme/issue/TOOL-42",
      branchName: "steve/tool-42",
      teamId: "team-1",
      teamKey: "TOOL",
      stateType: "unstarted",
      stateName: "Todo",
      labels: ["backend"],
      priority: 2,
      subIssueSortOrder: 1.5,
      projectName: "Omniralph",
      parentId: "epic",
      assigneeId: "user-1",
    });
    expect(calls).toHaveLength(1);
  });

  it("fills defaults for missing optional fields", async () => {
    resolvers.Issue = () => ({
      issue: issueNode("1", {
        description: null,
        priority: null,
        subIssueSortOrder: null,
        parent: null,
        assignee: null,
        state: null,
        labels: { nodes: [] },
        project: null,
      }),
    });
    const issue = await gateway().getIssue("TOOL-1");
    expect(issue).toMatchObject({
      description: "",
      priority: 0,
      stateType: "unstarted",
      labels: [],
    });
    expect(issue.parentId).toBeUndefined();
    expect(issue.projectName).toBeUndefined();
  });

  it("reads every page of children, deduplicated", async () => {
    resolvers.IssueChildren = (v) =>
      v.after
        ? {
            issue: {
              children: {
                nodes: [issueNode("2"), issueNode("3")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }
        : {
            issue: {
              children: {
                nodes: [issueNode("1"), issueNode("2")],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          };
    const children = await gateway().getChildren("epic");
    expect(children.map((c) => c.id)).toEqual(["1", "2", "3"]);
    expect(calls.map((c) => c.variables)).toEqual([
      { id: "epic", first: 100, after: null },
      { id: "epic", first: 100, after: "cursor-1" },
    ]);
  });

  it("reads comments oldest first", async () => {
    resolvers.IssueComments = () => ({
      issue: {
        comments: {
          nodes: [
            { body: "second", createdAt: "2026-10-02T00:00:00.000Z", user: { name: "Bo" } },
            { body: "first", createdAt: "2026-10-01T00:00:00.000Z", user: null },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    expect(await gateway().getComments("1")).toEqual([
      { body: "first", author: undefined, createdAt: "2026-10-01T00:00:00.000Z" },
      { body: "second", author: "Bo", createdAt: "2026-10-02T00:00:00.000Z" },
    ]);
  });

  it("reads only inverse blocks relations as blockers", async () => {
    resolvers.IssueBlockers = () => ({
      issue: {
        inverseRelations: {
          nodes: [
            {
              type: "blocks",
              issue: { id: "b1", identifier: "TOOL-7", state: { type: "started" } },
            },
            {
              type: "related",
              issue: { id: "r1", identifier: "TOOL-8", state: { type: "started" } },
            },
            { type: "blocks", issue: { id: "b2", identifier: "TOOL-9", state: null } },
            { type: "blocks", issue: null },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    expect(await gateway().getBlockers("1")).toEqual([
      { id: "b1", identifier: "TOOL-7", stateType: "started" },
      { id: "b2", identifier: "TOOL-9", stateType: "unstarted" },
    ]);
  });

  it("caches workflow states per team, sorted by position", async () => {
    resolvers.TeamWorkflowStates = (v) => ({
      workflowStates: {
        nodes: [
          { id: `${String(v.teamId)}-done`, name: "Done", type: "completed", position: 3 },
          { id: `${String(v.teamId)}-todo`, name: "Todo", type: "unstarted", position: 1 },
        ],
      },
    });
    const gw = gateway();
    const states = await gw.getWorkflowStates("team-1");
    expect(states.map((s) => s.name)).toEqual(["Todo", "Done"]);
    await gw.getWorkflowStates("team-1");
    await gw.getWorkflowStates("team-2");
    expect(calls.map((c) => c.variables.teamId)).toEqual(["team-1", "team-2"]);
  });

  it("finds a label: the team's first, then a workspace label", async () => {
    resolvers.IssueLabelsByName = () => ({
      issueLabels: {
        nodes: [
          { id: "other-team", name: "Manual", team: { id: "team-2" } },
          { id: "workspace", name: "manual", team: null },
          { id: "own-team", name: "MANUAL", team: { id: "team-1" } },
        ],
      },
    });
    const gw = gateway();
    expect(await gw.findLabel("team-1", "manual")).toEqual({
      id: "own-team",
      name: "MANUAL",
      teamId: "team-1",
    });
    expect((await gw.findLabel("team-3", "manual"))?.id).toBe("workspace");
    expect(calls[0]?.variables).toEqual({ name: "manual" });
    expect(calls[0]?.query).toContain("eqIgnoreCase");

    resolvers.IssueLabelsByName = () => ({ issueLabels: { nodes: [] } });
    expect(await gw.findLabel("team-1", "nope")).toBeNull();
  });
});

describe("SdkLinearGateway writes", () => {
  it("creates a label on the team", async () => {
    resolvers.CreateIssueLabel = () => ({
      issueLabelCreate: { success: true, issueLabel: { id: "l1", name: "manual" } },
    });
    expect(await gateway().createLabel("team-1", "manual")).toEqual({
      id: "l1",
      name: "manual",
      teamId: "team-1",
    });
    expect(calls[0]?.variables).toEqual({ input: { name: "manual", teamId: "team-1" } });
  });

  it("creates an issue with parent, priority, order, project and labels (creating missing labels)", async () => {
    resolvers.ProjectByName = () => ({ projects: { nodes: [{ id: "proj-1" }] } });
    resolvers.IssueLabelsByName = (v) => ({
      issueLabels: {
        nodes: v.name === "backend" ? [{ id: "lbl-backend", name: "backend", team: null }] : [],
      },
    });
    resolvers.CreateIssueLabel = () => ({
      issueLabelCreate: { success: true, issueLabel: { id: "lbl-manual", name: "manual" } },
    });
    resolvers.CreateIssue = () => ({ issueCreate: { success: true, issue: issueNode("99") } });

    const created = await gateway().createIssue({
      teamId: "team-1",
      title: "Follow-up",
      description: "Do it",
      parentId: "epic",
      priority: 3,
      subIssueSortOrder: 4.5,
      projectName: "Omniralph",
      labels: ["backend", "manual"],
    });
    expect(created.identifier).toBe("TOOL-99");
    const create = calls.find((c) => c.operation === "CreateIssue");
    expect(create?.variables).toEqual({
      input: {
        teamId: "team-1",
        title: "Follow-up",
        description: "Do it",
        parentId: "epic",
        priority: 3,
        subIssueSortOrder: 4.5,
        projectId: "proj-1",
        labelIds: ["lbl-backend", "lbl-manual"],
      },
    });
  });

  it("creates a plain issue without optional fields", async () => {
    resolvers.CreateIssue = () => ({ issueCreate: { success: true, issue: issueNode("5") } });
    await gateway().createIssue({ teamId: "team-1", title: "T", description: "D" });
    expect(calls.map((c) => c.operation)).toEqual(["CreateIssue"]);
    expect(calls[0]?.variables).toEqual({
      input: { teamId: "team-1", title: "T", description: "D" },
    });
  });

  it("throws when a mutation doesn't succeed", async () => {
    resolvers.CreateIssue = () => ({ issueCreate: { success: false, issue: null } });
    await expect(
      gateway().createIssue({ teamId: "team-1", title: "T", description: "D" }),
    ).rejects.toBeInstanceOf(LinearMutationError);
  });

  it("surfaces GraphQL errors", async () => {
    await expect(gateway().getIssue("1")).rejects.toThrow(/unexpected Issue/);
  });

  it("creates a blocks relation", async () => {
    resolvers.CreateIssueRelation = () => ({ issueRelationCreate: { success: true } });
    await gateway().createBlocksRelation("blocker", "blocked");
    expect(calls[0]?.variables).toEqual({
      input: { issueId: "blocker", relatedIssueId: "blocked", type: "blocks" },
    });
  });

  describe("setIssueState", () => {
    const setup = (currentStateId: string) => {
      resolvers.IssueTeamState = () => ({
        issue: { team: { id: "team-1" }, state: { id: currentStateId } },
      });
      resolvers.TeamWorkflowStates = () => ({
        workflowStates: {
          nodes: [
            { id: "s-review", name: "In Review", type: "started", position: 3 },
            { id: "s-progress", name: "In Progress", type: "started", position: 2 },
            { id: "s-done", name: "Done", type: "completed", position: 4 },
          ],
        },
      });
      resolvers.UpdateIssueState = () => ({ issueUpdate: { success: true } });
    };
    const updates = () =>
      calls.filter((c) => c.operation === "UpdateIssueState").map((c) => c.variables);

    it("moves to the team's first state of the type", async () => {
      setup("s-todo");
      await gateway().setIssueState("1", { type: "started" });
      expect(updates()).toEqual([{ id: "1", input: { stateId: "s-progress" } }]);
    });

    it("prefers a state by name (case-insensitive)", async () => {
      setup("s-todo");
      await gateway().setIssueState("1", { name: "in review", type: "started" });
      expect(updates()).toEqual([{ id: "1", input: { stateId: "s-review" } }]);
    });

    it("does nothing when already there or no state matches", async () => {
      setup("s-done");
      const gw = gateway();
      await gw.setIssueState("1", { type: "completed" });
      await gw.setIssueState("1", { type: "canceled" });
      expect(updates()).toEqual([]);
    });
  });

  it("creates a comment", async () => {
    resolvers.CreateComment = () => ({ commentCreate: { success: true } });
    await gateway().addComment("1", "Done: summary");
    expect(calls[0]?.variables).toEqual({ input: { issueId: "1", body: "Done: summary" } });
  });
});

describe("SdkLinearGateway agent sessions", () => {
  const activities = () =>
    calls.filter((c) => c.operation === "CreateAgentActivity").map((c) => c.variables.input);

  it("creates every activity type with ephemeral flags and signals", async () => {
    resolvers.CreateAgentActivity = () => ({ agentActivityCreate: { success: true } });
    const gw = gateway();
    await gw.createActivity("s1", { type: "thought", body: "Thinking" });
    await gw.createActivity(
      "s1",
      { type: "action", action: "Read", parameter: "src/a.ts", result: "ok" },
      { ephemeral: true },
    );
    await gw.createActivity("s1", { type: "response", body: "PR: https://x" });
    await gw.createActivity("s1", { type: "error", body: "Failed" });
    await gw.createActivity(
      "s1",
      { type: "elicitation", body: "Run it?" },
      { signal: "select", signalMetadata: { options: [{ value: "Run it" }] } },
    );
    expect(activities()).toEqual([
      { agentSessionId: "s1", content: { type: "thought", body: "Thinking" } },
      {
        agentSessionId: "s1",
        content: { type: "action", action: "Read", parameter: "src/a.ts", result: "ok" },
        ephemeral: true,
      },
      { agentSessionId: "s1", content: { type: "response", body: "PR: https://x" } },
      { agentSessionId: "s1", content: { type: "error", body: "Failed" } },
      {
        agentSessionId: "s1",
        content: { type: "elicitation", body: "Run it?" },
        signal: "select",
        signalMetadata: { options: [{ value: "Run it" }] },
      },
    ]);
  });

  it("updates the session plan and adds external URLs", async () => {
    resolvers.UpdateAgentSession = () => ({ agentSessionUpdate: { success: true } });
    const gw = gateway();
    await gw.updateSessionPlan("s1", [
      { content: "TOOL-1: First", status: "completed" },
      { content: "TOOL-2: Second", status: "inProgress" },
    ]);
    await gw.addSessionExternalUrl("s1", "Pull request", "https://github.com/acme/app/pull/1");
    expect(calls.map((c) => c.variables)).toEqual([
      {
        id: "s1",
        input: {
          plan: [
            { content: "TOOL-1: First", status: "completed" },
            { content: "TOOL-2: Second", status: "inProgress" },
          ],
        },
      },
      {
        id: "s1",
        input: {
          addedExternalUrls: [{ label: "Pull request", url: "https://github.com/acme/app/pull/1" }],
        },
      },
    ]);
  });
});
