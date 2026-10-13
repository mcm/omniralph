import "server-only";
import { FakeLinearGateway } from "./fake-gateway";

/**
 * Whether the panel reads Linear settings options from the fixture workspace instead of
 * linear.app: only outside production with `OMNIRALPH_FIXTURE_LINEAR=1`, which the fixture
 * environment (`scripts/fixtures`) sets so screenshots show real pickers.
 */
export function fixtureLinearEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.OMNIRALPH_FIXTURE_LINEAR === "1";
}

/** The fixture organization's Linear workspace: its teams, labels, projects and states. */
export function fixtureLinearGateway(): FakeLinearGateway {
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
    { id: "fixture-project-2", name: "Harness" },
    { id: "fixture-project-3", name: "Platform API" },
  ];
  linear.workflowStates = [
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
  return linear;
}
