// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { ShortcutProvider, UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import { LiveProvider } from "@/components/live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "@/components/live/live-test-utils";
import { useQueryKeys } from "@/components/query-provider";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { Backlog } from "@/lib/api/backlog";
import { backlogKeys } from "@/lib/api/keys";
import { SHORTCUTS } from "@/lib/shortcuts";
import { BacklogView } from "./backlog-view";
import { useBacklogCounts } from "./queries";
import { backlogOf, BETA_ID, blockedRow, REPO_WEB, refineRow, workItemRow } from "./test-fixtures";

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    search: new URLSearchParams(),
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Follows a push or replace that opens or closes the New work item sheet (`?new=1`). */
    follow(href: string) {
      const next = new URLSearchParams(href.split("?")[1] ?? "");
      if ((next.get("new") === "1") === (state.search.get("new") === "1")) return;
      state.search = next;
      for (const listener of listeners) listener();
    },
  };
  return state;
});
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePathname: () => "/backlog",
    useRouter: () => nav.router,
    useSearchParams: () => useSyncExternalStore(nav.subscribe, () => nav.search),
  };
});

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

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

/** What `GET /api/ui/backlog` answers. */
let backlog: Backlog;
let seen: SeenRequest[];

function serve() {
  seen = mockFetch({
    "GET /api/ui/backlog": () => jsonResponse(backlog),
    "GET /api/ui/backlog/counts": () =>
      jsonResponse({
        readyToStart: backlog.groups.readyToStart.length,
        needsRefining: backlog.groups.needsRefining.length,
        total: backlog.groups.readyToStart.length + backlog.groups.needsRefining.length,
      }),
    "GET /api/ui/backlog/up-next": () =>
      jsonResponse({
        readyToStart: backlog.groups.readyToStart.slice(0, 3),
        needsRefining: backlog.groups.needsRefining.slice(0, 2),
      }),
  });
}

/** Observes the counts and Up next, as the nav and the empty Inbox do. */
function Observers() {
  const keys = useQueryKeys();
  useBacklogCounts();
  useQuery({
    queryKey: backlogKeys(keys).upNext(TEST_ORGANIZATION_ID),
    queryFn: async () => (await fetch("/api/ui/backlog/up-next")).json(),
  });
  return null;
}

function renderBacklog(
  options: {
    search?: string;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
    workItemId?: string | null;
    renderNewWorkItem?: (close: () => void) => React.ReactNode;
  } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = options.client ?? createTestQueryClient();
  const user = options.user ?? testUser;
  let workItemId = options.workItemId ?? null;
  const view = () => (
    <BacklogView
      workItemId={workItemId}
      renderDetail={(id) => <p data-testid="detail">Detail of {id}</p>}
      renderNewWorkItem={options.renderNewWorkItem}
    />
  );
  const tree = () => (
    <CurrentUserProvider user={user}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          {options.live ? (
            <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
              {view()}
              <Observers />
            </LiveProvider>
          ) : (
            view()
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>
  );
  const utils = render(tree());
  return {
    ...utils,
    client,
    /** Moves to another URL, as a client-side navigation does (no remount). */
    navigate: (next: { workItemId?: string | null; search?: string }) => {
      if (next.workItemId !== undefined) workItemId = next.workItemId;
      if (next.search !== undefined) nav.search = new URLSearchParams(next.search);
      utils.rerender(tree());
    },
  };
}

const rows = () =>
  screen.queryAllByRole("listitem").filter((row) => row.classList.contains("or-row"));
const titles = () => rows().map((row) => row.querySelector(".or-row__title")!.textContent);
const requests = (path: string) => seen.filter((request) => request.path === path);
/** A row's badges, in order, by what they say. */
const badges = (row: HTMLElement) =>
  [...row.querySelectorAll(".or-row__meta > *")].map(
    (badge) =>
      badge.getAttribute("aria-label") ??
      badge.querySelector(".or-ref__text")?.textContent ??
      badge.textContent!.trim(),
  );
/** A menu's checkable items by their visible label (marks left out). */
const choices = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitemcheckbox")
    .map((item) => item.querySelector(".or-menu__label")!.textContent);
const split = (container: HTMLElement) => container.querySelector(".or-split")!;

beforeEach(() => {
  nav.router.push.mockReset().mockImplementation(nav.follow);
  nav.router.replace.mockReset().mockImplementation(nav.follow);
  backlog = backlogOf([workItemRow(), blockedRow(), refineRow()]);
  serve();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Backlog list", () => {
  it("shows Backlog, the + named New work item, the Source and Repo filters at All and the groups with counts", async () => {
    renderBacklog();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.getByRole("heading", { level: 1, name: "Backlog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New work item" })).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Filters" }))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Source: All", "Repo: All"]);
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Ready to start · 2", "Needs refining · 1"]);
    const ready = screen.getByRole("list", { name: "Ready to start" });
    expect(within(ready).getAllByRole("listitem")).toHaveLength(2);
    expect(titles()).toEqual([
      "Export invoices as CSV",
      "Send invoice reminders",
      "Rough idea: dunning emails",
    ]);
    expect(requests("/api/ui/backlog").at(-1)!.query.get("organization")).toBe(
      TEST_ORGANIZATION_ID,
    );
  });

  it("doesn't render a group with no items", async () => {
    backlog = backlogOf([refineRow()]);
    renderBacklog();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole("list", { name: "Ready to start" })).toBeNull();
    expect(screen.queryByText(/Ready to start/)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Needs refining · 1" })).toBeTruthy();
  });

  it("gives each row the tracker mark, the title and the identifier, repo, size and Blocked badges in order", async () => {
    renderBacklog();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [ready, blocked, refine] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    const mark = ready.querySelector(".or-row__mark")!;
    expect(within(mark as HTMLElement).getByRole("img", { name: "Linear" })).toBeTruthy();
    expect(ready.querySelector(".or-row__dot")).toBeNull();
    expect(within(ready).getByRole("link", { name: "Export invoices as CSV" })).toBeTruthy();
    expect(badges(ready)).toEqual(["SOC-412", "acme/portal", "Size M"]);
    // No size when unknown; Blocked last, only when blocked.
    expect(badges(blocked)).toEqual(["SOC-413", "acme/web", "Blocked"]);
    expect(within(blocked).getByRole("img", { name: "Blocked" }).textContent).toBe("Blocked");
    // No repo yet while routing asks.
    expect(badges(refine)).toEqual(["SOC-420", "Size S"]);
    expect(screen.queryAllByRole("img", { name: "Blocked" })).toHaveLength(1);
  });

  it("leads the badges with the organization under All organizations", async () => {
    backlog = backlogOf([
      workItemRow(),
      { ...refineRow(), organization: { id: BETA_ID, name: "Beta", role: "member" } },
    ]);
    renderBacklog({ user: allOrganizations });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(badges(rows()[0]!)).toEqual(["Acme", "SOC-412", "acme/portal", "Size M"]);
    expect(badges(rows()[1]!)).toEqual(["Beta", "SOC-420", "Size S"]);
    expect(requests("/api/ui/backlog").at(-1)!.query.get("organization")).toBe("all");
  });
});

describe("the filters", () => {
  async function openFilter(name: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name }));
    return { user, menu: await screen.findByRole("menu") };
  }

  it("offer the sources (as the detail's via badge names them) and repos, and put the choice in the URL", async () => {
    renderBacklog();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const source = await openFilter("Source: All");
    expect(choices(source.menu)).toEqual(["All", "Portal project", "SOC team"]);
    await source.user.click(
      within(source.menu).getByRole("menuitemcheckbox", { name: "SOC team" }),
    );
    expect(nav.router.push).toHaveBeenLastCalledWith("/backlog?source=linear%3Ateam%3Ateam-soc", {
      scroll: false,
    });

    const repo = await openFilter("Repo: All");
    expect(choices(repo.menu)).toEqual(["All", "acme/portal", "acme/web"]);
    await repo.user.click(within(repo.menu).getByRole("menuitemcheckbox", { name: "acme/web" }));
    expect(nav.router.push).toHaveBeenLastCalledWith(`/backlog?repo=${REPO_WEB}`, {
      scroll: false,
    });
  });

  it("read the URL, send it to the API and keep it on row links and the back link", async () => {
    backlog = backlogOf([blockedRow()], {
      filters: backlogOf([workItemRow(), blockedRow()]).filters,
    });
    const search = `source=linear%3Ateam%3Ateam-soc&repo=${REPO_WEB}`;
    const { container } = renderBacklog({ search });
    await waitFor(() => expect(rows()).toHaveLength(1));
    const last = requests("/api/ui/backlog").at(-1)!;
    expect(last.query.get("source")).toBe("linear:team:team-soc");
    expect(last.query.get("repo")).toBe(REPO_WEB);
    expect(screen.getByRole("button", { name: "Source: SOC team" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repo: acme/web" })).toBeTruthy();
    expect(
      within(rows()[0]!).getByRole("link", { name: "Send invoice reminders" }).getAttribute("href"),
    ).toBe(`/backlog/linear-issue-413?${search}`);
    expect(container.querySelector(".or-split__back")!.getAttribute("href")).toBe(
      `/backlog?${search}`,
    );
  });

  it("go back to All from the menu", async () => {
    renderBacklog({ search: "source=linear%3Ateam%3Ateam-soc" });
    await waitFor(() => expect(rows()).toHaveLength(3));
    const source = await openFilter("Source: SOC team");
    await source.user.click(within(source.menu).getByRole("menuitemcheckbox", { name: "All" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/backlog", { scroll: false });
  });
});

describe("New work item's URL", () => {
  const sheet = () => screen.queryByRole("button", { name: "Close new work item" });
  const renderNew = (options: { search?: string; workItemId?: string } = {}) =>
    renderBacklog({
      ...options,
      renderNewWorkItem: (close) => (
        <button type="button" onClick={close}>
          Close new work item
        </button>
      ),
    });

  it("opens the sheet from ?new=1, and closing removes it, keeping the rest of the URL", async () => {
    renderNew({ workItemId: "linear-issue-1", search: `repo=${REPO_WEB}&new=1` });
    expect(sheet()).toBeTruthy();
    await userEvent.setup().click(sheet()!);
    expect(nav.router.replace).toHaveBeenLastCalledWith(
      `/backlog/linear-issue-1?repo=${REPO_WEB}`,
      {
        scroll: false,
      },
    );
    expect(sheet()).toBeNull();
  });

  it("opens it from the + by setting ?new=1, which carries the New work item key", async () => {
    renderNew({ search: `repo=${REPO_WEB}` });
    const plus = await screen.findByRole("button", { name: "New work item" });
    expect(sheet()).toBeNull();
    await userEvent.setup().click(plus);
    expect(nav.router.push).toHaveBeenLastCalledWith(`/backlog?repo=${REPO_WEB}&new=1`, {
      scroll: false,
    });
    expect(sheet()).toBeTruthy();
  });

  it("puts the key on the + inside the shortcuts", async () => {
    nav.search = new URLSearchParams();
    render(
      <ShortcutProvider definitions={SHORTCUTS} platform="other">
        <CurrentUserProvider user={testUser}>
          <QueryClientProvider client={createTestQueryClient()}>
            <UiProvider linkComponent={TestLink}>
              <BacklogView renderDetail={() => null} />
            </UiProvider>
          </QueryClientProvider>
        </CurrentUserProvider>
      </ShortcutProvider>,
    );
    const plus = screen.getByRole("button", { name: "New work item" });
    expect(plus.getAttribute("aria-keyshortcuts")).toBe("N");
    expect(plus.textContent).toBe("");
  });
});

describe("empty states", () => {
  const heading = () => screen.getByRole("heading", { level: 2 });
  const description = () => document.querySelector(".or-empty__description");

  it("says Nothing in the backlog, with New work item", async () => {
    backlog = backlogOf([]);
    const opened = vi.fn();
    renderBacklog({
      renderNewWorkItem: (close) => {
        opened();
        return (
          <button type="button" onClick={close}>
            Close new work item
          </button>
        );
      },
    });
    await waitFor(() => expect(heading().textContent).toBe("Nothing in the backlog"));
    expect(description()).toBeNull();
    const user = userEvent.setup();
    const empty = document.querySelector(".or-empty") as HTMLElement;
    await user.click(within(empty).getByRole("button", { name: "New work item" }));
    expect(opened).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close new work item" }));
    expect(screen.queryByRole("button", { name: "Close new work item" })).toBeNull();
    // The + opens it too.
    await user.click(screen.getAllByRole("button", { name: "New work item" })[0]!);
    expect(screen.getByRole("button", { name: "Close new work item" })).toBeTruthy();
  });

  it("says No work items match these filters, with Clear filters", async () => {
    backlog = backlogOf([], { filters: backlogOf([workItemRow()]).filters });
    renderBacklog({ workItemId: "linear-issue-1", search: `repo=${REPO_WEB}` });
    await waitFor(() => expect(heading().textContent).toBe("No work items match these filters"));
    expect(description()).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }));
    expect(nav.router.push).toHaveBeenLastCalledWith("/backlog/linear-issue-1", { scroll: false });
  });

  it.each([
    ["no_work_item_match", "No repo picks up work items yet", "Open Repos", "/repos"],
    [
      "no_tracker",
      "Connect Linear to see its work items",
      "Open Settings",
      "/settings/integrations",
    ],
  ] as const)("for %s says %s, with %s for admins only", async (setup, title, action, href) => {
    backlog = backlogOf([], { setup });
    const { unmount } = renderBacklog();
    await waitFor(() => expect(heading().textContent).toBe(title));
    expect(description()).toBeNull();
    expect(screen.getByRole("link", { name: action }).getAttribute("href")).toBe(href);
    unmount();

    renderBacklog({ user: member });
    await waitFor(() => expect(heading().textContent).toBe(title));
    expect(screen.queryByRole("link", { name: action })).toBeNull();
    expect(document.querySelector(".or-empty__action")).toBeNull();
  });

  it("offers the admin action under All organizations when the user administers one", async () => {
    backlog = backlogOf([], { setup: "no_tracker" });
    renderBacklog({ user: allOrganizations });
    await waitFor(() => expect(screen.getByRole("link", { name: "Open Settings" })).toBeTruthy());
  });
});

describe("what didn't load", () => {
  it("names the organizations whose Linear couldn't be read in one notice, with Retry", async () => {
    const unavailable: Backlog["unavailable"] = [
      {
        organization: { id: BETA_ID, name: "NETbuilder", role: "member" },
        tracker: "linear",
        reason: "Linear didn't answer. Try again in a moment.",
      },
    ];
    backlog = backlogOf([workItemRow()], { unavailable });
    renderBacklog();
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Couldn't load work items from Linear for NETbuilder.");
    // Above the groups.
    expect(
      notice.compareDocumentPosition(screen.getByRole("heading", { name: "Ready to start · 1" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const before = requests("/api/ui/backlog").length;
    backlog = backlogOf([workItemRow(), refineRow()]);
    await userEvent.setup().click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requests("/api/ui/backlog").length).toBe(before + 1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(rows()).toHaveLength(2);
  });

  it("joins several organizations' names, and ends a cut list with its notice", async () => {
    const org = (name: string) => ({ id: name, name, role: "member" as const });
    backlog = backlogOf([workItemRow()], {
      unavailable: [
        { organization: org("Acme"), tracker: "linear", reason: "x" },
        { organization: org("NETbuilder"), tracker: "linear", reason: "x" },
      ],
      truncated: true,
      truncatedOrganizations: [org("Big")],
    });
    renderBacklog();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't load work items from Linear for Acme and NETbuilder.",
    );
    expect(screen.getByText("Showing the first 500 work items from Big.")).toBeTruthy();
  });
});

describe("selecting a work item", () => {
  it("puts it in the URL without a reload and marks its row aria-current", async () => {
    const { navigate } = renderBacklog();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().filter((row) => row.getAttribute("aria-current") === "true")).toHaveLength(0);
    const link = within(rows()[1]!).getByRole("link", { name: "Send invoice reminders" });
    expect(link.getAttribute("href")).toBe("/backlog/linear-issue-413");
    await userEvent.setup().click(link);
    expect(nav.router.push).toHaveBeenLastCalledWith("/backlog/linear-issue-413");
    const listRequests = requests("/api/ui/backlog").length;
    navigate({ workItemId: "linear-issue-413" });
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
    expect(rows().filter((row) => row.getAttribute("aria-current") === "true")).toHaveLength(1);
    expect(screen.getByTestId("detail").textContent).toBe("Detail of linear-issue-413");
    // The same list stays mounted: no refetch, no reload.
    expect(requests("/api/ui/backlog")).toHaveLength(listRequests);
  });
});

describe("SplitView", () => {
  it("shows the list on /backlog and the detail on /backlog/{id}, with the ‹ Backlog back link", async () => {
    const { container, navigate } = renderBacklog();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(split(container).getAttribute("data-view")).toBe("list");
    expect(screen.getByRole("region", { name: "Backlog" })).toBeTruthy();
    navigate({ workItemId: "linear-issue-412" });
    expect(split(container).getAttribute("data-view")).toBe("detail");
    const back = container.querySelector(".or-split__back")!;
    expect(back.textContent).toBe("‹ Backlog");
    expect(back.getAttribute("href")).toBe("/backlog");
    expect(
      within(screen.getByRole("region", { name: "Work item" })).getByTestId("detail"),
    ).toBeTruthy();
  });
});

describe("live updates", () => {
  it.each<[string, Parameters<typeof changeEvent>[1]]>([
    ["work_item", { resource: "work_item", ids: ["linear-issue-999"] }],
    ["repository", { resource: "repository" }],
    ["settings (routing rules)", { resource: "settings", section: "routing_rules" }],
  ])(
    "a %s event refetches the list, counts and Up next, and the list shows the new data",
    async (_name, event) => {
      const live = fakeAbly();
      renderBacklog({ live });
      await waitFor(() => expect(rows()).toHaveLength(3));
      await waitFor(() => expect(requests("/api/ui/backlog/counts")).toHaveLength(1));
      await waitFor(() => expect(requests("/api/ui/backlog/up-next")).toHaveLength(1));
      await waitFor(() =>
        expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
      );
      const newcomer = workItemRow({
        id: "linear-issue-999",
        identifier: "SOC-999",
        title: "Triaged just now",
      });
      backlog = backlogOf([workItemRow(), blockedRow(), newcomer]);
      act(() =>
        live
          .current()
          .deliver(`org:${TEST_ORGANIZATION_ID}:changes`, changeEvent(TEST_ORGANIZATION_ID, event)),
      );
      await waitFor(() => expect(requests("/api/ui/backlog")).toHaveLength(2));
      await waitFor(() => expect(requests("/api/ui/backlog/counts")).toHaveLength(2));
      await waitFor(() => expect(requests("/api/ui/backlog/up-next")).toHaveLength(2));
      await waitFor(() =>
        expect(titles()).toEqual([
          "Export invoices as CSV",
          "Send invoice reminders",
          "Triaged just now",
        ]),
      );
      expect(screen.getByRole("heading", { name: "Ready to start · 3" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: /Needs refining/ })).toBeNull();
    },
  );
});

describe("wording", () => {
  it("has no Live indicator, hint text, keyboard shortcuts or Ralph", async () => {
    backlog = backlogOf([workItemRow(), blockedRow(), refineRow()], {
      unavailable: [
        {
          organization: { id: BETA_ID, name: "NETbuilder", role: "member" },
          tracker: "linear",
          reason: "x",
        },
      ],
    });
    const { container } = renderBacklog();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const text = container.textContent!;
    expect(text).not.toMatch(/\blive\b/i);
    expect(text).not.toMatch(/ralph/i);
    expect(text).not.toMatch(/⌘|Ctrl\+|shortcut/i);
    expect(container.querySelector("kbd")).toBeNull();
    expect(container.querySelector(".or-empty__description")).toBeNull();
  });
});
