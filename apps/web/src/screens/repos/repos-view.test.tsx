// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { nestedInteractiveElements, UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { queryKeys } from "@/lib/api/keys";
import type { RepositoryDetail, RepositoryListItem } from "@/lib/api/repositories";
import { createQueryClient } from "@/lib/api/query-client";
import { REMOVE_REPO_DESCRIPTION } from "./remove-repo-dialog";
import { ReposView } from "./repos-view";
import {
  BETA_ID,
  betaRow,
  portalRow,
  REPO_BETA,
  REPO_PORTAL,
  REPO_WEB,
  repoDetail,
  webRow,
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
  usePathname: () => "/repos",
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
        if (event.defaultPrevented) return;
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

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

let rows: RepositoryListItem[];
let details: Record<string, RepositoryDetail>;
let seen: SeenRequest[];
let deleteAnswer: () => Response | Promise<Response>;
/** While set, reads never answer: what the view shows then comes from the cache. */
let holdReads: boolean;

const pending = () => new Promise<Response>(() => {});

function serve(extra: Parameters<typeof mockFetch>[0] = {}) {
  seen = mockFetch({
    "GET /api/ui/repositories": () =>
      holdReads ? pending() : jsonResponse({ repositories: rows, truncated: false }),
    ...Object.fromEntries(
      [REPO_PORTAL, REPO_WEB, REPO_BETA].map((id) => [
        `/api/ui/repositories/${id}`,
        (request: SeenRequest) =>
          request.method === "DELETE"
            ? deleteAnswer()
            : holdReads
              ? pending()
              : details[id]
                ? jsonResponse(details[id])
                : jsonResponse({ error: "Not found" }, 404),
      ]),
    ),
    ...Object.fromEntries(
      [REPO_PORTAL, REPO_WEB, REPO_BETA].map((id) => [
        `GET /api/ui/repositories/${id}/rules`,
        () =>
          holdReads
            ? pending()
            : jsonResponse({
                repository: { id, provider: "github", fullPath: "x/y", webUrl: "https://x/y" },
                rules: [],
              }),
      ]),
    ),
    ...extra,
  });
}

function renderRepos(
  options: {
    repositoryId?: string;
    search?: string;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
  } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = options.client ?? createTestQueryClient();
  const user = options.user ?? testUser;
  const view = <ReposView repositoryId={options.repositoryId} />;
  const utils = render(
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
    </CurrentUserProvider>,
  );
  return { ...utils, client };
}

const rail = () => screen.getByRole("region", { name: "Repos" });
const detailPane = () => screen.getByRole("region", { name: "Repo" });
const railRows = () => within(rail()).queryAllByRole("listitem");
const rowLink = (row: HTMLElement) => within(row).getByRole("link");
const listRequests = () =>
  seen.filter((request) => request.method === "GET" && request.path === "/api/ui/repositories");
const detailRequests = (id: string) =>
  seen.filter(
    (request) => request.method === "GET" && request.path === `/api/ui/repositories/${id}`,
  );
const badgeTexts = (row: HTMLElement) =>
  [...row.querySelectorAll(".or-ref__text")].map((badge) => badge.textContent!.trim());
const dot = (row: HTMLElement) => row.querySelector<HTMLElement>(".or-dot");

async function loadedDetail() {
  return within(detailPane()).findByRole("article");
}

beforeEach(() => {
  nav.router.push.mockReset();
  ui.toast.mockReset();
  rows = [portalRow(), webRow()];
  details = {
    [REPO_PORTAL]: repoDetail(portalRow()),
    [REPO_WEB]: repoDetail(webRow()),
  };
  deleteAnswer = () => jsonResponse({ ok: true });
  holdReads = false;
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the rail", () => {
  it("shows Repos as the page heading and one row per repo", async () => {
    renderRepos();
    expect(screen.getByRole("heading", { level: 1, name: "Repos" })).toBeTruthy();
    await waitFor(() => expect(railRows()).toHaveLength(2));
    expect(listRequests()[0]!.query.get("organization")).toBe(TEST_ORGANIZATION_ID);
  });

  it("shows the repo name and group badges, without the organization in one organization", async () => {
    renderRepos();
    await waitFor(() => expect(railRows()).toHaveLength(2));
    const [portal, web] = railRows();
    expect(badgeTexts(portal!)).toEqual(["customer-portal", "managed-services"]);
    expect(badgeTexts(web!)).toEqual(["web", "acme"]);
    expect(within(portal!).queryByRole("img", { name: "Organization" })).toBeNull();
  });

  it("leads each row with its organization under All organizations, and asks for all", async () => {
    rows = [portalRow(), betaRow()];
    renderRepos({ user: allOrganizations });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    expect(listRequests()[0]!.query.get("organization")).toBe("all");
    const [portal, beta] = railRows();
    expect(badgeTexts(portal!)).toEqual(["Acme", "customer-portal", "managed-services"]);
    // No group: no group badge.
    expect(badgeTexts(beta!)).toEqual(["Beta", "api"]);
  });

  it("names the Reviews, Coding and Ask icons on or off, dimming the ones that are off", async () => {
    rows = [portalRow(), betaRow()];
    renderRepos();
    await waitFor(() => expect(railRows()).toHaveLength(2));
    const [portal, beta] = railRows();
    const icon = (row: HTMLElement, name: string) => within(row).getByRole("img", { name });
    expect(icon(portal!, "Reviews on").classList.contains("or-repo-row__switch--off")).toBe(false);
    expect(icon(portal!, "Coding off").classList.contains("or-repo-row__switch--off")).toBe(true);
    expect(icon(portal!, "Ask on").classList.contains("or-repo-row__switch--off")).toBe(false);
    for (const name of ["Reviews off", "Coding off", "Ask off"]) {
      expect(icon(beta!, name).classList.contains("or-repo-row__switch--off")).toBe(true);
    }
  });

  it.each([
    ["nothing running and no problem: no dot", 0, [], null],
    ["running work: a mint dot with the count", 2, [], { tone: "run", label: "2 running" }],
    [
      "a problem: a coral dot named by it",
      0,
      ["No agent online"],
      { tone: "fail", label: "No agent online" },
    ],
    [
      "a problem while work runs: the problem wins, the first one names it",
      3,
      ["Couldn't update this repo's checkout on build-01.", "No agent online"],
      { tone: "fail", label: "Couldn't update this repo's checkout on build-01." },
    ],
  ] as const)("shows %s", async (_case, running, messages, expected) => {
    rows = [
      portalRow({
        status: {
          running,
          problems: messages.map((message, index) => ({
            code: index === 0 && messages.length > 1 ? "sync_failed" : "no_agent_online",
            message,
          })),
        },
      }),
    ];
    renderRepos();
    await waitFor(() => expect(railRows()).toHaveLength(1));
    const found = dot(railRows()[0]!);
    if (expected === null) {
      expect(found).toBeNull();
      return;
    }
    expect(found!.classList.contains(`or-dot--${expected.tone}`)).toBe(true);
    expect(found!.getAttribute("aria-label")).toBe(expected.label);
  });

  it("makes each row one link to its repo, wrapping nothing interactive", async () => {
    renderRepos({ repositoryId: REPO_WEB });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    const [portal, web] = railRows();
    expect(within(portal!).getAllByRole("link")).toHaveLength(1);
    expect(rowLink(portal!).getAttribute("href")).toBe(`/repos/${REPO_PORTAL}`);
    expect(rowLink(web!).getAttribute("href")).toBe(`/repos/${REPO_WEB}`);
    expect(rowLink(portal!).getAttribute("aria-current")).toBeNull();
    expect(rowLink(web!).getAttribute("aria-current")).toBe("page");
    expect(nestedInteractiveElements(rail())).toEqual([]);
    await loadedDetail();
    expect(nestedInteractiveElements(document.body)).toEqual([]);
  });

  it("offers Add repo to admins as an outline icon button", async () => {
    renderRepos();
    const add = screen.getByRole("link", { name: "Add repo" });
    expect(add.classList.contains("or-icon-btn--outline")).toBe(true);
  });

  it("offers no Add repo to members", async () => {
    renderRepos({ user: member });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    expect(screen.queryByRole("link", { name: "Add repo" })).toBeNull();
  });

  it("offers Add repo under All organizations when the user is an admin of one", async () => {
    renderRepos({
      user: {
        ...allOrganizations,
        role: "member",
        organizations: [
          { ...testUser.organization, role: "member" },
          { id: BETA_ID, name: "Beta", role: "admin" },
        ],
      },
    });
    expect(screen.getByRole("link", { name: "Add repo" })).toBeTruthy();
  });
});

describe("no repos", () => {
  it("says No repos yet, with Add repo for admins", async () => {
    rows = [];
    renderRepos();
    expect(await screen.findByRole("heading", { name: "No repos yet" })).toBeTruthy();
    const empty = screen.getByRole("heading", { name: "No repos yet" }).closest(".or-empty")!;
    expect(within(empty as HTMLElement).getByRole("link", { name: "Add repo" })).toBeTruthy();
  });

  it("says No repos yet without Add repo for members", async () => {
    rows = [];
    renderRepos({ user: member });
    expect(await screen.findByRole("heading", { name: "No repos yet" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add repo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add repo" })).toBeNull();
  });
});

describe("the layout", () => {
  type Callback = (entries: { contentRect: { width: number } }[]) => void;
  let observers: Callback[];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(callback: Callback) {
          observers.push(callback);
        }
      },
    );
  });

  const resize = (width: number) =>
    act(() => observers.forEach((callback) => callback([{ contentRect: { width } }])));

  it("renders through SplitView with the default list widths and the list view on /repos", () => {
    const { container } = renderRepos();
    const split = container.querySelector<HTMLElement>(".or-split")!;
    expect(split.classList.contains("or-repos")).toBe(true);
    expect(split.style.getPropertyValue("--or-split-wide")).toBe("340px");
    expect(split.getAttribute("data-view")).toBe("list");
  });

  it("shows the detail view with a back link to Repos on /repos/{id}", async () => {
    const { container } = renderRepos({ repositoryId: REPO_WEB });
    expect(container.querySelector(".or-split")!.getAttribute("data-view")).toBe("detail");
    const back = within(detailPane()).getByRole("link", { name: "Repos" });
    expect(back.textContent).toBe("‹ Repos");
    expect(back.getAttribute("href")).toBe("/repos");
    await loadedDetail();
    expect(detailRequests(REPO_WEB)).toHaveLength(1);
  });

  it("shows the first repo's detail on /repos when the container is wide, its row selected", async () => {
    renderRepos();
    await waitFor(() => expect(railRows()).toHaveLength(2));
    expect(detailPane().querySelector(".or-repo-detail")).toBeNull();
    resize(1200);
    const article = await loadedDetail();
    expect(article.getAttribute("aria-label")).toBe("managed-services/customer-portal");
    expect(rowLink(railRows()[0]!).getAttribute("aria-current")).toBe("page");
    expect(rowLink(railRows()[1]!).getAttribute("aria-current")).toBeNull();
  });

  it("shows no detail on /repos when the container is narrow", async () => {
    renderRepos();
    await waitFor(() => expect(railRows()).toHaveLength(2));
    resize(728);
    expect(detailPane().querySelector(".or-repo-detail")).toBeNull();
    expect(detailRequests(REPO_PORTAL)).toHaveLength(0);
    expect(rowLink(railRows()[0]!).getAttribute("aria-current")).toBeNull();
  });
});

describe("the detail header", () => {
  async function openMenu() {
    const user = userEvent.setup();
    await user.click(within(detailPane()).getByRole("button", { name: "More actions" }));
    return { user, menu: await screen.findByRole("menu") };
  }

  const menuEntries = (menu: HTMLElement) =>
    [...menu.querySelectorAll(".or-menu__item, .or-menu__separator")].map((item) =>
      item.classList.contains("or-menu__separator") ? "—" : item.textContent!.trim(),
    );

  it("shows the repo's full path and its default branch, without the organization in one organization", async () => {
    renderRepos({ repositoryId: REPO_PORTAL });
    const article = await loadedDetail();
    const head = article.querySelector<HTMLElement>(".or-repo-detail__head")!;
    expect(badgeTexts(head)).toEqual(["managed-services/customer-portal", "main"]);
    expect(head.querySelector(".or-ref--repo")!.classList.contains("or-ref--strong")).toBe(true);
    expect(within(head).getByRole("img", { name: "Branch" })).toBeTruthy();
    expect(within(head).queryByRole("img", { name: "Organization" })).toBeNull();
  });

  it("leads with the organization under All organizations", async () => {
    renderRepos({ repositoryId: REPO_PORTAL, user: allOrganizations });
    const article = await loadedDetail();
    const head = article.querySelector<HTMLElement>(".or-repo-detail__head")!;
    expect(badgeTexts(head)).toEqual(["Acme", "managed-services/customer-portal", "main"]);
  });

  it("leaves the branch out while it is unknown", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), { defaultBranch: null });
    renderRepos({ repositoryId: REPO_PORTAL });
    const article = await loadedDetail();
    expect(badgeTexts(article.querySelector(".or-repo-detail__head")!)).toEqual([
      "managed-services/customer-portal",
    ]);
    // Nothing for the phone's Details either.
    expect(article.querySelector(".or-repo-detail__details")).toBeNull();
  });

  it("repeats the organization and branch in a collapsed Details for phone", async () => {
    renderRepos({ repositoryId: REPO_PORTAL, user: allOrganizations });
    const article = await loadedDetail();
    const details = article.querySelector<HTMLDetailsElement>("details.or-repo-detail__details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Details");
    expect(badgeTexts(details)).toEqual(["Acme", "main"]);
  });

  it("has a menu-only toolbar: View runs, Open in GitLab, then Remove repo… last for admins", async () => {
    renderRepos({ repositoryId: REPO_PORTAL });
    await loadedDetail();
    const toolbar = within(detailPane()).getByRole("toolbar", { name: "Repo actions" });
    expect(within(toolbar).getAllByRole("button")).toHaveLength(1);
    const { menu } = await openMenu();
    expect(menuEntries(menu)).toEqual([
      "View runs for this repo",
      "Open in GitLab",
      "—",
      "Remove repo…",
    ]);
    expect(
      within(menu).getByRole("menuitem", { name: "View runs for this repo" }).getAttribute("href"),
    ).toBe(`/runs?repository=${REPO_PORTAL}`);
  });

  it("opens the repo's GitHub page in a new tab", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderRepos({ repositoryId: REPO_WEB });
    await loadedDetail();
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Open in GitHub" }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/web",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("leaves Remove repo… out for members", async () => {
    rows = [portalRow(), betaRow()];
    details[REPO_BETA] = repoDetail(betaRow());
    renderRepos({ repositoryId: REPO_BETA, user: allOrganizations });
    await loadedDetail();
    const { menu } = await openMenu();
    expect(menuEntries(menu)).toEqual(["View runs for this repo", "Open in GitHub"]);
  });

  it("says when the repo doesn't exist", async () => {
    renderRepos({ repositoryId: REPO_BETA });
    expect(
      await within(detailPane()).findByText(
        "This repo doesn't exist or isn't in your organizations.",
      ),
    ).toBeTruthy();
  });
});

describe("Remove repo…", () => {
  async function openRemove(id = REPO_PORTAL) {
    const result = renderRepos({ repositoryId: id });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    await loadedDetail();
    const user = userEvent.setup();
    await user.click(within(detailPane()).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove repo…" }));
    return { ...result, user, dialog: await screen.findByRole("alertdialog") };
  }

  it("asks to type the full path, describing what removal does", async () => {
    const { dialog, user } = await openRemove();
    expect(
      within(dialog).getByRole("heading", { name: "Remove managed-services/customer-portal?" }),
    ).toBeTruthy();
    expect(within(dialog).getByText(REMOVE_REPO_DESCRIPTION)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Remove repo" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.type(within(dialog).getByRole("textbox"), "customer-portal");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.clear(within(dialog).getByRole("textbox"));
    await user.type(within(dialog).getByRole("textbox"), "managed-services/customer-portal");
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("removes the repo: the row leaves the rail at once, a toast, then /repos", async () => {
    let answer!: (response: Response) => void;
    deleteAnswer = () => new Promise<Response>((resolve) => (answer = resolve));
    const { dialog, user } = await openRemove();
    holdReads = true;
    const before = listRequests().length;
    await user.type(within(dialog).getByRole("textbox"), "managed-services/customer-portal");
    await user.click(within(dialog).getByRole("button", { name: "Remove repo" }));
    // Gone before the server answers, and without a refetch.
    await waitFor(() => expect(railRows()).toHaveLength(1));
    expect(listRequests()).toHaveLength(before);
    expect(badgeTexts(railRows()[0]!)).toEqual(["web", "acme"]);
    const removal = seen.find((request) => request.method === "DELETE")!;
    expect(removal.path).toBe(`/api/ui/repositories/${REPO_PORTAL}`);
    rows = [webRow()];
    act(() => answer(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Removed customer-portal"));
    expect(nav.router.push).toHaveBeenCalledWith("/repos");
  });

  it("adds the API's warning to the toast", async () => {
    deleteAnswer = () => jsonResponse({ ok: true, warning: "Couldn't delete the GitLab webhook." });
    const { dialog, user } = await openRemove();
    await user.type(within(dialog).getByRole("textbox"), "managed-services/customer-portal");
    await user.click(within(dialog).getByRole("button", { name: "Remove repo" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        "Removed customer-portal. Couldn't delete the GitLab webhook.",
        { variant: "warning" },
      ),
    );
    expect(nav.router.push).toHaveBeenCalledWith("/repos");
  });

  it("puts the row back when the removal fails", async () => {
    deleteAnswer = () => jsonResponse({ error: "Only admins can do that." }, 403);
    const { dialog, user } = await openRemove();
    await user.type(within(dialog).getByRole("textbox"), "managed-services/customer-portal");
    await user.click(within(dialog).getByRole("button", { name: "Remove repo" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Only admins can do that.", { variant: "danger" }),
    );
    await waitFor(() => expect(railRows()).toHaveLength(2));
    expect(nav.router.push).not.toHaveBeenCalled();
  });
});

describe("problems", () => {
  const notice = () => within(detailPane()).queryByRole("region", { name: "Problems" });

  function withProblems(problems: RepositoryDetail["status"]["problems"]) {
    const status = { running: 0, problems };
    rows = [portalRow({ status }), webRow()];
    details[REPO_PORTAL] = repoDetail(portalRow({ status }));
  }

  it("shows no notice without problems", async () => {
    renderRepos({ repositoryId: REPO_PORTAL });
    await loadedDetail();
    expect(notice()).toBeNull();
    expect(within(detailPane()).queryByRole("alert")).toBeNull();
  });

  it("lists each problem's message with its action", async () => {
    withProblems([
      {
        code: "webhook",
        message: "The project's webhook is missing.",
        action: {
          type: "post",
          label: "Recreate webhook",
          path: `/api/ui/repositories/${REPO_PORTAL}/webhook`,
        },
      },
      {
        code: "sync_failed",
        message: "Couldn't update this repo's checkout on build-01.",
        action: { type: "post", label: "Retry", path: "/api/ui/jobs/job-1/rerun" },
      },
      {
        code: "no_agent_online",
        message: "No agent online",
        action: { type: "link", label: "Open agent", href: "/fleet/agent-1" },
      },
      { code: "connection", message: "The GitLab token was revoked." },
    ]);
    renderRepos({ repositoryId: REPO_PORTAL });
    await loadedDetail();
    const items = within(notice()!).getAllByRole("listitem");
    expect(
      items.map((item) => item.querySelector(".or-repo-problems__message")!.textContent),
    ).toEqual([
      "The project's webhook is missing.",
      "Couldn't update this repo's checkout on build-01.",
      "No agent online",
      "The GitLab token was revoked.",
    ]);
    expect(within(items[0]!).getByRole("button", { name: "Recreate webhook" })).toBeTruthy();
    expect(within(items[1]!).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(items[2]!).getByRole("link", { name: "Open agent" }).getAttribute("href")).toBe(
      "/fleet/agent-1",
    );
    expect(within(items[3]!).queryByRole("button")).toBeNull();
    expect(within(items[3]!).queryByRole("link")).toBeNull();
  });

  it.each([
    [
      "Recreate webhook",
      "webhook",
      `/api/ui/repositories/${REPO_PORTAL}/webhook`,
      "Webhook recreated",
    ],
    ["Retry", "sync_failed", "/api/ui/jobs/job-1/rerun", "Update retried"],
  ] as const)(
    "%s posts its action and clears the problem at once",
    async (label, code, path, toast) => {
      withProblems([
        { code, message: "Something is wrong.", action: { type: "post", label, path } },
      ]);
      serve({ [`POST ${path}`]: { ok: true } });
      renderRepos({ repositoryId: REPO_PORTAL });
      await loadedDetail();
      await waitFor(() => expect(dot(railRows()[0]!)).not.toBeNull());
      // From here no read answers: the problem can only leave through the cache.
      holdReads = true;
      await userEvent.setup().click(within(notice()!).getByRole("button", { name: label }));
      await waitFor(() => expect(notice()).toBeNull());
      expect(seen.some((request) => request.method === "POST" && request.path === path)).toBe(true);
      // The rail's dot goes too.
      expect(dot(railRows()[0]!)).toBeNull();
      expect(ui.toast).toHaveBeenCalledWith(toast);
    },
  );
});

describe("the section index", () => {
  it("lists Reviews, Coding, Ask, Agents, Rules and Advanced, each with its section and heading", async () => {
    renderRepos({ repositoryId: REPO_PORTAL });
    const article = await loadedDetail();
    const index = within(article).getByRole("navigation", { name: "Sections" });
    const links = within(index).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Reviews", "#reviews"],
      ["Coding", "#coding"],
      ["Ask", "#ask"],
      ["Agents", "#agents"],
      ["Rules", "#rules"],
      ["Advanced", "#advanced"],
    ]);
    expect(links[0]!.getAttribute("aria-current")).toBe("true");
    for (const [id, label] of [
      ["reviews", "Reviews"],
      ["coding", "Coding"],
      ["ask", "Ask"],
      ["agents", "Agents"],
      ["rules", "Rules"],
      ["advanced", "Advanced"],
    ]) {
      const section = article.querySelector<HTMLElement>(`section#${id}`)!;
      expect(within(section).getByRole("heading", { level: 2, name: label })).toBeTruthy();
    }
  });

  it("scrolls to ?section= on load", async () => {
    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this.id);
    });
    renderRepos({ repositoryId: REPO_PORTAL, search: "section=coding" });
    await loadedDetail();
    await waitFor(() => expect(scrolled).toEqual(["coding"]));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Coding" }));
  });

  it("ignores an unknown ?section=", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    renderRepos({ repositoryId: REPO_PORTAL, search: "section=nowhere" });
    await loadedDetail();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("writes ?section= in place when an entry is clicked", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    renderRepos({ repositoryId: REPO_PORTAL });
    const article = await loadedDetail();
    const index = within(article).getByRole("navigation", { name: "Sections" });
    await userEvent.setup().click(within(index).getByRole("link", { name: "Agents" }));
    expect(replace).toHaveBeenCalledTimes(1);
    const url = new URL(String(replace.mock.calls[0]![2]), "http://localhost");
    expect(url.searchParams.get("section")).toBe("agents");
    expect(nav.router.push).not.toHaveBeenCalled();
  });
});

describe("live updates", () => {
  async function connected(live: ReturnType<typeof fakeAbly>) {
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
  }

  const deliver = (live: ReturnType<typeof fakeAbly>, event: Parameters<typeof changeEvent>[1]) =>
    act(() =>
      live
        .current()
        .deliver(`org:${TEST_ORGANIZATION_ID}:changes`, changeEvent(TEST_ORGANIZATION_ID, event)),
    );

  it("refetch the list on a repositories change (a repo added)", async () => {
    const live = fakeAbly();
    renderRepos({ live });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    await connected(live);
    const before = listRequests().length;
    rows = [portalRow(), webRow(), betaRow({ organization: portalRow().organization })];
    deliver(live, { resource: "repository", ids: [REPO_BETA] });
    await waitFor(() => expect(listRequests().length).toBe(before + 1));
    await waitFor(() => expect(railRows()).toHaveLength(3));
  });

  it("refetch the open repo's detail on its repository event, and no other repo's", async () => {
    const live = fakeAbly();
    const { client } = renderRepos({ live, repositoryId: REPO_PORTAL });
    await loadedDetail();
    await connected(live);
    // Another repo's detail sits in the cache (opened earlier).
    const keys = queryKeys(TEST_ORGANIZATION_ID);
    client.setQueryData(keys.repositories.detail(REPO_WEB), details[REPO_WEB]);
    const before = detailRequests(REPO_PORTAL).length;
    details[REPO_PORTAL] = repoDetail(portalRow(), { defaultBranch: "trunk" });
    deliver(live, { resource: "repository", ids: [REPO_PORTAL] });
    await waitFor(() => expect(detailRequests(REPO_PORTAL).length).toBe(before + 1));
    await waitFor(() =>
      expect(badgeTexts(detailPane().querySelector(".or-repo-detail__head")!)).toContain("trunk"),
    );
    expect(client.getQueryState(keys.repositories.detail(REPO_WEB))!.isInvalidated).toBe(false);
    expect(detailRequests(REPO_WEB)).toHaveLength(0);
  });

  it("refetch the list on a run event, so a repo's dot turns mint", async () => {
    const live = fakeAbly();
    renderRepos({ live });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    await connected(live);
    expect(dot(railRows()[0]!)).toBeNull();
    const before = listRequests().length;
    rows = [portalRow({ status: { running: 1, problems: [] } }), webRow()];
    deliver(live, { resource: "run", runId: "44444444-4444-4444-8444-444444444444" });
    await waitFor(() => expect(listRequests().length).toBe(before + 1));
    await waitFor(() => expect(dot(railRows()[0]!)?.getAttribute("aria-label")).toBe("1 running"));
    expect(dot(railRows()[0]!)!.classList.contains("or-dot--run")).toBe(true);
  });

  it("refetch the list and detail on an agent event (an agent going offline)", async () => {
    const live = fakeAbly();
    renderRepos({ live, repositoryId: REPO_PORTAL });
    await loadedDetail();
    await connected(live);
    const lists = listRequests().length;
    const detail = detailRequests(REPO_PORTAL).length;
    deliver(live, { resource: "agent", ids: ["66666666-6666-4666-8666-666666666666"] });
    await waitFor(() => expect(listRequests().length).toBe(lists + 1));
    await waitFor(() => expect(detailRequests(REPO_PORTAL).length).toBe(detail + 1));
  });

  it("show no Live or Updated indicator and no notice of their own", async () => {
    renderRepos({ repositoryId: REPO_PORTAL });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    await loadedDetail();
    const screenText = document.body.textContent!;
    expect(screenText).not.toMatch(/\bLive\b|Updated|Reconnecting|paused/i);
    expect(screen.queryAllByRole("status")).toEqual([]);
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });

  it("set no refetchInterval of their own", async () => {
    const client = createQueryClient();
    renderRepos({ client, repositoryId: REPO_PORTAL });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    await loadedDetail();
    const fallback = client.getDefaultOptions().queries!.refetchInterval;
    const queries = client
      .getQueryCache()
      .findAll({ queryKey: [TEST_ORGANIZATION_ID, "repositories"] });
    // The rail, the detail and the cards' own (the Coding card's match check).
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const query of queries) {
      expect(query.observers.length).toBeGreaterThan(0);
      for (const observer of query.observers) {
        expect(observer.options.refetchInterval).toBe(fallback);
      }
    }
    client.clear();
  });
});
