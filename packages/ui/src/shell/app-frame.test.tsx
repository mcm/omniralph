import {
  IconBuildingFactory2,
  IconFolder,
  IconInbox,
  IconMessageCircle,
  IconPlayerPlay,
  IconSettings,
} from "@tabler/icons-react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "../actions/menu.js";
import { UiProvider, type LinkProps } from "../provider/ui-provider.js";
import { AppFrame, type AppFrameProps } from "./app-frame.js";
import type { NavItem } from "./nav.js";

const NAV: NavItem[] = [
  {
    id: "inbox",
    label: "Inbox",
    href: "/inbox",
    icon: IconInbox,
    placement: "main",
    phone: "tab",
    indicator: { kind: "count", value: 4, label: "4 need you" },
  },
  {
    id: "runs",
    label: "Runs",
    href: "/coding",
    icon: IconPlayerPlay,
    placement: "main",
    phone: "tab",
    activeFor: ["/reviews", "/triage"],
  },
  {
    id: "repos",
    label: "Repos",
    href: "/repositories",
    icon: IconFolder,
    placement: "main",
    phone: "drawer",
  },
  {
    id: "fleet",
    label: "Fleet",
    href: "/harnesses",
    icon: IconBuildingFactory2,
    placement: "main",
    phone: "drawer",
    indicator: { kind: "dot", tone: "fail", label: "1 agent offline" },
  },
  {
    id: "ask",
    label: "Ask",
    href: "/ask",
    icon: IconMessageCircle,
    placement: "bottom",
    phone: "tab",
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings/organization",
    icon: IconSettings,
    placement: "bottom",
    phone: "drawer",
    activeFor: ["/settings"],
    indicator: { kind: "dot", tone: "run", label: "Deliveries retrying" },
  },
];

/** A router-style link: it prevents the default, like Next's Link does. */
function RouterLink({ onClick, ...props }: LinkProps) {
  return (
    <a
      {...props}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
      }}
    />
  );
}

function renderFrame(overrides: Partial<AppFrameProps> = {}) {
  const onSignOut = vi.fn();
  const props: AppFrameProps = {
    currentPath: "/reviews/42",
    brandHref: "/",
    nav: NAV,
    orgPicker: <button type="button">Acme</button>,
    user: { name: "Ada Lovelace", initials: "AL" },
    userMenu: (trigger) => (
      <Menu trigger={trigger} items={[{ label: "Sign out", onSelect: onSignOut }]} />
    ),
    children: <p>Page content</p>,
    ...overrides,
  };
  const utils = render(
    <UiProvider linkComponent={RouterLink}>
      <AppFrame {...props} />
    </UiProvider>,
  );
  return { ...utils, onSignOut };
}

function sidebar() {
  return screen.getAllByRole("navigation", { name: "Primary" })[0]!;
}

function tabBar() {
  return screen.getAllByRole("navigation", { name: "Primary" })[1]!;
}

function controlNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("a, button")).map(
    (element) =>
      element.getAttribute("aria-label") ??
      element.querySelector(".or-user__name")?.textContent ??
      element.textContent ??
      "",
  );
}

describe("AppFrame", () => {
  it("renders the page in the main landmark", () => {
    renderFrame();
    expect(within(screen.getByRole("main")).getByText("Page content")).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
  });

  it("orders the sidebar: brand, picker, main entries, gap, bottom entries, user footer", () => {
    const { container } = renderFrame();
    expect(controlNames(sidebar())).toEqual([
      "Omniralph home",
      "Acme",
      "Inbox, 4 need you",
      "Runs",
      "Repos",
      "Fleet, 1 agent offline",
      "Ask",
      "Settings, Deliveries retrying",
      "Ada Lovelace",
    ]);
    const gap = container.querySelector(".or-sidebar > .or-sidebar__gap")!;
    const lists = container.querySelectorAll(".or-sidebar > .or-nav__list");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.compareDocumentPosition(gap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gap.compareDocumentPosition(lists[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks the active entry with aria-current, including activeFor prefixes", () => {
    renderFrame();
    const nav = within(sidebar());
    expect(nav.getByRole("link", { name: "Runs" }).getAttribute("aria-current")).toBe("page");
    for (const name of ["Inbox, 4 need you", "Repos", "Ask"]) {
      expect(nav.getByRole("link", { name }).hasAttribute("aria-current")).toBe(false);
    }
  });

  it("follows currentPath", () => {
    renderFrame({ currentPath: "/settings/members" });
    const settings = within(sidebar()).getByRole("link", { name: "Settings, Deliveries retrying" });
    expect(settings.getAttribute("aria-current")).toBe("page");
    expect(within(sidebar()).getByRole("link", { name: "Runs" }).hasAttribute("aria-current")).toBe(
      false,
    );
  });

  it("draws a count as the accent pill and a dot as a pip in its tone", () => {
    renderFrame();
    const nav = within(sidebar());
    const inbox = nav.getByRole("link", { name: "Inbox, 4 need you" });
    const count = inbox.querySelector(".or-nav__count")!;
    expect(count.textContent).toBe("4");
    expect(count.getAttribute("aria-hidden")).toBe("true");
    const fleet = nav.getByRole("link", { name: "Fleet, 1 agent offline" });
    expect(fleet.querySelector(".or-nav__pip")!.classList.contains("or-dot--fail")).toBe(true);
    const settings = nav.getByRole("link", { name: "Settings, Deliveries retrying" });
    expect(settings.querySelector(".or-nav__pip")!.classList.contains("or-dot--run")).toBe(true);
  });

  it("keeps every rail entry's accessible name, with its label in a rail-hidden span", () => {
    renderFrame();
    const nav = sidebar();
    for (const item of NAV) {
      const link = nav.querySelector(`a[href="${item.href}"]`)!;
      const label = link.querySelector(".or-nav__label")!;
      expect(label.textContent).toBe(item.label);
      expect(label.classList.contains("or-rail-hidden")).toBe(true);
    }
    expect(nav.querySelector(".or-user__name")!.classList.contains("or-rail-hidden")).toBe(true);
    expect(within(nav).getByRole("button", { name: "Ada Lovelace" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Omniralph home" })).toBeTruthy();
  });

  it("gives each sidebar entry a rail tooltip with its label", async () => {
    const user = userEvent.setup();
    renderFrame();
    await user.tab(); // brand link (the top bar's controls come first in the DOM)
    within(sidebar()).getByRole("link", { name: "Repos" }).focus();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Repos");
    expect(document.querySelector(".or-tip--rail")!.textContent).toContain("Repos");
  });

  it("opens the user menu from the sidebar footer", async () => {
    const user = userEvent.setup();
    const { onSignOut } = renderFrame();
    const footer = within(sidebar()).getByRole("button", { name: "Ada Lovelace" });
    expect(footer.querySelector(".or-avatar")!.textContent).toBe("AL");
    await user.click(footer);
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("shows the avatar image when the user has one", () => {
    const { container } = renderFrame({
      user: { name: "Ada Lovelace", initials: "AL", image: "https://example.com/ada.png" },
    });
    const images = container.querySelectorAll("img.or-avatar__img");
    expect(images.length).toBeGreaterThan(0);
    expect(images[0]!.getAttribute("src")).toBe("https://example.com/ada.png");
    expect(images[0]!.getAttribute("alt")).toBe("");
  });

  describe("phone top bar", () => {
    it("names the hamburger with the drawer entries' alerts and shows the alert dot", () => {
      renderFrame();
      const header = within(screen.getByRole("banner"));
      const hamburger = header.getByRole("button", { name: "Open menu, 2 alerts" });
      expect(hamburger.querySelector(".or-topbar__alert")).toBeTruthy();
      expect(header.getByRole("link", { name: "Omniralph home" }).getAttribute("href")).toBe("/");
    });

    it('names the hamburger "Open menu" with no alert dot when no drawer entry has one', () => {
      renderFrame({ nav: NAV.map(({ indicator: _indicator, ...item }) => item) });
      const hamburger = within(screen.getByRole("banner")).getByRole("button", {
        name: "Open menu",
      });
      expect(hamburger.querySelector(".or-topbar__alert")).toBeNull();
    });

    it("doesn't count tab indicators as drawer alerts", () => {
      renderFrame({ nav: NAV.filter((item) => item.phone === "tab") });
      expect(
        within(screen.getByRole("banner")).getByRole("button", { name: "Open menu" }),
      ).toBeTruthy();
    });

    it("opens the user menu from the avatar", async () => {
      const user = userEvent.setup();
      const { onSignOut } = renderFrame();
      await user.click(
        within(screen.getByRole("banner")).getByRole("button", { name: "Ada Lovelace" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      expect(onSignOut).toHaveBeenCalledOnce();
    });
  });

  describe("tab bar", () => {
    it("lists the tab entries in order with 22 px icons, aria-current and indicators", () => {
      renderFrame({ currentPath: "/coding" });
      const tabs = within(tabBar()).getAllByRole("link");
      expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
        "Inbox, 4 need you",
        "Runs",
        "Ask",
      ]);
      for (const tab of tabs) {
        const icon = tab.querySelector(".or-nav__icon svg")!;
        expect(icon.getAttribute("width")).toBe("22");
        // The icon sits above the label.
        expect(
          icon.compareDocumentPosition(tab.querySelector(".or-nav__label")!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      expect(tabs[1]!.getAttribute("aria-current")).toBe("page");
      expect(tabs[0]!.hasAttribute("aria-current")).toBe(false);
      expect(tabs[0]!.querySelector(".or-nav__count")!.textContent).toBe("4");
    });
  });

  describe("drawer", () => {
    async function openDrawer() {
      const user = userEvent.setup();
      const utils = renderFrame();
      const hamburger = screen.getByRole("button", { name: "Open menu, 2 alerts" });
      await user.click(hamburger);
      const dialog = await screen.findByRole("dialog", { name: "Menu" });
      return { ...utils, user, hamburger, dialog };
    }

    it("holds the brand, a close button, the picker, the drawer entries and the user footer", async () => {
      const { dialog } = await openDrawer();
      expect(controlNames(dialog)).toEqual([
        "Omniralph home",
        "Close menu",
        "Acme",
        "Repos",
        "Fleet, 1 agent offline",
        "Settings, Deliveries retrying",
        "Ada Lovelace",
      ]);
      for (const link of within(dialog).getAllByRole("link").slice(1)) {
        expect(link.classList.contains("or-nav__item--drawer")).toBe(true);
      }
    });

    it("moves focus in and traps it", async () => {
      const { dialog, user } = await openDrawer();
      expect(dialog.contains(document.activeElement)).toBe(true);
      for (let step = 0; step < 10; step += 1) {
        await user.tab();
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    async function expectClosed(hamburger: HTMLElement) {
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(hamburger);
    }

    it("closes on Escape and returns focus to the hamburger", async () => {
      const { user, hamburger } = await openDrawer();
      await user.keyboard("{Escape}");
      await expectClosed(hamburger);
    });

    it("closes from the close button", async () => {
      const { user, hamburger, dialog } = await openDrawer();
      await user.click(within(dialog).getByRole("button", { name: "Close menu" }));
      await expectClosed(hamburger);
    });

    it("closes on a scrim click", async () => {
      const { user, hamburger } = await openDrawer();
      await user.click(document.querySelector(".or-drawer__scrim")!);
      await expectClosed(hamburger);
    });

    it("closes when a link is followed", async () => {
      const { user, hamburger, dialog } = await openDrawer();
      await user.click(within(dialog).getByRole("link", { name: "Repos" }));
      await expectClosed(hamburger);
    });

    it("stays open on a modified (new tab) link click", async () => {
      const { user, dialog } = await openDrawer();
      await user.keyboard("{Control>}");
      await user.click(within(dialog).getByRole("link", { name: "Repos" }));
      await user.keyboard("{/Control}");
      expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy();
    });

    it("closes once the window is wider than a phone", async () => {
      let listener: (() => void) | undefined;
      const query = {
        matches: false,
        addEventListener: (_type: string, callback: () => void) => {
          listener = callback;
        },
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => query),
      );
      try {
        const { hamburger } = await openDrawer();
        query.matches = true;
        listener!();
        await expectClosed(hamburger);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it("renders no search control", () => {
    renderFrame();
    expect(screen.queryAllByRole("search")).toHaveLength(0);
    expect(screen.queryAllByRole("searchbox")).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /search/i })).toHaveLength(0);
  });

  it("renders with an empty nav", async () => {
    const user = userEvent.setup();
    renderFrame({ nav: [] });
    expect(screen.getAllByRole("navigation", { name: "Primary" })).toHaveLength(1);
    expect(within(sidebar()).queryAllByRole("link")).toHaveLength(1); // the brand
    expect(screen.getByRole("main").textContent).toBe("Page content");
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
  });

  it("renders only the entries given, with a one-entry nav", () => {
    renderFrame({ nav: [NAV[1]!], currentPath: "/coding" });
    expect(
      within(sidebar())
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Omniralph home", "Runs"]);
    expect(
      within(tabBar())
        .getAllByRole("link")
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Runs"]);
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
  });

  it("renders without an organization picker", () => {
    renderFrame({ orgPicker: undefined });
    expect(within(sidebar()).queryByRole("button", { name: "Acme" })).toBeNull();
  });
});
