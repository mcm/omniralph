// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
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
import type { AskChat as AskChatModel, AskChatDetail, AskMessageView } from "@/lib/api/ask";
import { askKeys, queryKeys } from "@/lib/api/keys";
import { createQueryClient } from "@/lib/api/query-client";
import { formatSseEvent, type AskStreamEventName, type AskStreamEvents } from "@/lib/ask/sse";
import { AskChat, type AskChatProps } from "./ask-chat";
import { resetAskChatMemory } from "./chat-memory";
import { composerRows } from "./composer";
import { omMessage, REPOSITORY, requestDraft } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const ORG = TEST_ORGANIZATION_ID;
const CHAT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CHAT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHAT_PATH = `/api/ui/ask/chats/${CHAT_ID}`;
const keys = askKeys(queryKeys(ORG));

const chat: AskChatModel = {
  id: CHAT_ID,
  title: "Where does the login form post?",
  organization: { id: ORG, name: "Acme", role: "admin" },
  repository: REPOSITORY,
  branch: "main",
  updatedAt: "2026-10-27T10:00:00.000Z",
};

const userMessage = (id: string, markdown: string): AskMessageView =>
  omMessage({ id, author: "user", markdown });

function detail(overrides: Partial<AskChatDetail> = {}): AskChatDetail {
  return {
    chat,
    messages: [userMessage("m-1", "Where does the login form post?"), omMessage({ id: "m-2" })],
    activity: null,
    nextBefore: null,
    ...overrides,
  };
}

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

/** A deferred response for a route, so the test decides when the server answers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const props = (overrides: Partial<AskChatProps> = {}): AskChatProps => ({
  chatId: CHAT_ID,
  onBack: vi.fn(),
  onNewChat: vi.fn(),
  ...overrides,
});

function renderChat(client: QueryClient, overrides: Partial<AskChatProps> = {}) {
  const Wrapper = queryWrapper(client);
  return render(<AskChat {...props(overrides)} />, { wrapper: Wrapper });
}

const gets = (seen: SeenRequest[], path = CHAT_PATH) =>
  seen.filter((request) => request.method === "GET" && request.path === path);

const composer = () => screen.getByRole("textbox", { name: "Message" });
const sendButton = () => screen.getByRole("button", { name: "Send" });

beforeEach(() => {
  ui.toast.mockReset();
  resetAskChatMemory();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AskChat", () => {
  it("renders the header, the messages, the activity line and the composer", async () => {
    mockFetch({
      [CHAT_PATH]: detail({
        activity: { state: "running", repository: REPOSITORY, filesRead: 3, runIds: [RUN_ID] },
      }),
    });
    const onBack = vi.fn();
    const onNewChat = vi.fn();
    const onClose = vi.fn();
    renderChat(createTestQueryClient(), { onBack, onNewChat, onClose });

    expect(await screen.findByRole("heading", { name: chat.title })).toBeTruthy();
    const header = screen.getByRole("banner");
    expect(within(header).getByText("acme/customer-portal")).toBeTruthy();
    expect(within(header).getByText("main")).toBeTruthy();
    expect(screen.getByText(/The login form posts to/)).toBeTruthy();
    expect(screen.getByText("Om is reading customer-portal · 3 files")).toBeTruthy();
    expect(composer().getAttribute("placeholder")).toBe("Ask a follow-up…");

    const user = userEvent.setup();
    await user.click(within(header).getByRole("button", { name: "Chats" }));
    await user.click(within(header).getByRole("button", { name: "New chat" }));
    await user.click(within(header).getByRole("button", { name: "Close Ask" }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows "All repos" for a chat about every repo, and no Close without onClose', async () => {
    mockFetch({ [CHAT_PATH]: detail({ chat: { ...chat, repository: null, branch: null } }) });
    renderChat(createTestQueryClient());
    const header = await screen.findByRole("banner");
    await within(header).findByText("All repos");
    expect(within(header).queryByRole("button", { name: "Close Ask" })).toBeNull();
    expect(within(header).getByRole("button", { name: "New chat" })).toBeTruthy();
  });

  it("shows why the chat couldn't load, with Retry", async () => {
    let found = false;
    const seen = mockFetch({
      [CHAT_PATH]: () =>
        found ? jsonResponse(detail()) : jsonResponse({ error: "Chat not found." }, 404),
    });
    renderChat(createTestQueryClient());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the chat. Chat not found.");
    found = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText(/The login form posts to/);
    expect(gets(seen)).toHaveLength(2);
  });

  it("puts the composer last, after the messages (pinned at the bottom)", async () => {
    mockFetch({ [CHAT_PATH]: detail() });
    const { container } = renderChat(createTestQueryClient());
    await screen.findByText(/The login form posts to/);
    const section = container.querySelector(".or-ask-chat")!;
    expect(section.lastElementChild!.className).toBe("or-ask-composer");
    const css = readFileSync(join(__dirname, "ask-chat.css"), "utf8");
    expect(css).toMatch(/\.or-ask-composer \{[^}]*position: sticky;[^}]*bottom: 0;/);
    expect(css).toMatch(/\.or-ask-chat__messages \{[^}]*overflow-y: auto;/);
  });
});

describe("the composer", () => {
  it("grows from 2 to 8 rows", () => {
    expect(composerRows("")).toBe(2);
    expect(composerRows("a\nb\nc")).toBe(3);
    expect(composerRows("a\n".repeat(20))).toBe(8);
    expect(composerRows("one long line", 5)).toBe(5);
  });

  it("sends with Enter, adds a line with Shift+Enter, and disables Send when blank or streaming", async () => {
    const stream = sseResponse();
    const seen = mockFetch({
      [`GET ${CHAT_PATH}`]: detail(),
      [`POST ${CHAT_PATH}/messages`]: () => stream.response,
    });
    renderChat(createTestQueryClient());
    await screen.findByText(/The login form posts to/);
    const user = userEvent.setup();

    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    await user.type(composer(), "   ");
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    await user.clear(composer());

    await user.type(composer(), "First line{Shift>}{Enter}{/Shift}second line");
    expect((composer() as HTMLTextAreaElement).value).toBe("First line\nsecond line");
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(0);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);

    await user.keyboard("{Enter}");
    const posts = seen.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ text: "First line\nsecond line" });
    expect((composer() as HTMLTextAreaElement).value).toBe("");

    // While the turn streams, Send stays disabled even with text.
    await user.type(composer(), "Next question");
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Enter}");
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);

    await act(async () => {
      stream.send("message", { message: userMessage("m-3", "First line\nsecond line") });
      stream.send("done", {});
      stream.close();
    });
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false));
    expect((composer() as HTMLTextAreaElement).value).toBe("Next question");
  });
});

describe("sending a message", () => {
  it("writes the stream's events into the chat's cache, with no refetch to show the reply", async () => {
    const stream = sseResponse();
    const answered = deferred<Response>();
    const seen = mockFetch({
      [`GET ${CHAT_PATH}`]: detail(),
      [`POST ${CHAT_PATH}/messages`]: () => answered.promise,
    });
    const client = createTestQueryClient();
    renderChat(client);
    await screen.findByText(/The login form posts to/);
    const user = userEvent.setup();

    await user.type(composer(), "And the logout?{Enter}");
    // Before the server has answered anything.
    expect(screen.getByText("And the logout?")).toBeTruthy();

    await act(async () => answered.resolve(stream.response));
    await act(async () => {
      stream.send("message", { message: userMessage("m-3", "And the logout?") });
      stream.send("status", { text: "Looking at runs" });
    });
    await screen.findByRole("status");
    expect(screen.getByRole("status").textContent).toBe("Looking at runs");
    expect(screen.getAllByText("And the logout?")).toHaveLength(1);

    await act(async () => {
      stream.send("message", {
        message: omMessage({ id: "m-4", markdown: "", status: "streaming" }),
      });
      stream.send("delta", { messageId: "m-4", text: "Logout posts " });
    });
    await screen.findByText("Logout posts");
    await act(async () => stream.send("delta", { messageId: "m-4", text: "to `/api/logout`." }));
    await screen.findByText("/api/logout", { selector: "code" });
    const cached = client.getQueryData<{ pages: AskChatDetail[] }>(keys.chat(CHAT_ID))!;
    expect(cached.pages[0]!.messages.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3", "m-4"]);
    expect(cached.pages[0]!.messages[3]!.markdown).toBe("Logout posts to `/api/logout`.");
    // The status shows on the streaming message.
    expect(screen.getByRole("status").textContent).toBe("Looking at runs");

    await act(async () => {
      stream.send("message", {
        message: omMessage({ id: "m-4", markdown: "Logout posts to **/api/logout**." }),
      });
      stream.send("done", {});
      stream.close();
    });
    await screen.findByText("/api/logout", { selector: "strong" });
    expect(screen.queryByText("/api/logout", { selector: "code" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(gets(seen)).toHaveLength(1);
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it("toasts an error event, and gives the text back when the send is refused", async () => {
    const stream = sseResponse();
    let refuse = false;
    mockFetch({
      [`GET ${CHAT_PATH}`]: detail(),
      [`POST ${CHAT_PATH}/messages`]: () =>
        refuse
          ? jsonResponse({ error: "A message can be at most 8,000 characters." }, 400)
          : stream.response,
    });
    renderChat(createTestQueryClient());
    await screen.findByText(/The login form posts to/);
    const user = userEvent.setup();

    await user.type(composer(), "Why?{Enter}");
    await act(async () => {
      stream.send("message", { message: userMessage("m-3", "Why?") });
      stream.send("error", { message: "Om couldn't answer. Try again." });
      stream.send("done", {});
      stream.close();
    });
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Om couldn't answer. Try again.", {
        variant: "danger",
      }),
    );

    refuse = true;
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(true));
    await user.type(composer(), "Too long{Enter}");
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("A message can be at most 8,000 characters.", {
        variant: "danger",
      }),
    );
    expect(screen.queryByText("Too long", { selector: ".or-ask-user__bubble" })).toBeNull();
    expect((composer() as HTMLTextAreaElement).value).toBe("Too long");
  });
});

describe("live updates", () => {
  function renderLive(seen: SeenRequest[]) {
    const ably = fakeAbly();
    const client = createQueryClient();
    render(
      <CurrentUserProvider user={testUser}>
        <QueryClientProvider client={client}>
          <LiveProvider createClient={ably.createClient} fetchToken={fakeToken}>
            <AskChat {...props()} />
          </LiveProvider>
        </QueryClientProvider>
      </CurrentUserProvider>,
    );
    const ready = async () => {
      await waitFor(() => expect(ably.current()?.subscribed()).toContain("user:user-1:changes"));
      act(() => ably.current().setState("connected"));
      await waitFor(() => expect(gets(seen)).toHaveLength(1));
    };
    return { ably, client, ready };
  }

  it("refetches on a chat event naming this chat or a run event of its ask, not another chat's", async () => {
    const seen = mockFetch({
      [CHAT_PATH]: detail({
        activity: { state: "queued", repository: REPOSITORY, filesRead: 0, runIds: [RUN_ID] },
      }),
    });
    const { ably, ready } = renderLive(seen);
    await ready();
    await screen.findByText("Waiting for an agent to read customer-portal");

    act(() =>
      ably
        .current()
        .deliver(
          "user:user-1:changes",
          changeEvent(ORG, { resource: "chat", ids: [OTHER_CHAT_ID] }),
        ),
    );
    await act(async () => {});
    expect(gets(seen)).toHaveLength(1);

    act(() =>
      ably
        .current()
        .deliver("user:user-1:changes", changeEvent(ORG, { resource: "chat", ids: [CHAT_ID] })),
    );
    await waitFor(() => expect(gets(seen)).toHaveLength(2));

    act(() =>
      ably
        .current()
        .deliver(
          `org:${ORG}:changes`,
          changeEvent(ORG, { resource: "transcript", ids: [RUN_ID], runId: RUN_ID }),
        ),
    );
    await waitFor(() => expect(gets(seen)).toHaveLength(3));
    act(() =>
      ably
        .current()
        .deliver(
          `org:${ORG}:changes`,
          changeEvent(ORG, { resource: "run", ids: [RUN_ID], runId: RUN_ID }),
        ),
    );
    await waitFor(() => expect(gets(seen)).toHaveLength(4));

    // Another run's events don't touch the chat.
    act(() =>
      ably.current().deliver(
        `org:${ORG}:changes`,
        changeEvent(ORG, {
          resource: "run",
          ids: [OTHER_CHAT_ID],
          runId: OTHER_CHAT_ID,
        }),
      ),
    );
    await act(async () => {});
    expect(gets(seen)).toHaveLength(4);
  });

  it("shows a relayed code answer after its chat event, and the activity line goes", async () => {
    let answered = false;
    const relayed = omMessage({
      id: "m-3",
      markdown: "It posts from `LoginForm.tsx`.",
      run: { id: RUN_ID, status: "completed", durationMs: 41_000, filesRead: 3 },
      files: [{ path: "src/LoginForm.tsx", startLine: 12, endLine: 20, url: null }],
    });
    const seen = mockFetch({
      [CHAT_PATH]: () =>
        jsonResponse(
          answered
            ? detail({ messages: [...detail().messages, relayed] })
            : detail({
                activity: {
                  state: "running",
                  repository: REPOSITORY,
                  filesRead: 2,
                  runIds: [RUN_ID],
                },
              }),
        ),
    });
    const { ably, ready } = renderLive(seen);
    await ready();
    await screen.findByText("Om is reading customer-portal · 2 files");

    answered = true;
    act(() =>
      ably
        .current()
        .deliver("user:user-1:changes", changeEvent(ORG, { resource: "chat", ids: [CHAT_ID] })),
    );
    await screen.findByText("LoginForm.tsx", { selector: "code" });
    expect(screen.getByText("read 3 files")).toBeTruthy();
    expect(screen.queryByText(/Om is reading/)).toBeNull();
  });

  it("sets no refetchInterval of its own", async () => {
    mockFetch({ [CHAT_PATH]: detail() });
    const client = createTestQueryClient();
    renderChat(client);
    await screen.findByText(/The login form posts to/);
    const query = client.getQueryCache().find({ queryKey: keys.chat(CHAT_ID) })!;
    // Only the client's own default (the live layer's fallback polling) applies.
    expect(query.observers[0]!.options.refetchInterval).toBe(
      client.getDefaultOptions().queries?.refetchInterval,
    );
    for (const file of readdirSync(__dirname).filter((name) => !name.endsWith(".test.tsx"))) {
      expect(readFileSync(join(__dirname, file), "utf8")).not.toContain("refetchInterval");
    }
  });
});

/** Gives the messages list a size, as a browser would lay it out. */
function sizeList(list: HTMLElement, size: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => size.scrollHeight });
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => size.clientHeight });
}

describe("scrolling", () => {
  it("loads older messages with before when scrolled to the top, keeping the view in place", async () => {
    const older = [userMessage("m-0", "An older question")];
    const seen = mockFetch({
      [CHAT_PATH]: (request) =>
        jsonResponse(
          request.query.get("before") === "m-1"
            ? detail({ messages: older, nextBefore: null })
            : detail({ nextBefore: "m-1" }),
        ),
    });
    const { container } = renderChat(createTestQueryClient());
    await screen.findByText(/The login form posts to/);
    const list = container.querySelector<HTMLElement>(".or-ask-chat__messages")!;
    const size = { scrollHeight: 1000, clientHeight: 300 };
    sizeList(list, size);

    list.scrollTop = 0;
    size.scrollHeight = 1000;
    act(() => list.dispatchEvent(new Event("scroll")));
    await screen.findByText("An older question");
    expect(gets(seen).map((r) => r.query.get("before"))).toEqual([null, "m-1"]);
    const texts = [...list.querySelectorAll(".or-ask-user__bubble")].map((n) => n.textContent);
    expect(texts).toEqual(["An older question", "Where does the login form post?"]);
  });

  it("follows a new message to the bottom unless the member has scrolled up", async () => {
    mockFetch({ [CHAT_PATH]: detail() });
    const client = createTestQueryClient();
    const { container } = renderChat(client);
    await screen.findByText(/The login form posts to/);
    const list = container.querySelector<HTMLElement>(".or-ask-chat__messages")!;
    const size = { scrollHeight: 1000, clientHeight: 300 };
    sizeList(list, size);
    const push = (message: AskMessageView) =>
      act(async () =>
        client.setQueryData<{ pages: AskChatDetail[]; pageParams: unknown[] }>(
          keys.chat(CHAT_ID),
          (data) => ({
            ...data!,
            pages: [{ ...data!.pages[0]!, messages: [...data!.pages[0]!.messages, message] }],
          }),
        ),
      );

    // At the bottom: a new message scrolls down to it.
    list.scrollTop = 700;
    act(() => list.dispatchEvent(new Event("scroll")));
    size.scrollHeight = 1200;
    await push(omMessage({ id: "m-3", markdown: "More" }));
    await screen.findByText("More");
    expect(list.scrollTop).toBe(1200);

    // Scrolled up: the list stays where the member is.
    list.scrollTop = 400;
    act(() => list.dispatchEvent(new Event("scroll")));
    size.scrollHeight = 1400;
    await push(omMessage({ id: "m-4", markdown: "Even more" }));
    await screen.findByText("Even more");
    expect(list.scrollTop).toBe(400);
  });
});

describe("card actions", () => {
  it("posts the click to /actions and updates the card from the response before any change event", async () => {
    const card = omMessage({
      id: "m-card",
      markdown: "",
      card: { kind: "request_draft", draft: requestDraft() },
    });
    const dismissed = {
      ...card,
      card: {
        kind: "request_draft" as const,
        draft: requestDraft({
          status: "dismissed",
          actions: [],
          outcome: { kind: "dismissed", text: "Not now", run: null, workItem: null },
        }),
      },
    };
    const seen = mockFetch({
      [`GET ${CHAT_PATH}`]: detail({ messages: [...detail().messages, card] }),
      [`POST ${CHAT_PATH}/actions`]: { message: dismissed },
    });
    renderChat(createTestQueryClient());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Not now" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Not now" })).toBeNull());
    expect(screen.getByText("Not now")).toBeTruthy();
    const post = seen.find((r) => r.method === "POST")!;
    expect(post.path).toBe(`${CHAT_PATH}/actions`);
    expect(post.body).toEqual({
      messageId: "m-card",
      actionId: "request_draft_dismiss",
      value: requestDraft().id,
    });
    expect(gets(seen)).toHaveLength(1);
  });
});

describe("the draft", () => {
  it("is kept per chat when the view unmounts and comes back", async () => {
    mockFetch({
      [CHAT_PATH]: detail(),
      [`/api/ui/ask/chats/${OTHER_CHAT_ID}`]: detail({ chat: { ...chat, id: OTHER_CHAT_ID } }),
    });
    const client = createTestQueryClient();
    const user = userEvent.setup();
    const first = renderChat(client);
    await screen.findByText(/The login form posts to/);
    await user.type(composer(), "Half a thought");
    first.unmount();

    const other = renderChat(client, { chatId: OTHER_CHAT_ID });
    await screen.findByText(/The login form posts to/);
    expect((composer() as HTMLTextAreaElement).value).toBe("");
    other.unmount();

    renderChat(client);
    await screen.findByText(/The login form posts to/);
    expect((composer() as HTMLTextAreaElement).value).toBe("Half a thought");
  });
});
