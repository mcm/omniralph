// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import { LiveProvider } from "@/components/live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "@/components/live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type {
  AskChat as AskChatModel,
  AskChatList,
  AskMessageView,
  AskRepositoryOption,
} from "@/lib/api/ask";
import { askKeys, queryKeys } from "@/lib/api/keys";
import { createQueryClient } from "@/lib/api/query-client";
import { formatSseEvent, type AskStreamEventName, type AskStreamEvents } from "@/lib/ask/sse";
import { AskChat } from "./ask-chat";
import { AskChatsList, type AskChatsListProps } from "./ask-chats-list";
import { AskContextProvider, useAskContextRepository } from "./ask-context";
import { AskNewChat, type AskNewChatProps, newChatPlaceholder } from "./ask-new-chat";
import { chatMessages, withMissingMessages, withTurn, type AskChatData } from "./chat-cache";
import { resetAskChatMemory } from "./chat-memory";
import { omMessage, REPOSITORY } from "./test-fixtures";
import type { AskChatListData } from "./use-ask-chats";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const ORG = TEST_ORGANIZATION_ID;
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const CHATS_PATH = "/api/ui/ask/chats";
const REPOS_PATH = "/api/ui/ask/repositories";
const NEW_CHAT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const keys = askKeys(queryKeys(ORG));

const acme = { id: ORG, name: "Acme", role: "admin" as const };
const globex = { id: OTHER_ORG, name: "Globex", role: "member" as const };

const allOrganizationsUser: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { id: ORG, name: "Acme", role: "admin" },
    { id: OTHER_ORG, name: "Globex", role: "member" },
  ],
};

function chat(overrides: Partial<AskChatModel> = {}): AskChatModel {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Where does the login form post?",
    organization: acme,
    repository: REPOSITORY,
    branch: "main",
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

const allReposChat = chat({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "Which repos still use Node 18?",
  repository: null,
  branch: null,
  updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
});

const page = (chats: AskChatModel[], nextCursor: string | null = null): AskChatList => ({
  chats,
  nextCursor,
});

const repository = (
  overrides: Partial<AskRepositoryOption> & Pick<AskRepositoryOption, "id" | "fullPath">,
): AskRepositoryOption => ({ provider: "github", organization: acme, ...overrides });

const REPOS = [
  repository({ id: REPOSITORY.id, fullPath: REPOSITORY.fullPath }),
  repository({ id: "repo-2", fullPath: "acme/billing" }),
];

const gets = (seen: SeenRequest[], path: string) =>
  seen.filter((request) => request.method === "GET" && request.path === path);

beforeEach(() => {
  ui.toast.mockReset();
  resetAskChatMemory();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function listProps(overrides: Partial<AskChatsListProps> = {}): AskChatsListProps {
  return { onNewChat: vi.fn(), ...overrides };
}

function renderList(
  overrides: Partial<AskChatsListProps> = {},
  { client = createTestQueryClient(), user = testUser } = {},
) {
  const Wrapper = queryWrapper(client, user);
  return render(<AskChatsList {...listProps(overrides)} />, { wrapper: Wrapper });
}

/** Captures the list's IntersectionObservers so a test can scroll its end into view. */
function stubIntersectionObserver() {
  const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
  class FakeObserver {
    targets: Element[] = [];
    constructor(public callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.targets = [];
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  return {
    scrollToEnd() {
      for (const observer of observers) {
        for (const target of observer.targets) {
          observer.callback(
            [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
            observer as unknown as IntersectionObserver,
          );
        }
      }
    },
  };
}

describe("AskChatsList", () => {
  it("renders the header with New chat and one row per chat, newest activity first", async () => {
    const seen = mockFetch({ [CHATS_PATH]: page([chat(), allReposChat]) });
    const onNewChat = vi.fn();
    const onClose = vi.fn();
    renderList({ onNewChat, onClose });

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Ask" })).toBeTruthy();

    const header = screen.getByRole("banner");
    const newChat = within(header).getByRole("button", { name: "New chat" });
    expect(newChat.className).toContain("or-btn--solid");
    expect(newChat.className).toContain("or-btn--sm");

    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(within(first).getByRole("link", { name: chat().title })).toBeTruthy();
    const time = first.querySelector(".or-row__time")!;
    expect(time.className).toContain("or-mono");
    expect(time.textContent).toBe("5m");
    expect(within(first).getByText("acme/customer-portal")).toBeTruthy();
    expect(second.querySelector(".or-row__time")!.textContent).toBe("1d");
    expect(within(second).getByText("All repos")).toBeTruthy();
    // One organization: no row carries an organization badge.
    expect(screen.queryByText("Acme")).toBeNull();
    expect(gets(seen, CHATS_PATH)[0]!.query.get("organization")).toBe(ORG);

    const user = userEvent.setup();
    await user.click(newChat);
    await user.click(within(header).getByRole("button", { name: "Close Ask" }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('starts every row with its organization under "All organizations"', async () => {
    const seen = mockFetch({
      [CHATS_PATH]: page([chat(), chat({ id: NEW_CHAT_ID, organization: globex })]),
    });
    renderList({}, { user: allOrganizationsUser });
    const rows = await screen.findAllByRole("listitem");
    const metas = rows.map((row) => row.querySelector(".or-row__meta")!);
    expect(metas[0]!.firstElementChild!.textContent).toContain("Acme");
    expect(metas[1]!.firstElementChild!.textContent).toContain("Globex");
    expect(metas[0]!.textContent).toContain("acme/customer-portal");
    expect(gets(seen, CHATS_PATH)[0]!.query.get("organization")).toBe("all");
  });

  it("links each row to its chat page, or opens it in place with onOpenChat", async () => {
    mockFetch({ [CHATS_PATH]: page([chat()]) });
    const { unmount } = renderList();
    const link = await screen.findByRole("link", { name: chat().title });
    expect(link.getAttribute("href")).toBe(`/ask/${chat().id}`);
    unmount();

    const onOpenChat = vi.fn();
    renderList({ onOpenChat });
    await userEvent.setup().click(await screen.findByRole("link", { name: chat().title }));
    expect(onOpenChat).toHaveBeenCalledWith(chat().id);
  });

  it("loads the next page with the cursor when the list scrolls to its end", async () => {
    const observer = stubIntersectionObserver();
    const older = chat({ id: NEW_CHAT_ID, title: "An older chat" });
    const seen = mockFetch({
      [CHATS_PATH]: (request) =>
        jsonResponse(
          request.query.get("cursor") === "next-1" ? page([older]) : page([chat()], "next-1"),
        ),
    });
    renderList();
    await screen.findByText(chat().title);
    expect(gets(seen, CHATS_PATH)).toHaveLength(1);

    act(() => observer.scrollToEnd());
    await screen.findByText("An older chat");
    const requests = gets(seen, CHATS_PATH);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.query.get("cursor")).toBe("next-1");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // The last page: nothing left to load.
    expect(screen.queryByTestId("ask-chats-more")).toBeNull();
  });

  it('shows "No chats yet" with New chat when there are none', async () => {
    mockFetch({ [CHATS_PATH]: page([]) });
    const onNewChat = vi.fn();
    renderList({ onNewChat });
    expect(await screen.findByRole("heading", { name: "No chats yet" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    const buttons = screen.getAllByRole("button", { name: "New chat" });
    expect(buttons).toHaveLength(2);
    await userEvent.setup().click(buttons[1]!);
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("shows why the list couldn't load, with Retry", async () => {
    let found = false;
    mockFetch({
      [CHATS_PATH]: () =>
        found ? jsonResponse(page([chat()])) : jsonResponse({ error: "Something broke." }, 500),
    });
    renderList();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load your chats. Something broke.");
    found = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(chat().title)).toBeTruthy();
  });

  describe("live updates", () => {
    function renderLive() {
      const ably = fakeAbly();
      const client = createQueryClient();
      render(
        <CurrentUserProvider user={testUser}>
          <QueryClientProvider client={client}>
            <LiveProvider createClient={ably.createClient} fetchToken={fakeToken}>
              <AskChatsList {...listProps()} />
            </LiveProvider>
          </QueryClientProvider>
        </CurrentUserProvider>,
      );
      const ready = async () => {
        await waitFor(() => expect(ably.current()?.subscribed()).toContain("user:user-1:changes"));
        act(() => ably.current().setState("connected"));
      };
      return { ably, ready };
    }

    const titles = () =>
      screen
        .getAllByRole("listitem")
        .map((row) => row.querySelector(".or-row__title")!.textContent);

    it("moves a chat that got a message to the top, and shows one started in another tab", async () => {
      const first = chat();
      let chats = [first, allReposChat];
      const seen = mockFetch({ [CHATS_PATH]: () => jsonResponse(page(chats)) });
      const { ably, ready } = renderLive();
      await ready();
      await screen.findByText(first.title);
      await waitFor(() => expect(gets(seen, CHATS_PATH)).toHaveLength(1));

      chats = [allReposChat, first];
      act(() =>
        ably
          .current()
          .deliver(
            "user:user-1:changes",
            changeEvent(ORG, { resource: "chat", ids: [allReposChat.id] }),
          ),
      );
      await waitFor(() => expect(titles()).toEqual([allReposChat.title, first.title]));

      const started = chat({ id: NEW_CHAT_ID, title: "Started in another tab" });
      chats = [started, allReposChat, first];
      act(() =>
        ably
          .current()
          .deliver(
            "user:user-1:changes",
            changeEvent(ORG, { resource: "chat", ids: [NEW_CHAT_ID] }),
          ),
      );
      await waitFor(() =>
        expect(titles()).toEqual([started.title, allReposChat.title, first.title]),
      );
      expect(gets(seen, CHATS_PATH)).toHaveLength(3);
    });

    it("ignores another member's chat events", async () => {
      const seen = mockFetch({ [CHATS_PATH]: page([chat()]) });
      const { ably, ready } = renderLive();
      await ready();
      await screen.findByText(chat().title);
      await waitFor(() => expect(gets(seen, CHATS_PATH)).toHaveLength(1));
      expect(ably.current().subscribed()).not.toContain("user:user-2:changes");

      act(() =>
        ably
          .current()
          .deliver(
            "user:user-2:changes",
            changeEvent(ORG, { resource: "chat", ids: [NEW_CHAT_ID] }),
          ),
      );
      await act(async () => {});
      expect(gets(seen, CHATS_PATH)).toHaveLength(1);
    });
  });
});

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

/** Registers the page's repo, as a repo page does. */
function PageRepo({ repositoryId }: { repositoryId: string }) {
  useAskContextRepository(repositoryId);
  return null;
}

function newChatProps(overrides: Partial<AskNewChatProps> = {}): AskNewChatProps {
  return { onBack: vi.fn(), onChatStarted: vi.fn(), ...overrides };
}

function renderNewChat(
  overrides: Partial<AskNewChatProps> = {},
  {
    client = createTestQueryClient(),
    user = testUser,
    pageRepositoryId = null as string | null,
  } = {},
) {
  const Wrapper = queryWrapper(client, user);
  return render(
    <AskContextProvider>
      {pageRepositoryId ? <PageRepo repositoryId={pageRepositoryId} /> : null}
      <AskNewChat {...newChatProps(overrides)} />
    </AskContextProvider>,
    { wrapper: Wrapper },
  );
}

const picker = () => screen.getByRole("button", { name: /^Repo: / }) as HTMLButtonElement;
const composer = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const selectedLabel = () => picker().textContent;

/** Opens the Repo picker's menu once `name` is offered (the repos loaded), and returns it. */
async function openPicker(name: string) {
  const user = userEvent.setup();
  return waitFor(async () => {
    await user.click(picker());
    const menu = screen.getByRole("menu");
    within(menu).getByRole("menuitemcheckbox", { name });
    return menu;
  });
}

/** Waits until the picker offers `name`, then closes its menu again. */
async function reposLoaded(name: string) {
  await openPicker(name);
  await userEvent.setup().keyboard("{Escape}");
}

/** Picks `name` in the Repo picker. */
async function pick(name: string) {
  const menu = await openPicker(name);
  await userEvent.setup().click(within(menu).getByRole("menuitemcheckbox", { name }));
}

describe("AskNewChat", () => {
  it('offers "All repos" first, then the repos a chat can ask about', async () => {
    const seen = mockFetch({ [REPOS_PATH]: { repositories: REPOS } });
    renderNewChat();
    expect(selectedLabel()).toBe("All repos");
    const menu = await openPicker("acme/billing");
    const options = within(menu).getAllByRole("menuitemcheckbox");
    // The label, not the marks' SVG titles.
    const label = (option: HTMLElement) => option.querySelector(".or-menu__label")!.textContent;
    expect(options.map(label)).toEqual(["All repos", "acme/customer-portal", "acme/billing"]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(within(menu).queryAllByRole("group")).toEqual([]);
    expect(gets(seen, REPOS_PATH)[0]!.query.get("organization")).toBe(ORG);
    // The header: "Ask", no picker-free badges yet.
    expect(screen.getByRole("heading", { name: "Ask" })).toBeTruthy();
  });

  it('groups the repos per organization under "All organizations"', async () => {
    mockFetch({
      [REPOS_PATH]: {
        repositories: [
          ...REPOS,
          repository({ id: "repo-3", fullPath: "globex/api", organization: globex }),
        ],
      },
    });
    renderNewChat({}, { user: allOrganizationsUser });
    const menu = await openPicker("globex/api");
    const items = (name: string) =>
      within(within(menu).getByRole("group", { name }))
        .getAllByRole("menuitemcheckbox")
        .map((item) => item.querySelector(".or-menu__label")!.textContent);
    expect(within(menu).getAllByRole("group")).toHaveLength(2);
    expect(items("Acme")).toEqual(["All repos in Acme", "acme/customer-portal", "acme/billing"]);
    expect(items("Globex")).toEqual(["All repos in Globex", "globex/api"]);
    expect(selectedLabel()).toBe("All repos in Acme");
  });

  it("starts on the page's repo, and reads the placeholder from the choice", async () => {
    mockFetch({ [REPOS_PATH]: { repositories: REPOS } });
    renderNewChat({}, { pageRepositoryId: "repo-2" });
    await waitFor(() => expect(selectedLabel()).toBe("acme/billing"));
    expect(composer().placeholder).toBe("Ask about billing…");

    await pick("All repos");
    expect(composer().placeholder).toBe("Ask about your repos…");
  });

  it("leads the picker with the chosen repo's host mark (Design rule 1)", async () => {
    const gitlab = repository({ id: "repo-3", fullPath: "acme/infra", provider: "gitlab" });
    mockFetch({ [REPOS_PATH]: { repositories: [...REPOS, gitlab] } });
    renderNewChat({}, { pageRepositoryId: "repo-3" });
    await waitFor(() => expect(selectedLabel()).toBe("acme/infra"));
    const leading = () => picker().closest(".or-select")!.querySelector(".or-select__leading")!;
    expect(leading().getAttribute("aria-hidden")).toBe("true");
    expect(leading().querySelector(".or-brand-mark")!.getAttribute("aria-label")).toBe("GitLab");

    // Every repo option carries its host's mark too; All repos its icon.
    const menu = await openPicker("acme/infra");
    const option = (name: string) => within(menu).getByRole("menuitemcheckbox", { name });
    expect(option("acme/infra").querySelector(".or-brand-mark")!.getAttribute("aria-label")).toBe(
      "GitLab",
    );
    expect(option("acme/billing").querySelector(".or-brand-mark")).not.toBeNull();
    expect(option("All repos").querySelector(".or-brand-mark")).toBeNull();
    expect(option("All repos").querySelector("svg")).toBeTruthy();
    await userEvent.setup().click(option("All repos"));
    expect(leading().querySelector(".or-brand-mark")).toBeNull();
    expect(leading().querySelector("svg")).toBeTruthy();
  });

  it('falls back to "All repos" when the page\'s repo has Ask off', async () => {
    // repo-off isn't offered: Ask is off (or it's disconnected).
    mockFetch({ [REPOS_PATH]: { repositories: REPOS } });
    renderNewChat({}, { pageRepositoryId: "repo-off" });
    await reposLoaded("acme/billing");
    expect(selectedLabel()).toBe("All repos");
    expect(composer().placeholder).toBe("Ask about your repos…");
  });

  it("names the repo in the placeholder", () => {
    expect(newChatPlaceholder({ fullPath: "acme/customer-portal" })).toBe(
      "Ask about customer-portal…",
    );
    expect(newChatPlaceholder(null)).toBe("Ask about your repos…");
  });

  it("starts the chat, puts it on top of the list and streams the reply in the chat", async () => {
    const stream = sseResponse();
    const started = chat({
      id: NEW_CHAT_ID,
      title: "Where is the session cookie set?",
      updatedAt: new Date().toISOString(),
    });
    const seen = mockFetch({
      [REPOS_PATH]: { repositories: REPOS },
      [`GET ${CHATS_PATH}`]: page([chat()]),
      [`POST ${CHATS_PATH}`]: () => stream.response,
      [`GET ${CHATS_PATH}/${NEW_CHAT_ID}`]: {
        chat: started,
        messages: [],
        activity: null,
        nextBefore: null,
      },
    });
    const client = createTestQueryClient();

    // Ask as the panel shows it: the list, New chat, then the chat it switches to.
    function Ask() {
      const [view, setView] = React.useState<{ kind: "new" } | { kind: "chat"; id: string }>({
        kind: "new",
      });
      return (
        <>
          <AskChatsList onNewChat={() => setView({ kind: "new" })} />
          {view.kind === "new" ? (
            <AskNewChat
              onBack={vi.fn()}
              onChatStarted={(created) => setView({ kind: "chat", id: created.id })}
            />
          ) : (
            <AskChat chatId={view.id} onBack={vi.fn()} onNewChat={() => setView({ kind: "new" })} />
          )}
        </>
      );
    }
    const Wrapper = queryWrapper(client);
    render(
      <AskContextProvider>
        <PageRepo repositoryId={REPOSITORY.id} />
        <Ask />
      </AskContextProvider>,
      { wrapper: Wrapper },
    );
    await screen.findByText(chat().title);
    await waitFor(() => expect(selectedLabel()).toBe("acme/customer-portal"));
    expect(composer().placeholder).toBe("Ask about customer-portal…");

    const user = userEvent.setup();
    await user.type(composer(), "Where is the session cookie set?{Enter}");
    // The member's message shows before the server answers.
    expect(screen.getByText("Where is the session cookie set?")).toBeTruthy();
    const posts = seen.filter((r) => r.method === "POST" && r.path === CHATS_PATH);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      organizationId: ORG,
      repositoryId: REPOSITORY.id,
      text: "Where is the session cookie set?",
    });

    const userMessage: AskMessageView = omMessage({
      id: "m-1",
      author: "user",
      markdown: "Where is the session cookie set?",
    });
    await act(async () => {
      stream.send("chat", { chat: started });
      stream.send("message", { message: userMessage });
      stream.send("message", {
        message: omMessage({ id: "m-2", markdown: "", status: "streaming" }),
      });
      stream.send("delta", { messageId: "m-2", text: "In `session.ts`" });
    });

    // On top of the list, before any change event.
    const list = client.getQueryData<AskChatListData>(keys.chats(ORG))!;
    expect(list.pages[0]!.chats.map((c) => c.id)).toEqual([NEW_CHAT_ID, chat().id]);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("listitem")
          .map((row) => row.querySelector(".or-row__title")!.textContent),
      ).toEqual([started.title, chat().title]),
    );

    // Switched to the chat: the reply streams there, and the repo is a badge, not a picker.
    const header = await screen.findByRole("heading", { name: started.title });
    expect(await screen.findByText("session.ts", { selector: "code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Repo: / })).toBeNull();
    const banner = header.closest("header")!;
    expect(within(banner).getByText("acme/customer-portal")).toBeTruthy();
    expect(within(banner).getByText("main")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      stream.send("message", {
        message: omMessage({ id: "m-2", markdown: "In `session.ts`, on sign-in." }),
      });
      stream.send("done", {});
      stream.close();
    });
    expect(await screen.findByText(/on sign-in/)).toBeTruthy();
    expect(screen.getAllByText("Where is the session cookie set?", { selector: "p" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: /^Repo: / })).toBeNull();
  });

  it("keeps the text and says why when the chat can't start", async () => {
    mockFetch({
      [REPOS_PATH]: { repositories: REPOS },
      [`POST ${CHATS_PATH}`]: () =>
        jsonResponse({ error: "Ask is off for this repo.", code: "repository_unavailable" }, 400),
    });
    const onChatStarted = vi.fn();
    renderNewChat({ onChatStarted });
    await reposLoaded("acme/billing");
    const user = userEvent.setup();
    await user.type(composer(), "Anything?{Enter}");
    await waitFor(() => expect(composer().value).toBe("Anything?"));
    expect(ui.toast).toHaveBeenCalledWith("Ask is off for this repo.", { variant: "danger" });
    expect(onChatStarted).not.toHaveBeenCalled();
    expect(picker().disabled).toBe(false);
  });
});

describe("a turn's messages over a load that predates them", () => {
  it("keeps the turn's stored and streaming messages, with the streamed text", () => {
    const loaded: AskChatData = {
      pages: [{ chat: chat(), messages: [], activity: null, nextBefore: null }],
      pageParams: [undefined],
    };
    const mine = omMessage({ id: "m-1", author: "user", markdown: "Hi" });
    const reply = omMessage({ id: "m-2", markdown: "", status: "streaming" });
    const shown = withTurn(loaded, {
      pending: null,
      streamed: new Map([["m-2", "Hello"]]),
      messages: new Map([
        ["m-1", mine],
        ["m-2", reply],
      ]),
    });
    expect(chatMessages(shown).map((m) => [m.id, m.markdown])).toEqual([
      ["m-1", "Hi"],
      ["m-2", "Hello"],
    ]);
    // Rows the load has win over the turn's copies.
    const stored = withMissingMessages(
      { ...loaded, pages: [{ ...loaded.pages[0]!, messages: [{ ...mine, markdown: "Hi!" }] }] },
      [mine],
    );
    expect(chatMessages(stored).map((m) => m.markdown)).toEqual(["Hi!"]);
  });
});
