// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
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
import { ShowAdvancedProvider } from "@/components/show-advanced";
import { UnsavedChangesProvider } from "@/components/unsaved-changes";
import type { Connection, ConnectionProvider } from "@/lib/api/connections";
import type { TrackerStateMappingView } from "@/lib/api/trackers";
import { ConnectionSettings } from "./connection-settings";
import { SettingsLayoutView } from "./settings-layout-view";
import { organizationChange } from "./test-fixtures";
import { SAME_STATE_ERROR, WORK_ITEM_STATES_HELP } from "./work-item-states-card";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  pathname: "/settings",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

const browser = vi.hoisted(() => ({ navigateTo: vi.fn(), openInNewTab: vi.fn() }));
vi.mock("@/lib/navigate", () => browser);

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const BETA_ID = "22222222-2222-4222-8222-222222222222";
const REPO_ID = "99999999-9999-4999-8999-999999999999";
const IDS: Record<ConnectionProvider, string> = {
  github: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  gitlab: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  linear: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  slack: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  discord: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};

const history = organizationChange({
  section: "connection",
  subjectId: IDS.gitlab,
  changes: [{ field: "credentials", label: "Credentials", before: "changed", after: "changed" }],
});

function connection(provider: ConnectionProvider, overrides: Partial<Connection> = {}): Connection {
  const base: Pick<
    Connection,
    | "provider"
    | "id"
    | "health"
    | "failedDeliveries"
    | "instanceUrl"
    | "installationUrl"
    | "history"
  > = {
    provider,
    id: IDS[provider],
    health: { state: "connected", problems: [] },
    failedDeliveries: 0,
    instanceUrl: null,
    installationUrl: null,
    history: null,
  };
  switch (provider) {
    case "github":
      return {
        ...base,
        name: "acme-corp",
        host: "github.com",
        account: "acme-corp",
        reposUsing: 4,
        usedAs: "code_host",
        linkedAccounts: null,
        installationUrl: "https://github.com/settings/installations/42",
        ...overrides,
      };
    case "gitlab":
      return {
        ...base,
        name: "om @ gitlab.netbuilder.io",
        host: "gitlab.netbuilder.io",
        account: "managed-services",
        health: { state: "healthy", problems: [] },
        reposUsing: 1,
        usedAs: "code_host",
        linkedAccounts: null,
        instanceUrl: "https://gitlab.netbuilder.io",
        history,
        ...overrides,
      };
    case "linear":
      return {
        ...base,
        name: "Acme",
        host: null,
        account: "Acme",
        reposUsing: 3,
        usedAs: "tracker",
        linkedAccounts: null,
        ...overrides,
      };
    case "slack":
    case "discord":
      return {
        ...base,
        name: provider === "slack" ? "Acme Slack" : "Acme Discord",
        host: null,
        account: provider === "slack" ? "Acme Slack" : "Acme Discord",
        reposUsing: null,
        usedAs: "chat",
        linkedAccounts: 2,
        ...overrides,
      };
  }
}

const STATES = [
  { id: "s-triage", name: "Triage", type: "triage", category: "triage" },
  { id: "s-backlog", name: "Backlog", type: "backlog", category: "backlog" },
  { id: "s-todo", name: "Todo", type: "unstarted", category: "todo" },
  { id: "s-progress", name: "In Progress", type: "started", category: "in_progress" },
  { id: "s-done", name: "Done", type: "completed", category: "done" },
] as const;

function stateMapping(overrides: Partial<TrackerStateMappingView["mapping"]> = {}) {
  return {
    integrationId: IDS.linear,
    tracker: "linear",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    mapping: {
      ready: { types: ["unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: {},
      ...overrides,
    },
    stateTypes: ["triage", "backlog", "unstarted", "started"],
    teams: [{ id: "team-1", key: "ENG", name: "Engineering", states: [...STATES] }],
  } satisfies TrackerStateMappingView;
}

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

let connections: Connection[];
let mapping: TrackerStateMappingView;
let seen: SeenRequest[];
/** While set, reads never answer: the view shows only what the cache holds. */
let holdReads: boolean;
let rotateResponse: () => Response;

const MAPPING_PATH = `/api/ui/trackers/${IDS.linear}/state-mapping`;

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.push.mockReset();
  browser.navigateTo.mockReset();
  browser.openInNewTab.mockReset();
  connections = (Object.keys(IDS) as ConnectionProvider[]).map((provider) => connection(provider));
  mapping = stateMapping();
  holdReads = false;
  rotateResponse = () =>
    jsonResponse({ health: { state: "expiring", expiresAt: "2026-11-02", problems: [] } });
  const held = (body: () => unknown) => () =>
    holdReads ? new Promise<Response>(() => {}) : jsonResponse(body());
  seen = mockFetch({
    "GET /api/ui/connections": held(() => ({ connections })),
    [`GET ${MAPPING_PATH}`]: held(() => mapping),
    [`PUT ${MAPPING_PATH}`]: (request) =>
      jsonResponse({
        ...mapping,
        mapping: request.body as TrackerStateMappingView["mapping"],
      }),
    [`POST /api/ui/connections/gitlab/${IDS.gitlab}/rotate`]: () => rotateResponse(),
    [`PUT /api/ui/connections/gitlab/${IDS.gitlab}`]: () =>
      jsonResponse({ health: { state: "healthy", problems: [] } }),
    [`DELETE /api/ui/scm-connections/${IDS.github}`]: { ok: true },
    [`DELETE /api/ui/scm-connections/${IDS.gitlab}`]: { ok: true },
    "DELETE /api/ui/integrations/linear": { ok: true },
    [`DELETE /api/ui/integrations/slack/${IDS.slack}`]: { ok: true },
    [`DELETE /api/ui/integrations/discord/${IDS.discord}`]: { ok: true },
    [`POST /api/ui/repositories/${REPO_ID}/webhook`]: { ok: true },
    [`GET /api/ui/connections/scm/${IDS.github}/deliveries`]: { deliveries: [], nextCursor: null },
    [`GET /api/ui/connections/scm/${IDS.gitlab}/deliveries`]: { deliveries: [], nextCursor: null },
    [`GET /api/ui/connections/linear/${IDS.linear}/deliveries`]: {
      deliveries: [],
      nextCursor: null,
    },
    "GET /api/ui/settings-history": () =>
      jsonResponse({ latest: history, entries: [history], next: null }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderConnection(
  provider: ConnectionProvider,
  options: { user?: SessionUser; live?: ReturnType<typeof fakeAbly>; id?: string } = {},
) {
  const id = options.id ?? IDS[provider];
  nav.pathname = `/settings/connections/${provider}/${id}`;
  const client = createTestQueryClient();
  const page = (
    <SettingsLayoutView>
      <ConnectionSettings provider={provider} connectionId={id} />
    </SettingsLayoutView>
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

const page = () => screen.findByRole("article");
const title = async () =>
  (await page()).querySelector<HTMLHeadingElement>("h2.or-settings-page__title")!;
const badges = async () =>
  Array.from((await page()).querySelectorAll(".or-settings-page__badges .or-ref")).map((badge) => [
    badge.textContent,
    badge.querySelector(".or-mono") !== null,
  ]);
const toolbar = () => screen.queryByRole("toolbar", { name: "Connection actions" });
const summary = () => screen.getByRole("region", { name: "Connection summary" });
const cell = (label: string) => within(summary()).getByRole("group", { name: label });
const sectionNav = () => screen.getByRole("navigation", { name: "Settings" });
const requests = (method: string, pathname: string) =>
  seen.filter((request) => request.method === method && request.path === pathname);

async function openMenu() {
  await userEvent.click(within(toolbar()!).getByRole("button", { name: "More actions" }));
  return screen.findByRole("menu");
}

async function chooseMenuItem(name: string) {
  const menu = await openMenu();
  await userEvent.click(within(menu).getByRole("menuitem", { name }));
}

describe("header", () => {
  it.each([
    [
      "github",
      "GitHub",
      [
        ["github.com", true],
        ["acme-corp", false],
      ],
    ],
    [
      "gitlab",
      "GitLab",
      [
        ["gitlab.netbuilder.io", true],
        ["managed-services", false],
      ],
    ],
    ["linear", "Linear", [["Acme", false]]],
    ["slack", "Slack", [["Acme Slack", false]]],
    ["discord", "Discord", [["Acme Discord", false]]],
  ] as const)(
    "%s: the mark, the provider's name and the host and account badges",
    async (provider, name, expected) => {
      renderConnection(provider);
      const heading = await title();
      expect(heading.textContent).toContain(name);
      expect(
        heading.querySelector(
          ".or-settings-page__mark svg, .or-settings-page__mark .or-brand-mark",
        ),
      ).not.toBeNull();
      expect(heading.querySelector(".or-settings-page__mark")!.getAttribute("aria-hidden")).toBe(
        "true",
      );
      expect(await badges()).toEqual(expected);
    },
  );

  it("is a busy status while the connections load, never a blank page", async () => {
    holdReads = true;
    renderConnection("gitlab");
    const loading = (await screen.findByText("Loading the connection")).closest(
      '[role="status"]',
    )!;
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("region", { name: "Connection summary" })).toBeNull();
    expect(toolbar()).toBeNull();
  });

  it("says a connection the organization doesn't have doesn't exist", async () => {
    renderConnection("gitlab", { id: "12121212-1212-4121-8121-121212121212" });
    expect(
      await screen.findByRole("heading", { name: "This connection doesn't exist." }),
    ).toBeTruthy();
  });

  it("says another provider's ID (or another organization's connection) doesn't exist", async () => {
    renderConnection("github", { id: IDS.gitlab });
    expect(
      await screen.findByRole("heading", { name: "This connection doesn't exist." }),
    ).toBeTruthy();
  });

  it("shows the back link to Settings in a narrow content area", async () => {
    renderConnection("gitlab");
    await page();
    expect(screen.getByRole("link", { name: /Settings/ }).getAttribute("href")).toBe("/settings");
  });
});

describe("toolbar", () => {
  it("GitLab: Rotate token, then ⋯ with Edit connection and, after a separator, Disconnect…", async () => {
    renderConnection("gitlab");
    await page();
    const bar = toolbar()!;
    expect(within(bar).getByRole("button", { name: "Rotate token" })).toBeTruthy();
    const menu = await openMenu();
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((item) =>
        item.getAttribute("role") === "separator" ? "—" : item.textContent,
      ),
    ).toEqual(["Edit connection", "—", "Disconnect…"]);
  });

  it.each(["github", "linear", "slack", "discord"] as const)(
    "%s: no Rotate token, the same ⋯ menu",
    async (provider) => {
      renderConnection(provider);
      await page();
      expect(within(toolbar()!).queryByRole("button", { name: "Rotate token" })).toBeNull();
      const menu = await openMenu();
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Edit connection", "Disconnect…"]);
    },
  );

  it.each(Object.keys(IDS) as ConnectionProvider[])(
    "%s: members see no toolbar items",
    async (provider) => {
      renderConnection(provider, { user: member });
      await page();
      expect(toolbar()).toBeNull();
      expect(
        within(await page()).queryAllByRole("button", { name: /Rotate|More actions/ }),
      ).toEqual([]);
    },
  );

  it("rotates the token and shows the new health before any refetch", async () => {
    renderConnection("gitlab");
    await page();
    expect(within(cell("Token")).getByText("Healthy")).toBeTruthy();
    holdReads = true;
    await userEvent.click(within(toolbar()!).getByRole("button", { name: "Rotate token" }));
    await waitFor(() => expect(within(cell("Token")).getByText("Expires Nov 2")).toBeTruthy());
    expect(requests("POST", `/api/ui/connections/gitlab/${IDS.gitlab}/rotate`)).toHaveLength(1);
    expect(ui.toast).toHaveBeenCalledWith("Token rotated");
  });

  it("toasts the refusal and keeps the health", async () => {
    const refusal = "This GitLab instance can't rotate tokens.";
    rotateResponse = () => jsonResponse({ error: refusal, code: "rotation_unsupported" }, 400);
    renderConnection("gitlab");
    await page();
    await userEvent.click(within(toolbar()!).getByRole("button", { name: "Rotate token" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        refusal,
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(within(cell("Token")).getByText("Healthy")).toBeTruthy();
  });
});

describe("Edit connection", () => {
  it("GitLab: a sheet with the token form, the instance read-only, replacing the token", async () => {
    connections = connections.map((row) =>
      row.provider === "gitlab"
        ? {
            ...row,
            health: {
              state: "needs_attention",
              problems: [{ code: "token_invalid", sentence: "GitLab rejects the bot token." }],
            },
          }
        : row,
    );
    renderConnection("gitlab");
    await page();
    await chooseMenuItem("Edit connection");
    const sheet = await screen.findByRole("dialog", { name: "Edit connection" });
    const form = within(sheet).getByRole("form", { name: "Replace the GitLab token" });
    const url = within(form).getByLabelText<HTMLInputElement>("GitLab URL");
    expect(url.value).toBe("https://gitlab.netbuilder.io");
    expect(url.readOnly).toBe(true);
    holdReads = true;
    await userEvent.type(within(form).getByLabelText("Access token"), "glpat-new");
    await userEvent.click(within(form).getByRole("button", { name: "Replace token" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit connection" })).toBeNull(),
    );
    expect(requests("PUT", `/api/ui/connections/gitlab/${IDS.gitlab}`).map((r) => r.body)).toEqual([
      { token: "glpat-new" },
    ]);
    expect(within(cell("Token")).getByText("Healthy")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Problems" })).toBeNull();
  });

  it("GitHub: opens the installation's settings on GitHub in a new tab", async () => {
    renderConnection("github");
    await page();
    await chooseMenuItem("Edit connection");
    expect(browser.openInNewTab).toHaveBeenCalledWith(
      "https://github.com/settings/installations/42",
    );
    expect(browser.navigateTo).not.toHaveBeenCalled();
  });

  it.each([
    ["linear", "/api/integrations/linear/connect"],
    ["slack", "/api/integrations/slack/connect"],
    ["discord", "/api/integrations/discord/connect"],
  ] as const)("%s: goes to its connect route to reconnect", async (provider, route) => {
    renderConnection(provider);
    await page();
    await chooseMenuItem("Edit connection");
    expect(browser.navigateTo).toHaveBeenCalledWith(route);
    expect(browser.openInNewTab).not.toHaveBeenCalled();
  });
});

describe("Disconnect…", () => {
  const dialog = () => screen.findByRole("alertdialog");

  it.each([
    [
      "github",
      "acme-corp",
      "Removes acme-corp and its 4 repos, with their reviews, rules and agent pins.",
      `/api/ui/scm-connections/${IDS.github}`,
    ],
    [
      "gitlab",
      "om @ gitlab.netbuilder.io",
      "Removes om @ gitlab.netbuilder.io and its 1 repo, with their reviews, rules and agent pins.",
      `/api/ui/scm-connections/${IDS.gitlab}`,
    ],
  ] as const)(
    "%s: names its repos and needs the exact name typed",
    async (provider, name, description, route) => {
      renderConnection(provider);
      await page();
      await chooseMenuItem("Disconnect…");
      const confirm = await dialog();
      expect(within(confirm).getByRole("heading").textContent).toBe(`Disconnect ${name}?`);
      expect(confirm.textContent).toContain(description);
      const button = within(confirm).getByRole<HTMLButtonElement>("button", { name: "Disconnect" });
      expect(button.disabled).toBe(true);
      const field = within(confirm).getByRole("textbox");
      await userEvent.type(field, name.slice(0, -1));
      expect(button.disabled).toBe(true);
      await userEvent.type(field, name.slice(-1));
      expect(button.disabled).toBe(false);
      holdReads = true;
      await userEvent.click(button);
      // The entry leaves the section nav at once, before any refetch.
      await waitFor(() =>
        expect(
          within(sectionNav()).queryByRole("link", {
            name: provider === "github" ? "GitHub" : "GitLab",
          }),
        ).toBeNull(),
      );
      await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith("/settings"));
      expect(requests("DELETE", route)).toHaveLength(1);
      expect(ui.toast).toHaveBeenCalledWith(`Disconnected ${name}`);
      expect(screen.queryByRole("heading", { name: "This connection doesn't exist." })).toBeNull();
    },
  );

  it.each([
    [
      "linear",
      "Linear",
      "Om stops picking up work items from Linear.",
      "/api/ui/integrations/linear",
    ],
    [
      "slack",
      "Slack",
      "Om stops answering in Acme Slack.",
      `/api/ui/integrations/slack/${IDS.slack}`,
    ],
    [
      "discord",
      "Discord",
      "Om stops answering in Acme Discord.",
      `/api/ui/integrations/discord/${IDS.discord}`,
    ],
  ] as const)(
    "%s: says what stops, with a plain confirm",
    async (provider, entry, description, route) => {
      renderConnection(provider);
      await page();
      await chooseMenuItem("Disconnect…");
      const confirm = await dialog();
      expect(confirm.textContent).toContain(description);
      expect(within(confirm).queryByRole("textbox")).toBeNull();
      holdReads = true;
      await userEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));
      await waitFor(() =>
        expect(within(sectionNav()).queryByRole("link", { name: entry })).toBeNull(),
      );
      await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith("/settings"));
      expect(requests("DELETE", route)).toHaveLength(1);
    },
  );

  it("puts the entry back and stays when the disconnect is refused", async () => {
    mockFetch({
      "GET /api/ui/connections": () => jsonResponse({ connections }),
      "DELETE /api/ui/integrations/linear": () => jsonResponse({ error: "Nope." }, 500),
    });
    renderConnection("linear");
    await page();
    await chooseMenuItem("Disconnect…");
    await userEvent.click(within(await dialog()).getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        "Nope.",
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(within(sectionNav()).getByRole("link", { name: "Linear" })).toBeTruthy();
    expect((await title()).textContent).toContain("Linear");
    expect(nav.router.push).not.toHaveBeenCalled();
  });
});

describe("summary", () => {
  it("code host: Token, Repos using it with Manage, Used as, and the change history ⓘ", async () => {
    renderConnection("gitlab");
    await page();
    expect(within(cell("Token")).getByText("Healthy")).toBeTruthy();
    expect(cell("Repos using it").textContent).toContain("1");
    expect(
      within(cell("Repos using it")).getByRole("link", { name: "Manage" }).getAttribute("href"),
    ).toBe(`/repos?add=gitlab&connection=${IDS.gitlab}`);
    expect(cell("Used as").textContent).toContain("Code host");
    await userEvent.click(within(cell("Token")).getByRole("button", { name: "Change history" }));
    expect(await screen.findByText(/Last changed by Grace/)).toBeTruthy();
    await waitFor(() => expect(requests("GET", "/api/ui/settings-history")).toHaveLength(1));
    const query = requests("GET", "/api/ui/settings-history")[0]!.query;
    expect([query.get("section"), query.get("subject")]).toEqual(["connection", IDS.gitlab]);
  });

  it("GitHub: Connected, and Manage opens its add-repo sheet", async () => {
    renderConnection("github");
    await page();
    expect(within(cell("Token")).getByText("Connected")).toBeTruthy();
    expect(
      within(cell("Repos using it")).getByRole("link", { name: "Manage" }).getAttribute("href"),
    ).toBe(`/repos?add=github&connection=${IDS.github}`);
  });

  it("Linear: repos using it without Manage, used as Tracker", async () => {
    renderConnection("linear");
    await page();
    expect(cell("Repos using it").textContent).toContain("3");
    expect(within(cell("Repos using it")).queryByRole("link")).toBeNull();
    expect(cell("Used as").textContent).toContain("Tracker");
  });

  it.each(["slack", "discord"] as const)("%s: Linked accounts, used as Chat", async (provider) => {
    renderConnection(provider);
    await page();
    expect(cell("Linked accounts").textContent).toContain("2");
    expect(within(summary()).queryByRole("group", { name: "Repos using it" })).toBeNull();
    expect(cell("Used as").textContent).toContain("Chat");
  });
});

describe("problems", () => {
  const attention: Connection["health"] = {
    state: "needs_attention",
    problems: [
      { code: "webhook_missing", sentence: "acme/api has no webhook.", repositoryId: REPO_ID },
      { code: "token_invalid", sentence: "GitLab rejects the bot token." },
    ],
  };
  beforeEach(() => {
    connections = connections.map((row) =>
      row.provider === "gitlab" ? { ...row, health: attention } : row,
    );
  });

  it("lists each problem with Recreate webhook for admins, and a recreate drops its problem", async () => {
    renderConnection("gitlab");
    const problems = await screen.findByRole("region", { name: "Problems" });
    expect(within(cell("Token")).getByText("Needs attention")).toBeTruthy();
    expect(problems.textContent).toContain("acme/api has no webhook.");
    expect(problems.textContent).toContain("GitLab rejects the bot token.");
    holdReads = true;
    await userEvent.click(within(problems).getByRole("button", { name: "Recreate webhook" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Problems" }).textContent).not.toContain(
        "acme/api has no webhook.",
      ),
    );
    expect(requests("POST", `/api/ui/repositories/${REPO_ID}/webhook`)).toHaveLength(1);
  });

  it("shows members the problems without Recreate webhook", async () => {
    renderConnection("gitlab", { user: member });
    const problems = await screen.findByRole("region", { name: "Problems" });
    expect(problems.textContent).toContain("acme/api has no webhook.");
    expect(within(problems).queryByRole("button")).toBeNull();
  });

  it("has no Problems card while healthy", async () => {
    connections = connections.map((row) =>
      row.provider === "gitlab" ? connection("gitlab") : row,
    );
    renderConnection("gitlab");
    await page();
    expect(screen.queryByRole("region", { name: "Problems" })).toBeNull();
  });
});

describe("work item states", () => {
  const states = () => screen.findByRole("region", { name: "Work item states" });
  // The card is replaced once the states load: look it up again each time.
  const select = (name: string) =>
    waitFor(() =>
      within(screen.getByRole("region", { name: "Work item states" })).getByRole<HTMLSelectElement>(
        "combobox",
        { name },
      ),
    );
  const selected = (element: HTMLSelectElement) => element.selectedOptions[0]?.textContent;

  it("is only on the Linear connection", async () => {
    renderConnection("gitlab");
    await page();
    expect(screen.queryByRole("region", { name: "Work item states" })).toBeNull();
  });

  it("shows the defaults, Todo and Backlog, with the help line and the workspace's states", async () => {
    renderConnection("linear");
    expect(selected(await select("Ready to start"))).toBe("Todo");
    expect(selected(await select("Needs refining"))).toBe("Backlog");
    expect((await states()).textContent).toContain(WORK_ITEM_STATES_HELP);
    expect(Array.from((await select("Ready to start")).options).map((o) => o.textContent)).toEqual([
      "Triage",
      "Backlog",
      "Todo",
      "In Progress",
    ]);
    expect(within(await states()).getByRole("button", { name: "Change history" })).toBeTruthy();
  });

  it("stages both choices and saves them in one request, shown before any refetch", async () => {
    renderConnection("linear");
    await userEvent.selectOptions(await select("Ready to start"), "Triage");
    await userEvent.selectOptions(await select("Needs refining"), "In Progress");
    holdReads = true;
    await userEvent.click(within(await states()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requests("PUT", MAPPING_PATH)).toHaveLength(1));
    expect(requests("PUT", MAPPING_PATH)[0]!.body).toEqual({
      ready: { types: ["triage"] },
      needsRefining: { types: ["started"] },
      teams: {},
    });
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Work item states" })).queryByRole("button", {
          name: "Save",
        }),
      ).toBeNull(),
    );
    expect(selected(await select("Ready to start"))).toBe("Triage");
    expect(selected(await select("Needs refining"))).toBe("In Progress");
  });

  it("refuses the same state for both, inline, without a request", async () => {
    renderConnection("linear");
    await userEvent.selectOptions(await select("Needs refining"), "Todo");
    expect((await states()).textContent).toContain(SAME_STATE_ERROR);
    await userEvent.click(within(await states()).getByRole("button", { name: "Save" }));
    expect(requests("PUT", MAPPING_PATH)).toEqual([]);
  });

  it("is read-only for members", async () => {
    renderConnection("linear", { user: member });
    expect((await select("Ready to start")).disabled).toBe(true);
    expect((await select("Needs refining")).disabled).toBe(true);
    expect(within(await states()).queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("live updates", () => {
  const connected = (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`));
  const deliver = (live: ReturnType<typeof fakeAbly>, organizationId: string, id: string) =>
    act(() =>
      live
        .current()
        .deliver(
          `org:${organizationId}:changes`,
          changeEvent(organizationId, { resource: "connection", ids: [id] }),
        ),
    );

  it("another admin's rotate or the daily check refreshes the summary and problems", async () => {
    const live = fakeAbly();
    renderConnection("gitlab", { live });
    await page();
    await connected(live, TEST_ORGANIZATION_ID);
    connections = connections.map((row) =>
      row.provider === "gitlab"
        ? {
            ...row,
            account: "om-bot",
            health: {
              state: "needs_attention",
              problems: [{ code: "token_invalid", sentence: "GitLab rejects the bot token." }],
            },
          }
        : row,
    );
    deliver(live, TEST_ORGANIZATION_ID, IDS.gitlab);
    expect((await screen.findByRole("region", { name: "Problems" })).textContent).toContain(
      "GitLab rejects the bot token.",
    );
    expect(within(cell("Token")).getByText("Needs attention")).toBeTruthy();
    expect((await badges()).map(([text]) => text)).toContain("om-bot");
  });

  it("a disconnect by someone else shows that the connection doesn't exist", async () => {
    const live = fakeAbly();
    renderConnection("slack", { live });
    await page();
    await connected(live, TEST_ORGANIZATION_ID);
    connections = connections.filter((row) => row.provider !== "slack");
    deliver(live, TEST_ORGANIZATION_ID, IDS.slack);
    expect(
      await screen.findByRole("heading", { name: "This connection doesn't exist." }),
    ).toBeTruthy();
  });

  it("another admin's work item states arrive through the connection event", async () => {
    const live = fakeAbly();
    renderConnection("linear", { live });
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: "Work item states" }),
        ).getByRole<HTMLSelectElement>("combobox", { name: "Ready to start" }).selectedOptions[0]
          ?.textContent,
      ).toBe("Todo"),
    );
    await connected(live, TEST_ORGANIZATION_ID);
    mapping = stateMapping({ ready: { types: ["started"] } });
    deliver(live, TEST_ORGANIZATION_ID, IDS.linear);
    await waitFor(() =>
      expect(
        within(
          screen.getByRole("region", { name: "Work item states" }),
        ).getByRole<HTMLSelectElement>("combobox", { name: "Ready to start" }).selectedOptions[0]
          ?.textContent,
      ).toBe("In Progress"),
    );
  });

  it("ignores another organization's events", async () => {
    const live = fakeAbly();
    renderConnection("gitlab", {
      live,
      user: {
        ...testUser,
        scope: "all",
        organizations: [
          { ...testUser.organization, role: "admin" },
          { id: BETA_ID, name: "Beta", role: "admin" },
        ],
      },
    });
    await page();
    await connected(live, BETA_ID);
    const before = requests("GET", "/api/ui/connections").length;
    deliver(live, BETA_ID, IDS.gitlab);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests("GET", "/api/ui/connections")).toHaveLength(before);
  });
});

describe("phone layout (board Settings-390)", () => {
  it("keeps the toolbar at the top right of the title and the summary in two columns", () => {
    const css = readFileSync(path.resolve(__dirname, "settings.css"), "utf8");
    const rule = (selector: string) =>
      new RegExp(`${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule(".or-settings-page__head")).toMatch(
      /display: flex;[\s\S]*justify-content: space-between;/,
    );
    expect(rule(".or-settings-page__head")).not.toMatch(/flex-wrap|flex-direction: column/);
    expect(rule(".or-settings-page__actions")).toContain("flex: none;");
    const phone = /@media \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(phone).not.toContain(".or-settings-page__head");
    const ui = readFileSync(
      path.resolve(__dirname, "../../../../../packages/ui/styles/surfaces.css"),
      "utf8",
    );
    const stats =
      /\/\* Summary cells[\s\S]*?@media \(max-width: 768px\) \{\s*\.or-stats \{([^}]*)\}/.exec(
        ui,
      )?.[1] ?? "";
    expect(stats).toMatch(/grid-template-columns: repeat\(2/);
  });
});
