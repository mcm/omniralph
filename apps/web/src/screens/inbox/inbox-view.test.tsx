// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
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
import type { InboxItem } from "@/lib/api/inbox";
import { createQueryClient } from "@/lib/api/query-client";
import { ITEM_HANDLED } from "./inbox-detail";
import { InboxView } from "./inbox-view";
import { agentOfflineItem, BETA_ID, COUNTS, inboxItem, mrReadyItem, NOW } from "./test-fixtures";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));

/** Client-side navigation as `next/link` does it: the router moves, the page doesn't reload. */
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

let feeds: Record<string, InboxItem[]>;
let seen: SeenRequest[];

function serve(counts = COUNTS) {
  seen = mockFetch({
    "GET /api/ui/inbox": (request) =>
      jsonResponse({ items: feeds[request.query.get("tab") ?? "needs-you"] ?? [] }),
    "GET /api/ui/inbox/counts": counts,
  });
}

function renderInbox(
  options: {
    search?: string;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
  } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = options.client ?? createTestQueryClient();
  const user = options.user ?? testUser;
  const tree = () => {
    const view = <InboxView />;
    return (
      <CurrentUserProvider user={user}>
        <QueryClientProvider client={client}>
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
      </CurrentUserProvider>
    );
  };
  const utils = render(tree());
  return {
    ...utils,
    client,
    /** Re-renders at a new URL, as a client-side navigation would. */
    navigate: (search: string) => {
      nav.search = new URLSearchParams(search);
      utils.rerender(tree());
    },
  };
}

const rows = () =>
  screen.getAllByRole("listitem").filter((row) => row.classList.contains("or-row"));
const rowLink = (title: string) => screen.getByRole("link", { name: title });
const detail = () => screen.getByRole("region", { name: "Item" });
const requests = (path: string) => seen.filter((request) => request.path === path);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  feeds = {
    "needs-you": [
      inboxItem(),
      mrReadyItem(),
      inboxItem({ key: "manual_story:s3", title: "Renew the domain" }),
    ],
    problems: [agentOfflineItem()],
    running: [],
  };
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Inbox", () => {
  it("shows the title, the three tabs with their counts and the Needs you items", async () => {
    renderInbox();
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeTruthy();
    const tablist = screen.getByRole("tablist", { name: "Inbox" });
    const needsYou = await within(tablist).findByRole("tab", { name: "Needs you, 2" });
    expect(needsYou.getAttribute("aria-selected")).toBe("true");
    const problems = within(tablist).getByRole("tab", { name: "Problems, 1" });
    const running = within(tablist).getByRole("tab", { name: "Running, 0" });
    expect(needsYou.querySelector(".or-tab__count--need")).not.toBeNull();
    expect(problems.querySelector(".or-tab__count--fail")).not.toBeNull();
    expect(running.querySelector(".or-tab__count")!.className).toBe("or-tab__count");

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(requests("/api/ui/inbox")[0]!.query.get("tab")).toBe("needs-you");
    expect(
      within(screen.getByRole("list", { name: "Needs you" })).getAllByRole("listitem"),
    ).toHaveLength(3);
  });

  it("asks for the active organization, and shows no organization badges", async () => {
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    for (const request of [...requests("/api/ui/inbox"), ...requests("/api/ui/inbox/counts")]) {
      expect(request.query.get("organization")).toBe(TEST_ORGANIZATION_ID);
    }
    expect(document.querySelector(".or-ref--org")).toBeNull();
  });

  it('asks for "all" under All organizations, with the organization badge first', async () => {
    renderInbox({ user: allOrganizations });
    await waitFor(() => expect(rows()).toHaveLength(3));
    for (const request of [...requests("/api/ui/inbox"), ...requests("/api/ui/inbox/counts")]) {
      expect(request.query.get("organization")).toBe("all");
    }
    for (const row of rows()) {
      expect(row.querySelector(".or-row__meta")!.firstElementChild!.className).toContain(
        "or-ref--org",
      );
    }
    const header = detail().querySelector(".or-inbox-detail__badges")!;
    expect(header.firstElementChild!.className).toContain("or-ref--org");
    expect(header.firstElementChild!.textContent).toContain("Acme");
  });

  it("renders each item as a row: dot tone, label, title, age and badges in order", async () => {
    renderInbox({ user: allOrganizations });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [manual, mr] = rows();
    expect(within(manual!).getByRole("img", { name: "Manual story · Epic" }).className).toContain(
      "or-dot--need",
    );
    expect(manual!.querySelector(".or-row__kind")!.textContent).toBe("Manual story · Epic");
    expect(manual!.querySelector(".or-row__title")!.textContent).toBe(
      "Rotate the staging certificates",
    );
    expect(manual!.querySelector(".or-row__time")!.textContent).toBe("15d");

    expect(mr!.querySelector(".or-row__kind")!.textContent).toBe("MR ready for your review");
    expect(mr!.querySelector(".or-row__time")!.textContent).toBe("42m");
    const badges = [...mr!.querySelector(".or-row__meta")!.children].map((badge) =>
      [...badge.classList].find((name) => name.startsWith("or-ref--")),
    );
    expect(badges).toEqual([
      "or-ref--org",
      "or-ref--issue",
      "or-ref--change",
      "or-ref--repo",
      "or-ref--meta",
    ]);
    expect(mr!.querySelector(".or-row__meta")!.textContent).toContain("!12");
    expect(mr!.querySelector(".or-row__meta")!.textContent).toContain("3 findings");
    // No reason or summary in a row (Design rule 8).
    expect(mr!.textContent).not.toContain("ready for your review.");
  });

  it("puts the agent badge after the repo on an agent's row, in tone fail", async () => {
    renderInbox({ search: "tab=problems" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    const row = rows()[0]!;
    expect(within(row).getByRole("img", { name: "Agent offline" }).className).toContain(
      "or-dot--fail",
    );
    expect(row.querySelector(".or-row__meta")!.textContent).toContain("build-box");
    expect(row.querySelector(".or-ref--agent")).not.toBeNull();
    expect(requests("/api/ui/inbox").at(-1)!.query.get("tab")).toBe("problems");
  });

  it("selects the first item without an item in the URL, with aria-current", async () => {
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual(["true", null, null]);
    expect(
      within(detail()).getByRole("heading", { level: 2, name: "Rotate the staging certificates" }),
    ).toBeTruthy();
  });

  it("selects a row through the URL, without a reload", async () => {
    const start = window.location.href;
    const { navigate } = renderInbox({ search: "tab=needs-you" });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const user = userEvent.setup({ advanceTimers: () => {} });
    expect(rowLink("Add the billing export").getAttribute("href")).toBe(
      "/?tab=needs-you&item=pr_waiting%3Alane-1",
    );
    await user.click(rowLink("Add the billing export"));
    expect(nav.router.push).toHaveBeenCalledWith("/?tab=needs-you&item=pr_waiting%3Alane-1");
    expect(window.location.href).toBe(start);

    navigate("tab=needs-you&item=pr_waiting%3Alane-1");
    expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual([null, "true", null]);
    expect(
      within(detail()).getByRole("heading", { level: 2, name: "Add the billing export" }),
    ).toBeTruthy();
  });

  it("switches tabs through the URL", async () => {
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(screen.getByRole("tab", { name: "Problems, 1" }));
    expect(nav.router.push).toHaveBeenCalledWith("/?tab=problems", { scroll: false });
  });

  it("shows the selected item's header: badges, status line, title and reason", async () => {
    renderInbox({ search: "item=pr_waiting%3Alane-1" });
    const heading = await within(detail()).findByRole("heading", {
      level: 2,
      name: "Add the billing export",
    });
    expect(heading).toBeTruthy();
    const badges = [...detail().querySelector(".or-inbox-detail__badges")!.children].map(
      (badge) => badge.querySelector(".or-ref__text")!.textContent,
    );
    expect(badges).toEqual(["Epic", "TOOL-42", "acme/portal", "!12"]);
    expect(
      within(detail()).getByRole("status", { name: "Waiting on you for 42 minutes" }).className,
    ).toContain("or-statusline--need");
    expect(within(detail()).getByText("The merge request is ready for your review.")).toBeTruthy();
  });

  it("says an item in the URL that no longer derives an item was already handled", async () => {
    renderInbox({ search: "tab=needs-you&item=manual_story%3Agone" });
    expect(await within(detail()).findByText(ITEM_HANDLED)).toBeTruthy();
    expect(rows().every((row) => row.getAttribute("aria-current") === null)).toBe(true);
  });

  it("shows the back link to the tab on the detail", async () => {
    renderInbox({ search: "tab=problems&item=agent_offline%3Aagent-1" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(detail()).getByRole("link", { name: "Inbox" }).getAttribute("href")).toBe(
      "/?tab=problems",
    );
    expect(document.querySelector(".or-split")!.getAttribute("data-view")).toBe("detail");
  });

  it("renders through SplitView with a 400/340 list column", async () => {
    renderInbox();
    const split = document.querySelector<HTMLElement>(".or-split")!;
    expect(split.classList.contains("or-inbox")).toBe(true);
    expect(split.dataset.view).toBe("list");
    expect(split.style.getPropertyValue("--or-split-wide")).toBe("400px");
    expect(split.style.getPropertyValue("--or-split-narrow")).toBe("340px");
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it("renders no notice of its own and no Live or Updated indicator", async () => {
    renderInbox();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bLive\b|Updated|Retrying|updates stopped/i);
    expect(document.querySelector(".or-live-notice, kbd")).toBeNull();
  });

  it("shows a tab's empty state", async () => {
    renderInbox({ search: "tab=running" });
    expect(await screen.findByRole("heading", { name: "Nothing is running" })).toBeTruthy();
  });
});

describe("the detail's More actions menu", () => {
  async function openMenu(search: string) {
    renderInbox({ search });
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const user = userEvent.setup({ advanceTimers: () => {} });
    await user.click(within(detail()).getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    return { user, menu, items, names: items.map((item) => item.textContent!.trim()) };
  }

  async function copies(user: ReturnType<typeof userEvent.setup>, menu: HTMLElement, url: string) {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
  }

  it("a manual story: Open in Linear, Open the run and Copy link", async () => {
    const { user, menu, items, names } = await openMenu("tab=needs-you&item=manual_story%3As1");
    expect(names).toEqual(["Open in Linear", "Open the run", "Copy link"]);
    expect(items[0]!.getAttribute("href")).toBe("https://linear.app/acme/issue/TOOL-42");
    expect(items[1]!.getAttribute("href")).toBe("/runs/run-1");
    await copies(user, menu, `${window.location.origin}/?tab=needs-you&item=manual_story%3As1`);
  });

  it("an MR ready for review: Open merge request too", async () => {
    const { user, menu, items, names } = await openMenu("item=pr_waiting%3Alane-1");
    expect(names).toEqual(["Open in Linear", "Open the run", "Open merge request", "Copy link"]);
    expect(items[2]!.getAttribute("href")).toBe(
      "https://gitlab.com/acme/portal/-/merge_requests/12",
    );
    await copies(user, menu, `${window.location.origin}/?tab=needs-you&item=pr_waiting%3Alane-1`);
  });

  it("a GitHub PR ready for review: Open pull request", async () => {
    feeds["needs-you"] = [
      mrReadyItem({
        repository: { id: "repo-2", provider: "github", fullPath: "acme/web" },
        pullRequest: { provider: "github", number: 7, url: "https://github.com/acme/web/pull/7" },
      }),
    ];
    const { names } = await openMenu("");
    expect(names).toContain("Open pull request");
  });

  it("an offline agent: Open agent on Fleet and Copy link", async () => {
    const { user, menu, items, names } = await openMenu(
      "tab=problems&item=agent_offline%3Aagent-1",
    );
    expect(names).toEqual(["Open agent", "Copy link"]);
    expect(items[0]!.getAttribute("href")).toBe("/fleet/agent-1");
    await copies(
      user,
      menu,
      `${window.location.origin}/?tab=problems&item=agent_offline%3Aagent-1`,
    );
  });
});

describe("live updates", () => {
  it("refetch the feed and counts on a run and an inbox_state change event", async () => {
    const live = fakeAbly();
    renderInbox({ live });
    await waitFor(() => expect(rows()).toHaveLength(3));
    await waitFor(() =>
      expect(live.current().subscribed()).toEqual([
        `org:${TEST_ORGANIZATION_ID}:changes`,
        "user:user-1:changes",
      ]),
    );
    const before = {
      feed: requests("/api/ui/inbox").length,
      counts: requests("/api/ui/inbox/counts").length,
    };

    act(() =>
      live.current().deliver(
        `org:${TEST_ORGANIZATION_ID}:changes`,
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "run",
          runId: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    );
    await waitFor(() => {
      expect(requests("/api/ui/inbox").length).toBe(before.feed + 1);
      expect(requests("/api/ui/inbox/counts").length).toBe(before.counts + 1);
    });

    act(() =>
      live
        .current()
        .deliver(
          "user:user-1:changes",
          changeEvent(TEST_ORGANIZATION_ID, { resource: "inbox_state", ids: ["manual_story:s1"] }),
        ),
    );
    await waitFor(() => {
      expect(requests("/api/ui/inbox").length).toBe(before.feed + 2);
      expect(requests("/api/ui/inbox/counts").length).toBe(before.counts + 2);
    });
  });

  it("set no refetchInterval of their own: they poll only as the live layer's fallback", async () => {
    const client = createQueryClient();
    renderInbox({ client });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const fallback = client.getDefaultOptions().queries!.refetchInterval;
    const queries = client.getQueryCache().findAll({ queryKey: [TEST_ORGANIZATION_ID, "inbox"] });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.observers.length).toBeGreaterThan(0);
      for (const observer of query.observers) {
        expect(observer.options.refetchInterval).toBe(fallback);
      }
    }
    client.clear();
  });

  it("select the next item when a change event removes the selected one", async () => {
    const live = fakeAbly();
    renderInbox({ live, search: "tab=needs-you&item=pr_waiting%3Alane-1" });
    await within(detail()).findByRole("heading", { level: 2, name: "Add the billing export" });
    await waitFor(() => expect(live.current().subscribed()).toContain("user:user-1:changes"));

    feeds["needs-you"] = feeds["needs-you"]!.filter((item) => item.key !== "pr_waiting:lane-1");
    act(() =>
      live.current().deliver(
        "user:user-1:changes",
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "inbox_state",
          ids: ["pr_waiting:lane-1"],
        }),
      ),
    );
    await within(detail()).findByRole("heading", { level: 2, name: "Renew the domain" });
    expect(screen.queryByText(ITEM_HANDLED)).toBeNull();
    expect(nav.router.replace).toHaveBeenCalledWith("/?tab=needs-you&item=manual_story%3As3", {
      scroll: false,
    });
    expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual([null, "true"]);
  });
});
