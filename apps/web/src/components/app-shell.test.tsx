// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import type { SessionUser } from "./current-user";
import { mockFetch, TEST_ORGANIZATION_ID, testUser } from "./query-test-utils";

const nav = vi.hoisted(() => ({
  pathname: "/analytics",
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
}));
vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock("@/lib/theme-actions", () => ({ saveThemePreference: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn(async () => {}) }));

const BETA = { id: "22222222-2222-4222-8222-222222222222", name: "Beta" };
const twoOrganizations: SessionUser = {
  ...testUser,
  organizations: [
    { ...testUser.organization, role: "admin" },
    { ...BETA, role: "member" },
  ],
};

function renderShell(pathname: string, user: SessionUser = testUser) {
  nav.pathname = pathname;
  return render(
    <AppShell
      user={user}
      themePreference="dark"
      organizationCookie={null}
      scopeCookie={null}
      showAdvanced={false}
    >
      <h1>Page content</h1>
    </AppShell>,
  );
}

const sidebar = () => screen.getAllByRole("navigation", { name: "Primary" })[0]!;
const tabBar = () => document.querySelector<HTMLElement>(".or-tabbar")!;
const current = (container: HTMLElement) =>
  within(container)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.getAttribute("aria-label"));

async function openDrawer() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open menu" }));
  return { user, drawer: await screen.findByRole("dialog", { name: "Menu" }) };
}

beforeEach(() => {
  nav.router.push.mockReset();
  nav.router.refresh.mockReset();
  document.documentElement.removeAttribute("data-theme");
});

describe("AppShell", () => {
  it("renders the page in the main landmark of the 2.0 frame", () => {
    renderShell("/analytics");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "Page content" })).toBeTruthy();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    // The glyph and wordmark link home, in the sidebar and the phone top bar.
    expect(
      within(sidebar()).getByRole("link", { name: "Omniralph home" }).getAttribute("href"),
    ).toBe("/");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("lists Inbox, Runs, Backlog, Repos and Fleet, then Ask, Analytics and Settings, each linking its 2.0 page", () => {
    renderShell("/analytics");
    const links = within(sidebar())
      .getAllByRole("link")
      .filter((link) => link.classList.contains("or-nav__item"))
      .map((link) => [link.getAttribute("aria-label"), link.getAttribute("href")]);
    expect(links).toEqual([
      ["Inbox", "/"],
      ["Runs", "/runs"],
      ["Backlog", "/backlog"],
      ["Repos", "/repos"],
      ["Fleet", "/fleet"],
      ["Ask", "/ask"],
      ["Analytics", "/analytics"],
      ["Settings", "/settings"],
    ]);
  });

  it.each([
    ["/", "Inbox"],
    ["/runs", "Runs"],
    ["/runs/123", "Runs"],
    ["/backlog", "Backlog"],
    ["/backlog/linear-1", "Backlog"],
    ["/repos", "Repos"],
    ["/repos/abc", "Repos"],
    ["/fleet/abc", "Fleet"],
    ["/settings", "Settings"],
    ["/settings/advanced/routing", "Settings"],
    ["/settings/routing", "Settings"],
    ["/ask", "Ask"],
    ["/ask/abc", "Ask"],
  ])("marks the entry for %s as the current page: %s", (pathname, label) => {
    renderShell(pathname);
    expect(current(sidebar())).toEqual([label]);
  });

  it("marks Runs current in the tab bar too", () => {
    renderShell("/runs/123");
    expect(current(tabBar())).toEqual(["Runs"]);
  });

  it("marks Repos current on a repo's page in the phone drawer too", async () => {
    renderShell("/repos/abc");
    expect(current(sidebar())).toEqual(["Repos"]);
    const { drawer } = await openDrawer();
    expect(current(drawer)).toEqual(["Repos"]);
  });

  it("marks Analytics alone current on /analytics, in the sidebar and the phone drawer", async () => {
    renderShell("/analytics");
    expect(current(sidebar())).toEqual(["Analytics"]);
    expect(current(tabBar())).toEqual([]);
    const { drawer } = await openDrawer();
    expect(current(drawer)).toEqual(["Analytics"]);
  });

  it("puts Inbox, Runs, Backlog and Ask in the tab bar and Repos, Fleet, Analytics and Settings in the drawer", async () => {
    renderShell("/settings/routing");
    expect(
      within(tabBar())
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Inbox", "Runs", "Backlog", "Ask"]);
    const { drawer } = await openDrawer();
    const entries = within(drawer)
      .getAllByRole("link")
      .filter((link) => link.classList.contains("or-nav__item"));
    expect(entries.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Repos",
      "Fleet",
      "Analytics",
      "Settings",
    ]);
    expect(current(drawer)).toEqual(["Settings"]);
  });

  it("shows the same organization picker in the sidebar and the drawer", async () => {
    renderShell("/analytics", twoOrganizations);
    const inSidebar = within(sidebar()).getByRole("button", { name: "Organization: Acme" });
    const { user, drawer } = await openDrawer();
    const inDrawer = within(drawer).getByRole("button", { name: "Organization: Acme" });
    expect(inDrawer).not.toBe(inSidebar);
    expect(inDrawer.className).toBe(inSidebar.className);
    expect(inDrawer.innerHTML).toBe(inSidebar.innerHTML);
    // Both open the same choices.
    await user.click(inDrawer);
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitemcheckbox")
        .map((item) => item.textContent),
    ).toEqual(["All organizations", "Acme", "Beta"]);
    expect(within(menu).getByRole("menuitem", { name: "New organization" })).toBeTruthy();
  });

  it("opens the user menu from the sidebar footer and the phone avatar", async () => {
    renderShell("/analytics");
    const user = userEvent.setup();
    for (const trigger of [
      within(sidebar()).getByRole("button", { name: "Ada" }),
      within(screen.getByRole("banner")).getByRole("button", { name: "Ada" }),
    ]) {
      await user.click(trigger);
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
      expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
      await user.keyboard("{Escape}");
    }
  });

  it("mounts the toaster", () => {
    renderShell("/analytics");
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
  });

  it("starts over with an empty query cache when the organization scope changes", () => {
    const clients: QueryClient[] = [];
    function Probe() {
      const client = useQueryClient();
      if (!clients.includes(client)) clients.push(client);
      return null;
    }
    const shell = (user: SessionUser) => (
      <AppShell
        user={user}
        themePreference="dark"
        organizationCookie={null}
        scopeCookie={null}
        showAdvanced={false}
      >
        <Probe />
      </AppShell>
    );
    nav.pathname = "/analytics";
    const { rerender } = render(shell(twoOrganizations));
    clients[0]!.setQueryData([testUser.organization.id, "probe"], 1);
    // A re-render in the same scope keeps the cache.
    rerender(shell(twoOrganizations));
    expect(clients).toHaveLength(1);
    // Same active organization, scope "all": a new, empty client.
    rerender(shell({ ...twoOrganizations, scope: "all" }));
    expect(clients).toHaveLength(2);
    expect(clients[1]!.getQueryData([testUser.organization.id, "probe"])).toBeUndefined();
  });

  it("shows no search control, keyboard-shortcut indicators or hints in the sidebar or drawer", async () => {
    renderShell("/analytics");
    const check = () => {
      expect(screen.queryAllByRole("search")).toHaveLength(0);
      expect(screen.queryAllByRole("searchbox")).toHaveLength(0);
      expect(screen.queryAllByRole("button", { name: /search/i })).toHaveLength(0);
      expect(document.querySelector("kbd, input[placeholder]")).toBeNull();
      expect(document.body.textContent).not.toMatch(/⌘|ctrl\s*\+|shortcut|search|press /i);
    };
    check();
    await openDrawer();
    check();
  });
});

describe("AppShell nav indicators", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts what needs the user on Inbox in the sidebar, the rail and the tab bar", async () => {
    const seen = mockFetch({
      "GET /api/ui/live/token": { token: null },
      "GET /api/ui/inbox/counts": { needsYou: 4, problems: 1, running: 2 },
      "GET /api/ui/backlog/counts": { readyToStart: 0, needsRefining: 0, total: 0 },
    });
    renderShell("/analytics");
    const inbox = await within(sidebar()).findByRole("link", { name: "Inbox, 4 need you" });
    expect(inbox.querySelector(".or-nav__count")!.textContent).toBe("4");
    // On the icon rail the label is hidden by CSS but kept in the accessible name.
    expect(inbox.querySelector(".or-nav__label")!.classList.contains("or-rail-hidden")).toBe(true);
    const tab = within(tabBar()).getByRole("link", { name: "Inbox, 4 need you" });
    expect(tab.querySelector(".or-nav__count")!.textContent).toBe("4");
    // Runs shows a mint dot while runs run.
    const runs = within(sidebar()).getByRole("link", { name: "Runs, 2 running" });
    expect(runs.querySelector(".or-nav__pip")!.classList.contains("or-dot--run")).toBe(true);
    expect(runs.getAttribute("href")).toBe("/runs");
    const runsTab = within(tabBar()).getByRole("link", { name: "Runs, 2 running" });
    expect(runsTab.querySelector(".or-nav__pip")!.classList.contains("or-dot--run")).toBe(true);
    const counts = seen.filter((request) => request.path === "/api/ui/inbox/counts");
    expect(counts.map((request) => request.query.get("organization"))).toEqual([
      TEST_ORGANIZATION_ID,
    ]);
  });

  it("shows the Backlog's items as a neutral count, named, never as the accent pill", async () => {
    const seen = mockFetch({
      "GET /api/ui/live/token": { token: null },
      "GET /api/ui/inbox/counts": { needsYou: 0, problems: 0, running: 0 },
      "GET /api/ui/backlog/counts": { readyToStart: 2, needsRefining: 1, total: 3 },
    });
    renderShell("/analytics");
    const backlog = await within(sidebar()).findByRole("link", { name: "Backlog, 3 items" });
    expect(backlog.getAttribute("href")).toBe("/backlog");
    expect(backlog.querySelector(".or-nav__n2")!.textContent).toBe("3");
    expect(backlog.querySelector(".or-nav__count")).toBeNull();
    // Only the full sidebar shows it: CSS hides it on the rail and in the tab bar, and it's
    // no alert on the hamburger.
    const tab = within(tabBar()).getByRole("link", { name: "Backlog, 3 items" });
    expect(tab.querySelector(".or-nav__count")).toBeNull();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
    expect(
      seen
        .filter((request) => request.path === "/api/ui/backlog/counts")
        .map((request) => request.query.get("organization")),
    ).toEqual([TEST_ORGANIZATION_ID]);
  });

  it("puts the running dot on the phone tab bar's Runs tab, on a run's page too", async () => {
    mockFetch({
      "GET /api/ui/live/token": { token: null },
      "GET /api/ui/inbox/counts": { needsYou: 0, problems: 0, running: 3 },
      "GET /api/ui/backlog/counts": { readyToStart: 0, needsRefining: 0, total: 0 },
    });
    renderShell("/runs/123/steps/456");
    const runsTab = await within(tabBar()).findByRole("link", { name: "Runs, 3 running" });
    expect(runsTab.getAttribute("aria-current")).toBe("page");
    expect(runsTab.querySelector(".or-nav__pip")!.classList.contains("or-dot--run")).toBe(true);
  });

  it("hides the count at 0 and asks for every organization under All organizations", async () => {
    const seen = mockFetch({
      "GET /api/ui/live/token": { token: null },
      "GET /api/ui/inbox/counts": { needsYou: 0, problems: 0, running: 0 },
      "GET /api/ui/backlog/counts": { readyToStart: 0, needsRefining: 0, total: 0 },
    });
    renderShell("/analytics", { ...twoOrganizations, scope: "all" });
    await waitFor(() =>
      expect(seen.some((request) => request.path === "/api/ui/inbox/counts")).toBe(true),
    );
    expect(
      seen.find((request) => request.path === "/api/ui/inbox/counts")!.query.get("organization"),
    ).toBe("all");
    await waitFor(() =>
      expect(within(sidebar()).getByRole("link", { name: "Inbox" })).toBeTruthy(),
    );
    expect(document.querySelector(".or-nav__count")).toBeNull();
    expect(within(tabBar()).getByRole("link", { name: "Inbox" })).toBeTruthy();
    // No Runs dot while nothing runs.
    expect(within(sidebar()).getByRole("link", { name: "Runs" })).toBeTruthy();
    expect(document.querySelector(".or-nav__pip")).toBeNull();
  });
});
