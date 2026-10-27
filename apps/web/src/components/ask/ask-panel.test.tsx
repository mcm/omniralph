// @vitest-environment jsdom
// The desktop Ask panel (board Ask): the frame's aside beside the page, opened from the
// sidebar's Ask entry, kept across navigation and reloads, closed with Close Ask or Esc.
import "@/components/pickers/test-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { mockFetch, TEST_ORGANIZATION_ID, testUser } from "@/components/query-test-utils";
import type { AskChat as AskChatModel, AskChatDetail, AskChatList } from "@/lib/api/ask";
import {
  ASK_PANEL_STORAGE_KEY,
  readAskPanelState,
  withAskEntry,
  writeAskPanelState,
} from "./ask-panel";
import { resetAskChatMemory } from "./chat-memory";
import { omMessage, REPOSITORY } from "./test-fixtures";

const nav = vi.hoisted(() => ({
  pathname: "/runs",
  router: { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() },
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

const ORG = TEST_ORGANIZATION_ID;
const CHAT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const chat: AskChatModel = {
  id: CHAT_ID,
  title: "Where does the login form post?",
  organization: { id: ORG, name: "Acme", role: "admin" },
  repository: REPOSITORY,
  branch: "main",
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};

const detail: AskChatDetail = {
  chat,
  messages: [
    omMessage({ id: "m-1", author: "user", markdown: "Where does the login form post?" }),
    omMessage({ id: "m-2" }),
  ],
  activity: null,
  nextBefore: null,
};

const list: AskChatList = { chats: [chat], nextCursor: null };

function mockAsk() {
  return mockFetch({
    "GET /api/ui/live/token": { token: null },
    "GET /api/ui/inbox/counts": { needsYou: 0, problems: 0, running: 0 },
    "GET /api/ui/backlog/counts": { readyToStart: 0, needsRefining: 0, total: 0 },
    "GET /api/ui/nav-indicators": {
      fleet: { offline: 0, updateFailed: 0 },
      settings: { failedDeliveries: 0, byConnection: [] },
    },
    "GET /api/ui/ask/chats": list,
    [`GET /api/ui/ask/chats/${CHAT_ID}`]: detail,
    "GET /api/ui/ask/repositories": {
      repositories: [
        {
          id: REPOSITORY.id,
          provider: "github",
          fullPath: REPOSITORY.fullPath,
          organization: { id: ORG, name: "Acme", role: "admin" },
        },
      ],
    },
  });
}

/** `matchMedia` for a desktop (wider than 768 px) or a phone window. */
function stubWidth(desktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: desktop && query === "(min-width: 769px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function shell(children: React.ReactNode = <h1>Page content</h1>) {
  return (
    <AppShell
      user={testUser}
      themePreference="dark"
      organizationCookie={null}
      scopeCookie={null}
      showAdvanced={false}
    >
      {children}
    </AppShell>
  );
}

function renderShell(pathname = "/runs", children?: React.ReactNode) {
  nav.pathname = pathname;
  return render(shell(children));
}

const sidebar = () => screen.getAllByRole("navigation", { name: "Primary" })[0]!;
const tabBar = () => document.querySelector<HTMLElement>(".or-tabbar")!;
const askEntry = () => within(sidebar()).getByRole("link", { name: "Ask" });
const panel = () => screen.queryByRole("complementary", { name: "Ask" });

beforeEach(() => {
  window.sessionStorage.clear();
  resetAskChatMemory();
  nav.router.push.mockReset();
  stubWidth(true);
  mockAsk();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Ask nav entry", () => {
  it("toggles the panel on desktop instead of navigating, with aria-expanded", async () => {
    const user = userEvent.setup();
    renderShell();
    expect(askEntry().getAttribute("href")).toBe("/ask");
    expect(askEntry().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();

    await user.click(askEntry());
    expect(panel()).toBeTruthy();
    expect(askEntry().getAttribute("aria-expanded")).toBe("true");
    expect(nav.router.push).not.toHaveBeenCalled();
    // The page stays, narrowed beside the panel: no dialog, nothing hidden.
    expect(within(screen.getByRole("main")).getByRole("heading", { name: "Page content" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".or-frame")!.classList.contains("or-frame--aside")).toBe(true);
    expect(panel()!.parentElement!.classList.contains("or-frame__aside")).toBe(true);

    await user.click(askEntry());
    expect(panel()).toBeNull();
    expect(askEntry().getAttribute("aria-expanded")).toBe("false");
  });

  it("navigates to /ask at phone widths", async () => {
    stubWidth(false);
    const user = userEvent.setup();
    renderShell();
    // Whether anything stopped the link from navigating (checked after React's handlers).
    const clicks: boolean[] = [];
    const record = (event: MouseEvent) => {
      clicks.push(event.defaultPrevented);
      event.preventDefault();
    };
    window.addEventListener("click", record);
    try {
      await user.click(within(tabBar()).getByRole("link", { name: "Ask" }));
      await user.click(askEntry());
    } finally {
      window.removeEventListener("click", record);
    }
    expect(clicks).toEqual([false, false]);
    expect(panel()).toBeNull();
  });

  it("is the current page on /ask pages, and the fourth phone tab", () => {
    for (const path of ["/ask", "/ask/new", `/ask/${CHAT_ID}`]) {
      const { unmount } = renderShell(path);
      expect(askEntry().getAttribute("aria-current")).toBe("page");
      const tabs = within(tabBar()).getAllByRole("link");
      expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
        "Inbox",
        "Runs",
        "Backlog",
        "Ask",
      ]);
      expect(tabs[3]!.getAttribute("aria-current")).toBe("page");
      unmount();
    }
    renderShell("/runs");
    expect(askEntry().getAttribute("aria-current")).toBeNull();
  });

  it("sits above Analytics and Settings at the bottom of the sidebar, with no indicator", () => {
    renderShell();
    const names = within(sidebar())
      .getAllByRole("link")
      .filter((link) => link.classList.contains("or-nav__item"))
      .map((link) => link.getAttribute("aria-label"));
    expect(names.slice(-3)).toEqual(["Ask", "Analytics", "Settings"]);
    expect(askEntry().querySelector(".or-nav__count, .or-nav__n2, .or-nav__pip")).toBeNull();
  });
});

describe("the Ask panel", () => {
  it("shows the chats list, New chat and a chat, and Close Ask closes it", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(askEntry());
    const aside = panel()!;
    // The chats list, focused on its first chat.
    const row = await within(aside).findByRole("link", { name: /Where does the login form post/ });
    await waitFor(() => expect(document.activeElement).toBe(row));

    await user.click(within(aside).getByRole("button", { name: "New chat" }));
    const picker = await within(panel()!).findByRole("combobox", { name: "Repo" });
    expect(picker).toBeTruthy();
    expect(document.activeElement).toBe(within(panel()!).getByRole("textbox", { name: "Message" }));

    // ‹ Chats goes back to the list, where a chat opens in the panel.
    await user.click(within(panel()!).getByRole("button", { name: "Chats" }));
    await user.click(
      await within(panel()!).findByRole("link", { name: /Where does the login form post/ }),
    );
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(
      await within(panel()!).findByRole("heading", { name: "Where does the login form post?" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(panel()!).getByRole("textbox", { name: "Message" }),
      ),
    );

    // New chat from a chat's header.
    await user.click(within(panel()!).getByRole("button", { name: "New chat" }));
    expect(await within(panel()!).findByRole("combobox", { name: "Repo" })).toBeTruthy();

    await user.click(within(panel()!).getByRole("button", { name: "Close Ask" }));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(askEntry());
  });

  it("stays open on the same chat across client-side navigation", async () => {
    const user = userEvent.setup();
    const { rerender } = renderShell("/runs");
    await user.click(askEntry());
    await user.click(
      await within(panel()!).findByRole("link", { name: /Where does the login form post/ }),
    );
    await within(panel()!).findByRole("heading", { name: "Where does the login form post?" });
    await user.type(within(panel()!).getByRole("textbox", { name: "Message" }), "And signup?");

    nav.pathname = "/repos/abc";
    rerender(shell(<h1>Repo page</h1>));
    expect(screen.getByRole("heading", { name: "Repo page" })).toBeTruthy();
    expect(
      within(panel()!).getByRole("heading", { name: "Where does the login form post?" }),
    ).toBeTruthy();
    expect(
      (within(panel()!).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value,
    ).toBe("And signup?");
  });

  it("reopens on the last chat after a reload, from sessionStorage", async () => {
    const user = userEvent.setup();
    const first = renderShell();
    await user.click(askEntry());
    await user.click(
      await within(panel()!).findByRole("link", { name: /Where does the login form post/ }),
    );
    expect(JSON.parse(window.sessionStorage.getItem(ASK_PANEL_STORAGE_KEY)!)).toEqual({
      open: true,
      view: "chat",
      chatId: CHAT_ID,
    });
    first.unmount();

    // A reload: a fresh shell reads the saved state.
    renderShell("/fleet");
    expect(
      await within(panel()!).findByRole("heading", { name: "Where does the login form post?" }),
    ).toBeTruthy();
    // Restoring doesn't steal focus from the page.
    expect(document.activeElement).toBe(document.body);
    expect(askEntry().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps working when sessionStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const user = userEvent.setup();
    renderShell();
    expect(panel()).toBeNull();
    await user.click(askEntry());
    expect(panel()).toBeTruthy();
    await user.click(within(panel()!).getByRole("button", { name: "Close Ask" }));
    expect(panel()).toBeNull();
    expect(readAskPanelState()).toBeNull();
    expect(() => writeAskPanelState({ open: true, view: "list", chatId: null })).not.toThrow();
  });

  it("ignores a malformed saved state", () => {
    for (const saved of [
      "not json",
      "null",
      JSON.stringify({ open: "yes", view: "list" }),
      JSON.stringify({ open: true, view: "sideways" }),
      JSON.stringify({ open: true, view: "chat" }),
    ]) {
      window.sessionStorage.setItem(ASK_PANEL_STORAGE_KEY, saved);
      expect(readAskPanelState(), saved).toBeNull();
    }
    window.sessionStorage.setItem(
      ASK_PANEL_STORAGE_KEY,
      JSON.stringify({ open: true, view: "new", chatId: "x" }),
    );
    expect(readAskPanelState()).toEqual({ open: true, view: "new", chatId: null });
  });
});

describe("Esc", () => {
  it("closes the panel from anywhere and returns focus to the Ask entry", async () => {
    const user = userEvent.setup();
    renderShell("/runs", <button type="button">Page button</button>);
    await user.click(askEntry());
    await within(panel()!).findByRole("link", { name: /Where does the login form post/ });
    // Focus on the page, outside the panel.
    screen.getByRole("button", { name: "Page button" }).focus();
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(askEntry());
  });

  it("closes it from the composer too", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(askEntry());
    await user.click(within(panel()!).getByRole("button", { name: "New chat" }));
    const composer = await within(panel()!).findByRole("textbox", { name: "Message" });
    expect(document.activeElement).toBe(composer);
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(askEntry());
  });

  it("leaves the panel open when an open menu handles it", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(askEntry());
    await user.click(within(sidebar()).getByRole("button", { name: "Ada" }));
    expect(await screen.findByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(panel()).toBeTruthy();
    // A second Esc, with nothing else open, closes the panel.
    await user.keyboard("{Escape}");
    expect(panel()).toBeNull();
  });

  it("does nothing while the panel is closed", async () => {
    const user = userEvent.setup();
    renderShell("/runs", <button type="button">Page button</button>);
    const button = screen.getByRole("button", { name: "Page button" });
    button.focus();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(button);
  });
});

describe("withAskEntry", () => {
  it("wires only the Ask entry", () => {
    const toggle = vi.fn();
    const items = withAskEntry(
      [
        {
          id: "runs",
          label: "Runs",
          href: "/runs",
          icon: () => null,
          placement: "main",
          phone: "tab",
        },
        {
          id: "ask",
          label: "Ask",
          href: "/ask",
          icon: () => null,
          placement: "bottom",
          phone: "tab",
        },
      ] as never,
      { open: true, toggle },
    );
    expect(items[0]).not.toHaveProperty("onSelect");
    expect(items[1]!.expanded).toBe(true);
    items[1]!.onSelect!({} as never);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("ask-panel.css", () => {
  it("fills the frame's aside column with the view", () => {
    const css = readFileSync(join(__dirname, "ask-panel.css"), "utf8");
    expect(css).toMatch(/\.or-ask-panel \{[^}]*height: 100%/);
    expect(css).toMatch(/\.or-ask-panel > \* \{[^}]*flex: 1/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
