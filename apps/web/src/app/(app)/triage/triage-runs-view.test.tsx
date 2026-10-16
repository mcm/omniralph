// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor } from "@testing-library/react";
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
import type { TriageRunList } from "@/lib/api/triage";
import type { TriageRunRow } from "@/lib/triage/display";
import { TriageRunsView } from "./triage-runs-view";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/triage",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

function runRow(n: number, overrides: Partial<TriageRunRow> = {}): TriageRunRow {
  return {
    id: `33333333-4444-4555-8666-${String(n).padStart(12, "0")}`,
    status: "running",
    trigger: "mention",
    issue: { identifier: `ENG-${n}`, title: `Issue ${n}`, url: null },
    repository: null,
    outcome: null,
    size: null,
    openQuestions: null,
    error: null,
    agent: null,
    jobCount: 1,
    createdAt: "2026-10-16T09:00:00.000Z",
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

function list(runs: TriageRunRow[], overrides: Partial<TriageRunList> = {}): TriageRunList {
  return { runs, page: 1, pageSize: 25, total: runs.length, ...overrides };
}

function renderView() {
  const client = createTestQueryClient();
  const view = render(<TriageRunsView />, { wrapper: queryWrapper(client, testUser) });
  return { client, view };
}

/** The runs table (and its pending wrapper). */
function table() {
  return document.querySelector(".list-pending") as HTMLElement | null;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  nav.search = new URLSearchParams();
  nav.router.push.mockReset();
});

describe("TriageRunsView", () => {
  it("shows a skeleton, then the runs with when they were fetched", async () => {
    mockFetch({ "GET /api/ui/triage": list([runRow(1), runRow(2)]) });
    renderView();
    expect(screen.getByLabelText("Loading triage runs")).toBeTruthy();
    await waitFor(() => expect(table()?.textContent).toContain("ENG-2"));
    expect(table()!.textContent).toContain("Issue 1");
    expect(document.querySelector(".freshness")?.textContent).toMatch(/^Updated /);
    expect(screen.getByText("Newest first. Showing 1–2 of 2.")).toBeTruthy();
  });

  it("shows a run's state and outcome as they change", async () => {
    let current = list([runRow(1)]);
    mockFetch({ "GET /api/ui/triage": () => jsonResponse(current) });
    const { client } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("Running"));

    current = list([
      runRow(1, { status: "completed", outcome: "prd", size: "L", openQuestions: 2 }),
    ]);
    await client.invalidateQueries({ queryKey: queryKeys(TEST_ORGANIZATION_ID).triage.all });
    await waitFor(() => expect(table()?.textContent).toContain("Completed"));
    expect(table()!.textContent).toContain("New PRD · L");
    expect(table()!.textContent).toContain("2 open questions");
  });

  it("shows the chosen filter at once and dims the old results until the new ones arrive", async () => {
    let release: () => void = () => {};
    const seen = mockFetch({
      "GET /api/ui/triage": async (request) => {
        if (request.query.get("status") !== "failed") {
          return jsonResponse(list([runRow(1), runRow(2, { status: "failed", error: "boom" })]));
        }
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(list([runRow(2, { status: "failed", error: "boom" })]));
      },
    });
    const { view } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("ENG-1"));
    expect(table()!.getAttribute("aria-busy")).toBe("false");

    const status = screen.getByLabelText("Filter by status") as HTMLSelectElement;
    await userEvent.selectOptions(status, "failed");
    // Before the URL has changed: the select holds the choice and its results load.
    expect(status.value).toBe("failed");
    expect(nav.router.push).toHaveBeenCalledWith("/triage?status=failed", { scroll: false });
    await waitFor(() =>
      expect(seen.some((request) => request.query.get("status") === "failed")).toBe(true),
    );
    expect(table()!.getAttribute("aria-busy")).toBe("true");
    expect(table()!.textContent).toContain("ENG-1");

    // The navigation lands: the URL holds the filter now.
    nav.search = new URLSearchParams("status=failed");
    view.rerender(<TriageRunsView />);
    expect((screen.getByLabelText("Filter by status") as HTMLSelectElement).value).toBe("failed");

    release();
    await waitFor(() => expect(table()?.getAttribute("aria-busy")).toBe("false"));
    expect(table()!.textContent).not.toContain("ENG-1");
    expect(table()!.textContent).toContain("ENG-2");

    // Back to the unfiltered URL: its filter shows, not the earlier choice.
    nav.search = new URLSearchParams();
    view.rerender(<TriageRunsView />);
    expect((screen.getByLabelText("Filter by status") as HTMLSelectElement).value).toBe("");
  });

  it("asks for the URL's page and resets to the first page on a new filter", async () => {
    nav.search = new URLSearchParams("page=2");
    const seen = mockFetch({ "GET /api/ui/triage": list([runRow(1)], { page: 2, total: 26 }) });
    renderView();
    await waitFor(() => expect(table()?.textContent).toContain("ENG-1"));
    expect(seen[0]!.query.get("page")).toBe("2");
    expect(screen.getByText("Newest first. Showing 26–26 of 26.")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "queued");
    expect(nav.router.push).toHaveBeenCalledWith("/triage?status=queued", { scroll: false });
    await waitFor(() => expect(seen.at(-1)!.query.get("status")).toBe("queued"));
    expect(seen.at(-1)!.query.get("page")).toBeNull();
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/triage": () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse(list([runRow(1)])),
    });
    renderView();
    expect(await screen.findByText("Couldn't load triage runs")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(table()?.textContent).toContain("ENG-1"));
  });

  it("stands in for an empty list", async () => {
    mockFetch({ "GET /api/ui/triage": list([]) });
    renderView();
    expect(await screen.findByText("No triage runs yet")).toBeTruthy();
  });
});
