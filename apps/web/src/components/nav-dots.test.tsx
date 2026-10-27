// @vitest-environment jsdom
// The Fleet and Settings nav dots (boards Fleet, Settings, MobileMenu): the shell's sidebar,
// icon rail and phone drawer, and the Settings section nav's connection entries, all from
// `GET /api/ui/nav-indicators`, live through change events and a Replay's cache update.
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/api/connections";
import type { DeliveryDetail } from "@/lib/api/deliveries";
import type { NavIndicators } from "@/lib/api/nav-indicators";
import { navItems } from "@/lib/navigation";
import { useReplayDelivery } from "@/screens/settings/replay";
import { SettingsLayoutView } from "@/screens/settings/settings-layout-view";
import { LiveAppFrame } from "./live-app-frame";
import { CurrentUserProvider, type SessionUser } from "./current-user";
import { LiveProvider } from "./live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "./live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "./query-test-utils";
import { ShowAdvancedProvider } from "./show-advanced";

const nav = vi.hoisted(() => ({
  pathname: "/settings/general",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const BETA_ID = "22222222-2222-4222-8222-222222222222";
const GITLAB_ID = "44444444-4444-4444-8444-444444444444";
const LINEAR_ID = "55555555-5555-4555-8555-555555555555";
const FAILED_DELIVERY_ID = "66666666-6666-4666-8666-666666666666";
const AGENT_ID = "88888888-8888-4888-8888-888888888888";

function connection(
  overrides: Partial<Connection> & Pick<Connection, "id" | "provider">,
): Connection {
  return {
    name: overrides.provider === "gitlab" ? "om @ gitlab.netbuilder.io" : "Acme",
    host: null,
    account: "Acme",
    health: { state: "connected", problems: [] },
    reposUsing: 1,
    usedAs: overrides.provider === "linear" ? "tracker" : "code_host",
    failedDeliveries: 0,
    linkedAccounts: null,
    instanceUrl: null,
    installationUrl: null,
    history: null,
    ...overrides,
  };
}

function indicatorsOf({
  offline = 0,
  updateFailed = 0,
  failed = {},
}: {
  offline?: number;
  updateFailed?: number;
  failed?: Record<string, number>;
}): NavIndicators {
  const byConnection = Object.entries(failed).map(([id, count]) => ({ id, failed: count }));
  return {
    fleet: { offline, updateFailed },
    settings: {
      failedDeliveries: byConnection.reduce((sum, c) => sum + c.failed, 0),
      byConnection,
    },
  };
}

function replayAnswer(outcome: DeliveryDetail["outcome"]): DeliveryDetail {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    provider: "gitlab",
    connection: { kind: "scm", id: GITLAB_ID },
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" },
    repository: null,
    deliveryId: null,
    event: "merge_request.update",
    outcome,
    reasonCode: outcome === "failed" ? "no_agent" : null,
    reason: outcome === "failed" ? "No agent online for this repo" : null,
    run: null,
    replayOfId: FAILED_DELIVERY_ID,
    payloadTruncated: false,
    receivedAt: "2026-10-27T10:00:00.000Z",
    payload: {},
    replayedBy: { id: testUser.id, name: "Ada" },
    replays: [],
  };
}

let indicators: NavIndicators;
let connections: Connection[];
let replayOutcome: DeliveryDetail["outcome"];
/** While set, every read stays pending: what shows comes from the cache alone. */
let holdReads: boolean;
let seen: SeenRequest[];

const pending = () => new Promise<Response>(() => {});

beforeEach(() => {
  nav.pathname = "/settings/general";
  indicators = indicatorsOf({});
  connections = [
    connection({ id: GITLAB_ID, provider: "gitlab" }),
    connection({ id: LINEAR_ID, provider: "linear" }),
  ];
  replayOutcome = "started_run";
  holdReads = false;
  seen = mockFetch({
    "GET /api/ui/live/token": { token: null },
    "GET /api/ui/inbox/counts": () =>
      holdReads ? pending() : jsonResponse({ needsYou: 0, problems: 0, running: 0 }),
    "GET /api/ui/nav-indicators": () => (holdReads ? pending() : jsonResponse(indicators)),
    "GET /api/ui/connections": () =>
      holdReads ? pending() : jsonResponse({ connections: structuredClone(connections) }),
    "GET /api/ui/organization": () => pending(),
    [`POST /api/ui/deliveries/${FAILED_DELIVERY_ID}/replay`]: () => {
      // From here on no refetch answers: the dots must clear from the answer alone.
      holdReads = true;
      return jsonResponse(replayAnswer(replayOutcome));
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ReplayButton() {
  const replay = useReplayDelivery();
  return (
    <button type="button" onClick={() => replay.mutate({ id: FAILED_DELIVERY_ID })}>
      Replay
    </button>
  );
}

function renderShell({
  user = testUser,
  live,
  settings = true,
}: { user?: SessionUser; live?: ReturnType<typeof fakeAbly>; settings?: boolean } = {}) {
  const client = createTestQueryClient();
  const frame = (
    <LiveAppFrame
      currentPath={nav.pathname}
      brandHref="/"
      nav={navItems}
      user={{ name: "Ada", initials: "A" }}
      userMenu={(trigger) => trigger}
    >
      {settings ? (
        <SettingsLayoutView>
          <ReplayButton />
        </SettingsLayoutView>
      ) : null}
    </LiveAppFrame>
  );
  render(
    <CurrentUserProvider user={user}>
      <ShowAdvancedProvider initial={false}>
        <QueryClientProvider client={client}>
          <UiProvider linkComponent={TestLink}>
            {live ? (
              <LiveProvider createClient={live.createClient} fetchToken={fakeToken}>
                {frame}
              </LiveProvider>
            ) : (
              frame
            )}
          </UiProvider>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
  return { client };
}

const sidebar = () => screen.getAllByRole("navigation", { name: "Primary" })[0]!;
const sectionNav = () => screen.getByRole("navigation", { name: "Settings" });
const requests = (path: string) => seen.filter((r) => r.method === "GET" && r.path === path);

describe("Fleet and Settings nav dots", () => {
  it("names the sidebar and icon rail entries with their dots' labels", async () => {
    indicators = indicatorsOf({ offline: 1, updateFailed: 1, failed: { [GITLAB_ID]: 3 } });
    renderShell();
    const fleet = await within(sidebar()).findByRole("link", {
      name: "Fleet, 2 agents need attention",
    });
    expect(fleet.getAttribute("href")).toBe("/fleet");
    expect(fleet.querySelector(".or-nav__pip")!.classList.contains("or-dot--fail")).toBe(true);
    // On the icon rail the label is hidden by CSS but kept in the accessible name.
    expect(fleet.querySelector(".or-nav__label")!.classList.contains("or-rail-hidden")).toBe(true);
    const settings = within(sidebar()).getByRole("link", {
      name: "Settings, 3 failed deliveries",
    });
    expect(settings.querySelector(".or-nav__pip")!.classList.contains("or-dot--fail")).toBe(true);
  });

  it("uses the singular for one agent and one delivery", async () => {
    indicators = indicatorsOf({ updateFailed: 1, failed: { [LINEAR_ID]: 1 } });
    renderShell();
    expect(
      await within(sidebar()).findByRole("link", { name: "Fleet, 1 agent needs attention" }),
    ).toBeTruthy();
    expect(
      within(sidebar()).getByRole("link", { name: "Settings, 1 failed delivery" }),
    ).toBeTruthy();
  });

  it("shows both dots in the phone drawer and names the hamburger with them", async () => {
    indicators = indicatorsOf({ offline: 2, failed: { [GITLAB_ID]: 1 } });
    renderShell({ settings: false });
    const banner = screen.getByRole("banner");
    const hamburger = await within(banner).findByRole("button", { name: "Open menu, 2 alerts" });
    expect(banner.querySelector(".or-topbar__alert")).not.toBeNull();
    await userEvent.setup().click(hamburger);
    const drawer = await screen.findByRole("dialog", { name: "Menu" });
    const fleet = within(drawer).getByRole("link", { name: "Fleet, 2 agents need attention" });
    const settings = within(drawer).getByRole("link", { name: "Settings, 1 failed delivery" });
    for (const entry of [fleet, settings]) {
      expect(entry.querySelector(".or-nav__pip")!.classList.contains("or-dot--fail")).toBe(true);
    }
    expect(within(drawer).getByRole("link", { name: "Repos" })).toBeTruthy();
  });

  it("shows no dot and a plain hamburger while nothing needs attention", async () => {
    renderShell({ settings: false });
    await waitFor(() => expect(requests("/api/ui/nav-indicators")).toHaveLength(1));
    await waitFor(() =>
      expect(within(sidebar()).getByRole("link", { name: "Fleet" })).toBeTruthy(),
    );
    expect(within(sidebar()).getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
    expect(document.querySelector(".or-nav__pip")).toBeNull();
    expect(document.querySelector(".or-topbar__alert")).toBeNull();
  });

  it("asks for the user's scope: the active organization, or all of them", async () => {
    renderShell({ settings: false });
    await waitFor(() => expect(requests("/api/ui/nav-indicators")).toHaveLength(1));
    expect(requests("/api/ui/nav-indicators")[0]!.query.get("organization")).toBe(
      TEST_ORGANIZATION_ID,
    );
    cleanup();
    seen.length = 0;
    renderShell({
      settings: false,
      user: {
        ...testUser,
        scope: "all",
        organizations: [
          { ...testUser.organization, role: "admin" },
          { id: BETA_ID, name: "Beta", role: "member" },
        ],
      },
    });
    await waitFor(() => expect(requests("/api/ui/nav-indicators")).toHaveLength(1));
    expect(requests("/api/ui/nav-indicators")[0]!.query.get("organization")).toBe("all");
  });

  it("marks each connection with unreplayed failed deliveries in the Settings section nav", async () => {
    indicators = indicatorsOf({ failed: { [GITLAB_ID]: 2 } });
    renderShell();
    const gitlab = await within(sectionNav()).findByRole("link", {
      name: "GitLab, 2 failed deliveries",
    });
    expect(gitlab.querySelector(".or-subnav__dot")!.classList.contains("or-dot--fail")).toBe(true);
    const linear = within(sectionNav()).getByRole("link", { name: "Linear" });
    expect(linear.querySelector(".or-subnav__dot")).toBeNull();
  });
});

describe("live nav dots", () => {
  const connected = (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`));
  const deliver = (
    live: ReturnType<typeof fakeAbly>,
    organizationId: string,
    event: Parameters<typeof changeEvent>[1],
  ) =>
    act(() =>
      live.current().deliver(`org:${organizationId}:changes`, changeEvent(organizationId, event)),
    );

  it("shows the Fleet dot when the liveness cron marks an agent offline, and clears it when it comes back", async () => {
    const live = fakeAbly();
    renderShell({ live, settings: false });
    await waitFor(() => expect(requests("/api/ui/nav-indicators")).toHaveLength(1));
    await connected(live, TEST_ORGANIZATION_ID);
    expect(within(sidebar()).getByRole("link", { name: "Fleet" })).toBeTruthy();
    // The agent-liveness cron sets live_online false and publishes `agent`.
    indicators = indicatorsOf({ offline: 1 });
    deliver(live, TEST_ORGANIZATION_ID, { resource: "agent", ids: [AGENT_ID] });
    expect(
      await within(sidebar()).findByRole("link", { name: "Fleet, 1 agent needs attention" }),
    ).toBeTruthy();
    // Its next heartbeat brings it back online and publishes `agent`.
    indicators = indicatorsOf({});
    deliver(live, TEST_ORGANIZATION_ID, { resource: "agent", ids: [AGENT_ID] });
    expect(await within(sidebar()).findByRole("link", { name: "Fleet" })).toBeTruthy();
    expect(document.querySelector(".or-nav__pip")).toBeNull();
  });

  it("shows the Settings and connection dots when a delivery fails", async () => {
    const live = fakeAbly();
    renderShell({ live });
    await within(sectionNav()).findByRole("link", { name: "GitLab" });
    await connected(live, TEST_ORGANIZATION_ID);
    indicators = indicatorsOf({ failed: { [GITLAB_ID]: 1 } });
    deliver(live, TEST_ORGANIZATION_ID, { resource: "webhook_event", ids: [FAILED_DELIVERY_ID] });
    expect(
      await within(sidebar()).findByRole("link", { name: "Settings, 1 failed delivery" }),
    ).toBeTruthy();
    expect(
      await within(sectionNav()).findByRole("link", { name: "GitLab, 1 failed delivery" }),
    ).toBeTruthy();
  });

  it("clears the Settings and connection dots as soon as a replay succeeds, before any refetch", async () => {
    indicators = indicatorsOf({ failed: { [GITLAB_ID]: 1 } });
    connections = [
      connection({ id: GITLAB_ID, provider: "gitlab", failedDeliveries: 1 }),
      connection({ id: LINEAR_ID, provider: "linear" }),
    ];
    const { client } = renderShell();
    await within(sectionNav()).findByRole("link", { name: "GitLab, 1 failed delivery" });
    within(sidebar()).getByRole("link", { name: "Settings, 1 failed delivery" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Replay" }));
    expect(await within(sectionNav()).findByRole("link", { name: "GitLab" })).toBeTruthy();
    expect(within(sidebar()).getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(document.querySelector(".or-nav__pip, .or-subnav__dot")).toBeNull();
    // The connection's failed count dropped with it.
    const list = client.getQueryData<{ connections: Connection[] }>([
      TEST_ORGANIZATION_ID,
      "settings",
      "detail",
      "connections",
    ]);
    expect(list!.connections.find((c) => c.id === GITLAB_ID)!.failedDeliveries).toBe(0);
  });

  it("keeps the dots when the replay fails again", async () => {
    indicators = indicatorsOf({ failed: { [GITLAB_ID]: 1 } });
    replayOutcome = "failed";
    renderShell();
    await within(sectionNav()).findByRole("link", { name: "GitLab, 1 failed delivery" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Replay" }));
    await waitFor(() => expect(holdReads).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      within(sectionNav()).getByRole("link", { name: "GitLab, 1 failed delivery" }),
    ).toBeTruthy();
    expect(
      within(sidebar()).getByRole("link", { name: "Settings, 1 failed delivery" }),
    ).toBeTruthy();
  });

  it("follows every organization's agents under All organizations", async () => {
    const live = fakeAbly();
    renderShell({
      live,
      settings: false,
      user: {
        ...testUser,
        scope: "all",
        organizations: [
          { ...testUser.organization, role: "admin" },
          { id: BETA_ID, name: "Beta", role: "member" },
        ],
      },
    });
    await waitFor(() => expect(requests("/api/ui/nav-indicators")).toHaveLength(1));
    await connected(live, BETA_ID);
    indicators = indicatorsOf({ offline: 1 });
    deliver(live, BETA_ID, { resource: "agent", ids: [AGENT_ID] });
    expect(
      await within(sidebar()).findByRole("link", { name: "Fleet, 1 agent needs attention" }),
    ).toBeTruthy();
  });

  it("ignores another organization's events", async () => {
    const live = fakeAbly();
    renderShell({ live, settings: false });
    await waitFor(() => expect(requests("/api/ui/nav-indicators")).toHaveLength(1));
    const userChannel = `user:${testUser.id}:changes`;
    await waitFor(() => expect(live.current().subscribed()).toContain(userChannel));
    indicators = indicatorsOf({ offline: 1, failed: { [GITLAB_ID]: 1 } });
    // Beta isn't in the scope: its events reach only the user's own data.
    act(() => {
      live.current().deliver(userChannel, changeEvent(BETA_ID, { resource: "agent" }));
      live.current().deliver(userChannel, changeEvent(BETA_ID, { resource: "webhook_event" }));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests("/api/ui/nav-indicators")).toHaveLength(1);
    expect(within(sidebar()).getByRole("link", { name: "Fleet" })).toBeTruthy();
  });
});
