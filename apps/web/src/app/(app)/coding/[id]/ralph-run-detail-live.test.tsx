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
  testUser,
  TEST_ORGANIZATION_ID,
} from "@/components/query-test-utils";
import type { RunDetail } from "@/lib/api/runs";
import { queryKeys } from "@/lib/api/keys";
import type { RalphJobView, RalphRunDetailView, RalphStoryView } from "@/lib/ralph/display";
import { RalphRunDetailView as RunPage } from "./ralph-run-detail-view";

const RUN_ID = "44444444-5555-4666-8777-000000000001";
const JOB_ID = "55555555-6666-4777-8888-000000000001";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "44444444-5555-4666-8777-000000000001" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/coding/44444444-5555-4666-8777-000000000001",
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

function story(n: number, status: RalphStoryView["status"]): RalphStoryView {
  return {
    id: `story-${n}`,
    identifier: `ENG-${10 + n}`,
    title: `Story ${n}`,
    status,
    attempts: 1,
    lastFeedback: null,
    commitSha: null,
    lastJobId: null,
    laneId: null,
    elsewhere: null,
    recommendations: [],
  };
}

function job(overrides: Partial<RalphJobView> = {}): RalphJobView {
  return {
    id: JOB_ID,
    type: "ralph.story",
    status: "running",
    cancelRequested: false,
    deliveryCount: 1,
    error: null,
    agent: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function detail(overrides: Partial<RalphRunDetailView> = {}): RunDetail {
  const stories = overrides.stories ?? [story(1, "running"), story(2, "pending")];
  return {
    linearConnected: true,
    run: {
      id: RUN_ID,
      origin: "linear",
      linearIdentifier: "ENG-10",
      linearTitle: "Epic",
      linearUrl: null,
      chatThread: null,
      repository: { id: "r-1", provider: "github", fullPath: "acme/api" },
      status: "running",
      branch: "eng-10",
      baseBranch: "main",
      pullRequest: null,
      agent: null,
      error: null,
      updatedAt: new Date(Date.now() - 20_000).toISOString(),
      createdAt: "2026-10-16T09:00:00.000Z",
      kind: "children",
      lanes: [],
      waitingOn: null,
      guidance: [],
      progress: "",
      iterations: 1,
      maxAttemptsPerStory: 3,
      storyCounts: {
        total: stories.length,
        completed: stories.filter((s) => s.status === "completed").length,
      },
      jobs: [job()],
      pendingRequests: [],
      messages: [],
      messageLimit: 20,
      ...overrides,
      stories,
    },
  };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(<RunPage />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

const refetch = (client: ReturnType<typeof createTestQueryClient>) =>
  client.invalidateQueries({ queryKey: queryKeys(TEST_ORGANIZATION_ID).runs.detail(RUN_ID) });

/** The "Stories done" fact's value. */
function storiesDone() {
  return screen.getByText("Stories done").parentElement!.textContent;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("RalphRunDetailView", () => {
  it("shows a skeleton, then the run, and asks with the page it's on", async () => {
    const seen = mockFetch({ [`GET /api/ui/runs/${RUN_ID}`]: detail() });
    renderView();
    expect(screen.getByLabelText("Loading the coding task")).toBeTruthy();
    expect(await screen.findByText("Story 1")).toBeTruthy();
    expect(seen[0]!.query.get("next")).toBe("/");
    // "Last updated" is relative to the browser's clock.
    expect(screen.getByText("Last updated").parentElement!.textContent).toMatch(/\d+s ago/);
    expect(document.querySelector(".freshness")).toBeTruthy();
  });

  it("updates the stories, jobs and progress log when the run changes", async () => {
    let current = detail();
    mockFetch({ [`GET /api/ui/runs/${RUN_ID}`]: () => jsonResponse(current) });
    const client = renderView();
    await screen.findByText("Story 1");
    expect(storiesDone()).toContain("0 / 2");

    current = detail({
      stories: [story(1, "completed"), story(2, "running")],
      jobs: [job({ status: "completed", finishedAt: "2026-10-16T10:05:00.000Z" })],
      progress: "## ENG-11 done",
    });
    await refetch(client);
    await waitFor(() => expect(storiesDone()).toContain("1 / 2"));
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.getByText("## ENG-11 done")).toBeTruthy();
  });

  it("shows Stopping… until the run is stopped, then its job's cancel request until confirmed", async () => {
    let current = detail();
    let stopRequested: () => void = () => {};
    let respond: () => void = () => {};
    const seen = mockFetch({
      [`GET /api/ui/runs/${RUN_ID}`]: () => jsonResponse(current),
      [`POST /api/ui/runs/${RUN_ID}/stop`]: async () => {
        stopRequested();
        await new Promise<void>((resolve) => (respond = resolve));
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    const requested = new Promise<void>((resolve) => (stopRequested = resolve));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop run" }),
    );
    await requested;
    const stopping = await screen.findByRole("button", { name: "Stopping…" });
    expect((stopping as HTMLButtonElement).disabled).toBe(true);

    // Stopped: the running job waits for its harness to confirm the cancel.
    current = detail({ status: "stopped", jobs: [job({ cancelRequested: true })] });
    respond();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull());
    expect(screen.getAllByText("Cancel requested").length).toBeGreaterThan(0);
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);

    // The harness's next heartbeat confirms it.
    current = detail({
      status: "stopped",
      jobs: [
        job({ status: "canceled", cancelRequested: true, finishedAt: new Date().toISOString() }),
      ],
    });
    await refetch(client);
    await waitFor(() => expect(screen.queryByText("Cancel requested")).toBeNull());
    expect(screen.getAllByText("Canceled").length).toBeGreaterThan(0);
  });

  it("doesn't offer members the Stop button", async () => {
    mockFetch({ [`GET /api/ui/runs/${RUN_ID}`]: detail() });
    renderView("member");
    await screen.findByText("Story 1");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      [`GET /api/ui/runs/${RUN_ID}`]: () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(detail()),
    });
    renderView();
    expect(await screen.findByText("Couldn't load the coding task")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Story 1")).toBeTruthy();
  });
});
