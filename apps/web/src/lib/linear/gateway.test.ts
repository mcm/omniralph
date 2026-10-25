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
    creator: { id: "user-2", name: "Ada", url: "https://linear.app/acme/profiles/ada" },
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

  it("lists every page of teams", async () => {
    resolvers.Teams = (v) => ({
      teams: v.after
        ? {
            nodes: [{ id: "t2", key: "OPS", name: "Operations" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          }
        : {
            nodes: [{ id: "t1", key: "TOOL", name: "Tooling" }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
    });
    expect(await gateway().listTeams()).toEqual([
      { id: "t1", key: "TOOL", name: "Tooling" },
      { id: "t2", key: "OPS", name: "Operations" },
    ]);
    expect(calls.map((c) => c.variables)).toEqual([
      { first: 100, after: null },
      { first: 100, after: "c1" },
    ]);
  });

  it("lists every page of issue labels, without label groups", async () => {
    resolvers.IssueLabels = (v) => ({
      issueLabels: v.after
        ? {
            nodes: [{ id: "l3", name: "Backend", isGroup: false, team: { id: "t1" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          }
        : {
            nodes: [
              { id: "l1", name: "ralph", isGroup: false, team: null },
              { id: "l2", name: "Area", isGroup: true, team: null },
            ],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
    });
    expect(await gateway().listIssueLabels()).toEqual([
      { id: "l1", name: "ralph", teamId: null },
      { id: "l3", name: "Backend", teamId: "t1" },
    ]);
    expect(calls.map((c) => c.variables)).toEqual([
      { first: 100, after: null },
      { first: 100, after: "c1" },
    ]);
  });

  it("lists every page of projects", async () => {
    resolvers.Projects = (v) => ({
      projects: v.after
        ? {
            nodes: [{ id: "p2", name: "Cyralph" }],
            pageInfo: { hasNextPage: false, endCursor: "c2" },
          }
        : {
            nodes: [{ id: "p1", name: "Omniralph" }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
    });
    expect(await gateway().listProjects()).toEqual([
      { id: "p1", name: "Omniralph" },
      { id: "p2", name: "Cyralph" },
    ]);
    expect(calls.map((c) => c.operation)).toEqual(["Projects", "Projects"]);
  });

  it("lists every page of project milestones, with their project", async () => {
    resolvers.ProjectMilestones = (v) => ({
      projectMilestones: v.after
        ? {
            nodes: [{ id: "m2", name: "GA", project: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          }
        : {
            nodes: [{ id: "m1", name: "Beta", project: { name: "Omniralph" } }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
    });
    expect(await gateway().listProjectMilestones()).toEqual([
      { id: "m1", name: "Beta", projectName: "Omniralph" },
      { id: "m2", name: "GA", projectName: "" },
    ]);
    expect(calls.map((c) => c.operation)).toEqual(["ProjectMilestones", "ProjectMilestones"]);
  });

  it("lists the current and upcoming cycles of every team", async () => {
    resolvers.Cycles = () => ({
      cycles: {
        nodes: [
          { id: "cy1", number: 12, name: null, team: { key: "ENG" } },
          { id: "cy2", number: 3, name: "Launch", team: { key: "OPS" } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    expect(await gateway().listCycles()).toEqual([
      { id: "cy1", number: 12, name: null, teamKey: "ENG" },
      { id: "cy2", number: 3, name: "Launch", teamKey: "OPS" },
    ]);
    expect(calls[0]?.query).toContain("isPast: { eq: false }");
  });

  it("lists every page of users", async () => {
    resolvers.Users = (v) => ({
      users: v.after
        ? {
            nodes: [{ id: "u2", name: "Grace" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          }
        : { nodes: [{ id: "u1", name: "Ada" }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    });
    expect(await gateway().listUsers()).toEqual([
      { id: "u1", name: "Ada" },
      { id: "u2", name: "Grace" },
    ]);
    expect(calls.map((c) => c.operation)).toEqual(["Users", "Users"]);
  });

  it("reads the viewer (the app user)", async () => {
    resolvers.Viewer = () => ({ viewer: { id: "app-user", name: "Omniralph" } });
    expect(await gateway().getViewer()).toEqual({ id: "app-user", name: "Omniralph" });
    expect(calls.map((c) => c.operation)).toEqual(["Viewer"]);
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
      creator: { id: "user-2", name: "Ada", url: "https://linear.app/acme/profiles/ada" },
    });
    expect(calls).toHaveLength(1);
  });

  it("reads an issue's routing fields and its parent's in one request", async () => {
    const routingNode = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      identifier: `TOOL-${id}`,
      title: `Issue ${id}`,
      description: `Body ${id}`,
      priority: 2,
      estimate: 3,
      dueDate: "2026-11-01",
      parent: { id: "10", identifier: "TOOL-10" },
      assignee: { id: "user-1" },
      creator: { id: "user-2" },
      team: { id: "team-1", key: "TOOL" },
      state: { name: "Todo", type: "unstarted" },
      labels: { nodes: [{ name: "backend" }] },
      project: { id: "project-1", name: "Omniralph" },
      projectMilestone: { id: "milestone-1", name: "Beta" },
      cycle: { id: "cycle-1" },
      ...overrides,
    });
    resolvers.IssueRoutingFields = (v) => ({
      issue: {
        ...routingNode(String(v.id)),
        parentIssue: routingNode("10", {
          parent: null,
          estimate: null,
          dueDate: null,
          projectMilestone: null,
          cycle: null,
          assignee: null,
          creator: null,
          state: null,
          project: null,
          description: null,
          priority: null,
          labels: { nodes: [] },
        }),
      },
    });
    expect(await gateway().getRoutingFields("42")).toEqual({
      issue: {
        id: "42",
        identifier: "TOOL-42",
        title: "Issue 42",
        description: "Body 42",
        team: "TOOL",
        project: "Omniralph",
        projectMilestone: "Beta",
        cycle: "cycle-1",
        state: "Todo",
        stateType: "unstarted",
        priority: 2,
        assignee: "user-1",
        creator: "user-2",
        parent: "TOOL-10",
        parentId: "10",
        labels: ["backend"],
        estimate: 3,
        dueDate: "2026-11-01",
        teamId: "team-1",
        projectId: "project-1",
        projectMilestoneId: "milestone-1",
      },
      parent: {
        id: "10",
        identifier: "TOOL-10",
        title: "Issue 10",
        description: "",
        team: "TOOL",
        project: null,
        projectMilestone: null,
        cycle: null,
        state: null,
        stateType: null,
        priority: 0,
        assignee: null,
        creator: null,
        parent: null,
        parentId: null,
        labels: [],
        estimate: null,
        dueDate: null,
        teamId: "team-1",
        projectId: null,
        projectMilestoneId: null,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables).toEqual({ id: "42" });
  });

  it("reads routing fields without a parent", async () => {
    resolvers.IssueRoutingFields = () => ({
      issue: { ...issueNode("1", { parent: null }), parentIssue: null },
    });
    const { issue, parent } = await gateway().getRoutingFields("TOOL-1");
    expect(parent).toBeNull();
    expect(issue).toMatchObject({ parent: null, parentId: null, estimate: null, dueDate: null });
  });

  it("fills defaults for missing optional fields", async () => {
    resolvers.Issue = () => ({
      issue: issueNode("1", {
        description: null,
        priority: null,
        subIssueSortOrder: null,
        parent: null,
        assignee: null,
        creator: null,
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
    expect(issue.creator).toBeUndefined();
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

  it("searches issues as summaries, with a default page size", async () => {
    resolvers.SearchIssues = () => ({
      searchIssues: { nodes: [issueNode("7"), issueNode("8", { description: null })] },
    });
    const issues = await gateway().searchIssues("login bug");
    expect(issues.map((i) => i.identifier)).toEqual(["TOOL-7", "TOOL-8"]);
    expect(issues[0]).toMatchObject({ teamKey: "TOOL", labels: ["backend"], parentId: "epic" });
    expect(issues[1]?.description).toBe("");
    expect(calls[0]?.variables).toEqual({ term: "login bug", first: 10 });
    expect(calls[0]?.query).toContain("on IssueSearchResult");

    await gateway().searchIssues("x", { first: 3 });
    expect(calls[1]?.variables).toEqual({ term: "x", first: 3 });
  });

  it("reads a document", async () => {
    resolvers.Document = (v) => ({
      document: {
        id: String(v.id),
        title: "Design",
        content: "# Design",
        url: "https://linear.app/acme/document/design-abc",
        updatedAt: "2026-10-01T00:00:00.000Z",
        project: { name: "Omniralph" },
        issue: { identifier: "TOOL-1" },
      },
    });
    expect(await gateway().getDocument("abc")).toEqual({
      id: "abc",
      title: "Design",
      content: "# Design",
      url: "https://linear.app/acme/document/design-abc",
      updatedAt: "2026-10-01T00:00:00.000Z",
      projectName: "Omniralph",
      issueIdentifier: "TOOL-1",
    });
  });

  it("reads a document without content, project or issue", async () => {
    resolvers.Document = () => ({
      document: {
        id: "d",
        title: "Empty",
        content: null,
        url: "https://linear.app/acme/document/empty-d",
        updatedAt: "2026-10-01T00:00:00.000Z",
        project: null,
        issue: null,
      },
    });
    expect(await gateway().getDocument("d")).toEqual({
      id: "d",
      title: "Empty",
      content: "",
      url: "https://linear.app/acme/document/empty-d",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("reads only inverse blocks relations as blockers", async () => {
    resolvers.IssueBlockers = () => ({
      issue: {
        inverseRelations: {
          nodes: [
            {
              type: "blocks",
              issue: {
                id: "b1",
                identifier: "TOOL-7",
                title: "Blocker",
                state: { type: "started" },
              },
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
      { id: "b1", identifier: "TOOL-7", title: "Blocker", stateType: "started" },
      { id: "b2", identifier: "TOOL-9", title: undefined, stateType: "unstarted" },
    ]);
  });

  it("reads the team's name, the state's ID and the project's ID when Linear returns them", async () => {
    resolvers.Issue = (v) => ({
      issue: issueNode(String(v.id), {
        team: { id: "team-1", key: "TOOL", name: "Tooling" },
        state: { id: "state-1", name: "Todo", type: "unstarted" },
        project: { id: "project-1", name: "Omniralph" },
      }),
    });
    expect(await gateway().getIssue("42")).toMatchObject({
      teamName: "Tooling",
      stateId: "state-1",
      projectId: "project-1",
      projectName: "Omniralph",
    });
  });

  it("lists a page of issues with their blockers in one request", async () => {
    resolvers.ListIssues = () => ({
      issues: {
        nodes: [
          {
            ...issueNode("1"),
            inverseRelations: {
              nodes: [
                {
                  type: "blocks",
                  issue: {
                    id: "b1",
                    identifier: "TOOL-7",
                    title: "Blocker",
                    state: { type: "started", name: "In Progress" },
                  },
                },
                { type: "related", issue: { id: "r1", identifier: "TOOL-8", state: null } },
              ],
            },
          },
          { ...issueNode("2"), inverseRelations: { nodes: [] } },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      },
    });
    const page = await gateway().listIssues({
      teamId: "team-1",
      projectId: "project-1",
      labelIds: ["label-1"],
      delegateId: "app-user",
      stateTypes: ["unstarted", "backlog"],
      stateMatch: { types: ["unstarted"], typesExceptTeamIds: ["team-2"], ids: ["state-9"] },
      first: 2,
      after: "cursor-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toContain("inverseRelations");
    expect(calls[0]!.variables).toEqual({
      first: 2,
      after: "cursor-1",
      filter: {
        and: [
          { team: { id: { eq: "team-1" } } },
          { project: { id: { eq: "project-1" } } },
          { labels: { some: { id: { in: ["label-1"] } } } },
          { delegate: { id: { eq: "app-user" } } },
          { state: { type: { in: ["unstarted", "backlog"] } } },
          {
            or: [
              { state: { type: { in: ["unstarted"] } }, team: { id: { nin: ["team-2"] } } },
              { state: { id: { in: ["state-9"] } } },
            ],
          },
        ],
      },
    });
    expect(page.endCursor).toBe("cursor-2");
    expect(page.issues.map((i) => i.identifier)).toEqual(["TOOL-1", "TOOL-2"]);
    expect(page.issues[0]!.blockers).toEqual([
      {
        id: "b1",
        identifier: "TOOL-7",
        title: "Blocker",
        stateType: "started",
        stateName: "In Progress",
      },
    ]);
    expect(page.issues[1]!.blockers).toEqual([]);
  });

  it("lists issues not delegated to a user, and answers no cursor on the last page", async () => {
    resolvers.ListIssues = () => ({
      issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "end" } },
    });
    const page = await gateway().listIssues({
      notDelegateId: "app-user",
      stateMatch: { types: [], typesExceptTeamIds: [], ids: [] },
      first: 10,
    });
    expect(page).toEqual({ issues: [], endCursor: null });
    expect(calls[0]!.variables).toEqual({
      first: 10,
      after: null,
      filter: {
        and: [
          {
            or: [{ delegate: { null: true } }, { delegate: { id: { neq: "app-user" } } }],
          },
          { state: { id: { in: [] } } },
        ],
      },
    });
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

  it("creates an issue in a project, milestone and cycle by ID", async () => {
    resolvers.CreateIssue = () => ({ issueCreate: { success: true, issue: issueNode("7") } });
    await gateway().createIssue({
      teamId: "team-1",
      title: "T",
      description: "D",
      projectId: "project-1",
      projectMilestoneId: "milestone-1",
      cycleId: "cycle-1",
    });
    // No project lookup by name.
    expect(calls.map((c) => c.operation)).toEqual(["CreateIssue"]);
    expect(calls[0]?.variables).toEqual({
      input: {
        teamId: "team-1",
        title: "T",
        description: "D",
        projectId: "project-1",
        projectMilestoneId: "milestone-1",
        cycleId: "cycle-1",
      },
    });
  });

  it("creates an issue delegated to the app user", async () => {
    resolvers.CreateIssue = () => ({ issueCreate: { success: true, issue: issueNode("6") } });
    await gateway().createIssue({
      teamId: "team-1",
      title: "T",
      description: "D",
      delegateId: "app-user",
    });
    expect(calls[0]?.variables).toEqual({
      input: { teamId: "team-1", title: "T", description: "D", delegateId: "app-user" },
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

  describe("issue updates", () => {
    const updates = () =>
      calls.filter((c) => c.operation === "UpdateIssue").map((c) => c.variables);

    it("updates only the given title, description and priority", async () => {
      resolvers.UpdateIssue = () => ({ issueUpdate: { success: true } });
      const gw = gateway();
      await gw.updateIssue("1", { title: "PRD", description: "## Introduction", priority: 2 });
      await gw.updateIssue("1", { description: "" });
      await gw.updateIssue("1", {});
      expect(updates()).toEqual([
        { id: "1", input: { title: "PRD", description: "## Introduction", priority: 2 } },
        { id: "1", input: { description: "" } },
      ]);
    });

    it("adds and removes labels by ID", async () => {
      resolvers.UpdateIssue = () => ({ issueUpdate: { success: true } });
      const gw = gateway();
      await gw.addIssueLabels("1", ["l1", "l2"]);
      await gw.addIssueLabels("1", []);
      await gw.removeIssueLabel("1", "l1");
      expect(updates()).toEqual([
        { id: "1", input: { addedLabelIds: ["l1", "l2"] } },
        { id: "1", input: { removedLabelIds: ["l1"] } },
      ]);
    });

    it("delegates an issue", async () => {
      resolvers.UpdateIssue = () => ({ issueUpdate: { success: true } });
      await gateway().delegateIssue("1", "app-user");
      expect(updates()).toEqual([{ id: "1", input: { delegateId: "app-user" } }]);
    });

    it("throws when the update doesn't succeed", async () => {
      resolvers.UpdateIssue = () => ({ issueUpdate: { success: false } });
      await expect(gateway().removeIssueLabel("1", "l1")).rejects.toBeInstanceOf(
        LinearMutationError,
      );
    });
  });

  it("creates a comment", async () => {
    resolvers.CreateComment = () => ({ commentCreate: { success: true } });
    await gateway().addComment("1", "Done: summary");
    expect(calls[0]?.variables).toEqual({ input: { issueId: "1", body: "Done: summary" } });
  });

  it("links a URL to an issue", async () => {
    resolvers.LinkUrl = () => ({ attachmentLinkURL: { success: true } });
    await gateway().linkUrl("1", "https://github.com/acme/api/pull/7", "Pull request #7");
    expect(calls[0]?.variables).toEqual({
      issueId: "1",
      url: "https://github.com/acme/api/pull/7",
      title: "Pull request #7",
    });
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

  it("opens an agent session on an issue and returns its ID", async () => {
    resolvers.CreateAgentSessionOnIssue = () => ({
      agentSessionCreateOnIssue: { success: true, agentSession: { id: "session-9" } },
    });
    expect(await gateway().createAgentSessionOnIssue("TOOL-1")).toBe("session-9");
    expect(calls[0]?.variables).toEqual({ input: { issueId: "TOOL-1" } });
  });

  it("throws when Linear opens no agent session", async () => {
    resolvers.CreateAgentSessionOnIssue = () => ({
      agentSessionCreateOnIssue: { success: true, agentSession: null },
    });
    await expect(gateway().createAgentSessionOnIssue("TOOL-1")).rejects.toBeInstanceOf(
      LinearMutationError,
    );
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

describe("SdkLinearGateway.downloadUpload", () => {
  const UPLOAD = "https://uploads.linear.app/org/a1b2/shot";

  it("fetches an upload with the workspace token", async () => {
    const seen: Array<string | null> = [];
    server.use(
      http.get(UPLOAD, ({ request }) => {
        seen.push(request.headers.get("authorization"));
        return new HttpResponse("PNGDATA", {
          headers: { "content-type": "image/png; charset=binary", "content-length": "7" },
        });
      }),
      http.get(`${UPLOAD}-missing`, () => new HttpResponse(null, { status: 401 })),
    );
    const ok = await gateway().downloadUpload(UPLOAD);
    expect(ok).toMatchObject({ ok: true, status: 200, contentType: "image/png", contentLength: 7 });
    expect(await new Response(ok.body).text()).toBe("PNGDATA");
    expect(await gateway().downloadUpload(`${UPLOAD}-missing`)).toMatchObject({
      ok: false,
      status: 401,
      body: null,
    });
    expect(seen).toEqual(["Bearer lin_oauth_token"]);
  });

  it("never sends the token anywhere but Linear's uploads", async () => {
    await expect(gateway().downloadUpload("https://example.com/x.png")).rejects.toThrow(
      "not a Linear upload URL",
    );
    await expect(gateway().downloadUpload(`${UPLOAD}?signature=x`)).rejects.toThrow(
      "not a Linear upload URL",
    );
  });
});

describe("SdkLinearGateway.uploadFile", () => {
  const SIGNED = "https://storage.example.com/signed/shot.png?sig=abc";
  const ASSET = "https://uploads.linear.app/org/a1b2/shot.png";

  it("asks Linear for a signed URL, PUTs the file there with Linear's headers, and returns the asset URL", async () => {
    resolvers.FileUpload = () => ({
      fileUpload: {
        success: true,
        uploadFile: {
          uploadUrl: SIGNED,
          assetUrl: ASSET,
          headers: [{ key: "x-goog-meta-owner", value: "org-1" }],
        },
      },
    });
    const puts: Array<{ headers: Headers; body: string }> = [];
    server.use(
      http.put(SIGNED, async ({ request }) => {
        puts.push({ headers: request.headers, body: await request.text() });
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const url = await gateway().uploadFile({
      filename: "shot.png",
      contentType: "image/png",
      data: new TextEncoder().encode("PNGDATA"),
    });
    expect(url).toBe(ASSET);
    expect(calls[0]).toMatchObject({
      operation: "FileUpload",
      variables: { contentType: "image/png", filename: "shot.png", size: 7 },
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toBe("PNGDATA");
    expect(puts[0]!.headers.get("content-type")).toBe("image/png");
    expect(puts[0]!.headers.get("x-goog-meta-owner")).toBe("org-1");
    // The signed URL carries its own auth: the token never goes to storage.
    expect(puts[0]!.headers.get("authorization")).toBeNull();
  });

  it("throws when storage rejects the upload", async () => {
    resolvers.FileUpload = () => ({
      fileUpload: {
        success: true,
        uploadFile: { uploadUrl: SIGNED, assetUrl: ASSET, headers: [] },
      },
    });
    server.use(http.put(SIGNED, () => new HttpResponse(null, { status: 403 })));
    await expect(
      gateway().uploadFile({
        filename: "a.png",
        contentType: "image/png",
        data: new Uint8Array(1),
      }),
    ).rejects.toThrow("403");
  });
});
