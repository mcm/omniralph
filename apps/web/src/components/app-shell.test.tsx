// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import type { SessionUser } from "./current-user";
import { testUser } from "./query-test-utils";

const nav = vi.hoisted(() => ({
  pathname: "/reviews",
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
    <AppShell user={user} themePreference="dark" organizationCookie={null} scopeCookie={null} showAdvanced={false}>
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
    renderShell("/reviews");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "Page content" })).toBeTruthy();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    // The glyph and wordmark link home, in the sidebar and the phone top bar.
    expect(
      within(sidebar()).getByRole("link", { name: "Omniralph home" }).getAttribute("href"),
    ).toBe("/");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("lists Runs, Repos and Fleet, then Settings, each linking its 2.0 page", () => {
    renderShell("/reviews");
    const links = within(sidebar())
      .getAllByRole("link")
      .filter((link) => link.classList.contains("or-nav__item"))
      .map((link) => [link.getAttribute("aria-label"), link.getAttribute("href")]);
    expect(links).toEqual([
      ["Runs", "/runs"],
      ["Repos", "/repositories"],
      ["Fleet", "/harnesses"],
      ["Settings", "/settings/organization"],
    ]);
  });

  it.each([
    ["/runs/123", "Runs"],
    ["/reviews/123", "Runs"],
    ["/triage", "Runs"],
    ["/analytics", "Runs"],
    ["/repositories/abc/rules", "Repos"],
    ["/harnesses/abc", "Fleet"],
    ["/settings/routing", "Settings"],
  ])("marks the entry for %s as the current page: %s", (pathname, label) => {
    renderShell(pathname);
    expect(current(sidebar())).toEqual([label]);
  });

  it("marks Runs current in the tab bar too", () => {
    renderShell("/reviews/123");
    expect(current(tabBar())).toEqual(["Runs"]);
  });

  it("puts Runs in the tab bar and Repos, Fleet and Settings in the drawer", async () => {
    renderShell("/settings/routing");
    expect(
      within(tabBar())
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Runs"]);
    const { drawer } = await openDrawer();
    const entries = within(drawer)
      .getAllByRole("link")
      .filter((link) => link.classList.contains("or-nav__item"));
    expect(entries.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Repos",
      "Fleet",
      "Settings",
    ]);
    expect(current(drawer)).toEqual(["Settings"]);
  });

  it("shows the same organization picker in the sidebar and the drawer", async () => {
    renderShell("/reviews", twoOrganizations);
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
    renderShell("/reviews");
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
    renderShell("/reviews");
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
      <AppShell user={user} themePreference="dark" organizationCookie={null} scopeCookie={null} showAdvanced={false}>
        <Probe />
      </AppShell>
    );
    nav.pathname = "/reviews";
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
    renderShell("/reviews");
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
