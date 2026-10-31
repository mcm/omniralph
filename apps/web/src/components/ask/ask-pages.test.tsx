// @vitest-environment jsdom
// Ask on the phone (board MobileAsk): `/ask` is the Ask tab's root with the top bar and tab
// bar; New chat and a chat (`/ask/new`, `/ask/{id}`) open full screen without the tab bar,
// the chat header at the top and the composer pinned at the bottom.
import "@/components/pickers/test-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";
import { mockFetch, TEST_ORGANIZATION_ID, testUser } from "@/components/query-test-utils";
import type { AskChat as AskChatModel, AskChatDetail, AskChatList } from "@/lib/api/ask";
import { formatSseEvent, type AskStreamEventName, type AskStreamEvents } from "@/lib/ask/sse";
import { AskChatsPage } from "./ask-chats-page";
import { AskChatPage, AskNewChatPage, isAskFullScreenPath } from "./ask-pages";
import { resetAskChatMemory } from "./chat-memory";
import { omMessage, REPOSITORY } from "./test-fixtures";

const nav = vi.hoisted(() => ({
  pathname: "/ask",
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
const NEW_CHAT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_REPO = { id: "repo-2", provider: "github" as const, fullPath: "acme/billing" };

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

/** A `text/event-stream` response whose events the test sends one by one. */
function sseResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    send<K extends AskStreamEventName>(name: K, data: AskStreamEvents[K]) {
      controller.enqueue(encoder.encode(formatSseEvent(name, data)));
    },
    close: () => controller.close(),
  };
}

function mockAsk(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    "GET /api/ui/live/token": { token: null },
    "GET /api/ui/inbox/counts": { needsYou: 0, problems: 0, running: 0, questions: 0 },
    "GET /api/ui/backlog/counts": { readyToStart: 0, needsRefining: 0, total: 0 },
    "GET /api/ui/nav-indicators": {
      fleet: { offline: 0, updateFailed: 0 },
      settings: { failedDeliveries: 0, byConnection: [] },
    },
    "GET /api/ui/ask/chats": list,
    [`GET /api/ui/ask/chats/${CHAT_ID}`]: detail,
    "GET /api/ui/ask/repositories": {
      repositories: [REPOSITORY, OTHER_REPO].map((repository) => ({
        ...repository,
        organization: { id: ORG, name: "Acme", role: "admin" },
      })),
    },
    ...extra,
  });
}

/** `matchMedia` for a phone (768 px and narrower) or a desktop window. */
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

function renderPage(pathname: string, page: React.ReactNode) {
  nav.pathname = pathname;
  return render(
    <AppShell
      user={testUser}
      themePreference="dark"
      organizationCookie={null}
      scopeCookie={null}
      showAdvanced={false}
      sound={{ enabled: true, volume: 0.7 }}
    >
      {page}
    </AppShell>,
  );
}

const tabBar = () => document.querySelector<HTMLElement>(".or-tabbar");
const composer = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

/** The view's header comes first and its composer last: pinned at the top and the bottom. */
function expectPinned(view: HTMLElement) {
  const children = Array.from(view.children);
  expect(children[0]!.matches(".or-ask-chat__header")).toBe(true);
  expect(children.at(-1)!.matches(".or-ask-composer")).toBe(true);
  expect(view.closest(".or-ask-page--full")).not.toBeNull();
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetAskChatMemory();
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  stubWidth(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isAskFullScreenPath", () => {
  it("is true for New chat and a chat, not for the chats list or other pages", () => {
    expect(isAskFullScreenPath("/ask/new")).toBe(true);
    expect(isAskFullScreenPath(`/ask/${CHAT_ID}`)).toBe(true);
    expect(isAskFullScreenPath(`/ask/${CHAT_ID}/`)).toBe(true);
    expect(isAskFullScreenPath("/ask")).toBe(false);
    expect(isAskFullScreenPath("/ask/")).toBe(false);
    expect(isAskFullScreenPath("/asking/x")).toBe(false);
    expect(isAskFullScreenPath("/backlog/x")).toBe(false);
  });
});

describe("the Ask tab's root (/ask)", () => {
  it("shows the Ask heading, New chat and the chats, with the top bar and the tab bar", async () => {
    mockAsk();
    const user = userEvent.setup();
    renderPage("/ask", <AskChatsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Ask" })).toBeTruthy();
    expect(document.querySelector(".or-topbar")).not.toBeNull();
    const tabs = within(tabBar()!).getAllByRole("link");
    expect(tabs).toHaveLength(4);
    expect(tabs[3]!.getAttribute("aria-label")).toBe("Ask");
    expect(tabs[3]!.getAttribute("aria-current")).toBe("page");

    const row = await screen.findByRole("link", { name: new RegExp(chat.title) });
    expect(row.getAttribute("href")).toBe(`/ask/${CHAT_ID}`);
    // No Close on a page: it isn't the panel.
    expect(screen.queryByRole("button", { name: "Close Ask" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(nav.router.push).toHaveBeenCalledWith("/ask/new");
  });

  it("follows the Ask tab to /ask on a phone instead of opening the panel", async () => {
    mockAsk();
    renderPage("/runs", <h1>Runs</h1>);
    const ask = within(tabBar()!).getByRole("link", { name: "Ask" });
    expect(ask.getAttribute("href")).toBe("/ask");
    expect(screen.queryByRole("complementary", { name: "Ask" })).toBeNull();
  });
});

describe("a chat (/ask/{id})", () => {
  it("opens full screen without the tab bar: header (‹ Chats, title, badges, New chat; no Close) and composer pinned", async () => {
    mockAsk();
    const user = userEvent.setup();
    renderPage(`/ask/${CHAT_ID}`, <AskChatPage chatId={CHAT_ID} />);
    expect(tabBar()).toBeNull();
    expect(document.querySelector(".or-frame--no-tabbar")).not.toBeNull();
    // The top bar stays (menu and organization).
    expect(document.querySelector(".or-topbar")).not.toBeNull();

    expect(await screen.findByRole("heading", { level: 1, name: chat.title })).toBeTruthy();
    const view = screen.getByRole("region", { name: chat.title });
    expectPinned(view);
    const header = view.querySelector<HTMLElement>(".or-ask-chat__header")!;
    expect(within(header).getByText("acme/customer-portal")).toBeTruthy();
    expect(within(header).getByText("main")).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Close Ask" })).toBeNull();
    expect(composer().placeholder).toBe("Ask a follow-up…");

    await user.click(within(header).getByRole("button", { name: "Chats" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/ask");
    await user.click(within(header).getByRole("button", { name: "New chat" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/ask/new");
  });

  it("renders the same chat view in the main area at desktop widths", async () => {
    stubWidth(true);
    mockAsk();
    renderPage(`/ask/${CHAT_ID}`, <AskChatPage chatId={CHAT_ID} />);
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { level: 1, name: chat.title })).toBeTruthy();
    expect(within(main).getByRole("textbox", { name: "Message" })).toBeTruthy();
  });
});

describe("New chat (/ask/new)", () => {
  it("opens full screen, preselects ?repository= and replaces itself with the started chat", async () => {
    const stream = sseResponse();
    const started: AskChatModel = {
      ...chat,
      id: NEW_CHAT_ID,
      title: "How are invoices numbered?",
      repository: OTHER_REPO,
    };
    const seen = mockAsk({
      "POST /api/ui/ask/chats": () => stream.response,
      [`GET /api/ui/ask/chats/${NEW_CHAT_ID}`]: {
        chat: started,
        messages: [],
        activity: null,
        nextBefore: null,
      },
    });
    const user = userEvent.setup();
    renderPage("/ask/new", <AskNewChatPage repositoryId={OTHER_REPO.id} />);
    expect(tabBar()).toBeNull();
    const view = screen.getByRole("region", { name: "New chat" });
    expectPinned(view);
    expect(screen.getByRole("heading", { level: 1, name: "Ask" })).toBeTruthy();
    expect(within(view).queryByRole("button", { name: "Close Ask" })).toBeNull();
    const repo = screen.getByRole<HTMLSelectElement>("combobox", { name: "Repo" });
    await waitFor(() => expect(repo.value).toBe(`${ORG}:${OTHER_REPO.id}`));
    expect(composer().placeholder).toBe("Ask about billing…");
    // Opened on purpose: the composer has focus.
    expect(document.activeElement).toBe(composer());

    await user.type(composer(), "How are invoices numbered?{Enter}");
    const post = seen.find((r) => r.method === "POST" && r.path === "/api/ui/ask/chats");
    expect(post?.body).toEqual({
      organizationId: ORG,
      repositoryId: OTHER_REPO.id,
      text: "How are invoices numbered?",
    });
    await act(async () => {
      stream.send("chat", { chat: started });
    });
    await waitFor(() => expect(nav.router.replace).toHaveBeenCalledWith(`/ask/${NEW_CHAT_ID}`));
    expect(nav.router.push).not.toHaveBeenCalled();
    await act(async () => {
      stream.send("done", {});
      stream.close();
    });

    await user.click(within(view).getByRole("button", { name: "Chats" }));
    expect(nav.router.push).toHaveBeenCalledWith("/ask");
  });
});

describe("ask-page.css", () => {
  const css = readFileSync(join(__dirname, "ask-page.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const phone = css.slice(css.indexOf("@media (max-width: 768px)"));

  it("fills the viewport with New chat and a chat, below the phone's top bar", () => {
    expect(css).toMatch(/\.or-ask-page--full \{[^}]*height: 100dvh;/);
    expect(phone).toMatch(/\.or-ask-page--full \{[^}]*height: calc\(100dvh - 52px\);/);
    expect(css).toMatch(/\.or-ask-page > \* \{[^}]*flex: 1;[^}]*min-height: 0;/);
  });

  it("keeps the chats list's header under the phone's top bar", () => {
    expect(phone).toMatch(/\.or-ask-page \.or-ask-chats__header \{[^}]*top: 52px;/);
  });

  it("pins the composer at the bottom above the safe area, and scrolls the messages between", () => {
    const chatCss = readFileSync(join(__dirname, "ask-chat.css"), "utf8");
    expect(chatCss).toMatch(/\.or-ask-composer \{[^}]*position: sticky;[^}]*bottom: 0;/);
    expect(chatCss).toMatch(/\.or-ask-composer \{[^}]*padding: [^;]*env\(safe-area-inset-bottom\)/);
    expect(chatCss).toMatch(/\.or-ask-chat__messages \{[^}]*overflow-y: auto;/);
    expect(chatCss).toMatch(/\.or-ask-chat__header \{[^}]*position: sticky;[^}]*top: 0;/);
  });
});
