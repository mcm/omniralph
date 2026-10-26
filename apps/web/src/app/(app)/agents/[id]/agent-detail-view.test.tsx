// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  TEST_ORGANIZATION_ID,
} from "@/components/query-test-utils";
import type { AgentDetail, AgentList, FleetAgentRow, InstallJobRow } from "@/lib/api/agents";
import { queryKeys } from "@/lib/api/keys";
import { AgentDetailView } from "./agent-detail-view";
import { InstallForm } from "./agent-installables";

const AGENT_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const REPO_ID = "0b6a3c1e-8f4d-4c2a-9e1b-7d5f3a2c1b0e";

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

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f" }),
  useRouter: () => router,
  usePathname: () => "/agents/6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

function agent(overrides: Partial<FleetAgentRow> = {}): FleetAgentRow {
  return {
    id: AGENT_ID,
    name: "build-01",
    online: true,
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
    pinnedRepositories: [
      {
        id: REPO_ID,
        provider: "github",
        fullPath: "acme/api",
        webUrl: "https://github.com/acme/api",
      },
    ],
    lastHeartbeatAt: new Date().toISOString(),
    revokedAt: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<FleetAgentRow> = {}, syncStatus = "queued"): AgentDetail {
  return {
    agent: agent(overrides),
    models: [],
    installables: [],
    runningNow: [],
    recentWork: [],
    security: { lastTokenRefreshAt: null, reuseAlerts30d: 0, authFailures30d: 0 },
    globalDesiredVersion: "1.0.0",
    audit: [],
    pinSyncJobs: [
      {
        repositoryId: REPO_ID,
        id: "00000000-0000-4000-8000-000000000009",
        status: syncStatus as AgentDetail["pinSyncJobs"][number]["status"],
        error: null,
        createdAt: "2026-10-16T10:00:00.000Z",
        finishedAt: null,
      },
    ],
  };
}

const keys = queryKeys(TEST_ORGANIZATION_ID);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentDetailView", () => {
  it("loads the agent and shows its running jobs and pins' syncs as they change", async () => {
    let current = detail();
    const requests = mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: () => jsonResponse(current),
    });
    const client = createTestQueryClient();
    render(<AgentDetailView tab="overview" />, { wrapper: queryWrapper(client) });

    expect(screen.getByLabelText("Loading the agent")).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "build-01" })).toBeTruthy();
    const pin = () => document.querySelector('[data-pin-sync="acme/api"]') as HTMLElement;
    expect(within(pin()).getByText("Queued")).toBeTruthy();
    expect(screen.getByText(/0 \/ 2/)).toBeTruthy();
    // Task types are the agent's own (Epic 7's Fleet shows them): no row here.
    expect(screen.queryByText("Accepted task types")).toBeNull();
    // The agent's organization needs no switch: the API reads it for any membership.
    expect(requests[0]!.query.get("next")).toBeNull();

    // The next poll: a job started, the sync finished.
    current = {
      ...detail(
        {
          runningJobs: [
            {
              id: "job-1",
              type: "review.run",
              taskType: "review",
              target: { label: "acme/api!7", url: null },
              runId: null,
            },
          ],
        },
        "completed",
      ),
    };
    await client.refetchQueries({ queryKey: keys.agents.detail(AGENT_ID) });
    await waitFor(() => expect(within(pin()).getByText("Completed")).toBeTruthy());
    expect(screen.getByText(/1 \/ 2/)).toBeTruthy();
    expect(document.querySelector(".agent-job-link")?.textContent).toContain("acme/api!7");
  });

  it("shows a failed load in place with a retry", async () => {
    let fail = true;
    mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: () =>
        fail
          ? jsonResponse({ error: "Something went wrong. Try again." }, 500)
          : jsonResponse(detail()),
    });
    render(<AgentDetailView tab="overview" />, {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    expect(await screen.findByText("Couldn't load the agent")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1, name: "build-01" })).toBeTruthy();
  });

  it("leaves for the agent list only once the delete succeeded and the list was invalidated", async () => {
    let resolveDelete: (response: Response) => void = () => {};
    const requests = mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: () => jsonResponse(detail()),
      [`DELETE /api/ui/agents/${AGENT_ID}`]: () =>
        new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        }),
      "GET /api/ui/agents": () => jsonResponse({ agents: [], summary: SUMMARY }),
    });
    const client = createTestQueryClient();
    // The agent list, cached from before.
    client.setQueryData(keys.agents.list(), { agents: [agent()], summary: SUMMARY });
    render(<AgentDetailView tab="overview" />, { wrapper: queryWrapper(client) });
    await userEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    resolveDelete(jsonResponse({ ok: true }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
    expect(requests.some((r) => r.method === "DELETE")).toBe(true);
    expect(client.getQueryState(keys.agents.list())?.isInvalidated).toBe(true);
  });

  it("doesn't leave when revoking fails", async () => {
    mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: () => jsonResponse(detail()),
      [`POST /api/ui/agents/${AGENT_ID}/revoke`]: () =>
        jsonResponse({ error: "That agent doesn't exist." }, 400),
    });
    render(<AgentDetailView tab="overview" />, {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Revoke agent" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke agent" })).toBeTruthy());
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("InstallForm", () => {
  it("shows the install job it started as it goes from queued to running to done", async () => {
    const JOB_ID = "00000000-0000-4000-8000-000000000001";
    const requests = mockFetch({
      [`POST /api/ui/agents/${AGENT_ID}/installs`]: { ok: true, jobId: JOB_ID },
    });
    const job = (
      status: InstallJobRow["status"],
      installedVersion: string | null = null,
    ): InstallJobRow => ({
      id: JOB_ID,
      status,
      name: "@omniralph/hello",
      version: null,
      installedVersion,
      error: null,
      createdAt: "2026-10-16T10:00:00.000Z",
    });
    const { rerender } = render(<InstallForm agentId={AGENT_ID} installJobs={[]} />, {
      wrapper: queryWrapper(createTestQueryClient()),
    });
    await userEvent.type(screen.getByLabelText("Package name"), "@omniralph/hello");
    await userEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Install requested; waiting for its job…")).toBeTruthy();
    expect(requests.at(-1)!.body).toEqual({ name: "@omniralph/hello", version: "latest" });

    const status = () =>
      document.querySelector("[data-install-status]")?.getAttribute("data-install-status");
    rerender(<InstallForm agentId={AGENT_ID} installJobs={[job("queued")]} />);
    expect(status()).toBe("queued");
    rerender(<InstallForm agentId={AGENT_ID} installJobs={[job("running")]} />);
    expect(status()).toBe("running");
    rerender(<InstallForm agentId={AGENT_ID} installJobs={[job("completed", "1.2.0")]} />);
    expect(status()).toBe("completed");
    expect(screen.getByText("Installed 1.2.0")).toBeTruthy();
  });
});
