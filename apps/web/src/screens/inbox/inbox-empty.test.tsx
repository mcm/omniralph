// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
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
import type { InboxCountsResponse, InboxItem } from "@/lib/api/inbox";
import {
  InboxEmptyState,
  inboxEmptyRunning,
  NOTHING_NEEDS_YOU,
  runsInProgress,
} from "./inbox-empty-state";
import { InboxView } from "./inbox-view";
import { COUNTS, inboxItem, NOW, runningItem } from "./test-fixtures";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
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

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let feeds: Record<string, InboxItem[]>;
let counts: InboxCountsResponse;
let seen: SeenRequest[];
let decide: () => Response | Promise<Response>;

const itemPath = (key: string) => `/api/ui/inbox/items/${encodeURIComponent(key)}`;

function serve() {
  seen = mockFetch({
    "GET /api/ui/inbox": (request) =>
      jsonResponse({ items: feeds[request.query.get("tab") ?? "needs-you"] ?? [] }),
    "GET /api/ui/inbox/counts": () => jsonResponse(counts),
    [`POST ${itemPath("manual_story:s1")}`]: () => decide(),
    "GET /api/ui/runs/run-1": () => new Promise<Response>(() => {}),
  });
}

function renderInbox(
  options: { search?: string; upNext?: React.ReactNode; live?: ReturnType<typeof fakeAbly> } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const view = <InboxView upNext={options.upNext} />;
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
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
    </CurrentUserProvider>,
  );
}

function renderState(props: React.ComponentProps<typeof InboxEmptyState>) {
  return render(
    <UiProvider linkComponent={TestLink}>
      <InboxEmptyState {...props} />
    </UiProvider>,
  );
}

const rows = () =>
  screen.queryAllByRole("listitem").filter((row) => row.classList.contains("or-row"));
const emptyState = () => document.querySelector<HTMLElement>(".or-inbox-empty");
const panelText = () => document.querySelector(".or-inbox__panel")?.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  counts = { ...COUNTS, needsYou: 0, problems: 0, running: 2 };
  feeds = {
    "needs-you": [],
    problems: [],
    running: [
      runningItem("run-9", "Add the billing export", 5),
      runningItem("run-8", "Rotate the staging certificates", 90),
    ],
  };
  decide = () =>
    jsonResponse({
      key: "manual_story:s1",
      action: "done",
      state: "done",
      snoozedUntil: null,
      runId: null,
      warning: null,
    });
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("InboxEmptyState", () => {
  it("shows the 32 px glyph, the heading and the newest running run", () => {
    const { container } = renderState({
      running: { count: 2, newest: { id: "run-9", title: "Add the billing export" } },
    });
    const glyph = container.querySelector("svg")!;
    expect(glyph.getAttribute("width")).toBe("32");
    expect(glyph.getAttribute("height")).toBe("32");
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "Nothing needs you" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add the billing export" }).getAttribute("href")).toBe(
      "/runs/run-9",
    );
    expect(container.textContent).toBe(
      "Nothing needs you2 runs in progress · Add the billing export",
    );
  });

  it('says "1 run in progress" for one run', () => {
    const { container } = renderState({
      running: { count: 1, newest: { id: "run-9", title: "Add the billing export" } },
    });
    expect(container.textContent).toBe(
      "Nothing needs you1 run in progress · Add the billing export",
    );
  });

  it("shows only the heading when nothing is running", () => {
    const { container } = renderState({ running: null });
    expect(container.textContent).toBe(NOTHING_NEEDS_YOU);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders upNext under the running line", () => {
    const { container } = renderState({
      running: { count: 1, newest: { id: "run-9", title: "Add the billing export" } },
      upNext: <section aria-label="Up next">Ready to start</section>,
    });
    const upNext = screen.getByRole("region", { name: "Up next" });
    const running = container.querySelector(".or-inbox-empty__running")!;
    expect(running.compareDocumentPosition(upNext) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".or-inbox-empty")!.lastElementChild!.contains(upNext)).toBe(
      true,
    );
  });

  it("renders nothing under the running line without upNext", () => {
    const { container } = renderState({
      running: { count: 1, newest: { id: "run-9", title: "Add the billing export" } },
    });
    expect(container.querySelector(".or-inbox-empty__up-next")).toBeNull();
    expect(container.querySelector(".or-inbox-empty")!.lastElementChild!.className).toBe(
      "or-inbox-empty__running",
    );
  });
});

describe("inboxEmptyRunning", () => {
  it("counts the running items and picks the one that started last", () => {
    expect(
      inboxEmptyRunning([runningItem("run-8", "Older", 90), runningItem("run-9", "Newer", 5)]),
    ).toEqual({ count: 2, newest: { id: "run-9", title: "Newer" } });
  });

  it("is null when nothing is running", () => {
    expect(inboxEmptyRunning([])).toBeNull();
  });

  it("words the count", () => {
    expect(runsInProgress(1)).toBe("1 run in progress");
    expect(runsInProgress(3)).toBe("3 runs in progress");
  });
});

describe("the empty Inbox", () => {
  it("replaces the list and the detail with InboxEmptyState, keeping the title and tabs", async () => {
    renderInbox();
    expect(await screen.findByRole("link", { name: "Add the billing export" })).toBeTruthy();
    expect(document.querySelector(".or-split")).toBeNull();
    expect(screen.queryByRole("region", { name: "Item" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Needs you0",
      "Problems0",
      "Running2",
    ]);
    expect(panelText()).toBe("Nothing needs you2 runs in progress · Add the billing export");
    expect(emptyState()!.querySelector("svg")!.getAttribute("width")).toBe("32");
  });

  it("passes the page's upNext through to InboxEmptyState", async () => {
    renderInbox({ upNext: <section aria-label="Up next">Ready to start</section> });
    const upNext = await screen.findByRole("region", { name: "Up next" });
    expect(emptyState()!.contains(upNext)).toBe(true);
  });

  it("shows only the heading when nothing is running", async () => {
    feeds.running = [];
    counts = { ...counts, running: 0 };
    renderInbox();
    await screen.findByRole("heading", { level: 2, name: "Nothing needs you" });
    await waitFor(() => expect(seen.some((r) => r.query.get("tab") === "running")).toBe(true));
    await waitFor(() => expect(panelText()).toBe("Nothing needs you"));
  });

  it('shows "No problems" on an empty Problems tab, without the glyph', async () => {
    renderInbox({ search: "tab=problems" });
    await screen.findByRole("heading", { level: 2, name: "No problems" });
    expect(panelText()).toBe("No problems");
    expect(document.querySelector(".or-inbox__panel svg")).toBeNull();
  });

  it('shows "Nothing is running" on an empty Running tab, without the glyph', async () => {
    feeds.running = [];
    renderInbox({ search: "tab=running" });
    await screen.findByRole("heading", { level: 2, name: "Nothing is running" });
    expect(panelText()).toBe("Nothing is running");
    expect(document.querySelector(".or-inbox__panel svg")).toBeNull();
  });

  it("appears at once when the last needs-you item is decided", async () => {
    feeds["needs-you"] = [inboxItem()];
    counts = { ...counts, needsYou: 1 };
    const held = deferred();
    decide = () => held.promise;
    renderInbox();
    const group = await screen.findByRole("group", { name: "Decisions" });
    feeds["needs-you"] = [];
    await userEvent
      .setup({ advanceTimers: () => {} })
      .click(within(group).getByRole("button", { name: "Done, resume epic" }));

    expect(
      await screen.findByRole("heading", { level: 2, name: "Nothing needs you" }),
    ).toBeTruthy();
    expect(rows()).toEqual([]);
    expect(screen.getAllByRole("tab")[0]!.textContent).toBe("Needs you0");

    held.resolve(
      jsonResponse({
        key: "manual_story:s1",
        action: "done",
        state: "done",
        snoozedUntil: null,
        runId: null,
        warning: null,
      }),
    );
    await waitFor(() => expect(seen.filter((r) => r.method === "POST")).toHaveLength(1));
    expect(screen.getByRole("heading", { level: 2, name: "Nothing needs you" })).toBeTruthy();
  });

  it("returns to the list when a change event brings a new item", async () => {
    const live = fakeAbly();
    renderInbox({ live });
    await screen.findByRole("heading", { level: 2, name: "Nothing needs you" });
    await waitFor(() => expect(live.current().subscribed()).toContain("user:user-1:changes"));

    feeds["needs-you"] = [inboxItem()];
    counts = { ...counts, needsYou: 1 };
    act(() =>
      live
        .current()
        .deliver(
          "user:user-1:changes",
          changeEvent(TEST_ORGANIZATION_ID, { resource: "inbox_state", ids: ["manual_story:s1"] }),
        ),
    );

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(emptyState()).toBeNull();
    expect(document.querySelector(".or-split")).not.toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Item" })).getByRole("heading", {
        level: 2,
        name: "Rotate the staging certificates",
      }),
    ).toBeTruthy();
  });
});
