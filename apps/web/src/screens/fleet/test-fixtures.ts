import { jsonResponse, TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type { AgentDetail, AgentList, FleetAgentRow, FleetSummary } from "@/lib/api/agents";

export const BETA_ID = "22222222-2222-4222-8222-222222222222";
export const AGENT_ALPHA = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
export const AGENT_BRAVO = "7a2d3b6a-3b6d-4b9f-8a1b-2e3c4d5e6f70";
export const AGENT_REVOKED = "8b3e4c7b-4c7e-4ca0-9b2c-3f4d5e6f7081";
export const AGENT_BETA = "9c4f5d8c-5d8f-4db1-8c3d-405e6f708192";

/** A Fleet row of the test organization: idle, online, no pins. */
export function agentRow(overrides: Partial<FleetAgentRow> = {}): FleetAgentRow {
  return {
    id: AGENT_ALPHA,
    name: "coder-1",
    online: true,
    revoked: false,
    status: { kind: "idle", label: "Idle", tone: "neutral" },
    runningCount: 0,
    host: { hostname: "build-1", coder: null },
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    version: "2.0.3",
    desiredVersion: "2.0.3",
    versionPin: null,
    tracksLatest: true,
    selfUpdate: "supported",
    update: null,
    failedVersions: [],
    updateStatus: "up_to_date",
    acceptedTaskTypes: ["review"],
    slots: { running: 0, max: 2 },
    runningJobs: [],
    pinnedRepositories: [],
    lastHeartbeatAt: "2026-10-26T11:59:40.000Z",
    revokedAt: null,
    createdAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  };
}

const repo = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  provider: "gitlab" as const,
  fullPath: `acme/repo-${n}`,
  webUrl: `https://gitlab.example.com/acme/repo-${n}`,
});

export const pins = (count: number) => Array.from({ length: count }, (_, i) => repo(i + 1));

export function summary(overrides: Partial<FleetSummary> = {}): FleetSummary {
  return {
    total: 7,
    online: 6,
    offline: 1,
    busy: 1,
    versionPolicy: { mode: "latest", version: null, target: "2.0.3" },
    versions: { onTarget: 6, behind: 0, pinned: 0, updateFailed: 0 },
    acceptedKinds: { limited: 0, total: 7 },
    ...overrides,
  };
}

/** Three agents: one running with two pins, one offline with three, one revoked. */
export function fleet(): AgentList {
  return {
    agents: [
      agentRow({
        id: AGENT_REVOKED,
        name: "aardvark",
        online: false,
        revoked: true,
        revokedAt: "2026-10-20T10:00:00.000Z",
        status: { kind: "revoked", label: "Revoked", tone: "neutral" },
      }),
      agentRow({
        id: AGENT_BRAVO,
        name: "coder-2",
        online: false,
        status: { kind: "offline", label: "Offline 3d", tone: "fail" },
        pinnedRepositories: pins(3),
      }),
      agentRow({
        id: AGENT_ALPHA,
        name: "coder-1",
        status: { kind: "running", label: "Running 2", tone: "run" },
        runningCount: 2,
        pinnedRepositories: pins(2),
      }),
    ],
    summary: summary({ total: 2, online: 1, offline: 1, busy: 1 }),
    versionHistory: null,
  };
}

/** An agent's detail: `agent` with nothing running, no history, reports or installs. */
export function agentDetail(agent: FleetAgentRow = agentRow()): AgentDetail {
  return {
    agent,
    models: [],
    installables: [],
    installs: [],
    runningNow: [],
    recentWork: [],
    security: {
      lastTokenRefreshAt: null,
      reuseAlerts30d: 0,
      lastReuseAt: null,
      authFailures30d: 0,
    },
    globalDesiredVersion: "2.0.3 (latest on npm)",
    local: {
      poolLimits: { short: 2, long: 1 },
      versionPin: null,
      installablesAllow: ["@omniralph/*"],
    },
    hostTools: [],
    missingRequiredHostTools: [],
    audit: [],
    pinSyncJobs: [],
  };
}

/** The detail route of every agent of `list`, plus a 404 for `missing` IDs. */
export function detailRoutes(
  list: () => AgentList,
  overrides: () => Record<string, AgentDetail> = () => ({}),
  missing: readonly string[] = [],
) {
  const routes: Record<string, () => Response> = {};
  for (const agent of list().agents) {
    routes[`GET /api/ui/agents/${agent.id}`] = () => {
      const current = list().agents.find((row) => row.id === agent.id)!;
      return jsonResponse(overrides()[agent.id] ?? agentDetail(current));
    };
  }
  for (const id of missing) {
    routes[`GET /api/ui/agents/${id}`] = () => jsonResponse({ ok: false, error: "Not found" }, 404);
  }
  return routes;
}
