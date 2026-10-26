// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  queryWrapper,
  TEST_ORGANIZATION_ID,
  testUser,
} from "@/components/query-test-utils";
import type { AgentList, FleetAgentRow } from "@/lib/api/agents";
import { AgentsView } from "./agents-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const AGENT_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const ENROLLMENT_ID = "0b6a3c1e-8f4d-4c2a-9e1b-7d5f3a2c1b0e";

/** The list's summary (the legacy page doesn't show it). */
const SUMMARY: AgentList["summary"] = {
  total: 0,
  online: 0,
  offline: 0,
  busy: 0,
  versionPolicy: null,
  versions: { onTarget: 0, behind: 0, updateFailed: 0 },
  acceptedKinds: { limited: 0, total: 0 },
};

function agent(overrides: Partial<FleetAgentRow> = {}): FleetAgentRow {
  return {
    id: AGENT_ID,
    name: "coder-1",
    online: false,
    revoked: false,
    status: { kind: "idle", label: "Idle", tone: "neutral" },
    runningCount: 0,
    host: null,
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    version: "1.0.0",
    desiredVersion: null,
    desiredVersionOverride: null,
    tracksLatest: false,
    selfUpdate: "supported",
    update: null,
    failedVersions: [],
    updateRequest: null,
    updateStatus: "up_to_date",
    acceptedTaskTypes: ["review"],
    maxConcurrency: 2,
    overrides: { maxConcurrency: null },
    defaults: { maxConcurrency: 2 },
    poolLimits: {},
    effectivePoolLimits: { short: 2, long: 1 },
    runningJobs: [],
    pinnedRepositories: [],
    lastHeartbeatAt: null,
    revokedAt: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers `fetch` by path: a function of the request, or a JSON body. */
function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0]!;
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch ${path}`);
    return route(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(<AgentsView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentsView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a skeleton, then the agents, online by the browser's clock", async () => {
    // Freeze only the clock, so a slow render still reads "5s ago" (timers stay real).
    vi.useFakeTimers({ toFake: ["Date"] });
    const recent = new Date(Date.now() - 5_000).toISOString();
    mockFetch({
      // The server rendered it offline; the browser's clock decides.
      "/api/ui/agents": () => json({ agents: [agent({ online: false, lastHeartbeatAt: recent })], summary: SUMMARY }),
    });
    renderView();
    expect(screen.getByLabelText("Loading agents")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "coder-1" });
    expect(link.getAttribute("href")).toBe(`/agents/${AGENT_ID}`);
    expect(screen.getAllByText("Online").length).toBeGreaterThan(0);
    // A slow test run can take a few seconds to render, so allow some drift.
    expect(screen.getAllByText(/^\d+s ago$/).length).toBeGreaterThan(0);
  });

  it("shows an old heartbeat as offline", async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    mockFetch({
      "/api/ui/agents": () => json({ agents: [agent({ online: true, lastHeartbeatAt: old })], summary: SUMMARY }),
    });
    renderView("member");
    // Members see the name without a link.
    await screen.findByText("coder-1");
    expect(screen.queryByRole("link", { name: "coder-1" })).toBeNull();
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });

  it("shows a failed load in place with a retry", async () => {
    let fail = true;
    mockFetch({
      "/api/ui/agents": () =>
        fail ? json({ error: "Database unavailable." }, 500) : json({ agents: [], summary: SUMMARY }),
    });
    renderView();
    expect(await screen.findByText("Couldn't load agents")).toBeTruthy();
    expect(screen.getByText("Database unavailable.")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No agents yet")).toBeTruthy();
  });

  it("shows the agent that enrolled with the dialog's token, with the list already updated", async () => {
    let enrolled = false;
    const fetch = mockFetch({
      "/api/ui/agents": () => json({ agents: enrolled ? [agent({ name: "build-box" })] : [], summary: SUMMARY }),
      "/api/ui/agent-enrollments": (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ name: "build-box" });
        return json({
          ok: true,
          id: ENROLLMENT_ID,
          token: "ore_secret",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          command: "omniralph-agent enroll --server https://x --token ore_secret",
        });
      },
      [`/api/ui/agent-enrollments/${ENROLLMENT_ID}`]: () =>
        json({
          id: ENROLLMENT_ID,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          agent: enrolled ? { id: AGENT_ID, name: "build-box" } : null,
        }),
    });
    const client = renderView();
    await screen.findByText("No agents yet");

    await userEvent.click(screen.getByRole("button", { name: "Enroll agent" }));
    await userEvent.type(screen.getByLabelText("Name"), "build-box");
    await userEvent.click(screen.getByRole("button", { name: "Generate token" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("ore_secret")).toBeTruthy();
    expect(within(dialog).getByLabelText("Install command").textContent).toBe(
      "npm install -g @omniralph/agent",
    );
    expect(within(dialog).getByLabelText("Enroll command").textContent).toBe(
      "omniralph-agent enroll --server https://x --token ore_secret",
    );
    expect(within(dialog).getByText("Waiting for the agent to enroll…")).toBeTruthy();

    // The agent redeems the token; the next poll of the enrollment finds it.
    enrolled = true;
    await client.refetchQueries({
      queryKey: [testUser.organization.id, "agents", "enrollment"],
    });
    expect(await within(dialog).findByText("build-box connected")).toBeTruthy();
    const open = within(dialog).getByRole("link", { name: "Open build-box" });
    expect(open.getAttribute("href")).toBe(`/agents/${AGENT_ID}`);
    // The list behind the dialog was refetched before the dialog said so.
    const listCalls = fetch.mock.calls.filter(([url]) => String(url) === "/api/ui/agents");
    expect(listCalls.length).toBe(2);
    await waitFor(() => expect(screen.getAllByText("build-box").length).toBeGreaterThan(0));
  });
});
