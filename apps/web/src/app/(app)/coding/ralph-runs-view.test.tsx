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
} from "@/components/query-test-utils";
import type { RunList } from "@/lib/api/runs";
import type { RalphRunRow } from "@/lib/ralph/display";
import { RalphRunsView } from "./ralph-runs-view";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/coding",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const REPO_ID = "22222222-3333-4444-8555-000000000001";

function runRow(n: number, overrides: Partial<RalphRunRow> = {}): RalphRunRow {
  return {
    id: `33333333-4444-4555-8666-${String(n).padStart(12, "0")}`,
    origin: "linear",
    linearIdentifier: `ENG-${n}`,
    linearTitle: `Epic ${n}`,
    linearUrl: null,
    chatThread: null,
    repository: { id: REPO_ID, provider: "github", fullPath: "acme/api" },
    status: "running",
    stories: { total: 3, completed: 1 },
    branch: `eng-${n}`,
    pullRequest: null,
    agent: null,
    error: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

function list(runs: RalphRunRow[], overrides: Partial<RunList> = {}): RunList {
  return {
    runs,
    repositories: [{ id: REPO_ID, provider: "github", fullPath: "acme/api" }],
    page: 1,
    pageSize: 25,
    total: runs.length,
    linearConnected: true,
    ...overrides,
  };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  const view = render(<RalphRunsView />, {
    wrapper: queryWrapper(client, { ...testUser, role }),
  });
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

describe("RalphRunsView", () => {
  it("shows a skeleton, then the runs with when they were fetched", async () => {
    mockFetch({ "GET /api/ui/runs": list([runRow(1), runRow(2)]) });
    renderView();
    expect(screen.getByLabelText("Loading coding tasks")).toBeTruthy();
    await waitFor(() => expect(table()?.textContent).toContain("ENG-2"));
    expect(table()!.textContent).toContain("Epic 1");
    expect(document.querySelector(".freshness")?.textContent).toMatch(/^Updated /);
    expect(screen.getByText("Newest first. Showing 1–2 of 2.")).toBeTruthy();
  });

  it("shows the chosen filter at once and dims the old results until the new ones arrive", async () => {
    let release: () => void = () => {};
    const seen = mockFetch({
      "GET /api/ui/runs": async (request) => {
        if (request.query.get("status") !== "waiting") {
          return jsonResponse(list([runRow(1), runRow(2, { status: "waiting" })]));
        }
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(list([runRow(2, { status: "waiting" })]));
      },
    });
    const { view } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("ENG-1"));
    expect(table()!.getAttribute("aria-busy")).toBe("false");

    const status = screen.getByLabelText("Filter by status") as HTMLSelectElement;
    await userEvent.selectOptions(status, "waiting");
    // Before the URL has changed: the select holds the choice and its results load.
    expect(status.value).toBe("waiting");
    expect(nav.router.push).toHaveBeenCalledWith("/coding?status=waiting", { scroll: false });
    await waitFor(() =>
      expect(seen.some((request) => request.query.get("status") === "waiting")).toBe(true),
    );
    expect(table()!.getAttribute("aria-busy")).toBe("true");
    expect(table()!.textContent).toContain("ENG-1");

    // The navigation lands: the URL holds the filter now.
    nav.search = new URLSearchParams("status=waiting");
    view.rerender(<RalphRunsView />);
    expect((screen.getByLabelText("Filter by status") as HTMLSelectElement).value).toBe("waiting");

    release();
    await waitFor(() => expect(table()?.getAttribute("aria-busy")).toBe("false"));
    expect(table()!.textContent).not.toContain("ENG-1");
    expect(table()!.textContent).toContain("ENG-2");
  });

  it("filters by repository from the URL and resets to the first page", async () => {
    nav.search = new URLSearchParams("page=2");
    const seen = mockFetch({
      "GET /api/ui/runs": list([runRow(1)], { page: 2, total: 26 }),
    });
    renderView();
    await waitFor(() => expect(table()?.textContent).toContain("ENG-1"));
    expect(seen[0]!.query.get("page")).toBe("2");
    await userEvent.selectOptions(screen.getByLabelText("Filter by repository"), REPO_ID);
    expect(nav.router.push).toHaveBeenCalledWith(`/coding?repository=${REPO_ID}`, {
      scroll: false,
    });
    await waitFor(() =>
      expect(seen.some((request) => request.query.get("repository") === REPO_ID)).toBe(true),
    );
    const last = seen.at(-1)!;
    expect(last.query.get("page")).toBeNull();
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/runs": () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse(list([runRow(1)])),
    });
    renderView();
    expect(await screen.findByText("Couldn't load coding tasks")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(table()?.textContent).toContain("ENG-1"));
  });

  it("asks to connect Linear when there are no runs and no workspace", async () => {
    mockFetch({ "GET /api/ui/runs": list([], { linearConnected: false }) });
    renderView();
    expect(await screen.findByText("Connect Linear to start coding tasks")).toBeTruthy();
  });
});
