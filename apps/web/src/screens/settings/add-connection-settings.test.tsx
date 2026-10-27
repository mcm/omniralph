// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_NOT_CONFIGURED } from "@/components/connect-github-button";
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
import { UnsavedChangesProvider } from "@/components/unsaved-changes";
import type { Connection } from "@/lib/api/connections";
import { CONNECT_NOTICE_TEXT } from "@/lib/connections/connect-notices";
import {
  ADD_CONNECTION_MEMBER,
  AddConnectionSettings,
  INSTALL_GITHUB_APP,
  PROVIDER_DESCRIPTIONS,
} from "./add-connection-settings";
import { ConnectionSettings } from "./connection-settings";
import { SettingsLayoutView } from "./settings-layout-view";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  pathname: "/settings/connections/new",
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const LINEAR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NEW_GITLAB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INSTALL_PATH = "/api/github/install?organization=org-1";

function linear(): Connection {
  return {
    provider: "linear",
    id: LINEAR_ID,
    name: "Acme",
    host: null,
    account: "Acme",
    health: { state: "connected", problems: [] },
    reposUsing: 0,
    usedAs: "tracker",
    failedDeliveries: 0,
    linkedAccounts: null,
    instanceUrl: null,
    installationUrl: null,
    history: null,
  };
}

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

let connections: Connection[];
let installPath: string | null;
let seen: SeenRequest[];
/** While set, connection list reads never answer: the view shows only what the cache holds. */
let holdList: boolean;
let connectGitLab: () => Response;

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  nav.pathname = "/settings/connections/new";
  nav.search = new URLSearchParams();
  connections = [];
  installPath = INSTALL_PATH;
  holdList = false;
  connectGitLab = () =>
    jsonResponse({
      ok: true,
      connectionId: NEW_GITLAB_ID,
      connection: {
        id: NEW_GITLAB_ID,
        provider: "gitlab",
        name: "om @ gitlab.example.org",
        host: "gitlab.example.org",
        health: { state: "healthy", problems: [] },
      },
    });
  seen = mockFetch({
    "GET /api/ui/connections": () =>
      holdList ? new Promise<Response>(() => {}) : jsonResponse({ connections }),
    "GET /api/ui/nav-indicators": {
      fleet: { offline: 0, updateFailed: 0 },
      settings: { failedDeliveries: 0, byConnection: [] },
    },
    "GET /api/ui/repositories/setup": () =>
      jsonResponse({ githubInstallPath: installPath, defaultGitLabUrl: "https://gitlab.com" }),
    "POST /api/ui/gitlab-connections": () => connectGitLab(),
    [`GET /api/ui/connections/linear/${LINEAR_ID}/deliveries`]: {
      deliveries: [],
      nextCursor: null,
    },
    [`GET /api/ui/trackers/${LINEAR_ID}/state-mapping`]: () => new Promise<Response>(() => {}),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage(
  options: {
    user?: SessionUser;
    live?: ReturnType<typeof fakeAbly>;
    children?: React.ReactNode;
  } = {},
) {
  const client = createTestQueryClient();
  const page = (
    <SettingsLayoutView>{options.children ?? <AddConnectionSettings />}</SettingsLayoutView>
  );
  render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial={false}>
        <QueryClientProvider client={client}>
          <UiProvider linkComponent={TestLink}>
            <UnsavedChangesProvider>
              {options.live ? (
                <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
                  {page}
                </LiveProvider>
              ) : (
                page
              )}
            </UnsavedChangesProvider>
          </UiProvider>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
  return { client };
}

const card = (name: string) => screen.findByRole("region", { name });
const sectionNav = () => screen.getByRole("navigation", { name: "Settings" });
const requests = (method: string, pathname: string) =>
  seen.filter((request) => request.method === method && request.path === pathname);

describe("provider cards", () => {
  it("shows one card per provider with its mark and what it does", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Add connection" })).toBeTruthy();
    for (const [name, provider] of [
      ["GitHub", "github"],
      ["GitLab", "gitlab"],
      ["Linear", "linear"],
      ["Slack", "slack"],
      ["Discord", "discord"],
    ] as const) {
      const region = await card(name);
      expect(within(region).getByText(PROVIDER_DESCRIPTIONS[provider])).toBeTruthy();
      const mark = region.querySelector(".or-add-connection__mark");
      expect(mark?.getAttribute("aria-hidden")).toBe("true");
      expect(mark?.querySelector(".or-brand-mark")).not.toBeNull();
    }
    expect(PROVIDER_DESCRIPTIONS.github).toBe("Reviews pull requests and builds in GitHub repos.");
    expect(PROVIDER_DESCRIPTIONS.linear).toBe("Picks up work items delegated to Omniralph.");
    expect(PROVIDER_DESCRIPTIONS.slack).toBe("Answers questions and starts work from Slack.");
  });

  it("GitHub: installs the GitHub App through the organization's install path", async () => {
    renderPage();
    const link = await within(await card("GitHub")).findByRole("link", {
      name: INSTALL_GITHUB_APP,
    });
    expect(link.getAttribute("href")).toBe(INSTALL_PATH);
    expect(requests("GET", "/api/ui/repositories/setup")[0]!.query.get("organization")).toBe(
      TEST_ORGANIZATION_ID,
    );
  });

  it("GitHub: disabled with the reason when the GitHub App isn't configured", async () => {
    installPath = null;
    renderPage();
    const region = await card("GitHub");
    await waitFor(() =>
      expect(
        within(region)
          .getByRole("button", { name: INSTALL_GITHUB_APP })
          .getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    await userEvent.hover(within(region).getByRole("button", { name: INSTALL_GITHUB_APP }));
    expect((await screen.findAllByText(GITHUB_NOT_CONFIGURED)).length).toBeGreaterThan(0);
  });

  it.each([
    ["Linear", "/api/integrations/linear/connect"],
    ["Slack", "/api/integrations/slack/connect"],
    ["Discord", "/api/integrations/discord/connect"],
  ])("%s: Connect goes to its connect route", async (name, href) => {
    renderPage();
    const region = await card(name);
    await waitFor(() => expect(requests("GET", "/api/ui/connections")).toHaveLength(1));
    expect(within(region).getByRole("link", { name: "Connect" }).getAttribute("href")).toBe(href);
  });

  it("Linear: reads Connected, disabled, when the organization already has it", async () => {
    connections = [linear()];
    renderPage();
    const region = await card("Linear");
    const button = await within(region).findByRole("button", { name: "Connected" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(within(region).queryByRole("link", { name: "Connect" })).toBeNull();
    // Slack and Discord connect more than one workspace.
    expect(within(await card("Slack")).getByRole("link", { name: "Connect" })).toBeTruthy();
  });

  it("members are asked to find an admin, and see no provider", async () => {
    renderPage({ user: member });
    expect(await screen.findByRole("heading", { name: ADD_CONNECTION_MEMBER })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "GitHub" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
    expect(requests("GET", "/api/ui/repositories/setup")).toHaveLength(0);
  });
});

describe("GitLab sheet", () => {
  async function openSheet() {
    renderPage();
    const button = await within(await card("GitLab")).findByRole("button", { name: "Connect" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Connect GitLab" });
    return within(dialog).getByRole("form", { name: "Connect GitLab" });
  }

  it("connects GitLab and opens the new connection, listed before any refetch", async () => {
    const form = await openSheet();
    expect((within(form).getByLabelText("GitLab URL") as HTMLInputElement).value).toBe(
      "https://gitlab.com",
    );
    await userEvent.type(within(form).getByLabelText("Access token"), "glpat-x");
    holdList = true;
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(nav.router.push).toHaveBeenCalledWith(`/settings/connections/gitlab/${NEW_GITLAB_ID}`),
    );
    expect(requests("POST", "/api/ui/gitlab-connections")[0]!.body).toEqual({
      baseUrl: "https://gitlab.com",
      token: "glpat-x",
      organizationId: TEST_ORGANIZATION_ID,
    });
    expect(ui.toast.mock.calls.map(([message]) => message)).toEqual(["GitLab connected"]);
    // The section nav lists it from the response while the list's refetch is held.
    expect(within(sectionNav()).getByRole("link", { name: "GitLab" }).getAttribute("href")).toBe(
      `/settings/connections/gitlab/${NEW_GITLAB_ID}`,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the server's validation error and stays open", async () => {
    connectGitLab = () => jsonResponse({ error: "GitLab rejected the access token." }, 400);
    const form = await openSheet();
    await userEvent.type(within(form).getByLabelText("Access token"), "glpat-bad");
    await userEvent.click(within(form).getByRole("button", { name: "Connect" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "GitLab rejected the access token.",
    );
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Connect GitLab" })).toBeTruthy();
    // The page behind the modal sheet is hidden from the accessibility tree meanwhile.
    const navBehind = screen.getByRole("navigation", { name: "Settings", hidden: true });
    expect(within(navBehind).queryByRole("link", { name: "GitLab", hidden: true })).toBeNull();
  });
});

describe("live updates", () => {
  it("a connection made in another tab shows in the nav and flips Linear to Connected", async () => {
    const live = fakeAbly();
    renderPage({ live });
    const region = await card("Linear");
    expect(await within(region).findByRole("link", { name: "Connect" })).toBeTruthy();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    connections = [linear()];
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "connection", ids: [LINEAR_ID] }),
        ),
    );
    expect(await within(region).findByRole("button", { name: "Connected" })).toBeTruthy();
    expect(within(sectionNav()).getByRole("link", { name: "Linear" }).getAttribute("href")).toBe(
      `/settings/connections/linear/${LINEAR_ID}`,
    );
  });
});

describe("connect notices", () => {
  it("lands on the new connection with a success toast and drops the parameter", async () => {
    connections = [linear()];
    nav.pathname = `/settings/connections/linear/${LINEAR_ID}`;
    nav.search = new URLSearchParams("linear=connected");
    renderPage({ children: <ConnectionSettings provider="linear" connectionId={LINEAR_ID} /> });
    await waitFor(() => expect(ui.toast).toHaveBeenCalledTimes(1));
    const { title, description } = CONNECT_NOTICE_TEXT.linear.connected;
    expect(ui.toast).toHaveBeenCalledWith(`${title}. ${description}`, { variant: "success" });
    expect(nav.router.replace).toHaveBeenCalledWith(`/settings/connections/linear/${LINEAR_ID}`, {
      scroll: false,
    });
  });

  it.each([
    ["slack", "denied"],
    ["discord", "other_organization"],
    ["linear", "not_configured"],
    ["slack", "invalid_state"],
  ] as const)("%s=%s on Add connection: a danger toast", async (provider, code) => {
    nav.search = new URLSearchParams(`${provider}=${code}&tab=1`);
    renderPage();
    await waitFor(() => expect(ui.toast).toHaveBeenCalledTimes(1));
    const { title, description } = CONNECT_NOTICE_TEXT[provider][code];
    expect(ui.toast).toHaveBeenCalledWith(`${title}. ${description}`, { variant: "danger" });
    // Other parameters stay.
    expect(nav.router.replace).toHaveBeenCalledWith("/settings/connections/new?tab=1", {
      scroll: false,
    });
  });

  it("drops an unknown notice without a toast, and shows nothing without one", async () => {
    nav.search = new URLSearchParams("slack=bogus");
    renderPage();
    await waitFor(() =>
      expect(nav.router.replace).toHaveBeenCalledWith("/settings/connections/new", {
        scroll: false,
      }),
    );
    expect(ui.toast).not.toHaveBeenCalled();

    cleanup();
    nav.router.replace.mockReset();
    nav.search = new URLSearchParams();
    renderPage();
    await card("GitHub");
    expect(ui.toast).not.toHaveBeenCalled();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });
});

describe("layout", () => {
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
  const detailPane = () => screen.getByRole("region", { name: "Setting" });

  it("phone: the page alone with a back link to Settings, every card in it", async () => {
    renderPage();
    resize(390);
    expect(document.querySelector(".or-split")!.getAttribute("data-view")).toBe("detail");
    const back = within(detailPane()).getByRole("link", { name: "Settings" });
    expect(back.getAttribute("href")).toBe("/settings");
    for (const name of ["GitHub", "GitLab", "Linear", "Slack", "Discord"]) {
      expect(within(detailPane()).getByRole("region", { name })).toBeTruthy();
    }
  });

  it("desktop: beside the section nav, Add connection current", async () => {
    renderPage();
    resize(1200);
    expect(within(detailPane()).getByRole("heading", { name: "Add connection" })).toBeTruthy();
    expect(
      within(sectionNav())
        .getByRole("link", { name: "Add connection" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});
