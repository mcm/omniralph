// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import { LiveProvider } from "@/components/live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "@/components/live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { RunList, RunRow } from "@/lib/api/runs";
import { createQueryClient } from "@/lib/api/query-client";
import { RunsView } from "./runs-view";
import {
  askRow,
  BETA_ID,
  FILTER_OPTIONS,
  NOW,
  REPO_PORTAL,
  REPO_WEB,
  reviewRow,
  runRow,
} from "./test-fixtures";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));

function TestLink({ href, onClick, ...props }: LinkProps) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        nav.router.push(href);
      }}
    />
  );
}

const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

/** The pages `GET /api/ui/runs` answers, by cursor ("" for the first). */
let pages: Record<string, RunList>;
let seen: SeenRequest[];

function serve() {
  seen = mockFetch({
    "GET /api/ui/runs": (request) =>
      jsonResponse(pages[request.query.get("cursor") ?? ""] ?? { runs: [], nextCursor: null }),
    "GET /api/ui/runs/filter-options": FILTER_OPTIONS,
  });
}

function renderRuns(
  options: {
    search?: string;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
  } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = options.client ?? createTestQueryClient();
  const user = options.user ?? testUser;
  const tree = () => (
    <CurrentUserProvider user={user}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          {options.live ? (
            <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
              <RunsView />
            </LiveProvider>
          ) : (
            <RunsView />
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>
  );
  const utils = render(tree());
  return {
    ...utils,
    client,
    navigate: (search: string) => {
      nav.search = new URLSearchParams(search);
      utils.rerender(tree());
    },
  };
}

const rows = () =>
  screen.queryAllByRole("listitem").filter((row) => row.classList.contains("or-row"));
const titles = () => rows().map((row) => row.querySelector(".or-row__title")!.textContent);
const runRequests = () => seen.filter((request) => request.path === "/api/ui/runs");
const lastRunRequest = () => runRequests().at(-1)!;
const badges = (row: HTMLElement) =>
  [...row.querySelectorAll(".or-row__meta > *")].map((badge) => badge.textContent!.trim());
/** A menu's checkable items by their visible label (marks left out). */
const choices = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitemcheckbox")
    .map((item) => item.querySelector(".or-menu__label")!.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  pages = {
    "": {
      runs: [runRow(), reviewRow({ organization: runRow().organization }), askRow()],
      nextCursor: null,
    },
  };
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Runs rail", () => {
  it("shows the title, the Kind, Status and Repo filters at All and the runs newest first", async () => {
    renderRuns();
    expect(screen.getByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
    const filters = screen.getByRole("group", { name: "Filters" });
    expect(
      within(filters)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Kind: All", "Status: All", "Repo: All"]);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(titles()).toEqual([
      "Customer portal billing export",
      "Review of pull request #7",
      "Which repo has the billing service?",
    ]);
    expect(
      within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem"),
    ).toHaveLength(3);
    const request = lastRunRequest();
    expect(request.query.get("organization")).toBe(TEST_ORGANIZATION_ID);
    expect(request.query.getAll("kind")).toEqual([]);
    expect(
      seen.find((r) => r.path === "/api/ui/runs/filter-options")!.query.get("organization"),
    ).toBe(TEST_ORGANIZATION_ID);
  });

  it("renders each run as a row: dot and label, title, age and badges without an organization", async () => {
    pages[""] = {
      runs: [
        runRow({
          status: "running",
          progress: { done: 1, total: 4, running: 2 },
          createdAt: new Date(NOW).toISOString(),
        }),
        reviewRow({ organization: runRow().organization }),
        askRow(),
      ],
      nextCursor: null,
    };
    renderRuns();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [epic, review, ask] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    const dot = (row: HTMLElement) => row.querySelector(".or-dot")!;
    expect(dot(epic).getAttribute("aria-label")).toBe("Running · story 2 of 4");
    expect(dot(epic).classList.contains("or-dot--run")).toBe(true);
    expect(dot(review).getAttribute("aria-label")).toBe("Review · failed");
    expect(dot(review).classList.contains("or-dot--fail")).toBe(true);
    expect(dot(ask).getAttribute("aria-label")).toBe("Ask · waiting on you");
    expect(dot(ask).classList.contains("or-dot--need")).toBe(true);
    expect([epic, review, ask].map((row) => row.querySelector("time")!.textContent)).toEqual([
      "now",
      "2h",
      "3d",
    ]);
    // Work item, repo, then the PR/MR; no organization with one organization selected.
    expect(badges(epic)).toEqual(["Linear TOOL-42", "GitLab acme/portal", "!12"]);
    expect(badges(review)).toEqual(["GitHub beta/web", "#7"]);
    expect(badges(ask)).toEqual([]);
    // The row link opens the run.
    expect(within(epic).getByRole("link").getAttribute("href")).toBe(`/runs/${runRow().id}`);
    // No reason, findings count or summary in a row (Design rule 8).
    for (const row of rows()) {
      expect(row.textContent).not.toMatch(/finding|error|because|summary|tokens/i);
    }
  });

  it("asks for every organization and leads each row with its organization under All organizations", async () => {
    pages[""] = { runs: [runRow(), reviewRow()], nextCursor: null };
    renderRuns({ user: allOrganizations });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(lastRunRequest().query.get("organization")).toBe("all");
    const [epic, review] = rows() as [HTMLElement, HTMLElement];
    expect(badges(epic)).toEqual(["Acme", "Linear TOOL-42", "GitLab acme/portal", "!12"]);
    expect(badges(review)).toEqual(["Beta", "GitHub beta/web", "#7"]);
  });

  it("keeps the filters on a row's link", async () => {
    renderRuns({ search: "kind=epic&status=completed" });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(within(rows()[0]!).getByRole("link").getAttribute("href")).toBe(
      `/runs/${runRow().id}?kind=epic&status=completed`,
    );
  });

  it("renders through SplitView with the default list widths", async () => {
    const { container } = renderRuns();
    const split = container.querySelector<HTMLElement>(".or-split")!;
    expect(split.classList.contains("or-runs")).toBe(true);
    expect(split.style.getPropertyValue("--or-split-wide")).toBe("340px");
    expect(split.style.getPropertyValue("--or-split-narrow")).toBe("300px");
    expect(split.getAttribute("data-view")).toBe("list");
    expect(screen.getByRole("region", { name: "Runs" })).toBeTruthy();
  });

  it("shows no stats line, no Live or Updated indicator and no notice of its own", async () => {
    renderRuns();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const rail = screen.getByRole("region", { name: "Runs" });
    expect(rail.textContent).not.toMatch(/\bLive\b|Updated|ago\b|runs today|success rate|tokens/i);
    expect(within(rail).queryAllByRole("status")).toEqual([]);
    expect(within(rail).queryAllByRole("alert")).toEqual([]);
  });
});

describe("the filters", () => {
  async function openFilter(name: string) {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name }));
    return { user, menu: await screen.findByRole("menu") };
  }

  it("offer the five kinds and seven statuses", async () => {
    renderRuns();
    const kind = await openFilter("Kind: All");
    expect(
      within(kind.menu)
        .getAllByRole("menuitemcheckbox")
        .map((item) => item.textContent),
    ).toEqual(["All", "Epic", "Request", "Review", "Triage", "Ask"]);
    await kind.user.keyboard("{Escape}");
    const status = await openFilter("Status: All");
    expect(
      within(status.menu)
        .getAllByRole("menuitemcheckbox")
        .map((item) => item.textContent),
    ).toEqual([
      "All",
      "Queued",
      "Running",
      "Waiting on you",
      "Finished",
      "Failed",
      "Stopped",
      "Skipped",
    ]);
    expect(within(status.menu).getByRole("menuitem", { name: "Clear" })).toBeTruthy();
  });

  it("write repeatable kind and status parameters, and refetch with them", async () => {
    const { navigate } = renderRuns();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const { user, menu } = await openFilter("Kind: All");
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Review" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/runs?kind=review", { scroll: false });

    navigate("kind=review");
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitemcheckbox", { name: "Epic" }),
    );
    expect(nav.router.push).toHaveBeenLastCalledWith("/runs?kind=epic&kind=review", {
      scroll: false,
    });
    await user.keyboard("{Escape}");

    pages[""] = { runs: [reviewRow({ status: "running" })], nextCursor: null };
    navigate("kind=epic&kind=review&status=running&status=failed");
    await waitFor(() => expect(titles()).toEqual(["Review of pull request #7"]));
    expect(lastRunRequest().query.getAll("kind")).toEqual(["epic", "review"]);
    expect(lastRunRequest().query.getAll("status")).toEqual(["running", "failed"]);
    expect(screen.getByRole("button", { name: "Kind: Epic, Review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Status: Running, Failed" })).toBeTruthy();

    const status = await openFilter("Status: Running, Failed");
    await status.user.click(within(status.menu).getByRole("menuitem", { name: "Clear" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/runs?kind=epic&kind=review", {
      scroll: false,
    });
  });

  it("keep the previous runs on the rail while the filtered list loads", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    seen = mockFetch({
      "GET /api/ui/runs": async (request) => {
        if (request.query.getAll("kind").includes("review")) {
          await held;
          return jsonResponse({ runs: [reviewRow()], nextCursor: null });
        }
        return jsonResponse(pages[""]);
      },
      "GET /api/ui/runs/filter-options": FILTER_OPTIONS,
    });
    const { navigate } = renderRuns();
    await waitFor(() => expect(rows()).toHaveLength(3));

    navigate("kind=review");
    await waitFor(() => expect(lastRunRequest().query.getAll("kind")).toEqual(["review"]));
    expect(rows()).toHaveLength(3);
    expect(screen.queryByText("No runs yet")).toBeNull();

    release();
    await waitFor(() => expect(titles()).toEqual(["Review of pull request #7"]));
  });

  it("offer the scope's repositories with their code-host marks, and write repository parameters", async () => {
    const { navigate } = renderRuns();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const { user, menu } = await openFilter("Repo: All");
    await waitFor(() =>
      expect(choices(menu)).toEqual(["All", "acme/portal", "acme/web", "beta/web"]),
    );
    const portal = within(menu).getByRole("menuitemcheckbox", { name: "acme/portal" });
    expect(portal.querySelector(".or-menu__mark .or-brand-mark")!.getAttribute("aria-label")).toBe(
      "GitLab",
    );
    // One organization: no groups.
    expect(within(menu).queryAllByRole("group")).toEqual([]);
    await user.click(portal);
    expect(nav.router.push).toHaveBeenLastCalledWith(`/runs?repository=${REPO_PORTAL}`, {
      scroll: false,
    });
    await user.keyboard("{Escape}");

    navigate(`repository=${REPO_PORTAL}&repository=${REPO_WEB}`);
    await waitFor(() =>
      expect(lastRunRequest().query.getAll("repository")).toEqual([REPO_PORTAL, REPO_WEB]),
    );
    expect(screen.getByRole("button", { name: "Repo: acme/portal, acme/web" })).toBeTruthy();
  });

  it("group the repositories by organization under All organizations", async () => {
    renderRuns({ user: allOrganizations });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(
      seen.find((r) => r.path === "/api/ui/runs/filter-options")!.query.get("organization"),
    ).toBe("all");
    const { menu } = await openFilter("Repo: All");
    const acme = await within(menu).findByRole("group", { name: "Acme" });
    expect(choices(acme)).toEqual(["acme/portal", "acme/web"]);
    expect(within(menu).getByRole("group", { name: "Beta" }).textContent).toContain("beta/web");
  });

  it("drop page and unknown parameters from the request", async () => {
    renderRuns({ search: "page=2&origin=chat&kind=bogus&kind=triage" });
    await waitFor(() => expect(runRequests().length).toBeGreaterThan(0));
    const query = lastRunRequest().query;
    expect([...query.keys()].sort()).toEqual(["kind", "organization"]);
    expect(query.getAll("kind")).toEqual(["triage"]);
  });
});

describe("empty lists", () => {
  it("offer to clear the filters when none match", async () => {
    pages[""] = { runs: [], nextCursor: null };
    renderRuns({ search: "status=failed" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "No runs match these filters" }),
    ).toBeTruthy();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/runs", { scroll: false });
    expect(screen.queryByText("No runs yet")).toBeNull();
  });

  it("say No runs yet without filters", async () => {
    pages[""] = { runs: [], nextCursor: null };
    renderRuns();
    expect(await screen.findByRole("heading", { level: 2, name: "No runs yet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });
});

describe("Show more", () => {
  it("loads the next page with nextCursor and appends it, then hides", async () => {
    pages = {
      "": { runs: [runRow()], nextCursor: "page-2" },
      "page-2": { runs: [reviewRow()], nextCursor: null },
    };
    renderRuns({ search: "kind=epic&kind=review" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() =>
      expect(titles()).toEqual(["Customer portal billing export", "Review of pull request #7"]),
    );
    expect(lastRunRequest().query.get("cursor")).toBe("page-2");
    expect(lastRunRequest().query.getAll("kind")).toEqual(["epic", "review"]);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("is hidden when nextCursor is null", async () => {
    renderRuns();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});

describe("live updates", () => {
  it("refetch the list on a run change event and show the run's new state", async () => {
    const live = fakeAbly();
    renderRuns({ live });
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const before = runRequests().length;
    const failed: RunRow = { ...runRow(), status: "failed" };
    pages[""] = { runs: [failed, ...pages[""]!.runs.slice(1)], nextCursor: null };
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: runRow().id }),
        ),
    );
    await waitFor(() => expect(runRequests().length).toBe(before + 1));
    await waitFor(() =>
      expect(rows()[0]!.querySelector(".or-dot")!.getAttribute("aria-label")).toBe("Epic · failed"),
    );
  });

  it("set no refetchInterval of their own", async () => {
    const client = createQueryClient();
    renderRuns({ client });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const fallback = client.getDefaultOptions().queries!.refetchInterval;
    const queries = client.getQueryCache().findAll({ queryKey: [TEST_ORGANIZATION_ID, "runs"] });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.observers.length).toBeGreaterThan(0);
      for (const observer of query.observers) {
        expect(observer.options.refetchInterval).toBe(fallback);
      }
    }
    client.clear();
  });
});
