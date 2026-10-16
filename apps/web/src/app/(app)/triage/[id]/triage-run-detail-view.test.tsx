// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen } from "@testing-library/react";
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
import { queryKeys } from "@/lib/api/keys";
import type { TriageRunDetailView as TriageRunDetail } from "@/lib/triage/display";
import { TriageRunDetailView } from "./triage-run-detail-view";

const RUN_ID = "11111111-2222-4333-8444-000000000001";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "11111111-2222-4333-8444-000000000001" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/triage/11111111-2222-4333-8444-000000000001",
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

function detail(overrides: Partial<TriageRunDetail> = {}): TriageRunDetail {
  return {
    id: RUN_ID,
    status: "completed",
    trigger: "label",
    issue: { identifier: "TOOL-7", title: "Add exports", url: "https://linear.app/a/TOOL-7" },
    repository: { provider: "github", fullPath: "acme/app", url: "https://github.com/acme/app" },
    outcome: "prd",
    size: "L",
    openQuestions: 1,
    error: null,
    agent: { id: "h-1", name: "builder" },
    jobCount: 1,
    createdAt: "2026-10-13T09:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
    linearAgentSessionId: "session-1",
    branch: "main",
    pendingReply: null,
    result: {
      summary: "Wrote a PRD with two stories.",
      error: null,
      outcome: {
        outcome: "prd",
        size: "L",
        title: "Add exports",
        description: "## Problem\n\nNo exports.",
        openQuestions: ["Which formats?"],
        stories: [
          { title: "Export CSV", body: "CSV body", priority: 2, dependsOn: [], manual: false },
          { title: "Ask legal", body: "Legal body", priority: 3, dependsOn: [0], manual: true },
        ],
        subIssueUpdates: [],
      },
      usage: { inputTokens: 1200, outputTokens: 300 },
      durationMs: 65_000,
    },
    jobs: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        cancelRequested: false,
        deliveryCount: 1,
        error: null,
        agent: { id: "h-1", name: "builder" },
        reply: "CSV only please",
        createdAt: "2026-10-13T09:01:00.000Z",
        finishedAt: "2026-10-13T09:05:00.000Z",
      },
    ],
    activities: [
      {
        id: "a-1",
        jobId: "22222222-2222-4222-8222-222222222222",
        type: "action",
        body: "Grep",
        parameter: "export",
        createdAt: "2026-10-13T09:02:00.000Z",
      },
    ],
    ...overrides,
  };
}

const DETAIL = `GET /api/ui/triage/${RUN_ID}`;

/** Renders the run's page answering `run`, and resolves to its HTML once it's loaded. */
async function show(run: TriageRunDetail): Promise<string> {
  mockFetch({ [DETAIL]: { run } });
  renderView();
  await screen.findByLabelText("Triage facts");
  return document.body.innerHTML;
}

function renderView(role: "admin" | "member" = "member") {
  const client = createTestQueryClient();
  render(<TriageRunDetailView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("TriageRunDetailView", () => {
  it("shows the issue, the facts, the result and the jobs", async () => {
    const html = await show(detail());
    expect(html).toContain("TOOL-7");
    expect(html).toContain("Add exports");
    expect(html).toContain('href="https://linear.app/a/TOOL-7"');
    expect(html).toContain("Triage label");
    expect(html).toContain("acme/app");
    expect(html).toContain("New PRD");
    expect(html).toContain("1,200 / 300");
    expect(html).toContain("1m 05s");
    expect(html).toContain("Wrote a PRD with two stories.");
    expect(html).toContain("Which formats?");
    expect(html).toContain("## Problem");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Manual");
    expect(html).toContain("#1");
    expect(html).toContain("Reply: CSV only please");
    expect(html).toContain("/jobs?job=22222222-2222-4222-8222-222222222222");
    expect(html).toContain("Session activity");
    expect(html).toContain("Grep");
  });

  it("says why a run failed and which reply waits", async () => {
    const html = await show(
      detail({
        status: "failed",
        error: "the triage ended without a result (error)",
        pendingReply: "Try again with JSON",
        result: null,
      }),
    );
    expect(html).toContain("Triage failed");
    expect(html).toContain("the triage ended without a result (error)");
    expect(html).toContain("Reply waiting");
    expect(html).toContain("Try again with JSON");
    expect(html).not.toContain("Summary");
  });

  it("stands in for a run with no job yet", async () => {
    const html = await show(
      detail({
        status: "queued",
        issue: null,
        repository: null,
        outcome: null,
        size: null,
        result: null,
        jobs: [],
        activities: [],
        jobCount: 0,
      }),
    );
    expect(html).toContain("Triage");
    expect(html).toContain("Not chosen yet");
    expect(html).toContain("Nothing yet");
  });

  it("shows a skeleton, then the run, and asks with the page it's on", async () => {
    const seen = mockFetch({
      [DETAIL]: { run: detail({ updatedAt: new Date(Date.now() - 20_000).toISOString() }) },
    });
    renderView();
    expect(screen.getByLabelText("Loading the triage run")).toBeTruthy();
    expect(await screen.findByText("Wrote a PRD with two stories.")).toBeTruthy();
    expect(seen[0]!.query.get("next")).toBe("/");
    // "Last updated" is relative to the browser's clock.
    expect(screen.getByText("Last updated").parentElement!.textContent).toMatch(/\d+s ago/);
    expect(document.querySelector(".freshness")).toBeTruthy();
  });

  it("shows the result and the job's outcome when the triage finishes", async () => {
    const running = detail({
      status: "running",
      outcome: null,
      size: null,
      openQuestions: null,
      result: null,
      jobs: [{ ...detail().jobs[0]!, status: "running", finishedAt: null }],
    });
    let current = running;
    mockFetch({ [DETAIL]: () => jsonResponse({ run: current }) });
    const client = renderView();
    expect(await screen.findByRole("heading", { name: "Jobs" })).toBeTruthy();
    expect(screen.queryByText("Summary")).toBeNull();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);

    current = detail();
    await client.invalidateQueries({ queryKey: queryKeys(TEST_ORGANIZATION_ID).triage.all });
    expect(await screen.findByText("Wrote a PRD with two stories.")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.getByText("Export CSV")).toBeTruthy();
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      [DETAIL]: () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse({ run: detail() }),
    });
    renderView();
    expect(await screen.findByText("Couldn't load the triage run")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Wrote a PRD with two stories.")).toBeTruthy();
  });
});
