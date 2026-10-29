import "server-only";
import { FIXTURE_SANDBOX_LINEAR_TOKEN } from "../../../scripts/fixtures/ids";
import { FakeLinearGateway } from "./fake-gateway";

/**
 * Whether the panel reads Linear settings options from the fixture workspace instead of
 * linear.app: only outside production with `OMNIRALPH_FIXTURE_LINEAR=1`, which the fixture
 * environment (`scripts/fixtures`) sets so screenshots show real pickers.
 */
export function fixtureLinearEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.OMNIRALPH_FIXTURE_LINEAR === "1";
}

const WORKFLOW_STATES = [
  ["Backlog", "backlog"],
  ["Todo", "unstarted"],
  ["In Progress", "started"],
  ["In Review", "started"],
  ["Done", "completed"],
  ["Canceled", "canceled"],
].map(([name, type], position) => ({
  id: `fixture-state-${position}`,
  name: name!,
  type: type!,
  position,
}));

/** Adds a work item of `team` in the workflow state named `state`. */
function addIssue(
  linear: FakeLinearGateway,
  team: { id: string; key: string },
  identifier: string,
  title: string,
  state: string,
  extra: Partial<Parameters<FakeLinearGateway["add"]>[0]> = {},
) {
  const { name, type } = linear.workflowStates.find((s) => s.name === state)!;
  return linear.add({
    id: `fixture-issue-${identifier.toLowerCase()}`,
    identifier,
    title,
    url: `https://linear.app/fixtures/issue/${identifier}`,
    teamId: team.id,
    teamKey: team.key,
    stateName: name,
    stateType: type,
    ...extra,
  });
}

/**
 * The fixture Linear workspace of an access token: the sandbox organization's
 * (`FIXTURE_SANDBOX_LINEAR_TOKEN`), or else the main fixture organization's.
 */
export function fixtureLinearGateway(accessToken?: string): FakeLinearGateway {
  return accessToken === FIXTURE_SANDBOX_LINEAR_TOKEN
    ? sandboxLinearGateway()
    : mainLinearGateway();
}

/** The sandbox organization's workspace: one team whose items are all on its Backlog. */
function sandboxLinearGateway(): FakeLinearGateway {
  const linear = new FakeLinearGateway();
  const team = { id: "fixture-team-sbx", key: "SBX", name: "Sandbox" };
  linear.teams = [team];
  linear.labels = [{ id: "fixture-label-sbx-1", name: "frontend", teamId: null }];
  linear.users = [{ id: "fixture-user-1", name: "Ada Lovelace" }];
  linear.workflowStates = WORKFLOW_STATES;
  addIssue(linear, team, "SBX-1", "Try the agent on a sample repo", "Todo", {
    priority: 2,
    description: [
      "# PRD: Try the agent on a sample repo",
      "",
      "## Introduction",
      "",
      "A new organization wants to see a run end to end before connecting its own repos.",
      "",
      "## User Stories",
      "",
      "### US-001: Add a sample repo",
      "",
      "As an admin, I want a sample repo so that I can start a first run in minutes.",
    ].join("\n"),
  });
  addIssue(linear, team, "SBX-2", "Show a welcome note to new members", "Backlog", {
    labels: ["frontend"],
  });
  addIssue(linear, team, "SBX-3", "Pick a default review depth", "Todo", { priority: 3 });
  return linear;
}

/** The main fixture organization's workspace: its teams, labels, projects, states,
 * milestones, cycles and users. */
function mainLinearGateway(): FakeLinearGateway {
  const linear = new FakeLinearGateway();
  linear.teams = [
    { id: "fixture-team-fix", key: "FIX", name: "Fixtures" },
    { id: "fixture-team-ops", key: "OPS", name: "Operations" },
    { id: "fixture-team-web", key: "WEB", name: "Web" },
  ];
  linear.labels = [
    { id: "fixture-label-1", name: "backend", teamId: null },
    { id: "fixture-label-2", name: "frontend", teamId: null },
    { id: "fixture-label-3", name: "manual", teamId: null },
    { id: "fixture-label-4", name: "needs-human", teamId: null },
    { id: "fixture-label-5", name: "api", teamId: "fixture-team-fix" },
    { id: "fixture-label-6", name: "infra", teamId: "fixture-team-ops" },
  ];
  linear.projects = [
    { id: "fixture-project-1", name: "Control panel" },
    { id: "fixture-project-2", name: "Agent" },
    { id: "fixture-project-3", name: "Platform API" },
  ];
  linear.projectMilestones = [
    { id: "fixture-milestone-1", name: "Beta", projectName: "Control panel" },
    { id: "fixture-milestone-2", name: "GA", projectName: "Control panel" },
  ];
  linear.cycles = [
    { id: "fixture-cycle-1", number: 12, name: null, teamKey: "FIX" },
    { id: "fixture-cycle-2", number: 13, name: "Hardening", teamKey: "FIX" },
  ];
  linear.users = [
    { id: "fixture-user-1", name: "Ada Lovelace" },
    { id: "fixture-user-2", name: "Grace Hopper" },
  ];
  linear.workflowStates = WORKFLOW_STATES;
  // Work items for the Backlog: ready, needing refinement, and one blocked by work in progress.
  const fix = { id: "fixture-team-fix", key: "FIX" };
  const issue = (
    identifier: string,
    title: string,
    state: string,
    extra: Partial<Parameters<FakeLinearGateway["add"]>[0]> = {},
  ) => addIssue(linear, fix, identifier, title, state, { projectName: "Control panel", ...extra });
  issue("FIX-101", "Export runs as CSV", "Todo", {
    labels: ["backend"],
    priority: 2,
    description: [
      "# PRD: Export runs as CSV",
      "",
      "## Introduction",
      "",
      "Members want the Runs list in a spreadsheet: one row per run, with its repo, status and duration.",
      "",
      "## Quality Gates",
      "",
      "- `pnpm turbo run typecheck lint test`",
      "",
      "## User Stories",
      "",
      "### US-001: Export the filtered list",
      "",
      "As a member, I want to download the runs I filtered as CSV.",
    ].join("\n"),
  });
  // Needs refining, with a first PRD that still has an open question.
  issue("FIX-102", "Explain why a review was skipped", "Backlog", {
    labels: ["frontend"],
    description: [
      "# PRD: Explain why a review was skipped",
      "",
      "## Introduction",
      "",
      "A skipped review only says it was skipped. Members want the reason on the run.",
      "",
      "## Open Questions",
      "",
      "- Should a skip for an already reviewed head link to that review?",
    ].join("\n"),
  });
  const blocker = issue("FIX-103", "Add the runs export endpoint", "In Progress", {
    labels: ["api"],
  });
  const blocked = issue("FIX-104", "Download a run's transcript", "Todo", { priority: 3 });
  void linear.createBlocksRelation(blocker.id, blocked.id);
  issue("OPS-21", "Rotate the agents' tokens", "Backlog", {
    teamId: "fixture-team-ops",
    teamKey: "OPS",
    projectName: undefined,
    labels: ["infra"],
  });
  return linear;
}
