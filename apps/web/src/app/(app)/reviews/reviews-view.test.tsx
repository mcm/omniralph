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
import type { ReviewList } from "@/lib/api/reviews";
import { queryKeys } from "@/lib/api/keys";
import type { ReviewRow } from "@/lib/reviews/display";
import { ReviewsView } from "./reviews-view";

const REPO_ID = "22222222-2222-4222-8222-222222222222";

const nav = vi.hoisted(() => ({
  pathname: "/reviews",
  params: {} as Record<string, string>,
  search: new URLSearchParams(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useParams: () => nav.params,
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const ERROR = "The harness lost its session (exit code 137) while cloning the repository.";
const YEAR = new Date().getFullYear();

function review(n: number, overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
    repository: { id: REPO_ID, provider: "github", fullPath: "fixture-labs/legacy-dashboard" },
    prNumber: 330 + n,
    prTitle: `Change ${n}`,
    prUrl: `https://github.com/fixture-labs/legacy-dashboard/pull/${330 + n}`,
    trigger: "webhook",
    status: "completed",
    profileName: "Deep",
    agent: { id: "33333333-3333-4333-8333-333333333333", name: "build-01" },
    findingCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    tokensUsed: 1000,
    budget: 2000,
    durationMs: 60_000,
    error: null,
    createdAt: `${YEAR}-10-09T00:42:00.000Z`,
    ...overrides,
  };
}

function list(reviews: ReviewRow[], overrides: Partial<ReviewList> = {}): ReviewList {
  return { reviews, page: 1, pageSize: 25, total: reviews.length, repository: null, ...overrides };
}

function renderView({
  role = "admin",
  inRepository = false,
}: { role?: "admin" | "member"; inRepository?: boolean } = {}) {
  const client = createTestQueryClient();
  const view = render(<ReviewsView inRepository={inRepository} />, {
    wrapper: queryWrapper(client, { ...testUser, role }),
  });
  return { client, view };
}

/** The reviews table (and its pending wrapper). */
function table() {
  return document.querySelector(".list-pending") as HTMLElement | null;
}

/** The `<tr>` elements of the table body. */
function bodyRows(): HTMLTableRowElement[] {
  return [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")];
}

beforeEach(() => {
  vi.unstubAllGlobals();
  nav.pathname = "/reviews";
  nav.params = {};
  nav.search = new URLSearchParams();
  nav.router.push.mockReset();
});

describe("ReviewsView", () => {
  it("shows a skeleton, then the reviews with when they were fetched", async () => {
    const seen = mockFetch({ "GET /api/ui/reviews": list([review(1), review(2)]) });
    renderView();
    expect(screen.getByLabelText("Loading reviews")).toBeTruthy();
    await waitFor(() => expect(table()?.textContent).toContain("Change 2"));
    expect(document.querySelector(".freshness")?.textContent).toMatch(/^Updated /);
    expect(screen.getByText("Newest first. Showing 1–2 of 2.")).toBeTruthy();
    expect(seen[0]!.query.get("repository")).toBeNull();
  });

  it("updates a review's status when it changes", async () => {
    let current = list([review(1, { status: "running" })]);
    mockFetch({ "GET /api/ui/reviews": () => jsonResponse(current) });
    const { client } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("Running"));

    current = list([
      review(1, { findingCounts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } }),
    ]);
    await client.invalidateQueries({ queryKey: queryKeys(TEST_ORGANIZATION_ID).reviews.all });
    await waitFor(() => expect(table()?.textContent).toContain("Completed"));
    expect(table()!.textContent).toContain("critical");
  });

  it("shows the chosen filter at once and dims the old results until the new ones arrive", async () => {
    let release: () => void = () => {};
    const seen = mockFetch({
      "GET /api/ui/reviews": async (request) => {
        if (request.query.get("trigger") !== "mention") {
          return jsonResponse(list([review(1), review(2, { trigger: "mention" })]));
        }
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(list([review(2, { trigger: "mention" })]));
      },
    });
    const { view } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("Change 1"));
    expect(table()!.getAttribute("aria-busy")).toBe("false");

    const trigger = screen.getByLabelText("Filter by trigger") as HTMLSelectElement;
    await userEvent.selectOptions(trigger, "mention");
    expect(trigger.value).toBe("mention");
    expect(nav.router.push).toHaveBeenCalledWith("/reviews?trigger=mention", { scroll: false });
    await waitFor(() =>
      expect(seen.some((request) => request.query.get("trigger") === "mention")).toBe(true),
    );
    expect(table()!.getAttribute("aria-busy")).toBe("true");
    expect(table()!.textContent).toContain("Change 1");

    nav.search = new URLSearchParams("trigger=mention");
    view.rerender(<ReviewsView />);
    expect((screen.getByLabelText("Filter by trigger") as HTMLSelectElement).value).toBe("mention");

    release();
    await waitFor(() => expect(table()?.getAttribute("aria-busy")).toBe("false"));
    expect(table()!.textContent).not.toContain("Change 1");
    expect(table()!.textContent).toContain("Change 2");
  });

  it("lists a repository's reviews under its header and tabs", async () => {
    nav.pathname = `/repositories/${REPO_ID}/reviews`;
    nav.params = { id: REPO_ID };
    nav.search = new URLSearchParams("status=failed&page=2");
    const seen = mockFetch({
      "GET /api/ui/reviews": list([review(1)], {
        page: 2,
        total: 26,
        repository: {
          id: REPO_ID,
          provider: "github",
          fullPath: "fixture-labs/legacy-dashboard",
          webUrl: "https://github.com/fixture-labs/legacy-dashboard",
          connected: true,
        },
      }),
    });
    renderView({ inRepository: true });
    await waitFor(() => expect(table()?.textContent).toContain("Change 1"));
    expect(seen[0]!.query.get("repository")).toBe(REPO_ID);
    expect(seen[0]!.query.get("status")).toBe("failed");
    expect(seen[0]!.query.get("page")).toBe("2");
    expect(screen.getByRole("link", { name: /Open on GitHub/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Rules/ })).toBeTruthy();
    // Rows don't repeat the repository.
    expect(bodyRows()[0]!.textContent).not.toContain("legacy-dashboard");
    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "");
    expect(nav.router.push).toHaveBeenCalledWith(`/repositories/${REPO_ID}/reviews`, {
      scroll: false,
    });
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/reviews": () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse(list([review(1)])),
    });
    renderView();
    expect(await screen.findByText("Couldn't load reviews")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(table()?.textContent).toContain("Change 1"));
  });

  it("puts a failed review's reason in its own full-width row, not the status cell", async () => {
    mockFetch({ "GET /api/ui/reviews": list([review(1, { status: "failed", error: ERROR })]) });
    renderView();
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    const [row, errorRow] = bodyRows();
    expect(row!.hasAttribute("data-has-error")).toBe(true);
    expect(row!.textContent).not.toContain(ERROR);
    expect(errorRow!.className).toContain("list-error-row");
    expect(errorRow!.querySelector("td")!.colSpan).toBe(7);
    expect(errorRow!.textContent).toContain(ERROR);
  });

  it("adds no error row for a review that didn't fail", async () => {
    mockFetch({
      "GET /api/ui/reviews": list([review(1, { error: ERROR }), review(2, { status: "failed" })]),
    });
    renderView();
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(document.querySelector(".list-error-row")).toBeNull();
    expect(document.querySelector("[data-has-error]")).toBeNull();
  });

  it("shows severity words when they fit the column, else initials", async () => {
    mockFetch({
      "GET /api/ui/reviews": list([
        review(1, { findingCounts: { critical: 1, high: 1, medium: 0, low: 0, info: 0 } }),
        review(2, { findingCounts: { critical: 0, high: 0, medium: 1, low: 1, info: 1 } }),
      ]),
    });
    renderView();
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    const [fits, tooLong] = bodyRows();
    expect(fits!.innerHTML).toContain('class="severity-counts"');
    expect(tooLong!.innerHTML).toContain('class="severity-counts severity-counts-short"');
  });

  it("drops the current year from Created", async () => {
    mockFetch({ "GET /api/ui/reviews": list([review(1)]) });
    renderView();
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    for (const time of bodyRows()[0]!.querySelectorAll("time")) {
      expect(time.textContent).not.toContain(String(YEAR));
    }
  });

  it("offers members no Re-run", async () => {
    mockFetch({ "GET /api/ui/reviews": list([review(1)]) });
    renderView({ role: "member" });
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /Re-run/ })).toBeNull();
  });
});
