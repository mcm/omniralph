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
import type { AgentDetail, AgentList } from "@/lib/api/agents";
import { AGENT_NOT_FOUND } from "./agent-panel";
import { FleetView } from "./fleet-view";
import {
  AGENT_ALPHA,
  AGENT_BETA,
  AGENT_BRAVO,
  AGENT_REVOKED,
  agentDetail,
  agentRow,
  BETA_ID,
  detailRoutes,
  fleet,
} from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/fleet",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const UNKNOWN = "aaaaaaaa-0000-4000-8000-000000000000";
const RUN_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_RUN = "bbbbbbbb-0000-4000-8000-000000000002";

const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

let data: AgentList;
let details: Record<string, AgentDetail>;
let seen: SeenRequest[];

function serve() {
  seen = mockFetch({
    "GET /api/ui/agents": () => jsonResponse(data),
    ...detailRoutes(
      () => data,
      () => details,
      [UNKNOWN, AGENT_BETA],
    ),
  });
}

function renderFleet(
  options: { agentId?: string; user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {},
) {
  const client = createTestQueryClient();
  const view = <FleetView agentId={options.agentId} />;
  return render(
    <CurrentUserProvider user={options.user ?? testUser}>
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
}

const panel = () => screen.getByRole("region", { name: "Agent" });
const section = (name: string) => within(panel()).queryByRole("region", { name });
const split = () => document.querySelector<HTMLElement>(".or-split")!;
const detailRequests = (id: string) =>
  seen.filter((request) => request.path === `/api/ui/agents/${id}`);
const badgeTexts = (element: HTMLElement) =>
  [...element.querySelectorAll(".or-ref__text")].map((badge) => badge.textContent!.trim());

/** Opens `/fleet/{id}` and waits for the panel's name. */
async function openAgent(
  id: string,
  name: string,
  options: Parameters<typeof renderFleet>[0] = {},
) {
  renderFleet({ ...options, agentId: id });
  await within(panel()).findByRole("heading", { level: 2, name });
}

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** coder-1, busy: a story of an epic running, ten finished attempts, reports and installs. */
function busyDetail(): AgentDetail {
  const agent = fleet().agents.find((row) => row.id === AGENT_ALPHA)!;
  return {
    ...agentDetail({
      ...agent,
      host: { hostname: "ws-1", coder: { owner: "steve", workspace: "omni" } },
    }),
    runningNow: [
      {
        id: "job-running",
        type: "ralph.story",
        label: "Building SOC-1720",
        run: { id: RUN_ID, kind: "epic", title: "Billing exports" },
        repository: { id: "repo-1", provider: "gitlab", fullPath: "acme/billing" },
        workItem: { tracker: "linear", identifier: "SOC-1700", url: null },
        step: "Story 2 of 3",
        startedAt: ago(5 * MINUTE),
      },
    ],
    recentWork: [
      {
        id: "job-1",
        type: "worktree.cleanup",
        label: "Cleaned up the SOC-1719 worktree",
        status: "completed",
        durationMs: 3_000,
        finishedAt: ago(MINUTE),
        run: { id: OTHER_RUN, kind: "epic", title: "Billing exports" },
      },
      {
        id: "job-2",
        type: "repo.sync",
        label: "Couldn't sync docs",
        status: "failed",
        durationMs: 40_000,
        finishedAt: ago(2 * MINUTE),
        run: null,
      },
      {
        id: "job-3",
        type: "ralph.story",
        label: "Stopped building SOC-1718",
        status: "canceled",
        durationMs: 120_000,
        finishedAt: ago(3 * MINUTE),
        run: null,
      },
      {
        id: "job-4",
        type: "repo.sync",
        label: "Didn't sync api in time",
        status: "expired",
        durationMs: null,
        finishedAt: ago(4 * MINUTE),
        run: null,
      },
    ],
    models: [
      { value: "claude-opus-5-5", displayName: "Opus 5.5" },
      { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
    ],
    installables: [
      { name: "gh", version: "2.0.0" },
      { name: "ripgrep", version: "14.1.0" },
    ],
    installs: [
      { id: "i-1", name: "jq", state: "installing", error: null, createdAt: ago(MINUTE) },
      {
        id: "i-2",
        name: "yq",
        state: "failed",
        error: "Not on the allow-list",
        createdAt: ago(60 * MINUTE),
      },
    ],
    security: {
      lastTokenRefreshAt: ago(2 * MINUTE + 5_000),
      reuseAlerts30d: 0,
      lastReuseAt: null,
      authFailures30d: 0,
    },
  };
}

beforeEach(() => {
  ui.toast.mockReset();
  data = fleet();
  details = { [AGENT_ALPHA]: busyDetail() };
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the agent panel's head", () => {
  it("shows the ⋯ button, status line, mono name, host and Enrolled badges, in order", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    const toolbar = within(panel()).getByRole("toolbar", { name: "Agent actions" });
    const status = within(panel()).getByText("Running · up to date");
    const name = within(panel()).getByRole("heading", { level: 2, name: "coder-1" });
    const badges = panel().querySelector<HTMLElement>(".or-fleet-agent__badges")!;
    const ordered = [toolbar, status, name, badges];
    for (let i = 1; i < ordered.length; i++) {
      expect(
        ordered[i - 1]!.compareDocumentPosition(ordered[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(name.classList.contains("or-mono")).toBe(true);
    expect(badgeTexts(badges)).toEqual(["Coder workspace", "Enrolled Oct 7"]);
    // No organization badge with one organization selected.
    expect(panel().querySelector(".or-ref--org")).toBeNull();
  });

  it("shows the Coder workspace in the host badge's tooltip", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    const host = panel().querySelector<HTMLElement>(".or-fleet-agent__host")!;
    act(() => host.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("steve/omni");
  });

  it("shows the hostname, or no host badge before the agent reports one", async () => {
    details[AGENT_BRAVO] = agentDetail(
      agentRow({ id: AGENT_BRAVO, name: "coder-2", host: { hostname: "build-7", coder: null } }),
    );
    await openAgent(AGENT_BRAVO, "coder-2");
    expect(badgeTexts(panel().querySelector(".or-fleet-agent__badges")!)).toEqual([
      "build-7",
      "Enrolled Oct 7",
    ]);
  });

  it("leaves out the host badge when no host is reported", async () => {
    details[AGENT_BRAVO] = agentDetail(agentRow({ id: AGENT_BRAVO, name: "coder-2", host: null }));
    await openAgent(AGENT_BRAVO, "coder-2");
    expect(badgeTexts(panel().querySelector(".or-fleet-agent__badges")!)).toEqual([
      "Enrolled Oct 7",
    ]);
  });

  it("starts with the organization badge under All organizations", async () => {
    await openAgent(AGENT_ALPHA, "coder-1", { user: allOrganizations });
    const top = panel().querySelector<HTMLElement>(".or-fleet-agent__top")!;
    expect(badgeTexts(top)).toEqual(["Acme"]);
    expect(top.firstElementChild!.classList.contains("or-ref--org")).toBe(true);
  });

  it.each([
    [
      "offline and behind",
      agentRow({
        id: AGENT_BRAVO,
        name: "coder-2",
        online: false,
        status: { kind: "offline", label: "Offline 3d", tone: "fail" },
        version: "2.0.2",
        updateStatus: "manual",
      }),
      "Offline 3d · 1 version behind",
      "fail",
    ],
    [
      "update failed",
      agentRow({
        id: AGENT_BRAVO,
        name: "coder-2",
        status: { kind: "update_failed", label: "Update failed", tone: "fail" },
        version: "2.0.3",
        desiredVersion: "2.0.4",
        updateStatus: "failed",
      }),
      "Update failed: 2.0.4",
      "fail",
    ],
    [
      "revoked",
      agentRow({
        id: AGENT_BRAVO,
        name: "coder-2",
        online: false,
        revoked: true,
        revokedAt: "2026-10-20T12:00:00.000Z",
        status: { kind: "revoked", label: "Revoked", tone: "neutral" },
      }),
      "Revoked Oct 20",
      "neutral",
    ],
  ])("reads the status line when %s", async (_, agent, label, tone) => {
    details[AGENT_BRAVO] = agentDetail(agent);
    await openAgent(AGENT_BRAVO, "coder-2");
    const status = within(panel()).getByText(label);
    expect(status.closest(`[data-tone="${tone}"], .or-status--${tone}`)).not.toBeNull();
  });

  it("copies the agent ID from the ⋯ menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openAgent(AGENT_ALPHA, "coder-1");
    const toolbar = within(panel()).getByRole("toolbar", { name: "Agent actions" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy agent ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(AGENT_ALPHA));
    expect(ui.toast).toHaveBeenCalledWith("Agent ID copied");
  });
});

describe("the agent panel's sections", () => {
  it("lists each running attempt as its run's title with repo, work item and step badges", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    const running = section("Running now")!;
    const items = within(running).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    const link = within(items[0]!).getByRole("link", { name: "Billing exports" });
    expect(link.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
    expect(badgeTexts(items[0]!)).toEqual(["acme/billing", "SOC-1700", "Story 2 of 3"]);
    expect(items[0]!.querySelector(".or-ref--repo")).not.toBeNull();
    expect(items[0]!.querySelector(".or-ref--issue")).not.toBeNull();
  });

  it("lists recent work as sentences with mono durations, failures in the fail tone", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    const items = within(section("Recent work")!).getAllByRole("listitem");
    expect(
      items.map((item) => [
        item.querySelector("a, span")!.textContent,
        item.querySelector(".or-fleet-agent__duration")?.textContent ?? null,
        item.getAttribute("data-tone"),
      ]),
    ).toEqual([
      ["Cleaned up the SOC-1719 worktree", "3s", "neutral"],
      ["Couldn't sync docs", "40s", "fail"],
      ["Stopped building SOC-1718", "2m", "fail"],
      ["Didn't sync api in time", null, "fail"],
    ]);
    expect(items[0]!.querySelector(".or-fleet-agent__duration")!.classList).toContain("or-mono");
    expect(
      within(items[0]!)
        .getByRole("link", { name: "Cleaned up the SOC-1719 worktree" })
        .getAttribute("href"),
    ).toBe(`/runs/${OTHER_RUN}`);
    expect(within(items[1]!).queryByRole("link")).toBeNull();
  });

  it("shows a badge per reported model and the packages with installs in progress or failed", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    expect(badgeTexts(section("Models reported")!)).toEqual(["Opus 5.5", "Sonnet 5.5"]);
    const packages = section("Packages")!;
    expect(badgeTexts(packages)).toEqual(["gh@2.0.0", "ripgrep@14.1.0"]);
    const installs = within(packages).getAllByRole("listitem");
    expect(installs.map((item) => [item.textContent, item.getAttribute("data-tone")])).toEqual([
      ["Installing jq…", null],
      ["Couldn't install yq: Not on the allow-list", "fail"],
    ]);
  });

  it("says when the token was last refreshed", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    const line = within(section("Security")!).getByText(
      "Token refreshed 2 minutes ago · no reuse alerts",
    );
    expect(line.getAttribute("data-tone")).toBe("neutral");
  });

  it("reports token reuse in the fail tone", async () => {
    details[AGENT_ALPHA] = {
      ...busyDetail(),
      security: {
        lastTokenRefreshAt: ago(MINUTE),
        reuseAlerts30d: 1,
        lastReuseAt: "2026-10-20T12:00:00.000Z",
        authFailures30d: 0,
      },
    };
    await openAgent(AGENT_ALPHA, "coder-1");
    const line = within(section("Security")!).getByText("Token reuse detected Oct 20");
    expect(line.getAttribute("data-tone")).toBe("fail");
  });

  it("shows each empty state, and no Running now when nothing runs", async () => {
    details[AGENT_BRAVO] = agentDetail(
      agentRow({
        id: AGENT_BRAVO,
        name: "coder-2",
        lastHeartbeatAt: null,
        online: false,
        status: { kind: "never_connected", label: "Never connected", tone: "neutral" },
      }),
    );
    await openAgent(AGENT_BRAVO, "coder-2");
    expect(section("Running now")).toBeNull();
    expect(within(section("Recent work")!).getByText("No recent work")).toBeTruthy();
    expect(within(section("Models reported")!).getByText("None reported")).toBeTruthy();
    expect(within(section("Packages")!).getByText("None installed")).toBeTruthy();
    expect(within(section("Security")!).getByText("Never connected")).toBeTruthy();
  });

  it("has no On the machine section and no control for settings set elsewhere", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    const text = panel().textContent!;
    for (const label of [
      /On the machine/i,
      /Pinned/i,
      /Pin /,
      /concurrency/i,
      /Accepted kinds/i,
      /Accept /,
      /Host tools?/i,
      /Version/,
      /Update now/i,
      /Agent settings/i,
    ]) {
      expect(text, String(label)).not.toMatch(label);
    }
    for (const role of ["textbox", "combobox", "spinbutton", "checkbox", "switch"]) {
      expect(within(panel()).queryAllByRole(role), role).toEqual([]);
    }
    // Only the ⋯ button.
    expect(
      within(panel())
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["More actions"]);
  });
});

describe("live updates", () => {
  async function connected(live: ReturnType<typeof fakeAbly>) {
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
  }
  const deliver = (live: ReturnType<typeof fakeAbly>, organizationId: string, ids: string[]) =>
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(organizationId, { resource: "agent", ids }),
        ),
    );

  it("moves a finished attempt from Running now to Recent work and shows Offline", async () => {
    const live = fakeAbly();
    await openAgent(AGENT_ALPHA, "coder-1", { live });
    await connected(live);
    expect(section("Running now")).not.toBeNull();

    const before = busyDetail();
    const offline = agentRow({
      ...before.agent,
      online: false,
      runningCount: 0,
      status: { kind: "offline", label: "Offline 1m", tone: "fail" },
    });
    details[AGENT_ALPHA] = {
      ...before,
      agent: { ...offline, organization: before.agent.organization },
      runningNow: [],
      recentWork: [
        {
          id: "job-running",
          type: "ralph.story",
          label: "Built SOC-1720",
          status: "completed",
          durationMs: 300_000,
          finishedAt: ago(0),
          run: { id: RUN_ID, kind: "epic", title: "Billing exports" },
        },
        ...before.recentWork,
      ],
    };
    deliver(live, TEST_ORGANIZATION_ID, [AGENT_ALPHA]);

    await waitFor(() => expect(section("Running now")).toBeNull());
    expect(within(panel()).getByText("Offline 1m · up to date")).toBeTruthy();
    const first = within(section("Recent work")!).getAllByRole("listitem")[0]!;
    expect(within(first).getByRole("link", { name: "Built SOC-1720" })).toBeTruthy();
    expect(first.querySelector(".or-fleet-agent__duration")!.textContent).toBe("5m");
    expect(detailRequests(AGENT_ALPHA)).toHaveLength(2);
  });

  it("ignores another organization's agent events", async () => {
    const live = fakeAbly();
    await openAgent(AGENT_ALPHA, "coder-1", { live });
    await connected(live);
    deliver(live, BETA_ID, [AGENT_ALPHA]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(detailRequests(AGENT_ALPHA)).toHaveLength(1);
  });
});

describe("the split", () => {
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

  it("opens the first agent beside the table on /fleet in a wide container", async () => {
    renderFleet();
    await screen.findByRole("table", { name: "Agents" });
    resize(1200);
    expect(await within(panel()).findByRole("heading", { level: 2, name: "coder-1" })).toBeTruthy();
    expect(split().getAttribute("data-view")).toBe("list");
    expect(detailRequests(AGENT_ALPHA)).toHaveLength(1);
    expect(detailRequests(AGENT_REVOKED)).toHaveLength(0);
  });

  it("shows only the table on /fleet in a narrow container", async () => {
    renderFleet();
    await screen.findByRole("table", { name: "Agents" });
    resize(700);
    expect(split().getAttribute("data-view")).toBe("list");
    expect(within(panel()).queryByRole("heading", { level: 2 })).toBeNull();
    expect(seen.filter((request) => request.path.startsWith("/api/ui/agents/"))).toEqual([]);
  });

  it("shows the agent with a ‹ Fleet back link on /fleet/{id}", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    resize(700);
    expect(split().getAttribute("data-view")).toBe("detail");
    expect(within(panel()).getByRole("link", { name: /Fleet/ }).getAttribute("href")).toBe(
      "/fleet",
    );
  });

  it.each([
    ["an unknown agent", UNKNOWN],
    ["another organization's agent", AGENT_BETA],
  ])("says the agent doesn't exist for %s", async (_, id) => {
    renderFleet({ agentId: id });
    expect(await within(panel()).findByText(AGENT_NOT_FOUND)).toBeTruthy();
    expect(split().getAttribute("data-view")).toBe("detail");
  });
});
