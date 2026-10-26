// @vitest-environment jsdom
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
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
import { ShowAdvancedProvider, useShowAdvanced } from "@/components/show-advanced";
import type { Connection } from "@/lib/api/connections";
import ChatOverridesSettingsPage from "@/app/(app)/settings/advanced/chat/page";
import PlaybooksSettingsPage from "@/app/(app)/settings/advanced/playbooks/page";
import RoutingRulesSettingsPage from "@/app/(app)/settings/advanced/routing/page";
import GeneralSettingsPage from "@/app/(app)/settings/general/page";
import { SettingsLayoutView } from "./settings-layout-view";
import { organizationSettings } from "./test-fixtures";

const nav = vi.hoisted(() => ({ pathname: "/settings", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const preference = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: preference.save }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const BETA_ID = "22222222-2222-4222-8222-222222222222";
const GITHUB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GITLAB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GITLAB_OTHER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINEAR_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SLACK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const github: Connection = {
  provider: "github",
  id: GITHUB_ID,
  name: "acme-corp",
  host: "github.com",
  account: "acme-corp",
};
const gitlab: Connection = {
  provider: "gitlab",
  id: GITLAB_ID,
  name: "om @ gitlab.netbuilder.io",
  host: "gitlab.netbuilder.io",
  account: "om",
};
const otherGitLab: Connection = {
  provider: "gitlab",
  id: GITLAB_OTHER_ID,
  name: "om @ gitlab.example.com",
  host: "gitlab.example.com",
  account: "om",
};
const linear: Connection = {
  provider: "linear",
  id: LINEAR_ID,
  name: "Acme",
  host: null,
  account: "Acme",
};
const slack: Connection = {
  provider: "slack",
  id: SLACK_ID,
  name: "Acme Slack",
  host: null,
  account: "Acme Slack",
};

let connections: Connection[];
let seen: SeenRequest[];

beforeEach(() => {
  nav.pathname = "/settings";
  preference.save.mockReset();
  preference.save.mockResolvedValue({ ok: true });
  connections = [github, gitlab, linear];
  seen = mockFetch({
    "GET /api/ui/connections": () => jsonResponse({ connections }),
    "GET /api/ui/organization": () => jsonResponse(organizationSettings()),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A switch standing in for Profile & theme's "Show advanced settings" toggle. */
function AdvancedToggle() {
  const [showAdvanced, setShowAdvanced] = useShowAdvanced();
  return (
    <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}>
      Toggle advanced
    </button>
  );
}

function renderSettings(
  options: {
    pathname?: string;
    page?: React.ReactNode;
    showAdvanced?: boolean;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
  } = {},
) {
  if (options.pathname) nav.pathname = options.pathname;
  const client = options.client ?? createTestQueryClient();
  const view = (
    <>
      <AdvancedToggle />
      <SettingsLayoutView>{options.page ?? <GeneralSettingsPage />}</SettingsLayoutView>
    </>
  );
  const utils = render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial={options.showAdvanced ?? false}>
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

const sectionNav = () => screen.getByRole("navigation", { name: "Settings" });
const group = (name: string) => within(sectionNav()).queryByRole("list", { name });
const entries = (name: string) =>
  within(group(name)!)
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);
const connectionRequests = () =>
  seen.filter((request) => request.method === "GET" && request.path === "/api/ui/connections");

describe("the section nav", () => {
  it("titles Settings with the active organization's badge", async () => {
    renderSettings();
    expect(within(sectionNav()).getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    const badge = sectionNav().querySelector(".or-subnav__badge")!;
    expect(badge.textContent).toContain("Acme");
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
  });

  it("lists Organization, Connections and You, without Advanced while the preference is off", async () => {
    renderSettings();
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    expect(
      within(sectionNav())
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Organization", "Connections", "You"]);
    expect(entries("Organization")).toEqual([
      ["General", "/settings/general"],
      ["Members", "/settings/members"],
    ]);
    expect(entries("Connections")).toEqual([
      ["GitHub", `/settings/connections/github/${GITHUB_ID}`],
      ["GitLab", `/settings/connections/gitlab/${GITLAB_ID}`],
      ["Linear", `/settings/connections/linear/${LINEAR_ID}`],
      ["Add connection", "/settings/connections/new"],
    ]);
    expect(entries("You")).toEqual([
      ["Profile & theme", "/settings/profile"],
      ["Linked chat accounts", "/settings/linked-accounts"],
    ]);
    expect(group("Advanced")).toBeNull();
  });

  it("lists Advanced when the user shows advanced settings", async () => {
    renderSettings({ showAdvanced: true });
    await waitFor(() => expect(group("Advanced")).not.toBeNull());
    expect(entries("Advanced")).toEqual([
      ["Routing rules", "/settings/advanced/routing"],
      ["Playbooks", "/settings/advanced/playbooks"],
      ["Chat channel overrides", "/settings/advanced/chat"],
    ]);
  });

  it("adds each connection's name when the organization has two of its provider", async () => {
    connections = [github, otherGitLab, gitlab, slack];
    renderSettings();
    await waitFor(() => expect(entries("Connections")).toHaveLength(5));
    expect(entries("Connections").map(([label]) => label)).toEqual([
      "GitHub",
      "GitLab · om @ gitlab.example.com",
      "GitLab · om @ gitlab.netbuilder.io",
      "Slack",
      "Add connection",
    ]);
  });

  it("offers Add connection before the connections load and when there are none", async () => {
    connections = [];
    renderSettings();
    expect(entries("Connections")).toEqual([["Add connection", "/settings/connections/new"]]);
    await waitFor(() => expect(connectionRequests()).toHaveLength(1));
    expect(entries("Connections")).toEqual([["Add connection", "/settings/connections/new"]]);
  });

  it("marks the open page's entry current, also under it", async () => {
    renderSettings({ pathname: `/settings/connections/gitlab/${GITLAB_ID}` });
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    const current = () =>
      within(sectionNav())
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent);
    expect(current()).toEqual(["GitLab"]);
  });

  it("shows members the same nav", async () => {
    const member: SessionUser = {
      ...testUser,
      role: "member",
      organizations: [{ ...testUser.organization, role: "member" }],
    };
    renderSettings({ user: member });
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    expect(entries("Organization")).toHaveLength(2);
  });
});

describe("the Advanced group", () => {
  it("shows and hides at once when the preference changes", async () => {
    // The save never answers: the nav follows the preference without waiting for it.
    preference.save.mockReturnValue(new Promise(() => {}));
    renderSettings();
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    expect(group("Advanced")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Toggle advanced" }));
    expect(entries("Advanced").map(([label]) => label)).toEqual([
      "Routing rules",
      "Playbooks",
      "Chat channel overrides",
    ]);
    expect(preference.save).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Toggle advanced" }));
    expect(group("Advanced")).toBeNull();
    expect(preference.save).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ["/settings/advanced/routing", "Routing rules", <RoutingRulesSettingsPage key="r" />],
    ["/settings/advanced/playbooks", "Playbooks", <PlaybooksSettingsPage key="p" />],
    ["/settings/advanced/chat", "Chat channel overrides", <ChatOverridesSettingsPage key="c" />],
  ])("renders %s by URL while the preference is off", async (pathname, title, page) => {
    const { container } = renderSettings({ pathname, page });
    const detail = screen.getByRole("region", { name: "Setting" });
    expect(within(detail).getByRole("heading", { level: 2, name: title })).toBeTruthy();
    expect(container.querySelector(".or-split")!.getAttribute("data-view")).toBe("detail");
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    expect(group("Advanced")).toBeNull();
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
  const detailPane = () => screen.getByRole("region", { name: "Setting" });
  const split = (container: HTMLElement) => container.querySelector<HTMLElement>(".or-split")!;

  it("is a SplitView with the nav as its list pane", () => {
    const { container } = renderSettings();
    expect(split(container).classList.contains("or-settings")).toBe(true);
    const list = screen.getByRole("region", { name: "Settings sections" });
    expect(within(list).getByRole("navigation", { name: "Settings" })).toBeTruthy();
    expect(split(container).style.getPropertyValue("--or-split-wide")).toBe("260px");
  });

  it("shows only the section list on /settings in a narrow container", () => {
    const { container } = renderSettings();
    resize(600);
    expect(split(container).getAttribute("data-view")).toBe("list");
    expect(within(detailPane()).queryByRole("heading", { name: "General" })).toBeNull();
  });

  it("shows General beside the nav on /settings in a wide container", async () => {
    const { container } = renderSettings();
    resize(1024);
    expect(split(container).getAttribute("data-view")).toBe("list");
    expect(within(detailPane()).getByRole("heading", { level: 2, name: "General" })).toBeTruthy();
    const general = within(sectionNav()).getByRole("link", { name: "General" });
    expect(general.getAttribute("aria-current")).toBe("page");
    // Narrowed again (the Ask panel opened), it is the section list again.
    resize(700);
    expect(within(detailPane()).queryByRole("heading", { name: "General" })).toBeNull();
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
  });

  it.each([
    "/settings/general",
    "/settings/members",
    `/settings/connections/github/${GITHUB_ID}`,
    "/settings/profile",
    "/settings/advanced/routing",
  ])("shows %s alone with a back link to /settings below 880 px", (pathname) => {
    const { container } = renderSettings({ pathname });
    resize(600);
    expect(split(container).getAttribute("data-view")).toBe("detail");
    const back = within(detailPane()).getByRole("link", { name: "Settings" });
    expect(back.getAttribute("href")).toBe("/settings");
    expect(within(detailPane()).getByRole("heading", { level: 2, name: "General" })).toBeTruthy();
  });

  it("keeps the page beside the nav on other pages in a wide container", () => {
    const { container } = renderSettings({ pathname: "/settings/general" });
    resize(1200);
    expect(split(container).getAttribute("data-view")).toBe("detail");
    expect(within(detailPane()).getByRole("heading", { name: "General" })).toBeTruthy();
    const general = within(sectionNav()).getByRole("link", { name: "General" });
    expect(general.getAttribute("aria-current")).toBe("page");
  });

  it("styles its pages with tokens only", () => {
    const css = readFileSync(path.join(__dirname, "settings.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe("live updates", () => {
  const connected = async (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`));
  const deliver = (
    live: ReturnType<typeof fakeAbly>,
    organizationId: string,
    event: Parameters<typeof changeEvent>[1],
  ) =>
    act(() =>
      live.current().deliver(`org:${organizationId}:changes`, changeEvent(organizationId, event)),
    );

  it("adds a connected connection's entry on a connection event", async () => {
    const live = fakeAbly();
    renderSettings({ live });
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    await connected(live, TEST_ORGANIZATION_ID);
    connections = [github, gitlab, linear, slack];
    deliver(live, TEST_ORGANIZATION_ID, { resource: "connection", ids: [SLACK_ID] });
    await waitFor(() => expect(entries("Connections")).toHaveLength(5));
    expect(entries("Connections")).toContainEqual([
      "Slack",
      `/settings/connections/slack/${SLACK_ID}`,
    ]);
  });

  it("removes a disconnected connection's entry on a connection event", async () => {
    const live = fakeAbly();
    renderSettings({ live });
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    await connected(live, TEST_ORGANIZATION_ID);
    connections = [github, linear];
    deliver(live, TEST_ORGANIZATION_ID, { resource: "connection", ids: [GITLAB_ID] });
    await waitFor(() => expect(entries("Connections")).toHaveLength(3));
    expect(entries("Connections").map(([label]) => label)).toEqual([
      "GitHub",
      "Linear",
      "Add connection",
    ]);
  });

  it("ignores another organization's connection events under All organizations", async () => {
    const live = fakeAbly();
    const user: SessionUser = {
      ...testUser,
      scope: "all",
      organizations: [
        { ...testUser.organization, role: "admin" },
        { id: BETA_ID, name: "Beta", role: "admin" },
      ],
    };
    renderSettings({ live, user });
    await waitFor(() => expect(entries("Connections")).toHaveLength(4));
    await connected(live, BETA_ID);
    const before = connectionRequests().length;
    connections = [github];
    deliver(live, BETA_ID, { resource: "connection", ids: [SLACK_ID] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connectionRequests()).toHaveLength(before);
    expect(entries("Connections")).toHaveLength(4);
  });
});
