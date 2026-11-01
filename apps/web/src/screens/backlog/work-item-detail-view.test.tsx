// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectAskRepo,
  serveAskRepositories,
  WithAskNewChat,
} from "@/components/ask/ask-context-test-utils";
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
import type { Backlog } from "@/lib/api/backlog";
import type { RepositoryListItem } from "@/lib/api/repositories";
import type { WorkItemDetail, WorkItemRow } from "@/lib/api/work-items";
import { portalRow, webRow } from "../repos/test-fixtures";
import { BacklogView } from "./backlog-view";
import { useBacklogCounts, useBacklogUpNext } from "./queries";
import {
  backlogOf,
  BETA_ID,
  blockedRow,
  REPO_PORTAL,
  REPO_WEB,
  refineRow,
  workItemRow,
} from "./test-fixtures";
import { WORK_ITEM_NOT_FOUND } from "./work-item-detail-view";

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
  usePathname: () => "/backlog",
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

const ORG = TEST_ORGANIZATION_ID;

const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

/** The detail `GET /api/ui/work-items/{id}` answers for `row`, offering what its group allows. */
function detailOf(row: WorkItemRow, overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  const ready = row.group === "ready";
  return {
    ...row,
    group: row.group,
    state: { category: ready ? "todo" : "backlog", name: ready ? "Todo" : "Backlog" },
    description: "## Introduction\n\nExport every invoice.\n",
    updatedAt: "2026-10-26T10:00:00.000Z",
    blockedBy: [],
    route: row.repository
      ? {
          outcome: "repository",
          repository: row.repository,
          via: { kind: "project", label: "Portal project" },
          by: "work item match (Portal project)",
        }
      : { outcome: "ask", repository: null, via: null, by: null },
    stories: [],
    activity: [],
    triageRunning: false,
    run: null,
    actions: {
      start: ready,
      triage: true,
      editPrd: true,
      changeRepo: true,
      move: ready,
      cancel: true,
    },
    ...overrides,
  };
}

const blockedDetail = () =>
  detailOf(blockedRow(), {
    blockedBy: [
      { identifier: "SOC-398", url: "https://linear.app/acme/issue/SOC-398", backlogId: null },
      {
        identifier: "SOC-401",
        url: "https://linear.app/acme/issue/SOC-401",
        backlogId: "linear-issue-401",
      },
    ],
  });

let backlog: Backlog;
let details: Record<string, WorkItemDetail | (() => Response)>;
let repositories: RepositoryListItem[];
let seen: SeenRequest[];
/** Each action's answer, by `<method> <action>`; `{ ok: true }` when unset. */
let answers: Record<string, () => Response | Promise<Response>>;

function serve() {
  const action = (method: string, name: string) => (): Response | Promise<Response> =>
    answers[`${method} ${name}`]?.() ?? jsonResponse({ ok: true });
  const routes: Parameters<typeof mockFetch>[0] = {
    "GET /api/ui/backlog": () => jsonResponse(backlog),
    "GET /api/ui/backlog/counts": () => {
      const ready = backlog.groups.readyToStart.length;
      const refining = backlog.groups.needsRefining.length;
      return jsonResponse({
        readyToStart: ready,
        needsRefining: refining,
        total: ready + refining,
      });
    },
    "GET /api/ui/backlog/up-next": () =>
      jsonResponse({
        readyToStart: backlog.groups.readyToStart.slice(0, 3),
        needsRefining: backlog.groups.needsRefining.slice(0, 2),
      }),
    "GET /api/ui/repositories": () => jsonResponse({ repositories, truncated: false }),
  };
  for (const id of [
    "linear-issue-412",
    "linear-issue-413",
    "linear-issue-414",
    "linear-issue-420",
  ]) {
    routes[`GET /api/ui/work-items/${id}`] = () => {
      const detail = details[id];
      if (!detail) return jsonResponse({ error: "Not found." }, 404);
      return typeof detail === "function" ? detail() : jsonResponse(detail);
    };
    for (const name of ["start", "triage", "move", "cancel"]) {
      routes[`POST /api/ui/work-items/${id}/${name}`] = action("POST", name);
    }
    routes[`PUT /api/ui/work-items/${id}/repository`] = action("PUT", "repository");
  }
  seen = mockFetch(routes);
}

/** The list's titles, the counts and Up next's titles, as the nav and the empty Inbox show them. */
function Observers() {
  const counts = useBacklogCounts();
  const upNext = useBacklogUpNext();
  return (
    <>
      <p data-testid="counts">
        {counts.data ? `${counts.data.readyToStart}/${counts.data.needsRefining}` : ""}
      </p>
      <p data-testid="up-next">
        {upNext.data
          ? [...upNext.data.readyToStart, ...upNext.data.needsRefining]
              .map((row) => row.identifier)
              .join(" ")
          : ""}
      </p>
    </>
  );
}

function renderBacklog(
  options: {
    workItemId?: string;
    search?: string;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
    renderShareLink?: (item: WorkItemDetail, close: () => void) => React.ReactNode;
    /** Renders New chat beside the screen, under one Ask context. */
    askNewChat?: boolean;
  } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = options.client ?? createTestQueryClient();
  const tree = () => {
    const screenContent = (
      <>
        <BacklogView
          workItemId={options.workItemId ?? "linear-issue-412"}
          renderShareLink={options.renderShareLink}
        />
        <Observers />
      </>
    );
    const content = options.askNewChat ? (
      <WithAskNewChat>{screenContent}</WithAskNewChat>
    ) : (
      screenContent
    );
    return (
      <CurrentUserProvider user={options.user ?? testUser}>
        <QueryClientProvider client={client}>
          <UiProvider linkComponent={TestLink}>
            {options.live ? (
              <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
                {content}
              </LiveProvider>
            ) : (
              content
            )}
          </UiProvider>
        </QueryClientProvider>
      </CurrentUserProvider>
    );
  };
  const utils = render(tree());
  return { ...utils, client, rerender: () => utils.rerender(tree()) };
}

const detailPane = () => screen.getByRole("region", { name: "Work item" });
const article = () => detailPane().querySelector("article") as HTMLElement;
const loaded = (title = "Export invoices as CSV") =>
  screen.findByRole("heading", { level: 2, name: title });
const toolbar = () => within(article()).getByRole("toolbar", { name: "Work item actions" });
const toolbarButtons = () =>
  within(toolbar())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
const listTitles = (group: string) =>
  Array.from(
    screen.queryByRole("list", { name: group })?.querySelectorAll(".or-row__title") ?? [],
    (title) => title.textContent,
  );
const requests = (method: string, path: string) =>
  seen.filter((request) => request.method === method && request.path === path);

async function openMenu() {
  await userEvent.click(within(toolbar()).getByRole("button", { name: "More actions" }));
  return screen.findByRole("menu");
}

/** The menu's entries in order, "—" for a separator. */
function menuEntries(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]'), (item) =>
    item.getAttribute("role") === "separator" ? "—" : (item.textContent ?? "").trim(),
  );
}

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.replace.mockReset();
  nav.router.push.mockReset();
  backlog = backlogOf([
    workItemRow(),
    blockedRow(),
    workItemRow({ id: "linear-issue-414", identifier: "SOC-414", title: "Archive old invoices" }),
    refineRow(),
  ]);
  details = {
    "linear-issue-412": detailOf(workItemRow()),
    "linear-issue-413": blockedDetail(),
    "linear-issue-414": detailOf(
      workItemRow({ id: "linear-issue-414", identifier: "SOC-414", title: "Archive old invoices" }),
    ),
    "linear-issue-420": detailOf(refineRow()),
  };
  repositories = [
    portalRow({ codingEnabled: true }),
    webRow(),
    portalRow({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
      fullPath: "acme/docs",
      name: "docs",
      codingEnabled: false,
    }),
  ];
  answers = {};
  serve();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the bar", () => {
  it("shows the identifier and size, then the toolbar, with the title, PRD and routes line below", async () => {
    renderBacklog();
    await loaded();
    const bar = article().querySelector(".or-backlog-detail__bar") as HTMLElement;
    const badges = bar.querySelector(".or-backlog-detail__badges") as HTMLElement;
    expect(bar.firstElementChild).toBe(badges);
    expect(badges.nextElementSibling).toBe(toolbar());
    expect(within(badges).getByText("SOC-412")).toBeTruthy();
    expect(within(badges).getByRole("img", { name: "Size M" })).toBeTruthy();
    expect(within(badges).queryByText("Acme")).toBeNull();
    // Title right after the bar.
    expect(bar.nextElementSibling!.tagName).toBe("H2");
    await waitFor(() => expect(within(article()).getByText("Export every invoice.")).toBeTruthy());
  });

  it("adds the organization under All organizations, and leaves out an unknown size", async () => {
    details["linear-issue-413"] = blockedDetail();
    renderBacklog({ user: allOrganizations, workItemId: "linear-issue-413" });
    await loaded("Send invoice reminders");
    const badges = article().querySelector(".or-backlog-detail__badges") as HTMLElement;
    expect(within(badges).getByText("Acme")).toBeTruthy();
    expect(within(badges).queryByRole("img", { name: /^Size/ })).toBeNull();
  });

  it("on phone heads the detail with ‹ Backlog, and the CSS moves the badges under the title", async () => {
    const { container } = renderBacklog({ search: "repo=" + REPO_PORTAL });
    await loaded();
    const back = container.querySelector(".or-split__back")!;
    expect(back.textContent).toBe("‹ Backlog");
    expect(back.getAttribute("href")).toBe(`/backlog?repo=${REPO_PORTAL}`);
    expect(detailPane().firstElementChild).toBe(back);

    const css = readFileSync(path.join(__dirname, "work-item-detail.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const phone = css.match(/@media \(max-width: 768px\) \{((?:[^{}]*\{[^}]*\})*)\s*\}/)?.[1] ?? "";
    const order = (selector: string) =>
      Number(
        phone.match(
          new RegExp(`${selector.replace(/[.*>]/g, "\\$&")}\\s*\\{[^}]*order:\\s*(\\d+)`),
        )?.[1],
      );
    expect(phone).toMatch(/\.or-backlog-detail__bar\s*\{[^}]*display:\s*contents/);
    expect(order(".or-backlog-detail__bar .or-toolbar")).toBeLessThan(
      order(".or-backlog-detail__title"),
    );
    expect(order(".or-backlog-detail__title")).toBeLessThan(
      order(".or-backlog-detail__bar .or-backlog-detail__badges"),
    );
    expect(order(".or-backlog-detail__bar .or-backlog-detail__badges")).toBeLessThan(
      order(".or-backlog-detail > *"),
    );
    // Wider, the bar is one row: badges, then the toolbar.
    const wide = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "");
    expect(wide).toMatch(/\.or-backlog-detail__bar\s*\{[^}]*display:\s*flex/);
    expect(wide).not.toMatch(/(?:^|[\s;{])order:/);
    expect(read("work-item-detail-view.tsx")).toMatch(/import\s+"\.\/work-item-detail\.css";/);
  });

  it("makes the item's repo New chat's default (useAskContextRepository)", async () => {
    serveAskRepositories([
      { id: REPO_WEB, provider: "github", fullPath: "acme/web" },
      { id: REPO_PORTAL, provider: "gitlab", fullPath: "acme/portal" },
    ]);
    renderBacklog({ askNewChat: true });
    await loaded();
    await expectAskRepo("acme/portal");
  });

  it("says when the item doesn't exist", async () => {
    delete details["linear-issue-412"];
    renderBacklog();
    expect(await screen.findByRole("heading", { name: WORK_ITEM_NOT_FOUND })).toBeTruthy();
  });
});

const read = (file: string) => readFileSync(path.join(__dirname, file), "utf8");

/** An element's words as read: its children's text, space-separated, without the marks. */
function words(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const mark of clone.querySelectorAll("svg")) mark.remove();
  return Array.from(clone.childNodes, (node) => (node.textContent ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

describe("the toolbar", () => {
  it("offers Start epic, Edit PRD and Share review link on a Ready item, and Open, Change repo, Move and Remove in ⋯", async () => {
    renderBacklog();
    await loaded();
    expect(toolbarButtons()).toEqual([
      "Start epic",
      "Edit PRD",
      "Share review link",
      "More actions",
    ]);
    const start = within(toolbar()).getByRole("button", { name: "Start epic" });
    expect(start.className).toContain("or-icon-btn--solid");
    const menu = await openMenu();
    expect(menuEntries(menu)).toEqual([
      "Open SOC-412 in Linear (opens in a new tab)",
      "Change repo…",
      "Move to Needs refining",
      "—",
      "Remove from backlog…",
    ]);
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Open SOC-412 in Linear (opens in a new tab)" })
        .getAttribute("href"),
    ).toBe("https://linear.app/acme/issue/SOC-412");
  });

  it("offers Triage now, Edit PRD and Share review link on a Needs refining item, without Move", async () => {
    renderBacklog({ workItemId: "linear-issue-420" });
    await loaded("Rough idea: dunning emails");
    expect(toolbarButtons()).toEqual([
      "Triage now",
      "Edit PRD",
      "Share review link",
      "More actions",
    ]);
    const menu = await openMenu();
    expect(menuEntries(menu)).toEqual([
      "Open SOC-420 in Linear (opens in a new tab)",
      "Change repo…",
      "—",
      "Remove from backlog…",
    ]);
  });

  it("disables Triage now with Om is triaging SOC-420 while triage runs", async () => {
    const user = userEvent.setup();
    details["linear-issue-420"] = detailOf(refineRow(), {
      triageRunning: true,
      actions: { ...detailOf(refineRow()).actions, triage: false },
    });
    renderBacklog({ workItemId: "linear-issue-420" });
    await loaded("Rough idea: dunning emails");
    const triage = within(toolbar()).getByRole("button", { name: "Triage now" });
    expect(triage.getAttribute("aria-disabled")).toBe("true");
    await user.hover(triage);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Om is triaging SOC-420");
    await user.click(triage);
    expect(requests("POST", "/api/ui/work-items/linear-issue-420/triage")).toHaveLength(0);
  });

  it("disables Start epic on a feature, saying why", async () => {
    const user = userEvent.setup();
    const reason =
      "SOC-412 is a feature: it holds epics (SOC-413). Each epic is started on its own: " +
      "start each epic instead.";
    details["linear-issue-412"] = detailOf(workItemRow(), {
      startRefusal: reason,
      actions: { ...detailOf(workItemRow()).actions, start: false },
    });
    renderBacklog();
    await loaded();
    const start = within(toolbar()).getByRole("button", { name: "Start epic" });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    await user.hover(start);
    expect((await screen.findByRole("tooltip")).textContent).toBe(reason);
    await user.click(start);
    expect(requests("POST", "/api/ui/work-items/linear-issue-412/start")).toHaveLength(0);
  });

  it("opens the editor from Edit PRD, switching to the PRD tab", async () => {
    renderBacklog({ search: "tab=stories" });
    nav.router.replace.mockImplementation((href: string) => {
      nav.search = new URLSearchParams(href.split("?")[1] ?? "");
    });
    await loaded();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Edit PRD" }));
    expect(nav.router.replace).toHaveBeenCalledWith("/backlog/linear-issue-412", { scroll: false });
    const editor = await screen.findByRole("textbox", { name: "PRD of SOC-412 (Markdown)" });
    expect((editor as HTMLTextAreaElement).value).toBe(
      "## Introduction\n\nExport every invoice.\n",
    );
    // The toolbar has Edit PRD: the PRD pane draws no second one.
    expect(within(article()).getAllByRole("button", { name: "Edit PRD" })).toHaveLength(1);
  });

  it("disables Edit PRD while Om works on the item", async () => {
    details["linear-issue-412"] = detailOf(workItemRow(), {
      actions: { ...detailOf(workItemRow()).actions, editPrd: false },
    });
    renderBacklog();
    await loaded();
    expect(
      (within(toolbar()).getByRole("button", { name: "Edit PRD" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("opens Share review link's flow", async () => {
    const renderShareLink = vi.fn((item: WorkItemDetail, close: () => void) => (
      <div role="dialog" aria-label="Share review link">
        Sharing {item.identifier}
        <button type="button" onClick={close}>
          Done
        </button>
      </div>
    ));
    renderBacklog({ renderShareLink });
    await loaded();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Share review link" }));
    const sheet = await screen.findByRole("dialog", { name: "Share review link" });
    expect(sheet.textContent).toContain("Sharing SOC-412");
    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Share review link" })).toBeNull();
  });
});

describe("a blocked item", () => {
  it("shows Blocked by under the title, and Start epic waits behind a confirm", async () => {
    const user = userEvent.setup();
    renderBacklog({ workItemId: "linear-issue-413" });
    const title = await loaded("Send invoice reminders");
    const blockedBy = title.nextElementSibling as HTMLElement;
    expect(blockedBy.textContent).toContain("Blocked by");
    expect(
      within(blockedBy)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["https://linear.app/acme/issue/SOC-398", "/backlog/linear-issue-401"]);

    const start = within(toolbar()).getByRole("button", { name: "Start epic" });
    await user.hover(start);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Starts when SOC-398 and SOC-401 are done",
    );
    await user.click(start);
    const dialog = await screen.findByRole("alertdialog", { name: "Start SOC-413?" });
    expect(dialog.textContent).toContain("Om will wait for its blockers to finish.");
    expect(requests("POST", "/api/ui/work-items/linear-issue-413/start")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Start epic" }));
    await waitFor(() =>
      expect(requests("POST", "/api/ui/work-items/linear-issue-413/start")).toHaveLength(1),
    );
  });

  it("an unblocked item has no Blocked by line and starts in one click", async () => {
    const user = userEvent.setup();
    renderBacklog();
    await loaded();
    expect(within(article()).queryByText("Blocked by")).toBeNull();
    const start = within(toolbar()).getByRole("button", { name: "Start epic" });
    await user.hover(start);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Start epic");
    await user.click(start);
    await waitFor(() =>
      expect(requests("POST", "/api/ui/work-items/linear-issue-412/start")).toHaveLength(1),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("the routes line", () => {
  it("reads Routes to <repo> via <source>", async () => {
    renderBacklog();
    await loaded();
    const routes = article().querySelector(".or-backlog-detail__routes") as HTMLElement;
    expect(words(routes)).toBe("Routes to acme/portal via Portal project");
    expect(routes.querySelector(".or-ref--repo.or-ref--strong")!.textContent).toContain(
      "acme/portal",
    );
    const via = routes.querySelector(".or-ref--meta") as HTMLElement;
    expect(within(via).getByRole("img", { name: "Linear" })).toBeTruthy();
  });

  it("reads Routes to no repo yet with Choose a repo, which opens Change repo…", async () => {
    renderBacklog({ workItemId: "linear-issue-420" });
    await loaded("Rough idea: dunning emails");
    const routes = article().querySelector(".or-backlog-detail__routes") as HTMLElement;
    expect(words(routes)).toBe("Routes to no repo yet Choose a repo");
    await userEvent.click(within(routes).getByRole("button", { name: "Choose a repo" }));
    expect(await screen.findByRole("dialog", { name: "Change repo" })).toBeTruthy();
  });
});

describe("the tabs", () => {
  const tabsDetail = () =>
    detailOf(workItemRow(), {
      stories: [
        {
          identifier: "SOC-430",
          title: "Export endpoint",
          state: { category: "todo", name: "Todo" },
          url: "https://linear.app/acme/issue/SOC-430",
          manual: false,
        },
        {
          identifier: "SOC-431",
          title: "Configure the bucket",
          state: { category: "backlog", name: "Backlog" },
          url: "https://linear.app/acme/issue/SOC-431",
          manual: true,
        },
      ],
      activity: [
        {
          id: "event-2",
          source: "event",
          text: "Steve changed the repo to portal",
          at: "2026-10-26T12:00:00.000Z",
        },
        {
          id: "triage-1",
          source: "triage",
          text: "Om triaged it (size M)",
          at: "2026-10-25T09:30:00.000Z",
        },
      ],
    });

  it("shows PRD, Stories with its count and Activity, PRD first", async () => {
    details["linear-issue-412"] = tabsDetail();
    renderBacklog();
    await loaded();
    const tabs = within(article()).getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label") ?? tab.textContent)).toEqual([
      "PRD",
      "Stories, 2",
      "Activity",
    ]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    await waitFor(() =>
      expect(
        within(screen.getByRole("tabpanel", { name: "PRD" })).getByText("Export every invoice."),
      ).toBeTruthy(),
    );
  });

  it("puts the chosen tab in the URL, keeping the filters", async () => {
    renderBacklog({ search: `repo=${REPO_PORTAL}` });
    await loaded();
    await userEvent.click(within(article()).getByRole("tab", { name: "Activity" }));
    expect(nav.router.replace).toHaveBeenCalledWith(
      `/backlog/linear-issue-412?repo=${REPO_PORTAL}&tab=activity`,
      { scroll: false },
    );
  });

  it("shows the stories the URL's tab names, with state and the manual badge", async () => {
    details["linear-issue-412"] = tabsDetail();
    renderBacklog({ search: "tab=stories" });
    await loaded();
    const panel = screen.getByRole("tabpanel", { name: "Stories, 2" });
    const stories = within(panel).getAllByRole("listitem");
    expect(stories.map(words)).toEqual([
      "SOC-430 (opens in a new tab) Export endpoint Todo",
      "SOC-431 (opens in a new tab) Configure the bucket Backlog manual",
    ]);
    expect(within(stories[0]!).getByRole("link").getAttribute("href")).toBe(
      "https://linear.app/acme/issue/SOC-430",
    );
  });

  it("lists PRD stories without identifiers", async () => {
    details["linear-issue-412"] = detailOf(workItemRow(), {
      stories: [
        { identifier: null, title: "US-001: Export", state: null, url: null, manual: false },
      ],
    });
    renderBacklog({ search: "tab=stories" });
    await loaded();
    const panel = screen.getByRole("tabpanel", { name: "Stories, 1" });
    expect(words(within(panel).getByRole("listitem"))).toBe("US-001: Export");
  });

  it("shows Activity through ActivityList, newest first with the date column", async () => {
    details["linear-issue-412"] = tabsDetail();
    renderBacklog({ search: "tab=activity" });
    await loaded();
    const panel = screen.getByRole("tabpanel", { name: "Activity" });
    const list = within(panel).getByRole("list", { name: "Activity" });
    expect(list.className).toBe("or-activity__list");
    const entries = within(list).getAllByRole("listitem");
    expect(entries.map((entry) => entry.querySelector(".or-activity__text")!.textContent)).toEqual([
      "Steve changed the repo to portal",
      "Om triaged it (size M)",
    ]);
    expect(entries[0]!.querySelector("time")!.getAttribute("dateTime")).toBe(
      "2026-10-26T12:00:00.000Z",
    );
  });

  it("says when there are no stories or activity", async () => {
    renderBacklog({ search: "tab=activity" });
    await loaded();
    expect(within(screen.getByRole("tabpanel")).getByText("No activity yet")).toBeTruthy();
  });
});

describe("Start epic", () => {
  it("removes the item from the list, counts and Up next before the response, and selects the next item", async () => {
    const response = deferred();
    answers["POST start"] = () => response.promise;
    renderBacklog({ search: `repo=${REPO_PORTAL}` });
    await loaded();
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/1"));
    await waitFor(() =>
      expect(screen.getByTestId("up-next").textContent).toBe("SOC-412 SOC-413 SOC-414 SOC-420"),
    );

    await userEvent.click(within(toolbar()).getByRole("button", { name: "Start epic" }));

    await waitFor(() =>
      expect(listTitles("Ready to start")).toEqual([
        "Send invoice reminders",
        "Archive old invoices",
      ]),
    );
    expect(screen.getByTestId("counts").textContent).toBe("2/1");
    expect(screen.getByTestId("up-next").textContent).toBe("SOC-413 SOC-414 SOC-420");
    expect(nav.router.replace).toHaveBeenCalledWith(
      `/backlog/linear-issue-413?repo=${REPO_PORTAL}`,
      { scroll: false },
    );
    expect(requests("POST", "/api/ui/work-items/linear-issue-412/start")).toHaveLength(1);

    backlog = backlogOf([blockedRow(), backlog.groups.readyToStart[2]!, refineRow()]);
    await act(async () => response.resolve(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Om is starting SOC-412"));
    expect(listTitles("Ready to start")).toEqual([
      "Send invoice reminders",
      "Archive old invoices",
    ]);
  });

  it("selects the previous item when it was the last one", async () => {
    renderBacklog({ workItemId: "linear-issue-420" });
    await loaded("Rough idea: dunning emails");
    // A Needs refining item has no Start: remove it instead, which leaves the same way.
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove from backlog…" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(nav.router.replace).toHaveBeenCalledWith("/backlog/linear-issue-414", {
      scroll: false,
    });
  });

  it("rolls everything back with an error toast when the server refuses", async () => {
    const response = deferred();
    answers["POST start"] = () => response.promise;
    renderBacklog();
    await loaded();
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/1"));
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Start epic" }));
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("2/1"));

    await act(async () =>
      response.resolve(jsonResponse({ error: "SOC-412 already has a run." }, 409)),
    );
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("SOC-412 already has a run.", { variant: "danger" }),
    );
    await waitFor(() =>
      expect(listTitles("Ready to start")).toEqual([
        "Export invoices as CSV",
        "Send invoice reminders",
        "Archive old invoices",
      ]),
    );
    expect(screen.getByTestId("counts").textContent).toBe("3/1");
    expect(screen.getByTestId("up-next").textContent).toBe("SOC-412 SOC-413 SOC-414 SOC-420");
  });
});

describe("the other actions", () => {
  it("Triage now disables itself before the response", async () => {
    const user = userEvent.setup();
    const response = deferred();
    answers["POST triage"] = () => response.promise;
    renderBacklog({ workItemId: "linear-issue-420" });
    await loaded("Rough idea: dunning emails");
    await user.click(within(toolbar()).getByRole("button", { name: "Triage now" }));
    const triage = within(toolbar()).getByRole("button", { name: "Triage now" });
    await waitFor(() => expect(triage.getAttribute("aria-disabled")).toBe("true"));
    await user.unhover(triage);
    await user.hover(triage);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Om is triaging SOC-420");
    expect(requests("POST", "/api/ui/work-items/linear-issue-420/triage")).toHaveLength(1);

    details["linear-issue-420"] = detailOf(refineRow(), {
      triageRunning: true,
      actions: { ...detailOf(refineRow()).actions, triage: false },
    });
    await act(async () => response.resolve(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Om is triaging SOC-420"));
    expect(
      within(toolbar()).getByRole("button", { name: "Triage now" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("Move to Needs refining moves the item before the response", async () => {
    const response = deferred();
    answers["POST move"] = () => response.promise;
    renderBacklog();
    await loaded();
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/1"));
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Move to Needs refining" }));

    await waitFor(() =>
      expect(listTitles("Needs refining")).toEqual([
        "Export invoices as CSV",
        "Rough idea: dunning emails",
      ]),
    );
    expect(listTitles("Ready to start")).toEqual([
      "Send invoice reminders",
      "Archive old invoices",
    ]);
    expect(screen.getByTestId("counts").textContent).toBe("2/2");
    // The detail now offers Triage now (a Needs refining item).
    expect(toolbarButtons()[0]).toBe("Triage now");
    expect(seen.find((request) => request.path.endsWith("/move"))?.body).toEqual({
      to: "needs_refining",
    });

    backlog = backlogOf([
      blockedRow(),
      backlog.groups.readyToStart[2]!,
      { ...workItemRow(), group: "refine" },
      refineRow(),
    ]);
    details["linear-issue-412"] = detailOf({ ...workItemRow(), group: "refine" });
    await act(async () => response.resolve(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Moved SOC-412 to Needs refining"));
  });

  it("Remove from backlog… confirms, then removes the item at once and cancels it", async () => {
    const response = deferred();
    answers["POST cancel"] = () => response.promise;
    renderBacklog();
    await loaded();
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/1"));
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove from backlog…" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Remove SOC-412 from the backlog?",
    });
    expect(dialog.textContent).toContain("It's canceled in Linear.");
    expect(requests("POST", "/api/ui/work-items/linear-issue-412/cancel")).toHaveLength(0);
    const remove = within(dialog).getByRole("button", { name: "Remove" });
    expect(remove.className).toContain("or-btn--danger");
    await userEvent.click(remove);

    await waitFor(() =>
      expect(listTitles("Ready to start")).toEqual([
        "Send invoice reminders",
        "Archive old invoices",
      ]),
    );
    expect(screen.getByTestId("counts").textContent).toBe("2/1");
    expect(screen.getByTestId("up-next").textContent).toBe("SOC-413 SOC-414 SOC-420");
    expect(requests("POST", "/api/ui/work-items/linear-issue-412/cancel")).toHaveLength(1);
    expect(nav.router.replace).toHaveBeenCalledWith("/backlog/linear-issue-413", {
      scroll: false,
    });
    await act(async () => response.resolve(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Removed SOC-412 from the backlog"));
  });

  it("asks nothing when Remove is canceled", async () => {
    renderBacklog();
    await loaded();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove from backlog…" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requests("POST", "/api/ui/work-items/linear-issue-412/cancel")).toHaveLength(0);
  });
});

describe("Change repo…", () => {
  async function openChangeRepo() {
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Change repo…" }));
    return screen.findByRole("dialog", { name: "Change repo" });
  }

  it("lists the organization's repos with Coding on, the current one selected, and says what the change causes", async () => {
    details["linear-issue-412"] = detailOf(
      workItemRow({
        repository: {
          id: REPO_PORTAL,
          provider: "gitlab",
          fullPath: "managed-services/customer-portal",
        },
      }),
    );
    renderBacklog();
    await loaded();
    const sheet = await openChangeRepo();
    const select = within(sheet).getByRole("combobox", { name: "Repo" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      "managed-services/customer-portal",
      "acme/web",
    ]);
    expect(select.value).toBe(REPO_PORTAL);
    expect(within(sheet).queryByRole("option", { name: "Use the routing rules again" })).toBeNull();
    expect(sheet.textContent).toContain("Om will build SOC-412 in customer-portal when it starts.");
    expect(
      (within(sheet).getByRole("button", { name: "Change repo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.selectOptions(select, REPO_WEB);
    expect(sheet.textContent).toContain("Om will build SOC-412 in web when it starts.");
    expect(
      (within(sheet).getByRole("button", { name: "Change repo" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    const query = requests("GET", "/api/ui/repositories")[0]!.query;
    expect(query.get("organization")).toBe(ORG);
  });

  it("offers Use the routing rules again when a choice is saved, and sends null", async () => {
    details["linear-issue-412"] = detailOf(workItemRow(), {
      route: {
        outcome: "repository",
        repository: { id: REPO_WEB, provider: "github", fullPath: "acme/web" },
        via: { kind: "choice", label: "your choice" },
        by: "your choice in Omniralph (web)",
      },
    });
    renderBacklog();
    await loaded();
    const sheet = await openChangeRepo();
    const select = within(sheet).getByRole("combobox", { name: "Repo" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe(REPO_WEB);
    await userEvent.selectOptions(
      select,
      within(sheet).getByRole("option", { name: "Use the routing rules again" }),
    );
    expect(sheet.textContent).toContain(
      "Om will route SOC-412 with the routing rules when it starts.",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Change repo" }));
    await waitFor(() =>
      expect(requests("PUT", "/api/ui/work-items/linear-issue-412/repository")[0]?.body).toEqual({
        repositoryId: null,
      }),
    );
  });

  it("updates the repo badge and the routes line before the response", async () => {
    const response = deferred();
    answers["PUT repository"] = () => response.promise;
    renderBacklog();
    await loaded();
    const sheet = await openChangeRepo();
    const select = within(sheet).getByRole("combobox", { name: "Repo" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, REPO_WEB);
    await userEvent.click(within(sheet).getByRole("button", { name: "Change repo" }));

    await waitFor(() =>
      expect(words(article().querySelector(".or-backlog-detail__routes")!)).toBe(
        "Routes to acme/web via your choice",
      ),
    );
    const row = screen
      .getByRole("list", { name: "Ready to start" })
      .querySelector(".or-row") as HTMLElement;
    expect(row.querySelector(".or-ref--repo")!.textContent).toContain("acme/web");
    expect(requests("PUT", "/api/ui/work-items/linear-issue-412/repository")[0]!.body).toEqual({
      repositoryId: REPO_WEB,
    });
    expect(screen.queryByRole("dialog", { name: "Change repo" })).toBeNull();

    details["linear-issue-412"] = detailOf(workItemRow(), {
      route: {
        outcome: "repository",
        repository: { id: REPO_WEB, provider: "github", fullPath: "acme/web" },
        via: { kind: "choice", label: "your choice" },
        by: "your choice in Omniralph (web)",
      },
    });
    await act(async () =>
      response.resolve(
        jsonResponse({ repository: { id: REPO_WEB, provider: "github", fullPath: "acme/web" } }),
      ),
    );
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("SOC-412 will build in acme/web"));
  });

  it("rolls the routes line back when the server refuses", async () => {
    const response = deferred();
    answers["PUT repository"] = () => response.promise;
    renderBacklog();
    await loaded();
    const sheet = await openChangeRepo();
    const select = within(sheet).getByRole("combobox", { name: "Repo" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, REPO_WEB);
    await userEvent.click(within(sheet).getByRole("button", { name: "Change repo" }));
    const routes = () => words(article().querySelector(".or-backlog-detail__routes")!);
    await waitFor(() => expect(routes()).toBe("Routes to acme/web via your choice"));
    await act(async () => response.resolve(jsonResponse({ error: "Coding is off for web." }, 400)));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Coding is off for web.", { variant: "danger" }),
    );
    await waitFor(() => expect(routes()).toBe("Routes to acme/portal via Portal project"));
  });
});

const RUN_ID = "44444444-4444-4444-8444-444444444444";

describe("live updates", () => {
  it("a work_item event naming the open item, or a run event for its run, refetches its detail", async () => {
    const live = fakeAbly();
    details["linear-issue-412"] = detailOf(workItemRow(), {
      run: { id: RUN_ID, status: "stopped" },
    });
    renderBacklog({ live });
    await loaded();
    await waitFor(() => expect(live.current().subscribed()).toContain(`org:${ORG}:changes`));
    const fetches = () => requests("GET", "/api/ui/work-items/linear-issue-412").length;
    await waitFor(() => expect(fetches()).toBeGreaterThan(0));
    const before = fetches();

    details["linear-issue-412"] = detailOf(workItemRow({ title: "Export invoices as XLSX" }));
    act(() =>
      live
        .current()
        .deliver(
          `org:${ORG}:changes`,
          changeEvent(ORG, { resource: "work_item", ids: ["linear-issue-412"] }),
        ),
    );
    await loaded("Export invoices as XLSX");
    expect(fetches()).toBe(before + 1);

    details["linear-issue-412"] = detailOf(workItemRow({ title: "Export invoices as JSON" }));
    act(() =>
      live
        .current()
        .deliver(
          `org:${ORG}:changes`,
          changeEvent(ORG, { resource: "run", runId: RUN_ID, ids: [RUN_ID] }),
        ),
    );
    await loaded("Export invoices as JSON");
    expect(fetches()).toBe(before + 2);
  });
});
