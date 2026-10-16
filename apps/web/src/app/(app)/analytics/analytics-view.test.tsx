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
import type { AnalyticsResponse } from "@/lib/api/analytics";
import { queryKeys } from "@/lib/api/keys";
import { REVIEW_STATUSES } from "@/lib/reviews/display";
import { AnalyticsView } from "./analytics-view";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/analytics",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const REPO = "11111111-2222-4333-8444-555555555555";

const zero = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
const RUNS = ["completed", "waiting", "stopped", "failed", "running"] as const;
const STORIES = ["firstAttempt", "afterRetries", "exhausted", "blocked"] as const;

function response({
  reviews = 3,
  runs = 0,
  days = 30,
  repositoryId = null,
}: {
  reviews?: number;
  runs?: number;
  days?: 7 | 30 | 90;
  repositoryId?: string | null;
} = {}): AnalyticsResponse {
  const window = { from: "2026-10-15T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z" };
  const dates = ["2026-10-15", "2026-10-16"];
  return {
    analytics: {
      ...window,
      totals: { reviews, tokensIn: 1200, tokensOut: 300 },
      daily: dates.map((date) => ({ date, reviews: 0, tokensIn: 0, tokensOut: 0 })),
      byProfile: [],
      reviewsByStatus: { ...zero(REVIEW_STATUSES), completed: reviews },
      findingsBySeverity: { critical: 0, high: 2, medium: 0, low: 0, info: 0 },
      dismissalsByRepository: [],
      jobsByHarness: [
        { agent: { id: "h1", name: "build-box" }, total: 4, completed: 3, failed: 1 },
      ],
    },
    ralph: {
      ...window,
      totals: { runs, jobs: 0, tokensIn: 0, tokensOut: 0 },
      daily: dates.map((date) => ({
        date,
        tokensIn: 0,
        tokensOut: 0,
        runs: zero(RUNS),
        stories: zero(STORIES),
      })),
      runsByOutcome: { ...zero(RUNS), running: runs },
      storyOutcomes: zero(STORIES),
      averageAttempts: 0,
    },
    repositories: [{ id: REPO, provider: "github", fullPath: "acme/app" }],
    params: { days, repositoryId },
  };
}

function renderView() {
  const client = createTestQueryClient();
  const view = render(<AnalyticsView />, { wrapper: queryWrapper(client, testUser) });
  return { client, view };
}

/** The figures (and their pending wrapper). */
function figures() {
  return document.querySelector(".list-pending") as HTMLElement | null;
}

/** The headline tiles' text. */
function metrics() {
  return figures()?.querySelector(".analytics-metrics")?.textContent ?? "";
}

beforeEach(() => {
  vi.unstubAllGlobals();
  nav.search = new URLSearchParams();
  nav.router.push.mockReset();
});

describe("AnalyticsView", () => {
  it("shows a skeleton, then the figures with when they were fetched", async () => {
    mockFetch({ "GET /api/ui/analytics": response() });
    renderView();
    expect(screen.getByLabelText("Loading analytics")).toBeTruthy();
    await waitFor(() => expect(metrics()).toContain("Reviews3"));
    expect(figures()!.textContent).toContain("build-box");
    expect(document.querySelector(".freshness")?.textContent).toMatch(/^Updated /);
    expect(
      screen.getByText(
        "Token usage, review quality and coding tasks for all repositories, last 30 days by UTC day.",
      ),
    ).toBeTruthy();
  });

  it("shows new reviews and runs as they are recorded", async () => {
    let current = response();
    mockFetch({ "GET /api/ui/analytics": () => jsonResponse(current) });
    const { client } = renderView();
    await waitFor(() => expect(metrics()).toContain("Reviews3"));
    expect(screen.getAllByText("No coding tasks").length).toBeGreaterThan(0);

    current = response({ reviews: 4, runs: 1 });
    await client.invalidateQueries({ queryKey: queryKeys(TEST_ORGANIZATION_ID).analytics.all });
    await waitFor(() => expect(metrics()).toContain("Reviews4"));
    expect(figures()!.textContent).toContain("Runs started1");
    expect(screen.queryByText("No coding tasks")).toBeNull();
  });

  it("shows the chosen window at once and dims the old figures until the new ones arrive", async () => {
    let release: () => void = () => {};
    const seen = mockFetch({
      "GET /api/ui/analytics": async (request) => {
        if (request.query.get("days") !== "7") return jsonResponse(response());
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(response({ reviews: 1, days: 7 }));
      },
    });
    const { view } = renderView();
    await waitFor(() => expect(metrics()).toContain("Reviews3"));
    expect(figures()!.getAttribute("aria-busy")).toBe("false");

    await userEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    // Before the URL has changed: the toggle holds the choice and its figures load.
    expect(screen.getByRole("radio", { name: "Last 7 days" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(nav.router.push).toHaveBeenCalledWith("/analytics?days=7", { scroll: false });
    await waitFor(() =>
      expect(seen.some((request) => request.query.get("days") === "7")).toBe(true),
    );
    expect(figures()!.getAttribute("aria-busy")).toBe("true");
    expect(metrics()).toContain("Reviews3");

    nav.search = new URLSearchParams("days=7");
    view.rerender(<AnalyticsView />);
    release();
    await waitFor(() => expect(figures()?.getAttribute("aria-busy")).toBe("false"));
    expect(metrics()).toContain("Reviews1");

    // Back to the default window: its toggle shows, not the earlier choice.
    nav.search = new URLSearchParams();
    view.rerender(<AnalyticsView />);
    expect(screen.getByRole("radio", { name: "Last 30 days" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("filters by repository from the URL and from the select", async () => {
    nav.search = new URLSearchParams(`repo=${REPO}`);
    const seen = mockFetch({
      "GET /api/ui/analytics": (request) =>
        jsonResponse(response({ repositoryId: request.query.get("repo") })),
    });
    renderView();
    await waitFor(() => expect(metrics()).toContain("Reviews3"));
    expect(seen[0]!.query.get("repo")).toBe(REPO);
    const select = screen.getByLabelText("Filter by repository") as HTMLSelectElement;
    expect(select.value).toBe(REPO);
    expect(screen.getByText(/coding tasks for acme\/app, last 30 days/)).toBeTruthy();

    await userEvent.selectOptions(select, "");
    expect(select.value).toBe("");
    expect(nav.router.push).toHaveBeenCalledWith("/analytics", { scroll: false });
    await waitFor(() => expect(seen.at(-1)!.query.get("repo")).toBeNull());
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/analytics": () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(response()),
    });
    renderView();
    expect(await screen.findByText("Couldn't load analytics")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(metrics()).toContain("Reviews3"));
  });
});
