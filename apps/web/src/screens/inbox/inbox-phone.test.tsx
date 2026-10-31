// @vitest-environment jsdom
// The Inbox on a phone (Design board MobileInbox, rule 16). jsdom applies no media or
// container queries, so the layout rules are checked in the CSS sources below.
import "@/components/pickers/test-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import type * as OmniralphUi from "@omniralph/ui";
import { nestedInteractiveElements, UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import { QUESTIONS, questionItem, runDetail } from "@/components/runs/test-fixtures";
import type { InboxCountsResponse, InboxItem, InboxItemActionResult } from "@/lib/api/inbox";
import { inboxKeys, queryKeys } from "@/lib/api/keys";
import { hasInlineDecisions, INBOX_LIST_WIDTH, InboxView } from "./inbox-view";
import { agentOfflineItem, COUNTS, inboxItem, mrReadyItem, NOW } from "./test-fixtures";

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
let answer: (request: SeenRequest) => Response | Promise<Response>;

const itemPath = (key: string) => `/api/ui/inbox/items/${encodeURIComponent(key)}`;

function serve() {
  const routes: Parameters<typeof mockFetch>[0] = {
    "GET /api/ui/inbox": (request) =>
      jsonResponse({ items: feeds[request.query.get("tab") ?? "needs-you"] ?? [] }),
    "GET /api/ui/inbox/counts": () => jsonResponse(counts),
    "GET /api/ui/runs/run-1": () => jsonResponse(runDetail(QUESTIONS.repository)),
  };
  for (const item of Object.values(feeds).flat()) {
    routes[`POST ${itemPath(item.key)}`] = (request) => answer(request);
  }
  seen = mockFetch(routes);
}

function renderInbox(search = "") {
  nav.search = new URLSearchParams(search);
  const client = createTestQueryClient();
  const tree = () => (
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          <InboxView />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>
  );
  const utils = render(tree());
  return {
    client,
    /** Re-renders at a new URL, as a client-side navigation would. */
    navigate: (next: string) => {
      nav.search = new URLSearchParams(next);
      utils.rerender(tree());
    },
  };
}

const split = () => document.querySelector<HTMLElement>(".or-split")!;
const rows = () =>
  screen.getAllByRole("listitem").filter((row) => row.classList.contains("or-row"));
const rowTitles = () => rows().map((row) => row.querySelector(".or-row__title")?.textContent);
const selectedRow = () => rows().find((row) => row.getAttribute("aria-current") === "true")!;
const inline = () => within(selectedRow()).getByRole("group", { name: "Decisions" });
const detail = () => screen.getByRole("region", { name: "Item" });
const posts = () => seen.filter((request) => request.method === "POST");
const needsYouCount = (client: ReturnType<typeof createTestQueryClient>) =>
  client.getQueryData<InboxCountsResponse>(
    inboxKeys(queryKeys(testUser.organization.id)).counts(testUser.organization.id),
  )?.needsYou;
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
    return jsonResponse({
      key: decodeURIComponent(request.path.split("/").pop()!),
      action: body.action,
      state: "done",
      snoozedUntil: null,
      runId: null,
      warning: null,
    } satisfies InboxItemActionResult);
  };
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("list first, then the detail", () => {
  it("without an item shows the list pane only", async () => {
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(split().dataset.view).toBe("list");
  });

  it('with an item shows the detail only, headed by "‹ Inbox" that drops the item', async () => {
    const { navigate } = renderInbox("tab=needs-you&item=pr_waiting%3Alane-1");
    await waitFor(() =>
      expect(
        within(detail()).getByRole("heading", { name: "Add the billing export" }),
      ).toBeTruthy(),
    );
    expect(split().dataset.view).toBe("detail");
    const back = within(detail()).getByRole("link", { name: "Inbox" });
    expect(back.textContent).toBe("‹ Inbox");
    // The back link heads the detail.
    expect(detail().firstElementChild).toBe(back);
    expect(back.getAttribute("href")).toBe("/?tab=needs-you");

    await user().click(back);
    expect(nav.router.push).toHaveBeenCalledWith("/?tab=needs-you");
    navigate("tab=needs-you");
    expect(split().dataset.view).toBe("list");
  });

  it("keeps the tab in the back link", async () => {
    renderInbox("tab=problems&item=agent_offline%3Aagent-1");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(detail()).getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe(
      "/?tab=problems",
    );
  });
});

describe("inline decisions on the selected row", () => {
  it("render the first item's DecisionButtons beside the row link, without nesting", async () => {
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const row = selectedRow();
    expect(row.querySelector(".or-row__title")?.textContent).toBe(
      "Rotate the staging certificates",
    );
    const group = inline();
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Done, resume epic", "Skip story", "Snooze"]);
    expect(group.querySelectorAll(".or-btn--primary")).toHaveLength(1);
    // In the row's actions slot, a sibling of the row link.
    const slot = group.closest(".or-row__actions")!;
    expect(slot.parentElement).toBe(row);
    expect(row.querySelector(":scope > .or-row__link")).not.toBeNull();
    expect(nestedInteractiveElements(row)).toEqual([]);
    expect(nestedInteractiveElements(document.body)).toEqual([]);
    // Only the selected row carries them.
    for (const other of rows().filter((r) => r !== row)) {
      expect(other.querySelector(".or-row__actions")).toBeNull();
    }
  });

  it("follow the item in the URL", async () => {
    renderInbox("tab=needs-you&item=pr_waiting%3Alane-1");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(selectedRow().querySelector(".or-row__title")?.textContent).toBe(
      "Add the billing export",
    );
    expect(
      within(inline())
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Dismiss", "Snooze"]);
  });

  it("post the same decision as the detail's", async () => {
    renderInbox("tab=problems");
    await waitFor(() => expect(rows()).toHaveLength(1));
    await user().click(within(inline()).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      path: itemPath("agent_offline:agent-1"),
      body: { action: "done" },
    });
  });

  it("remove the item and lower the count before the server answers", async () => {
    const held = deferred();
    answer = () => held.promise;
    const { client } = renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(needsYouCount(client)).toBe(3));

    await user().click(within(inline()).getByRole("button", { name: "Done, resume epic" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowTitles()).toEqual(["Add the billing export", "Renew the domain"]);
    expect(needsYouCount(client)).toBe(2);
    expect(screen.getByRole("tab", { name: /Needs you/ }).textContent).toContain("2");
    // The next row is selected and carries the inline decisions now.
    expect(selectedRow().querySelector(".or-row__title")?.textContent).toBe(
      "Add the billing export",
    );
    expect(within(inline()).getByRole("button", { name: "Dismiss" })).toBeTruthy();

    counts = { ...counts, needsYou: 2 };
    feeds["needs-you"] = feeds["needs-you"]!.slice(1);
    held.resolve(
      jsonResponse({
        key: "manual_story:s1",
        action: "done",
        state: "done",
        snoozedUntil: null,
        runId: null,
        warning: null,
      } satisfies InboxItemActionResult),
    );
    await waitFor(() => expect(seen.filter((r) => r.method === "GET").length).toBeGreaterThan(3));
    expect(rows()).toHaveLength(2);
    expect(ui.toast).not.toHaveBeenCalledWith(expect.anything(), { variant: "danger" });
  });

  it("roll back with the server's message when the decision fails", async () => {
    const held = deferred();
    answer = () => held.promise;
    const { client } = renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() => expect(needsYouCount(client)).toBe(3));
    await user().click(within(inline()).getByRole("button", { name: "Done, resume epic" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(needsYouCount(client)).toBe(2);

    held.resolve(jsonResponse({ error: "Linear didn't accept the change." }, 502));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rowTitles()[0]).toBe("Rotate the staging certificates");
    expect(needsYouCount(client)).toBe(3);
    expect(ui.toast).toHaveBeenCalledWith("Linear didn't accept the change.", {
      variant: "danger",
    });
  });
});

describe("a question row", () => {
  it("shows no inline buttons; tapping it opens the detail with the answer form", async () => {
    const question = questionItem(QUESTIONS.repository);
    feeds["needs-you"] = [question, inboxItem()];
    serve();
    const { navigate } = renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const row = selectedRow();
    expect(row.querySelector(".or-row__title")?.textContent).toBe("Build the billing export");
    expect(row.querySelector(".or-row__actions")).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();

    await user().click(within(row).getByRole("link", { name: "Build the billing export" }));
    const href = `/?tab=needs-you&item=${encodeURIComponent(question.key)}`;
    expect(nav.router.push).toHaveBeenCalledWith(href);
    navigate(href.slice(2));
    expect(split().dataset.view).toBe("detail");
    expect(
      within(detail()).getByRole("radiogroup", { name: QUESTIONS.repository.prompt }),
    ).toBeTruthy();
    expect(within(detail()).getByRole("button", { name: "Send answer" })).toBeTruthy();
  });

  it("hasInlineDecisions: no for a question or a running run, yes for the rest", () => {
    expect(hasInlineDecisions(questionItem(QUESTIONS.repository))).toBe(false);
    expect(
      hasInlineDecisions(inboxItem({ key: "run:r1", tab: "running", kind: "run", actions: [] })),
    ).toBe(false);
    expect(hasInlineDecisions(inboxItem())).toBe(true);
    expect(hasInlineDecisions(agentOfflineItem())).toBe(true);
  });
});

/** Strips comments. */
const read = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the at-rule whose prelude is `prelude` (balanced braces). */
function atRule(source: string, prelude: string): string {
  const start = source.indexOf(prelude);
  expect(start, prelude).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${prelude}`);
}

/** Removes the at-rule blocks with these preludes, leaving the rest. */
function without(source: string, preludes: string[]): string {
  let out = source;
  for (const prelude of preludes) {
    while (out.includes(prelude)) {
      const body = atRule(out, prelude);
      const start = out.indexOf(prelude);
      out = out.slice(0, start) + out.slice(out.indexOf(body, start) + body.length + 1);
    }
  }
  return out;
}

/** The declarations of the rule whose selector list contains `selector`. */
function declarations(source: string, selector: string): Record<string, string> {
  const rule = Array.from(source.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(([, selectors]) =>
    selectors!.split(",").some((part) => part.trim() === selector),
  );
  expect(rule, selector).toBeDefined();
  return Object.fromEntries(
    rule![2]!
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const colon = part.indexOf(":");
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
      }),
  );
}

describe("the phone layout (CSS)", () => {
  const inboxCss = read(path.join(__dirname, "inbox.css"));
  const phone = "@media (max-width: 768px)";

  it("hides the inline decisions above 768 px", () => {
    const wide = without(inboxCss, [phone]);
    expect(declarations(wide, ".or-inbox-row__decisions").display).toBe("none");
    expect(declarations(wide, ".or-inbox-row > .or-row__actions").display).toBe("none");
  });

  it("shows them at 768 px and narrower, on a line of their own under the row", () => {
    // The last phone block is the inline decisions' one.
    const blocks = inboxCss.split(phone).slice(1);
    const body = atRule(phone + blocks.at(-1)!, phone);
    expect(declarations(body, ".or-inbox-row__decisions").display).toBe("block");
    expect(declarations(body, ".or-inbox-row > .or-row__actions")).toMatchObject({
      display: "flex",
      "flex-basis": "100%",
    });
    expect(declarations(body, ".or-inbox-row")["flex-wrap"]).toBe("wrap");
  });

  it("keeps list and detail side by side from 880 px, the list 340 px below 1200 px", () => {
    expect(INBOX_LIST_WIDTH).toEqual({ wide: 400, narrow: 340 });
    const layout = read(path.resolve(__dirname, "../../../../../packages/ui/styles/layout.css"));
    const viewport = "@media (min-width: 1200px)";
    const container = "@container or-split (min-width: 880px)";
    const base = without(layout, [viewport, container]);
    // Below a 1200 px viewport the fixed pane is the narrow width (340 px for the Inbox) …
    expect(declarations(base, ".or-split")["--or-split-size"]).toBe("var(--or-split-narrow)");
    expect(declarations(atRule(layout, viewport), ".or-split")["--or-split-size"]).toBe(
      "var(--or-split-wide)",
    );
    // … and from an 880 px container both panes show, the list column that wide.
    const wide = atRule(layout, container);
    expect(declarations(wide, ".or-split__panes")["grid-template-columns"]).toBe(
      "var(--or-split-size) minmax(0, 1fr)",
    );
    expect(declarations(wide, ".or-split[data-view] .or-split__list").display).toBe("flex");
    // Below it only `data-view`'s pane shows.
    expect(declarations(base, '.or-split[data-view="detail"] .or-split__list').display).toBe(
      "none",
    );
    expect(declarations(base, '.or-split[data-view="list"] .or-split__detail').display).toBe(
      "none",
    );
  });
});
