// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { ShowAdvancedProvider } from "@/components/show-advanced";
import { queryKeys } from "@/lib/api/keys";
import type {
  RepositoryListItem,
  ScmConnectionListRow,
  SelectableRepositories,
} from "@/lib/api/repositories";
import { GITHUB_NOTICES, type GitHubNotice } from "./add-repo-sheet";
import { addRepoKeys } from "./queries";
import { ReposView } from "./repos-view";
import { BETA_ID, portalRow, REPO_PORTAL, repoDetail, webRow } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));
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

const GITHUB_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const GITLAB_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const NEW_GITLAB_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const ADDED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
const GAMMA_ID = "33333333-3333-4333-8333-333333333333";

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

/** "All organizations", admin of Acme and Gamma, member of Beta. */
const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
    { id: GAMMA_ID, name: "Gamma", role: "admin" },
  ],
};

const githubConnection: ScmConnectionListRow = {
  id: GITHUB_ID,
  provider: "github",
  name: "acme",
  host: "github.com",
  health: { state: "connected", problems: [] },
};

function gitlabConnection(
  health: ScmConnectionListRow["health"] = { state: "healthy", problems: [] },
): ScmConnectionListRow {
  return {
    id: GITLAB_ID,
    provider: "gitlab",
    name: "bot @ gitlab.example.com",
    host: "gitlab.example.com",
    health,
  };
}

function listing(overrides: Partial<SelectableRepositories> = {}): SelectableRepositories {
  return {
    account: "acme",
    manageUrl: "https://github.com/settings/installations/42",
    truncated: false,
    repos: [
      {
        id: 1,
        fullPath: "acme/web",
        private: false,
        htmlUrl: "https://github.com/acme/web",
        connected: true,
      },
      {
        id: 2,
        fullPath: "acme/api",
        private: true,
        htmlUrl: "https://github.com/acme/api",
        connected: false,
      },
      {
        id: 3,
        fullPath: "acme/docs",
        private: false,
        htmlUrl: "https://github.com/acme/docs",
        connected: false,
      },
    ],
    ...overrides,
  };
}

const addedRow = (): RepositoryListItem =>
  webRow({
    id: ADDED_ID,
    fullPath: "acme/api",
    name: "api",
    webUrl: "https://github.com/acme/api",
    codingEnabled: false,
    status: { running: 0, problems: [] },
  });

let rows: RepositoryListItem[];
let connections: Record<string, ScmConnectionListRow[]>;
let installPath: string | null;
let listingAnswer: () => Response | Promise<Response>;
let seen: SeenRequest[];
let holdReads: boolean;

const pending = () => new Promise<Response>(() => {});

function serve(extra: Parameters<typeof mockFetch>[0] = {}) {
  seen = mockFetch({
    "GET /api/ui/repositories": () =>
      holdReads ? pending() : jsonResponse({ repositories: rows, truncated: false }),
    [`GET /api/ui/repositories/${REPO_PORTAL}`]: () =>
      holdReads ? pending() : jsonResponse(repoDetail(portalRow())),
    [`GET /api/ui/repositories/${REPO_PORTAL}/rules`]: () =>
      holdReads
        ? pending()
        : jsonResponse({
            repository: {
              id: REPO_PORTAL,
              provider: "gitlab",
              fullPath: "x/y",
              webUrl: "https://x/y",
            },
            rules: [],
          }),
    "GET /api/ui/scm-connections": (request) =>
      jsonResponse({ connections: connections[request.query.get("organization")!] ?? [] }),
    "GET /api/ui/repositories/setup": () =>
      jsonResponse({ githubInstallPath: installPath, defaultGitLabUrl: "https://gitlab.com" }),
    [`GET /api/ui/scm-connections/${GITHUB_ID}/repositories`]: () => listingAnswer(),
    [`GET /api/ui/scm-connections/${GITLAB_ID}/repositories`]: () => listingAnswer(),
    [`GET /api/ui/scm-connections/${NEW_GITLAB_ID}/repositories`]: () => listingAnswer(),
    [`POST /api/ui/scm-connections/${GITHUB_ID}/repositories`]: () =>
      jsonResponse({
        ok: true,
        added: [{ id: ADDED_ID, fullPath: "acme/api" }],
        repositories: [addedRow()],
      }),
    ...extra,
  });
}

function renderRepos(
  options: { user?: SessionUser; search?: string; live?: ReturnType<typeof fakeAbly> } = {},
) {
  const search = options.search ?? "";
  nav.search = new URLSearchParams(search);
  window.history.replaceState(null, "", `/repos${search ? `?${search}` : ""}`);
  const client = createTestQueryClient();
  const view = <ReposView repositoryId={REPO_PORTAL} renderDetail={() => null} />;
  const utils = render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial={false}>
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
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
  return { ...utils, client };
}

const sheet = () => screen.getByRole("dialog", { name: "Add repos" });
const requests = (method: string, path: string) =>
  seen.filter((request) => request.method === method && request.path === path);
// Hidden from the accessibility tree while the (modal) sheet is open.
const railRows = () =>
  within(screen.getByRole("list", { name: "Repos", hidden: true })).queryAllByRole("listitem", {
    hidden: true,
  });

async function openSheet() {
  await waitFor(() => expect(railRows()).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "Add repo" }));
  return sheet();
}

async function openPicker(name = "GitHub acme") {
  await openSheet();
  await userEvent.click(await within(sheet()).findByRole("button", { name }));
  await within(sheet()).findByRole("list", { name: "Repos" });
}

const repoBox = (path: string) =>
  within(sheet()).getByRole("checkbox", { name: new RegExp(path) }) as HTMLInputElement;

beforeEach(() => {
  nav.router.push.mockReset();
  ui.toast.mockReset();
  rows = [portalRow(), webRow()];
  connections = { [TEST_ORGANIZATION_ID]: [githubConnection, gitlabConnection()] };
  installPath = `/repositories/github/install?organization=${TEST_ORGANIZATION_ID}`;
  listingAnswer = () => jsonResponse(listing());
  holdReads = false;
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the add-repo sheet", () => {
  it("opens from Add repo as Add repos, on the active organization's connections", async () => {
    renderRepos();
    await openSheet();
    expect(within(sheet()).queryByLabelText("Organization")).toBeNull();
    const list = await within(sheet()).findByRole("list", { name: "Connections" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => within(item).getAllByRole("button")[0]!.textContent)).toEqual([
      "GitHubacmegithub.com",
      "GitLabbot @ gitlab.example.comgitlab.example.com",
    ]);
    expect(within(list).getByRole("button", { name: "GitHub acme" })).toBeTruthy();
    // Each with its brand mark and health.
    expect(within(items[0]!).getByRole("img", { name: "GitHub" })).toBeTruthy();
    expect(within(items[0]!).getByText("Connected")).toBeTruthy();
    expect(within(items[1]!).getByRole("img", { name: "GitLab" })).toBeTruthy();
    expect(within(items[1]!).getByText("Healthy")).toBeTruthy();
    expect(
      requests("GET", "/api/ui/scm-connections").map((request) =>
        request.query.get("organization"),
      ),
    ).toEqual([TEST_ORGANIZATION_ID]);
    // Connect GitHub goes to the organization's install route.
    expect(within(sheet()).getByRole("link", { name: "Connect GitHub" }).getAttribute("href")).toBe(
      installPath,
    );
  });

  it("shows each connection's health: expiring, needs attention with its problems, not checked", async () => {
    connections[TEST_ORGANIZATION_ID] = [
      {
        ...gitlabConnection(),
        id: "e",
        name: "expiring",
        health: { state: "expiring", expiresAt: "2026-11-02", problems: [] },
      },
      {
        ...gitlabConnection(),
        id: "n",
        name: "broken",
        health: {
          state: "needs_attention",
          problems: [{ code: "token_invalid", sentence: "GitLab rejects the bot token." }],
        },
      },
      {
        ...gitlabConnection(),
        id: "u",
        name: "new",
        health: { state: "not_checked", problems: [] },
      },
    ];
    renderRepos();
    await openSheet();
    const list = await within(sheet()).findByRole("list", { name: "Connections" });
    const text = within(list)
      .getAllByRole("listitem")
      .filter((item) => item.parentElement === list)
      .map((item) => item.querySelector(".or-connection-health")!.textContent);
    expect(text).toEqual([
      "Expires Nov 2",
      "Needs attentionGitLab rejects the bot token.",
      "Not checked yet",
    ]);
  });

  it("refetches the connections on a connection event", async () => {
    const live = fakeAbly();
    renderRepos({ live });
    await openSheet();
    await within(sheet()).findByRole("list", { name: "Connections" });
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const before = requests("GET", "/api/ui/scm-connections").length;
    connections[TEST_ORGANIZATION_ID] = [
      githubConnection,
      gitlabConnection({
        state: "needs_attention",
        problems: [{ code: "token_invalid", sentence: "GitLab rejects the bot token." }],
      }),
    ];
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "connection", ids: [GITLAB_ID] }),
        ),
    );
    await waitFor(() => expect(requests("GET", "/api/ui/scm-connections").length).toBe(before + 1));
    expect(await within(sheet()).findByText("Needs attention")).toBeTruthy();
  });

  it("recreates a repo's webhook and drops the problem at once", async () => {
    const problem = {
      code: "webhook_missing",
      sentence: "managed-services/customer-portal has no Omniralph webhook.",
      repositoryId: REPO_PORTAL,
    };
    connections[TEST_ORGANIZATION_ID] = [
      gitlabConnection({ state: "needs_attention", expiresAt: "2027-06-01", problems: [problem] }),
    ];
    rows = [
      portalRow({
        status: {
          running: 0,
          problems: [{ code: "webhook", message: "Webhook missing" }],
        },
      }),
      webRow(),
    ];
    serve({
      [`POST /api/ui/repositories/${REPO_PORTAL}/webhook`]: () => jsonResponse({ ok: true }),
    });
    renderRepos();
    await openSheet();
    // From here on, what shows comes from the cache.
    holdReads = true;
    await userEvent.click(await within(sheet()).findByRole("button", { name: "Recreate webhook" }));
    await waitFor(() => expect(within(sheet()).getByText("Healthy")).toBeTruthy());
    expect(within(sheet()).queryByText(problem.sentence)).toBeNull();
    expect(requests("POST", `/api/ui/repositories/${REPO_PORTAL}/webhook`)).toHaveLength(1);
    // The rail row loses its webhook problem too.
    expect(railRows()[0]!.querySelector(".or-dot")).toBeNull();
  });

  it("says why Connect GitHub is disabled when the GitHub App isn't configured", async () => {
    installPath = null;
    renderRepos();
    await openSheet();
    const button = await within(sheet()).findByRole("button", { name: "Connect GitHub" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(within(sheet()).queryByRole("link", { name: "Connect GitHub" })).toBeNull();
  });

  it("connects GitLab, adds the connection from the response and opens its picker", async () => {
    const created: ScmConnectionListRow = {
      ...gitlabConnection({ state: "not_checked", problems: [] }),
      id: NEW_GITLAB_ID,
      name: "bot @ git.example.org",
      host: "git.example.org",
    };
    serve({
      "POST /api/ui/gitlab-connections": () =>
        jsonResponse({ ok: true, connectionId: NEW_GITLAB_ID, connection: created }),
    });
    const { client } = renderRepos();
    await openSheet();
    await within(sheet()).findByRole("list", { name: "Connections" });
    await userEvent.click(within(sheet()).getByRole("button", { name: "Connect GitLab" }));
    const form = await within(sheet()).findByRole("form", { name: "Connect GitLab" });
    expect((within(form).getByLabelText("GitLab URL") as HTMLInputElement).value).toBe(
      "https://gitlab.com",
    );
    await userEvent.type(within(form).getByLabelText("Access token"), "glpat-x");
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));

    await within(sheet()).findByRole("list", { name: "Repos" });
    expect(requests("POST", "/api/ui/gitlab-connections")[0]!.body).toEqual({
      baseUrl: "https://gitlab.com",
      token: "glpat-x",
      organizationId: TEST_ORGANIZATION_ID,
    });
    expect(requests("GET", `/api/ui/scm-connections/${NEW_GITLAB_ID}/repositories`)).toHaveLength(
      1,
    );
    // The connection list has it from the response, before any refetch.
    const cached = client.getQueryData<{ connections: ScmConnectionListRow[] }>(
      addRepoKeys(queryKeys(TEST_ORGANIZATION_ID)).connections(TEST_ORGANIZATION_ID),
    );
    expect(cached?.connections.map((connection) => connection.id)).toContain(NEW_GITLAB_ID);
    connections[TEST_ORGANIZATION_ID]!.push(created);
    await userEvent.click(within(sheet()).getByRole("button", { name: "Connections" }));
    expect(
      await within(sheet()).findByRole("button", { name: /bot @ git\.example\.org/ }),
    ).toBeTruthy();
  });

  it("shows the server's message when connecting GitLab fails", async () => {
    serve({
      "POST /api/ui/gitlab-connections": () =>
        jsonResponse({ error: "Enter the bot's access token." }, 400),
    });
    renderRepos();
    await openSheet();
    await within(sheet()).findByRole("list", { name: "Connections" });
    await userEvent.click(within(sheet()).getByRole("button", { name: "Connect GitLab" }));
    await userEvent.click(within(sheet()).getByRole("button", { name: "Connect" }));
    expect((await within(sheet()).findByRole("alert")).textContent).toBe(
      "Enter the bot's access token.",
    );
  });

  it("asks for the organization under All organizations, listing only those the user is an admin of", async () => {
    connections[GAMMA_ID] = [{ ...githubConnection, id: "g", name: "gamma-gh" }];
    renderRepos({ user: allOrganizations });
    await openSheet();
    const select = within(sheet()).getByLabelText("Organization") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Acme", "Gamma"]);
    expect(select.value).toBe(TEST_ORGANIZATION_ID);
    await within(sheet()).findByRole("button", { name: "GitHub acme" });

    await userEvent.selectOptions(select, GAMMA_ID);
    expect(await within(sheet()).findByRole("button", { name: "GitHub gamma-gh" })).toBeTruthy();
    expect(requests("GET", "/api/ui/repositories/setup").at(-1)!.query.get("organization")).toBe(
      GAMMA_ID,
    );
  });
});

describe("the picker", () => {
  it("lists the connection's repos once, with Private and Added, and refreshes on request", async () => {
    const { client } = renderRepos();
    await openPicker();
    const listings = () => requests("GET", `/api/ui/scm-connections/${GITHUB_ID}/repositories`);
    expect(listings()).toHaveLength(1);
    expect(listings()[0]!.query.get("provider")).toBe("github");
    expect(listings()[0]!.query.get("organization")).toBe(TEST_ORGANIZATION_ID);
    // From the code host: never polled or refetched on focus.
    const query = client.getQueryCache().find({
      queryKey: addRepoKeys(queryKeys(TEST_ORGANIZATION_ID)).listing(
        GITHUB_ID,
        TEST_ORGANIZATION_ID,
      ),
    });
    expect(query?.options).toMatchObject({ refetchInterval: false, refetchOnWindowFocus: false });

    // Connected: ticked, disabled and marked Added.
    const web = repoBox("acme/web");
    expect([web.checked, web.disabled]).toEqual([true, true]);
    const webRowItem = web.closest("li")!;
    expect(within(webRowItem).getByText("Added")).toBeTruthy();
    expect(within(webRowItem).queryByText("Private")).toBeNull();
    const api = repoBox("acme/api");
    expect([api.checked, api.disabled]).toEqual([false, false]);
    expect(within(api.closest("li")!).getByText("Private")).toBeTruthy();
    expect(
      within(sheet()).getByRole("link", { name: "Manage access on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/settings/installations/42");
    expect(within(sheet()).queryByText(/Showing the first/)).toBeNull();
    const add = within(sheet()).getByRole("button", { name: "Add 0 repos" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.className).toContain("or-btn--solid");

    await userEvent.click(within(sheet()).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listings()).toHaveLength(2));
  });

  it("filters the repos by path", async () => {
    renderRepos();
    await openPicker();
    await userEvent.type(within(sheet()).getByLabelText("Filter repos"), "DOC");
    expect(
      within(sheet())
        .getAllByRole("checkbox")
        .map((box) => box.closest("li")!.querySelector(".or-ref__text")!.textContent),
    ).toEqual(["acme/docs"]);
    // A ticked repo stays ticked while filtered out.
    await userEvent.click(repoBox("acme/docs"));
    await userEvent.clear(within(sheet()).getByLabelText("Filter repos"));
    expect(repoBox("acme/docs").checked).toBe(true);
    await userEvent.type(within(sheet()).getByLabelText("Filter repos"), "zzz");
    expect(within(sheet()).getByText("No repos match the filter.")).toBeTruthy();
  });

  it("says when the listing is cut off, and leaves out Manage access without a manageUrl", async () => {
    listingAnswer = () => jsonResponse(listing({ truncated: true, manageUrl: null }));
    renderRepos();
    await openPicker("GitLab bot @ gitlab.example.com");
    expect(within(sheet()).getByText("Showing the first 3 repos.")).toBeTruthy();
    expect(within(sheet()).queryByRole("link", { name: "Manage access on GitHub" })).toBeNull();
    expect(
      requests("GET", `/api/ui/scm-connections/${GITLAB_ID}/repositories`)[0]!.query.get(
        "provider",
      ),
    ).toBe("gitlab");
  });

  it("shows the code host's message in an alert when listing fails, and retries", async () => {
    let fail = true;
    listingAnswer = () =>
      fail
        ? jsonResponse({ error: "fetch failed", code: "listing_failed" }, 502)
        : jsonResponse(listing());
    renderRepos();
    await openSheet();
    await userEvent.click(await within(sheet()).findByRole("button", { name: "GitHub acme" }));
    const alert = await within(sheet()).findByRole("alert");
    expect(within(alert).getByText("GitHub couldn't list the repos")).toBeTruthy();
    expect(within(alert).getByText("fetch failed")).toBeTruthy();
    fail = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(sheet()).findByRole("list", { name: "Repos" })).toBeTruthy();
    expect(within(sheet()).queryByRole("alert")).toBeNull();
  });

  it("adds the ticked repos in one request, shows them in the rail without a refetch and opens the first", async () => {
    renderRepos();
    await openPicker();
    await userEvent.click(repoBox("acme/api"));
    await userEvent.click(repoBox("acme/docs"));
    await userEvent.click(repoBox("acme/docs"));
    const lists = requests("GET", "/api/ui/repositories").length;
    holdReads = true;
    await userEvent.click(within(sheet()).getByRole("button", { name: "Add 1 repo" }));

    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith(`/repos/${ADDED_ID}`));
    const posts = requests("POST", `/api/ui/scm-connections/${GITHUB_ID}/repositories`);
    expect(posts.map((request) => request.body)).toEqual([
      { provider: "github", ids: [2], organizationId: TEST_ORGANIZATION_ID },
    ]);
    expect(ui.toast).toHaveBeenCalledWith("Added 1 repo");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add repos" })).toBeNull());
    // The new row, from the response, in rail order; no list refetch.
    await waitFor(() => expect(railRows()).toHaveLength(3));
    expect(railRows().map((row) => row.querySelector(".or-ref__text")!.textContent)).toEqual([
      "api",
      "web",
      "customer-portal",
    ]);
    expect(requests("GET", "/api/ui/repositories")).toHaveLength(lists);
  });
});

describe("opening from a link", () => {
  it("opens /repos?add=github&connection={id} on that connection's picker and drops the parameters", async () => {
    renderRepos({ search: `add=github&connection=${GITHUB_ID}` });
    expect(await within(sheet()).findByRole("list", { name: "Repos" })).toBeTruthy();
    expect(within(sheet()).getByRole("heading", { name: /acme/ })).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/repos");
  });

  it("opens /repos?add=gitlab&connection={id} on a GitLab picker", async () => {
    renderRepos({ search: `add=gitlab&connection=${GITLAB_ID}&section=coding` });
    expect(await within(sheet()).findByRole("list", { name: "Repos" })).toBeTruthy();
    expect(
      requests("GET", `/api/ui/scm-connections/${GITLAB_ID}/repositories`)[0]!.query.get(
        "provider",
      ),
    ).toBe("gitlab");
    // Only the sheet's parameters go.
    expect(window.location.search).toBe("?section=coding");
  });

  it("finds the connection's organization under All organizations", async () => {
    connections[GAMMA_ID] = [{ ...githubConnection, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }];
    serve({
      "GET /api/ui/scm-connections/dddddddd-dddd-4ddd-8ddd-dddddddddddd/repositories": () =>
        jsonResponse(listing()),
    });
    renderRepos({
      user: allOrganizations,
      search: "add=github&connection=dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    expect(await within(sheet()).findByRole("list", { name: "Repos" })).toBeTruthy();
    expect((within(sheet()).getByLabelText("Organization") as HTMLSelectElement).value).toBe(
      GAMMA_ID,
    );
    expect(
      requests(
        "GET",
        "/api/ui/scm-connections/dddddddd-dddd-4ddd-8ddd-dddddddddddd/repositories",
      )[0]!.query.get("organization"),
    ).toBe(GAMMA_ID);
  });

  it.each(Object.keys(GITHUB_NOTICES) as GitHubNotice[])(
    "opens /repos?github=%s with its message",
    async (status) => {
      renderRepos({ search: `github=${status}` });
      const alert = await within(sheet()).findByRole("alert");
      expect(alert.textContent).toBe(
        `${GITHUB_NOTICES[status].title}${GITHUB_NOTICES[status].description}`,
      );
      expect(window.location.search).toBe("");
      // The connections are there to try again.
      expect(await within(sheet()).findByRole("list", { name: "Connections" })).toBeTruthy();
    },
  );

  it("starts at the connections when opened again with Add repo", async () => {
    renderRepos({ search: `add=github&connection=${GITHUB_ID}` });
    await within(sheet()).findByRole("list", { name: "Repos" });
    await userEvent.click(within(sheet()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Add repo" }));
    expect(await within(sheet()).findByRole("list", { name: "Connections" })).toBeTruthy();
  });

  it("never opens for members, and members never see Add repo", async () => {
    renderRepos({ user: member, search: "github=error" });
    await waitFor(() => expect(railRows()).toHaveLength(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add repo" })).toBeNull();
    expect(requests("GET", "/api/ui/scm-connections")).toHaveLength(0);
  });
});
