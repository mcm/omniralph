// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { Button, ShortcutProvider, UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import { DecisionButtons } from "@/components/runs/decision-buttons";
import { ITEM_HANDLED, snoozeUntil } from "@/components/runs/decisions";
import type { InboxCountsResponse, InboxItem, InboxItemActionResult } from "@/lib/api/inbox";
import { inboxKeys, queryKeys } from "@/lib/api/keys";
import { SHORTCUTS } from "@/lib/shortcuts";
import { InboxView } from "./inbox-view";
import {
  agentOfflineItem,
  BETA_ID,
  COUNTS,
  inboxItem,
  mrReadyItem,
  NOW,
  prdReadyItem,
} from "./test-fixtures";

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

const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const result = (key: string, action: InboxItemActionResult["action"]): InboxItemActionResult => ({
  key,
  action,
  state: action === "done" ? "done" : action === "snooze" ? "snoozed" : null,
  snoozedUntil: null,
  runId: null,
  warning: null,
});

let feeds: Record<string, InboxItem[]>;
let counts: InboxCountsResponse;
let seen: SeenRequest[];
/** Answers each decision; defaults to success. */
let answer: (request: SeenRequest) => Response | Promise<Response>;

const itemPath = (key: string) => `/api/ui/inbox/items/${encodeURIComponent(key)}`;

function serve(extra: Parameters<typeof mockFetch>[0] = {}) {
  const routes: Parameters<typeof mockFetch>[0] = {
    "GET /api/ui/inbox": (request) =>
      jsonResponse({ items: feeds[request.query.get("tab") ?? "needs-you"] ?? [] }),
    "GET /api/ui/inbox/counts": () => jsonResponse(counts),
    ...extra,
  };
  for (const item of Object.values(feeds).flat()) {
    routes[`POST ${itemPath(item.key)}`] = (request) => answer(request);
  }
  seen = mockFetch(routes);
}

function renderInbox(search = "", user: SessionUser = testUser) {
  nav.search = new URLSearchParams(search);
  const client = createTestQueryClient();
  render(
    <ShortcutProvider definitions={SHORTCUTS} platform="other">
      <CurrentUserProvider user={user}>
        <QueryClientProvider client={client}>
          <UiProvider linkComponent={TestLink}>
            <InboxView />
          </UiProvider>
        </QueryClientProvider>
      </CurrentUserProvider>
    </ShortcutProvider>,
  );
  return client;
}

const rows = () =>
  screen.getAllByRole("listitem").filter((row) => row.classList.contains("or-row"));
const rowTitles = () => rows().map((row) => row.querySelector(".or-row__title")?.textContent);
const detail = () => screen.getByRole("region", { name: "Item" });
const decisions = () => within(detail()).getByRole("group", { name: "Decisions" });
const posts = () => seen.filter((request) => request.method === "POST");
/** A decisions group's buttons, links styled as buttons (Open pull request) included. */
const buttonsIn = (group: HTMLElement) => [...group.querySelectorAll<HTMLElement>(".or-btn")];
const scopeCounts = (client: ReturnType<typeof createTestQueryClient>, scope: string) =>
  client.getQueryData<InboxCountsResponse>(
    inboxKeys(queryKeys(testUser.organization.id)).counts(scope),
  );
const user = () => userEvent.setup({ advanceTimers: () => {} });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  ui.toast.mockReset();
  counts = { ...COUNTS, needsYou: 3 };
  feeds = {
    "needs-you": [
      inboxItem(),
      mrReadyItem(),
      inboxItem({ key: "manual_story:s3", title: "Renew the domain" }),
    ],
    problems: [agentOfflineItem()],
    running: [],
  };
  answer = (request) => {
    const body = request.body as { action: InboxItemActionResult["action"] };
    return jsonResponse(result(decodeURIComponent(request.path.split("/").pop()!), body.action));
  };
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One item of each kind that has decisions, offering every action its kind documents. */
const KINDS: { item: InboxItem; buttons: string[]; posts: Record<string, string> }[] = [
  {
    item: inboxItem({ actions: ["done", "skip", "snooze"] }),
    buttons: ["Done, resume epic", "Skip story", "Snooze"],
    posts: { "Done, resume epic": "done", "Skip story": "skip" },
  },
  {
    item: inboxItem({
      key: "blocked_epic:r1",
      kind: "blocked_epic",
      actions: ["start_anyway", "done", "snooze"],
    }),
    buttons: ["Start anyway", "Done", "Snooze"],
    posts: { "Start anyway": "start_anyway", Done: "done" },
  },
  {
    item: inboxItem({
      key: "stopped_epic:r1",
      kind: "stopped_epic",
      actions: ["resume", "done", "snooze"],
    }),
    buttons: ["Resume", "Done", "Snooze"],
    posts: { Resume: "resume", Done: "done" },
  },
  { item: prdReadyItem(), buttons: ["Start epic", "Done", "Snooze"], posts: { Done: "done" } },
  {
    item: mrReadyItem(),
    buttons: ["Open merge request", "Done", "Snooze"],
    posts: { Done: "done" },
  },
  { item: agentOfflineItem(), buttons: ["Done", "Snooze"], posts: { Done: "done" } },
  {
    item: agentOfflineItem({ key: "agent_update_failed:a1", kind: "agent_update_failed" }),
    buttons: ["Done", "Snooze"],
    posts: { Done: "done" },
  },
  {
    item: inboxItem({
      key: "failed_run:r1",
      tab: "problems",
      kind: "failed_run",
      actions: ["retry", "done", "snooze"],
    }),
    buttons: ["Retry", "Done", "Snooze"],
    posts: { Retry: "retry", Done: "done" },
  },
  {
    item: inboxItem({
      key: "failed_system:j1",
      tab: "problems",
      kind: "failed_system",
      run: null,
      actions: ["retry", "done", "snooze"],
    }),
    buttons: ["Retry", "Done", "Snooze"],
    posts: { Retry: "retry", Done: "done" },
  },
];

/** Each decision's key (`SHORTCUTS`). */
const DECISION_KEYS: Record<string, string> = {
  Done: "e",
  "Done, resume epic": "e",
  "Skip story": "s",
  "Start anyway": "t",
  Resume: "c",
  "Start epic": "b",
  "Open merge request": "v",
  Retry: "r",
  Snooze: "z",
};

describe("decision keys in the Inbox detail", () => {
  it.each(KINDS.map((entry) => [entry.item.kind, entry] as const))(
    "%s: each shown decision's key posts what its button posts, and the button names the key",
    async (_kind, { item, buttons, posts: expected }) => {
      for (const [label, action] of Object.entries(expected)) {
        feeds = { "needs-you": [], problems: [], running: [], [item.tab]: [item] };
        serve();
        renderInbox(`tab=${item.tab}&item=${encodeURIComponent(item.key)}`);
        const group = await waitFor(decisions);
        expect(buttonsIn(group).map((button) => button.getAttribute("aria-keyshortcuts"))).toEqual(
          buttons.map((name) => DECISION_KEYS[name]!.toUpperCase()),
        );
        await user().keyboard(DECISION_KEYS[label]!);
        await waitFor(() => expect(posts()).toHaveLength(1));
        expect(posts()[0]!.path).toBe(itemPath(item.key));
        expect(posts()[0]!.body).toEqual({ action });
        cleanup();
      }
    },
  );

  it("opens the Snooze menu with z, whose choice posts the snooze", async () => {
    const item = feeds["needs-you"]![0]!;
    renderInbox(`item=${encodeURIComponent(item.key)}`);
    await waitFor(decisions);
    await user().keyboard("z");
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((entry) => entry.textContent),
    ).toEqual(["1 hour", "Tomorrow", "Next week"]);
    await user().click(within(menu).getByRole("menuitem", { name: "1 hour" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({
      action: "snooze",
      until: snoozeUntil("hour", new Date(NOW)).toISOString(),
    });
  });

  it("acts on the item the detail shows: after Done, the next one", async () => {
    const held = deferred();
    answer = () => held.promise;
    const [first, second] = feeds["needs-you"]!;
    renderInbox(`item=${encodeURIComponent(first!.key)}`);
    await waitFor(decisions);
    await user().keyboard("e");
    await waitFor(() => expect(posts()).toHaveLength(1));
    // The item left its feed at once; the detail moved on to the next one.
    await waitFor(() =>
      expect(within(detail()).getByRole("heading", { level: 2 }).textContent).toBe(second!.title),
    );
    await user().keyboard("e");
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map((request) => request.path)).toEqual([
      itemPath(first!.key),
      itemPath(second!.key),
    ]);
    held.resolve(jsonResponse(result(first!.key, "done")));
  });

  it("binds nothing while the detail is hidden behind the phone's list (inline row decisions)", async () => {
    renderInbox();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const inline = rows()[0]!.querySelector(".or-inbox-row__decisions")!;
    expect(
      within(inline as HTMLElement)
        .getAllByRole("button")[0]!
        .hasAttribute("aria-keyshortcuts"),
    ).toBe(false);
    await user().keyboard("e");
    expect(posts()).toHaveLength(0);
  });
});

describe("decisions in the Inbox detail", () => {
  it.each(KINDS.map((entry) => [entry.item.kind, entry] as const))(
    "%s: its buttons under the reason, exactly one primary, posting its action",
    async (_kind, { item, buttons, posts: expected }) => {
      feeds = { "needs-you": [], problems: [], running: [], [item.tab]: [item] };
      serve();
      renderInbox(`tab=${item.tab}`);
      const group = await waitFor(decisions);
      // Under the reason.
      expect(group.previousElementSibling?.className).toBe("or-inbox-detail__reason");
      const all = buttonsIn(group);
      expect(all.map((button) => button.textContent)).toEqual(buttons);
      expect(group.querySelectorAll(".or-btn--primary")).toHaveLength(1);
      expect(all[0]!.classList.contains("or-btn--primary")).toBe(true);
      for (const button of all.slice(1))
        expect(button.classList.contains("or-btn--outline")).toBe(true);
      expect(document.querySelector("kbd")).toBeNull();

      const [label, action] = Object.entries(expected)[0]!;
      await user().click(within(group).getByRole("button", { name: label }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.path).toBe(itemPath(item.key));
      expect(posts()[0]!.body).toEqual({ action });
    },
  );

  it.each(
    KINDS.flatMap(({ item, posts: expected }) =>
      Object.entries(expected).map(([label, action]) => [item.kind, label, action, item] as const),
    ),
  )("%s: %s posts {action: %s} for the item's key", async (_kind, label, action, item) => {
    feeds = { "needs-you": [], problems: [], running: [], [item.tab]: [item] };
    serve();
    renderInbox(`tab=${item.tab}`);
    await user().click(within(await waitFor(decisions)).getByRole("button", { name: label }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: itemPath(item.key), body: { action } });
  });

  it("shows no decisions on a running run", async () => {
    feeds.running = [
      inboxItem({ key: "run:r9", tab: "running", kind: "run", actions: [], title: "Running epic" }),
    ];
    serve();
    renderInbox("tab=running");
    await waitFor(() =>
      expect(within(detail()).getByRole("heading", { name: "Running epic" })).toBeTruthy(),
    );
    expect(within(detail()).queryByRole("group", { name: "Decisions" })).toBeNull();
  });

  it("Snooze opens 1 hour, Tomorrow and Next week, and posts {action: snooze, until}", async () => {
    renderInbox();
    const actor = user();
    await actor.click(within(await waitFor(decisions)).getByRole("button", { name: "Snooze" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["1 hour", "Tomorrow", "Next week"]);
    expect(menu.querySelector("kbd")).toBeNull();
    await actor.click(within(menu).getByRole("menuitem", { name: "Tomorrow" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      path: itemPath("manual_story:s1"),
      body: { action: "snooze", until: snoozeUntil("tomorrow", new Date(NOW)).toISOString() },
    });
  });

  it("each snooze choice posts its own until", async () => {
    for (const [label, choice] of [
      ["1 hour", "hour"],
      ["Next week", "next-week"],
    ] as const) {
      document.body.innerHTML = "";
      serve();
      renderInbox();
      const actor = user();
      await actor.click(within(await waitFor(decisions)).getByRole("button", { name: "Snooze" }));
      await actor.click(await screen.findByRole("menuitem", { name: label }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]!.body).toEqual({
        action: "snooze",
        until: snoozeUntil(choice, new Date(NOW)).toISOString(),
      });
    }
  });
});

describe("the decision a ready PRD and a PR/MR wait for", () => {
  const startPath = "/api/ui/work-items/linear-issue-51/start";

  it("a ready PRD's Start epic starts its work item and the item leaves at once", async () => {
    const held = deferred();
    const prd = prdReadyItem();
    feeds = { "needs-you": [prd, inboxItem()], problems: [], running: [] };
    serve({ [`POST ${startPath}`]: () => held.promise });
    const client = renderInbox(`item=${encodeURIComponent(prd.key)}`);
    await waitFor(() => expect(rows()).toHaveLength(2));

    await user().click(within(decisions()).getByRole("button", { name: "Start epic" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.path).toBe(startPath);
    expect(posts()[0]!.query.get("organization")).toBe(prd.organization.id);
    // Before the server answers: the item left its feed and the count, the next is selected,
    // and no Inbox decision was posted for it.
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(scopeCounts(client, testUser.organization.id)?.needsYou).toBe(2);
    expect(posts().some((request) => request.path === itemPath(prd.key))).toBe(false);
    held.resolve(jsonResponse({ ok: true }));
  });

  it("Start epic's key (b) starts it from the detail", async () => {
    const prd = prdReadyItem();
    feeds = { "needs-you": [prd], problems: [], running: [] };
    serve({ [`POST ${startPath}`]: () => jsonResponse({ ok: true }) });
    renderInbox(`item=${encodeURIComponent(prd.key)}`);
    await waitFor(decisions);
    await user().keyboard("b");
    await waitFor(() => expect(posts().map((request) => request.path)).toEqual([startPath]));
  });

  it("a PR/MR's Open merge request links to it on its code host, in a new tab; v opens it", async () => {
    const mr = mrReadyItem();
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderInbox(`item=${encodeURIComponent(mr.key)}`);
    const link = await waitFor(() =>
      within(decisions()).getByRole("link", { name: "Open merge request" }),
    );
    expect(link.getAttribute("href")).toBe(mr.pullRequest!.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.classList.contains("or-btn--primary")).toBe(true);
    await user().keyboard("v");
    expect(open).toHaveBeenCalledWith(mr.pullRequest!.url, "_blank", "noopener,noreferrer");
    expect(posts()).toHaveLength(0);
  });
});

describe("a decision before the server answers", () => {
  it("removes the item, lowers the tab and nav counts and selects the next item", async () => {
    const held = deferred();
    answer = () => held.promise;
    const client = renderInbox("tab=needs-you&item=manual_story%3As1");
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(scopeCounts(client, testUser.organization.id)?.needsYou).toBe(3));

    await user().click(within(decisions()).getByRole("button", { name: "Done, resume epic" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowTitles()).toEqual(["Add the billing export", "Renew the domain"]);
    // The tab count, and the shell's nav count (the same query).
    expect(scopeCounts(client, testUser.organization.id)?.needsYou).toBe(2);
    expect(screen.getByRole("tab", { name: /Needs you/ }).textContent).toContain("2");
    // The next item is selected.
    expect(within(detail()).getByRole("heading", { name: "Add the billing export" })).toBeTruthy();
    expect(nav.router.replace).toHaveBeenCalledWith("/?tab=needs-you&item=pr_waiting%3Alane-1", {
      scroll: false,
    });
    expect(posts()).toHaveLength(1);

    counts = { ...counts, needsYou: 2 };
    feeds["needs-you"] = feeds["needs-you"]!.slice(1);
    held.resolve(jsonResponse(result("manual_story:s1", "done")));
    await waitFor(() => expect(seen.filter((r) => r.method === "GET").length).toBeGreaterThan(2));
    expect(rows()).toHaveLength(2);
    expect(ui.toast).not.toHaveBeenCalledWith(expect.anything(), { variant: "danger" });
  });

  it("selects the previous item when the decided one was last", async () => {
    answer = () => deferred().promise;
    renderInbox("tab=needs-you&item=manual_story%3As3");
    await waitFor(() => expect(rows()).toHaveLength(3));
    await user().click(within(decisions()).getByRole("button", { name: "Skip story" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(detail()).getByRole("heading", { name: "Add the billing export" })).toBeTruthy();
    expect(nav.router.replace).toHaveBeenCalledWith("/?tab=needs-you&item=pr_waiting%3Alane-1", {
      scroll: false,
    });
  });

  it("disables the item's other decision buttons while it is pending", async () => {
    const held = deferred();
    answer = () => held.promise;
    const client = createTestQueryClient();
    const item = inboxItem();
    render(
      <CurrentUserProvider user={testUser}>
        <QueryClientProvider client={client}>
          <UiProvider linkComponent={TestLink}>
            <DecisionButtons item={item} />
          </UiProvider>
        </QueryClientProvider>
      </CurrentUserProvider>,
    );
    const group = screen.getByRole("group", { name: "Decisions" });
    await user().click(within(group).getByRole("button", { name: "Done, resume epic" }));
    await waitFor(() =>
      expect(
        within(group).getByRole("button", { name: "Skip story" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(within(group).getByRole("button", { name: "Snooze" }).hasAttribute("disabled")).toBe(
      true,
    );
    held.resolve(jsonResponse(result(item.key, "done")));
    await waitFor(() =>
      expect(
        within(group).getByRole("button", { name: "Skip story" }).hasAttribute("disabled"),
      ).toBe(false),
    );
  });
});

describe("a failed decision", () => {
  it("puts the item back, restores the counts and shows the server's message", async () => {
    const held = deferred();
    answer = () => held.promise;
    const client = renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(scopeCounts(client, testUser.organization.id)?.needsYou).toBe(3));
    await user().click(within(decisions()).getByRole("button", { name: "Done, resume epic" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(scopeCounts(client, testUser.organization.id)?.needsYou).toBe(2);

    held.resolve(jsonResponse({ error: "Linear didn't accept the change." }, 502));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rowTitles()[0]).toBe("Rotate the staging certificates");
    expect(scopeCounts(client, testUser.organization.id)?.needsYou).toBe(3);
    expect(ui.toast).toHaveBeenCalledWith("Linear didn't accept the change.", {
      variant: "danger",
    });
  });

  it("a 404 says the item was already handled, in an info toast, and leaves it removed", async () => {
    answer = () => jsonResponse({ error: ITEM_HANDLED }, 404);
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    // The server no longer derives it.
    feeds["needs-you"] = feeds["needs-you"]!.slice(1);
    counts = { ...counts, needsYou: 2 };
    await user().click(within(decisions()).getByRole("button", { name: "Done, resume epic" }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith(ITEM_HANDLED, { variant: "info" }));
    expect(ui.toast).not.toHaveBeenCalledWith(expect.anything(), { variant: "danger" });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowTitles()).not.toContain("Rotate the staging certificates");
  });
});

describe("under All organizations", () => {
  it("decides on an item of a second organization", async () => {
    const beta = inboxItem({
      key: "manual_story:beta-1",
      organization: { id: BETA_ID, name: "Beta", role: "member" },
      title: "Beta's manual story",
    });
    feeds["needs-you"] = [beta, ...feeds["needs-you"]!];
    serve();
    answer = () => deferred().promise;
    const client = renderInbox("", allOrganizations);
    await waitFor(() => expect(rows()).toHaveLength(4));
    await waitFor(() => expect(scopeCounts(client, "all")?.needsYou).toBe(3));
    await user().click(within(decisions()).getByRole("button", { name: "Done, resume epic" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rowTitles()).not.toContain("Beta's manual story");
    expect(scopeCounts(client, "all")?.needsYou).toBe(2);
    expect(posts()).toEqual([
      expect.objectContaining({ path: itemPath(beta.key), body: { action: "done" } }),
    ]);
  });
});

describe("the answer slot", () => {
  it("renders a question's Send answer in place of its first button: one primary", () => {
    const question = inboxItem({
      key: "question:q1",
      kind: "question",
      actions: ["answer", "done", "snooze"],
    });
    render(
      <CurrentUserProvider user={testUser}>
        <QueryClientProvider client={createTestQueryClient()}>
          <UiProvider linkComponent={TestLink}>
            <DecisionButtons
              item={question}
              answer={
                <Button key="answer" variant="primary">
                  Send answer
                </Button>
              }
            />
          </UiProvider>
        </QueryClientProvider>
      </CurrentUserProvider>,
    );
    const group = screen.getByRole("group", { name: "Decisions" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Send answer", "Done", "Snooze"]);
    expect(group.querySelectorAll(".or-btn--primary")).toHaveLength(1);
  });
});
