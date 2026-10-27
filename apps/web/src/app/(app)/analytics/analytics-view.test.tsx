// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
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
import type { RunAnalyticsResponse } from "@/lib/api/analytics";
import {
  analyticsFixture,
  FRAKINSHIP,
  NETBUILDER,
  REPO_OMNIRALPH,
  REPO_PORTAL,
  totalTokens,
  type FixtureOptions,
} from "./analytics-fixtures";
import { ANALYTICS_LIVE_THROTTLE_MS } from "./analytics-queries";
import { AnalyticsView, COST_NOTE } from "./analytics-view";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/analytics",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const netbuilderUser: SessionUser = {
  ...testUser,
  organization: NETBUILDER,
  organizations: [{ ...NETBUILDER, role: "admin" }],
};

const allOrganizations: SessionUser = {
  ...netbuilderUser,
  scope: "all",
  organizations: [
    { ...NETBUILDER, role: "admin" },
    { ...FRAKINSHIP, role: "member" },
  ],
};

let seen: SeenRequest[];
let respond: (request: SeenRequest) => Response | Promise<Response>;

/** Answers the fixture for each request's filters (and `options`). */
function serve(options: Omit<FixtureOptions, "days" | "scope" | "repositoryId"> = {}) {
  respond = (request) =>
    jsonResponse(
      analyticsFixture({
        ...options,
        days: Number(request.query.get("days")) as 7 | 30 | 90,
        scope: request.query.get("organization") === "all" ? "all" : "single",
        repositoryId: request.query.get("repository"),
      }),
    );
}

function renderView(
  options: { user?: SessionUser; client?: QueryClient; live?: ReturnType<typeof fakeAbly> } = {},
) {
  const client = options.client ?? createTestQueryClient();
  const user = options.user ?? netbuilderUser;
  const tree = () => {
    const view = <AnalyticsView scope={user.scope === "all" ? "all" : user.organization.id} />;
    return (
    <CurrentUserProvider user={user}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          {options.live ? (
            <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
              {view}
            </LiveProvider>
          ) : (
            view
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>
    );
  };
  const utils = render(tree());
  return { ...utils, client, rerenderView: () => utils.rerender(tree()) };
}

const requests = () => seen.filter((request) => request.path === "/api/ui/analytics/runs");
const summary = () => screen.getByRole("region", { name: "Summary" });
const cell = (name: string) => within(summary()).getByRole("group", { name });
const cellValue = (name: string) => cell(name).querySelector(".or-stats__value")!;
const content = () => document.querySelector(".or-analytics__content") as HTMLElement;
const card = (name: string) => screen.getByRole("region", { name });
const table = (name: string) => screen.getAllByRole("table", { name })[0]!;
const bodyRows = (element: HTMLElement) => within(element).getAllByRole("row").slice(1);
const headers = (element: HTMLElement) =>
  within(element)
    .getAllByRole("columnheader")
    .map((header) => header.textContent);
const loaded = () => screen.findByRole("region", { name: "Summary" });
/** The charts' SVGs (badge icons are images too). */
const charts = () =>
  screen.getAllByRole("img").filter((image) => image.classList.contains("or-chart__svg"));
const badgeText = (element: Element) =>
  [...element.querySelectorAll(".or-ref__text")].map((badge) => badge.textContent!.trim());
const count = (value: number) => value.toLocaleString("en-US");

beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  ui.toast.mockReset();
  serve();
  seen = mockFetch({ "GET /api/ui/analytics/runs": (request) => respond(request) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the head row", () => {
  it("shows the heading, the Window control (30 days) and the Repository filter", async () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "Analytics" })).toBeTruthy();
    const window = screen.getByRole("radiogroup", { name: "Window" });
    const options = within(window).getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual(["7 days", "30 days", "90 days"]);
    expect(within(window).getByRole("radio", { name: "30 days" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await loaded();
    const repository = screen.getByRole("combobox", { name: "Repository" }) as HTMLSelectElement;
    expect([...repository.options].map((option) => option.textContent)).toEqual([
      "All repos",
      "mcm/omniralph",
      "netbuilder/archive",
      "netbuilder/portal",
    ]);
    expect(repository.value).toBe("");
    expect(repository.querySelector("optgroup")).toBeNull();
  });

  it("asks for 30 days by day in the active organization", async () => {
    renderView();
    await loaded();
    expect(requests()).toHaveLength(1);
    const query = Object.fromEntries(requests()[0]!.query);
    expect(query).toEqual({ days: "30", bucket: "day", organization: TEST_ORGANIZATION_ID });
  });

  it("asks by week for 90 days, and by day for 7, with the repository when one is chosen", async () => {
    nav.search = new URLSearchParams({ days: "90", repo: REPO_OMNIRALPH.id });
    renderView();
    await loaded();
    expect(Object.fromEntries(requests()[0]!.query)).toEqual({
      days: "90",
      bucket: "week",
      repository: REPO_OMNIRALPH.id,
      organization: TEST_ORGANIZATION_ID,
    });
    expect(
      (screen.getByRole("combobox", { name: "Repository" }) as HTMLSelectElement).value,
    ).toBe(REPO_OMNIRALPH.id);

    nav.search = new URLSearchParams({ days: "7" });
    renderView();
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(Object.fromEntries(requests()[1]!.query)).toMatchObject({ days: "7", bucket: "day" });
  });

  it("keeps the window and repository in the URL, leaving defaults out", async () => {
    const user = userEvent.setup();
    renderView();
    await loaded();
    await user.click(screen.getByRole("radio", { name: "90 days" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/analytics?days=90", { scroll: false });
    await user.selectOptions(screen.getByRole("combobox", { name: "Repository" }), REPO_PORTAL.id);
    expect(nav.router.push).toHaveBeenLastCalledWith(`/analytics?repo=${REPO_PORTAL.id}`, {
      scroll: false,
    });

    nav.search = new URLSearchParams({ days: "7", repo: REPO_PORTAL.id });
    renderView();
    await waitFor(() => expect(requests()).toHaveLength(2));
    const [, second] = screen.getAllByRole("combobox", { name: "Repository" });
    await user.selectOptions(second!, "");
    expect(nav.router.push).toHaveBeenLastCalledWith("/analytics?days=7", { scroll: false });
  });

  it("drops a repository the server ignored from the URL", async () => {
    nav.search = new URLSearchParams({ days: "7", repo: "not-in-scope" });
    respond = () => jsonResponse({ ...analyticsFixture({ days: 7 }) });
    renderView();
    await loaded();
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith("/analytics?days=7", { scroll: false }),
    );
  });

  it("groups the repositories by organization under All organizations", async () => {
    renderView({ user: allOrganizations });
    await loaded();
    expect(Object.fromEntries(requests()[0]!.query)).toMatchObject({ organization: "all" });
    const repository = screen.getByRole("combobox", { name: "Repository" });
    const groups = [...repository.querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual(["NETbuilder", "TheFrakinShip"]);
    expect([...groups[1]!.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "frakinship/ship",
    ]);
    expect(repository.querySelector("option")!.textContent).toBe("All repos");
  });
});

describe("the summary", () => {
  it("shows the window's stories, reviews, success rate and tokens", async () => {
    renderView();
    await loaded();
    const data = analyticsFixture();
    const { totals } = data;
    const tokens = totalTokens(totals);
    expect(
      within(summary())
        .getAllByRole("group")
        .map((group) => group.querySelector(".or-stats__label")!.textContent),
    ).toEqual(["Stories completed", "Reviews", "Success rate", "Tokens in", "Tokens out"]);
    expect(cellValue("Stories completed").textContent).toBe(count(totals.stories));
    expect(cellValue("Reviews").textContent).toBe(count(totals.reviewRuns));

    const { completed, failed, expired } = totals.attempts;
    const rate = cellValue("Success rate").querySelector("span")!;
    expect(rate.textContent).toBe(`${Math.round(totals.attempts.successRate! * 100)}%`);
    expect(rate.className).toBe("or-mono");
    expect(rate.getAttribute("title")).toBe(
      `${count(completed)} of ${count(completed + failed + expired)} finished attempts completed`,
    );
    expect(cell("Success rate").querySelector(".or-stats__detail")!.textContent).toBe(
      `${count(completed)} of ${count(completed + failed + expired)} attempts`,
    );

    const tokensIn = cellValue("Tokens in").querySelector("span")!;
    expect(tokensIn.textContent).toMatch(/^\d+(\.\d)?M$/);
    expect(tokensIn.getAttribute("title")).toBe(count(tokens.in));
    expect(cellValue("Tokens out").querySelector("span")!.getAttribute("title")).toBe(
      count(tokens.out),
    );
  });

  it("says — when no attempt finished", async () => {
    const data = analyticsFixture({ days: 7 });
    data.totals.attempts = { finished: 0, completed: 0, failed: 0, expired: 0, successRate: null };
    respond = () => jsonResponse(data);
    renderView();
    await loaded();
    expect(cellValue("Success rate").textContent).toBe("—");
    expect(cell("Success rate").querySelector(".or-stats__detail")).toBeNull();
  });
});

describe("the charts", () => {
  it("charts stories, reviews, success rate and tokens in and out, each with a summary and a table", async () => {
    renderView();
    await loaded();
    const data = analyticsFixture();
    const images = charts();
    const names = images.map((image) => image.getAttribute("aria-label")!);
    expect(names).toHaveLength(5);
    expect(names[0]).toMatch(
      new RegExp(
        `^Stories completed per day, Sep 25 to Oct 24: ${count(data.totals.stories)} in total, most on \\w+ \\d+ \\(\\d+\\)$`,
      ),
    );
    expect(names[1]).toMatch(/^Reviews per day, Sep 25 to Oct 24: [\d,]+ in total, most on/);
    expect(names[2]).toMatch(
      /^Success rate per day, Sep 25 to Oct 24: \d+% overall, lowest on \w+ \d+ \(\d+%\)$/,
    );
    expect(names[3]).toMatch(/^Tokens in per day, Sep 25 to Oct 24: [\d.]+M in total, most on/);
    expect(names[4]).toMatch(/^Tokens out per day, Sep 25 to Oct 24: /);

    // Every chart has a bucket table with a row per bucket, and bars with titles.
    for (const image of images) {
      const figure = image.closest("figure")!;
      const bucketTable = within(figure).getByRole("table", { hidden: true });
      expect(bodyRows(bucketTable)).toHaveLength(data.buckets.length);
      expect(headers(bucketTable)[0]).toBe("Day");
      expect(figure.querySelector("details")!.open).toBe(false);
      expect(figure.querySelector("summary")!.textContent).toBe("Show table");
      expect(image.querySelector("rect title")!.textContent).toMatch(/^Sep 25: /);
    }
    // The cards are h2s under the h1.
    for (const name of ["Stories completed", "Reviews", "Success rate", "Tokens"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
    // Tokens holds In and Out, on their own scales, sharing the buckets.
    const tokens = card("Tokens");
    expect([...tokens.querySelectorAll("figcaption")].map((caption) => caption.textContent)).toEqual(
      ["In", "Out"],
    );
  });

  it("draws no bar for a bucket without finished attempts, and says No attempts", async () => {
    renderView();
    await loaded();
    const figure = card("Success rate").querySelector("figure")!;
    // Sep 27 (the third day) had no finished attempt.
    const rows = bodyRows(within(figure).getByRole("table", { hidden: true }));
    expect(rows[2]!.textContent).toBe("Sep 27No attempts");
    const bars = figure.querySelectorAll("rect");
    expect(bars).toHaveLength(analyticsFixture().buckets.length - 1);
    expect([...bars].some((bar) => bar.textContent!.startsWith("Sep 27"))).toBe(false);
    // A fixed 0–100% axis.
    expect(
      [...figure.querySelectorAll(".or-chart__tick")].map((tick) => tick.textContent),
    ).toEqual(["100%", "0%"]);
  });

  it("charts weeks for 90 days", async () => {
    nav.search = new URLSearchParams({ days: "90" });
    renderView();
    await loaded();
    const data = analyticsFixture({ days: 90 });
    const figure = card("Stories completed").querySelector("figure")!;
    const bucketTable = within(figure).getByRole("table", { hidden: true });
    expect(headers(bucketTable)).toEqual(["Week of", "Stories completed"]);
    expect(bodyRows(bucketTable)).toHaveLength(data.buckets.length);
    expect(figure.querySelector("svg")!.getAttribute("aria-label")).toMatch(
      /^Stories completed per week, Jul 27 to Oct 24: [\d,]+ in total, most in the week of /,
    );
    expect(figure.querySelector("rect title")!.textContent).toMatch(/^Week of Jul 27: \d+$/);
  });
});

describe("the tables", () => {
  it("lists each repo by total tokens, linking the page filtered to it", async () => {
    nav.search = new URLSearchParams({ days: "7" });
    renderView();
    await loaded();
    const byRepo = table("By repo");
    expect(headers(byRepo)).toEqual([
      "Repo",
      "Stories",
      "Reviews",
      "Success rate",
      "Tokens in",
      "Tokens out",
    ]);
    const rows = bodyRows(byRepo);
    // mcm/omniralph has three times netbuilder/portal's tokens.
    expect(rows.map((row) => badgeText(within(row).getByRole("link")))).toEqual([
      ["mcm/omniralph"],
      ["netbuilder/portal"],
    ]);
    expect(within(rows[0]!).getByRole("link").getAttribute("href")).toBe(
      `/analytics?days=7&repo=${REPO_OMNIRALPH.id}`,
    );
    // One organization: no organization badge, no By organization card.
    expect(byRepo.querySelector(".or-ref--org")).toBeNull();
    expect(screen.queryByRole("region", { name: "By organization" })).toBeNull();
    expect(screen.queryByText("By organization")).toBeNull();
  });

  it("starts each repo with its organization and adds By organization under All organizations", async () => {
    renderView({ user: allOrganizations });
    await loaded();
    const rows = bodyRows(table("By repo"));
    expect(rows).toHaveLength(3);
    const first = rows[0]!.querySelector(".or-analytics__repo")!;
    expect([...first.querySelectorAll(".or-ref__text")].map((badge) => badge.textContent)).toEqual(
      ["NETbuilder", "mcm/omniralph"],
    );
    expect(rows.map((row) => row.querySelector(".or-ref--org .or-ref__text")!.textContent)).toEqual(
      ["NETbuilder", "TheFrakinShip", "NETbuilder"],
    );
    // The phone cards lead their meta with the organization.
    const cards = within(screen.getByRole("list", { name: "By repo" })).getAllByRole("listitem");
    expect(badgeText(cards[1]!.querySelector(".or-cardrow__meta > span")!)).toEqual([
      "TheFrakinShip",
    ]);

    const byOrganization = table("By organization");
    expect(headers(byOrganization)).toEqual([
      "Organization",
      "Stories",
      "Reviews",
      "Success rate",
      "Tokens in",
      "Tokens out",
    ]);
    expect(bodyRows(byOrganization).map((row) => row.querySelector(".or-ref__text")!.textContent)).toEqual([
      "TheFrakinShip",
      "NETbuilder",
    ]);
    expect(card("By organization")).toBeTruthy();
  });

  it("shows only the selected repo", async () => {
    nav.search = new URLSearchParams({ repo: REPO_PORTAL.id });
    renderView();
    await loaded();
    expect(bodyRows(table("By repo")).map((row) => row.textContent)).toEqual([
      expect.stringContaining("netbuilder/portal"),
    ]);
  });

  it("lists tokens by kind in order, leaving out kinds with none", async () => {
    renderView();
    await loaded();
    const byKind = table("By kind");
    expect(headers(byKind)).toEqual(["Kind", "Tokens in", "Tokens out"]);
    expect(bodyRows(byKind).map((row) => row.querySelector("td")!.textContent)).toEqual([
      "Epic",
      "Request",
      "Review",
      "Triage",
    ]);
    // On phone it sits in a collapsed "By kind" section.
    const section = document.querySelector("details.or-analytics__by-kind-phone") as HTMLDetailsElement;
    expect(section.open).toBe(false);
    expect(section.querySelector("summary")!.textContent).toBe("By kind");
    expect(within(section).getByRole("table", { name: "By kind", hidden: true })).toBeTruthy();
  });
});

describe("cost", () => {
  it("renders nothing about cost when the response has none", async () => {
    renderView({ user: allOrganizations });
    await loaded();
    expect(document.body.textContent).not.toMatch(/Cost|\$/);
  });

  it("adds a Cost tile, chart and column to every table when the response prices tokens", async () => {
    serve({ cost: true });
    renderView({ user: allOrganizations });
    await loaded();
    const data = analyticsFixture({ scope: "all", cost: true });

    const tile = cellValue("Cost").querySelector("span")!;
    expect(tile.textContent).toBe(
      `$${data.totals.costUsd!.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    expect(tile.getAttribute("title")).toBe(
      `${COST_NOTE}\nExcludes 4 attempts with no list price`,
    );
    expect(within(cell("Cost")).getByRole("button", { name: "About cost" })).toBeTruthy();

    const tokens = card("Tokens");
    expect([...tokens.querySelectorAll("figcaption")].map((caption) => caption.textContent)).toEqual(
      ["In", "Out", "Cost"],
    );
    const costFigure = [...tokens.querySelectorAll("figure")][2]!;
    expect(costFigure.querySelector("svg")!.getAttribute("aria-label")).toMatch(
      /^Cost per day, Sep 25 to Oct 24: \$[\d,.]+ in total, most on/,
    );
    const titles = [...costFigure.querySelectorAll("rect title")].map((t) => t.textContent!);
    expect(titles[0]).toBe(`Sep 25: $${data.buckets[0]!.costUsd!.toFixed(2)}\n${COST_NOTE}`);
    // Oct 12 left out an attempt with no list price.
    expect(titles.find((title) => title.startsWith("Oct 12"))).toMatch(
      /\nWhat these tokens.*billed\.\nExcludes 1 attempt with no list price$/s,
    );
    const costRows = bodyRows(within(costFigure).getByRole("table", { hidden: true }));
    expect(costRows[0]!.querySelector("td")!.getAttribute("title")).toBe(COST_NOTE);

    for (const name of ["By repo", "By organization", "By kind"]) {
      expect(headers(table(name)).at(-1)).toBe("Cost");
    }
    const portal = bodyRows(table("By repo")).find((row) =>
      row.textContent!.includes("netbuilder/portal"),
    )!;
    const portalCost = portal.querySelectorAll("td")[6]!.querySelector(".or-mono")!;
    expect(portalCost.textContent).toMatch(/^\$[\d,]+\.\d\d$/);
    expect(portalCost.getAttribute("title")).toBe(
      `${COST_NOTE}\nExcludes 3 attempts with no list price`,
    );
  });

  it("says — for a row without a cost", async () => {
    const data = analyticsFixture({ cost: true });
    delete data.byRepository[0]!.costUsd;
    respond = () => jsonResponse(data);
    renderView();
    await loaded();
    const row = bodyRows(table("By repo")).find((r) => r.textContent!.includes("mcm/omniralph"))!;
    expect(row.querySelectorAll("td")[6]!.querySelector(".or-mono")!.textContent).toBe("—");
  });
});

describe("states", () => {
  it("shows card-shaped placeholders with no text while the first figures load", async () => {
    respond = () => new Promise<Response>(() => {});
    renderView();
    const placeholders = document.querySelector(".or-analytics__placeholders")!;
    expect(placeholders.getAttribute("aria-hidden")).toBe("true");
    expect(placeholders.querySelectorAll(".or-analytics__placeholder")).toHaveLength(5);
    expect(content().textContent).toBe("");
    expect(content().getAttribute("aria-busy")).toBe("true");
  });

  it("keeps the previous figures, busy, while another window loads", async () => {
    const { rerenderView } = renderView();
    await loaded();
    const stories = cellValue("Stories completed").textContent;
    let release!: () => void;
    respond = (request) =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(jsonResponse(analyticsFixture({ days: Number(request.query.get("days")) as 7 })));
      });
    nav.search = new URLSearchParams({ days: "7" });
    rerenderView();
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(content().getAttribute("aria-busy")).toBe("true");
    expect(cellValue("Stories completed").textContent).toBe(stories);
    await act(async () => release());
    await waitFor(() => expect(content().getAttribute("aria-busy")).toBeNull());
    expect(cellValue("Stories completed").textContent).toBe(
      count(analyticsFixture({ days: 7 }).totals.stories),
    );
  });

  it("shows the empty state naming the window, and the repo when one is selected", async () => {
    serve({ empty: true });
    const { unmount } = renderView();
    expect(
      await screen.findByRole("heading", { name: "Nothing ran in the last 30 days" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Summary" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".or-chart")).toBeNull();
    unmount();

    nav.search = new URLSearchParams({ days: "7", repo: REPO_OMNIRALPH.id });
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Nothing ran in mcm/omniralph in the last 7 days" }),
    ).toBeTruthy();
  });

  it("says it couldn't load, with Try again, when the first load fails", async () => {
    const user = userEvent.setup();
    respond = () => jsonResponse({ error: "Something went wrong." }, 500);
    renderView();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load analytics.");
    serve();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await loaded();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the figures and toasts when a refetch fails", async () => {
    const { client } = renderView();
    await loaded();
    const stories = cellValue("Stories completed").textContent;
    respond = () => jsonResponse({ error: "Something went wrong." }, 500);
    await act(() => client.refetchQueries());
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Couldn't refresh analytics.", { variant: "danger" }),
    );
    expect(ui.toast).toHaveBeenCalledTimes(1);
    expect(cellValue("Stories completed").textContent).toBe(stories);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("live updates", () => {
  async function connected(live: ReturnType<typeof fakeAbly>, organizationId: string) {
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`),
    );
  }
  const deliver = (
    live: ReturnType<typeof fakeAbly>,
    organizationId: string,
    event: Parameters<typeof changeEvent>[1],
  ) =>
    act(() =>
      live.current().deliver(`org:${organizationId}:changes`, changeEvent(organizationId, event)),
    );

  it("updates the totals in place when a run finishes, with no user action and no polling", async () => {
    const live = fakeAbly();
    const { client } = renderView({ live });
    await loaded();
    await connected(live, TEST_ORGANIZATION_ID);
    const query = client.getQueryCache().findAll({ queryKey: [TEST_ORGANIZATION_ID, "analytics"] })[0]!;
    expect(query.meta).toEqual({ liveThrottleMs: ANALYTICS_LIVE_THROTTLE_MS });
    expect(ANALYTICS_LIVE_THROTTLE_MS).toBe(10_000);

    const before = analyticsFixture();
    const after: RunAnalyticsResponse = {
      ...before,
      totals: { ...before.totals, stories: before.totals.stories + 1 },
    };
    respond = () => jsonResponse(after);
    deliver(live, TEST_ORGANIZATION_ID, { resource: "run", runId: "44444444-4444-4444-8444-444444444444" });
    await waitFor(() =>
      expect(cellValue("Stories completed").textContent).toBe(count(after.totals.stories)),
    );
    // In place: no loading state on the way.
    expect(content().getAttribute("aria-busy")).toBeNull();
    expect(requests()).toHaveLength(2);
  });

  it("ignores a transcript growing, which changes no figure", async () => {
    const live = fakeAbly();
    renderView({ live });
    await loaded();
    await connected(live, TEST_ORGANIZATION_ID);
    deliver(live, TEST_ORGANIZATION_ID, {
      resource: "transcript",
      runId: "44444444-4444-4444-8444-444444444444",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests()).toHaveLength(1);
  });

  it("refetches on another organization's run under All organizations", async () => {
    const live = fakeAbly();
    renderView({ live, user: allOrganizations });
    await loaded();
    await connected(live, FRAKINSHIP.id);
    deliver(live, FRAKINSHIP.id, { resource: "run", runId: "44444444-4444-4444-8444-444444444444" });
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(Object.fromEntries(requests()[1]!.query)).toMatchObject({ organization: "all" });
  });

  it("renders no live notice of its own", async () => {
    renderView();
    await loaded();
    expect(document.body.textContent).not.toMatch(/Live|Retrying|Updated/);
  });
});
