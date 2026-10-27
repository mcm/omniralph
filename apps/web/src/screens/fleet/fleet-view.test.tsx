// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { SummaryCells, UiProvider, type LinkProps } from "@omniralph/ui";
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
import type { AgentList, FleetSummary } from "@/lib/api/agents";
import { fleetSummaryCells, FleetView } from "./fleet-view";
import {
  AGENT_ALPHA,
  AGENT_BETA,
  AGENT_BRAVO,
  AGENT_REVOKED,
  agentRow,
  BETA_ID,
  detailRoutes,
  fleet,
  summary,
} from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/fleet",
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
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

const ENROLLMENT_ID = "0b6a3c1e-8f4d-4c2a-9e1b-7d5f3a2c1b0e";

let data: AgentList;
let seen: SeenRequest[];

function serve(extra: Parameters<typeof mockFetch>[0] = {}) {
  seen = mockFetch({
    "GET /api/ui/agents": () => jsonResponse(data),
    ...detailRoutes(() => data),
    ...extra,
  });
}

function renderFleet(
  options: {
    agentId?: string;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
  } = {},
) {
  const client = options.client ?? createTestQueryClient();
  const view = <FleetView agentId={options.agentId} />;
  const utils = render(
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
  return { ...utils, client };
}

const table = () => screen.getByRole("table", { name: "Agents" });
const bodyRows = () => within(table()).getAllByRole("row").slice(1);
const cards = () => within(screen.getByRole("list", { name: "Agents" })).getAllByRole("listitem");
const healthCell = () => screen.getByRole("group", { name: "Health" });
const listRequests = () =>
  seen.filter((request) => request.method === "GET" && request.path === "/api/ui/agents");
const badgeTexts = (element: HTMLElement) =>
  [...element.querySelectorAll(".or-ref__text")].map((badge) => badge.textContent!.trim());

beforeEach(() => {
  nav.router.push.mockReset();
  ui.toast.mockReset();
  data = fleet();
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Fleet", () => {
  it("shows the heading, Enroll, the summary and the agents of the active organization", async () => {
    renderFleet();
    expect(screen.getByRole("heading", { level: 1, name: "Fleet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enroll" })).toBeTruthy();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(screen.getByRole("region", { name: "Summary" })).toBeTruthy();
    expect(listRequests()[0]!.query.get("organization")).toBe(TEST_ORGANIZATION_ID);
  });

  it("shows a member no Enroll", async () => {
    renderFleet({ user: member });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Enroll" })).toBeNull();
  });

  it("asks for every organization under All organizations", async () => {
    renderFleet({ user: allOrganizations });
    await waitFor(() => expect(listRequests()).toHaveLength(1));
    expect(listRequests()[0]!.query.get("organization")).toBe("all");
  });

  it("shows a failed load with Try again", async () => {
    let fail = true;
    serve({
      "GET /api/ui/agents": () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(data),
    });
    renderFleet();
    expect(await screen.findByRole("heading", { name: "Couldn't load agents" })).toBeTruthy();
    expect(screen.getByText("Database unavailable.")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
  });
});

describe("the summary", () => {
  const renderCells = (value: FleetSummary) =>
    render(
      <UiProvider linkComponent={TestLink}>
        <SummaryCells cells={fleetSummaryCells(value)} />
      </UiProvider>,
    );
  const cell = (name: string) => screen.getByRole("group", { name });
  const value = (name: string) => cell(name).querySelector(".or-stats__value")!;
  const detail = (name: string) => cell(name).querySelector(".or-stats__detail");

  it("shows health with the offline part in the fail tone, then the busy count", () => {
    renderCells(summary());
    expect(value("Health").textContent).toBe("6 of 7 online · 1 offline");
    expect(within(cell("Health")).getByText("1 offline").className).toContain("or-fleet__fail");
    expect(detail("Health")!.textContent).toBe("1 busy");
  });

  it("leaves out the offline part at zero", () => {
    renderCells(summary({ online: 7, offline: 0, busy: 0 }));
    expect(value("Health").textContent).toBe("7 of 7 online");
    expect(cell("Health").querySelector(".or-fleet__fail")).toBeNull();
    expect(detail("Health")!.textContent).toBe("0 busy");
  });

  it("shows Track latest with every agent on the target version as a mono badge", () => {
    renderCells(summary());
    expect(value("Version policy").textContent).toBe("Track latest");
    expect(detail("Version policy")!.textContent).toBe("All agents on2.0.3");
    const badge = cell("Version policy").querySelector(".or-ref")!;
    expect(badge.textContent).toBe("2.0.3");
    expect(badge.querySelector(".or-mono")).toBeTruthy();
    expect(within(cell("Version policy")).queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("shows a pinned version with agents behind, neutral", () => {
    renderCells(
      summary({
        versionPolicy: { mode: "pinned", version: "2.0.3", target: "2.0.3" },
        versions: { onTarget: 4, behind: 2, updateFailed: 0 },
      }),
    );
    expect(value("Version policy").textContent).toBe("Pinned to 2.0.3");
    expect(detail("Version policy")!.textContent).toBe("2 agents behind");
    expect(cell("Version policy").querySelector(".or-fleet__fail")).toBeNull();
  });

  it("shows a failed update in the fail tone", () => {
    renderCells(summary({ versions: { onTarget: 5, behind: 1, updateFailed: 1 } }));
    const failed = within(cell("Version policy")).getByText("1 update failed");
    expect(failed.className).toContain("or-fleet__fail");
  });

  it("says Varies by organization when the organizations' policies differ", () => {
    renderCells(summary({ versionPolicy: null }));
    expect(value("Version policy").textContent).toBe("Varies by organization");
  });

  it("shows the accepted kinds without an Edit link", () => {
    renderCells(summary());
    expect(value("Org defaults").textContent).toBe("Accept all kinds");
    expect(detail("Org defaults")).toBeNull();
    expect(within(cell("Org defaults")).queryByRole("link")).toBeNull();
  });

  it("counts agents that limit their kinds", () => {
    renderCells(summary({ acceptedKinds: { limited: 2, total: 7 } }));
    expect(value("Org defaults").textContent).toBe("2 of 7 agents limit kinds");
  });
});

describe("the agents table", () => {
  it("has the Agent, Status and Pinned repos columns, without Org for one organization", async () => {
    renderFleet();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    const headers = within(table())
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers).toEqual(["Agent", "Status", "Pinned repos"]);
  });

  it("sorts by name with revoked agents last", async () => {
    renderFleet();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(bodyRows().map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([
      "coder-1",
      "coder-2",
      "aardvark",
    ]);
  });

  it("links each mono name to its agent", async () => {
    renderFleet();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    const link = within(bodyRows()[0]!).getByRole("link", { name: "coder-1" });
    expect(link.getAttribute("href")).toBe(`/fleet/${AGENT_ALPHA}`);
    expect(link.closest("td")!.className).toContain("or-mono");
  });

  it("shows each status with its dot in its tone", async () => {
    renderFleet();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    const status = (index: number) =>
      within(bodyRows()[index]!).getAllByRole("cell")[1]!.querySelector(".or-status")!;
    expect(status(0).textContent).toBe("Running 2");
    expect(status(0).className).toContain("or-status--run");
    expect(status(0).querySelector(".or-dot--run")).toBeTruthy();
    expect(status(1).textContent).toBe("Offline 3d");
    expect(status(1).className).toContain("or-status--fail");
    expect(status(2).textContent).toBe("Revoked");
    expect(status(2).className).toContain("or-status--neutral");
  });

  it("shows two pins as badges, and three as the first and +2", async () => {
    renderFleet();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    const pinsCell = (index: number) => within(bodyRows()[index]!).getAllByRole("cell")[2]!;
    expect(badgeTexts(pinsCell(0))).toEqual(["acme/repo-1", "acme/repo-2"]);
    expect(badgeTexts(pinsCell(1))).toEqual(["acme/repo-1", "+2"]);
    expect(pinsCell(2).textContent).toBe("None");
  });

  it("marks the open agent's row current", async () => {
    renderFleet({ agentId: AGENT_BRAVO });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(bodyRows().map((row) => row.getAttribute("aria-current"))).toEqual([null, "true", null]);
    const detail = screen.getByRole("region", { name: "Agent" });
    expect(await within(detail).findByRole("heading", { level: 2, name: "coder-2" })).toBeTruthy();
    expect(within(detail).getByRole("link", { name: /Fleet/ }).getAttribute("href")).toBe("/fleet");
    expect(document.querySelector(".or-split")!.getAttribute("data-view")).toBe("detail");
    expect(document.querySelector(".or-split")!.getAttribute("data-fixed")).toBe("detail");
  });

  it("shows the list pane alone on /fleet when the content area is narrow", async () => {
    renderFleet();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(document.querySelector(".or-split")!.getAttribute("data-view")).toBe("list");
    expect(bodyRows().every((row) => row.getAttribute("aria-current") === null)).toBe(true);
  });

  it("adds the Org column and badges under All organizations", async () => {
    data = {
      ...fleet(),
      agents: [
        ...fleet().agents,
        agentRow({
          id: AGENT_BETA,
          name: "beta-1",
          organization: { id: BETA_ID, name: "Beta", role: "member" },
        }),
      ],
    };
    renderFleet({ user: allOrganizations });
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    expect(within(table()).getAllByRole("columnheader").at(-1)!.textContent).toBe("Org");
    const beta = bodyRows().find((row) => row.textContent!.includes("beta-1"))!;
    expect(badgeTexts(within(beta).getAllByRole("cell").at(-1)!)).toEqual(["Beta"]);
  });
});

describe("the phone cards", () => {
  it("show the name, status and pins of each agent, linking to it", async () => {
    renderFleet();
    await waitFor(() => expect(cards()).toHaveLength(3));
    const [first, second] = cards();
    const link = within(first!).getByRole("link", { name: "coder-1" });
    expect(link.getAttribute("href")).toBe(`/fleet/${AGENT_ALPHA}`);
    expect(first!.querySelector(".or-status")!.textContent).toBe("Running 2");
    expect(badgeTexts(first!)).toEqual(["acme/repo-1", "acme/repo-2"]);
    expect(within(second!).getByRole("link", { name: "coder-2" }).getAttribute("href")).toBe(
      `/fleet/${AGENT_BRAVO}`,
    );
    expect(second!.querySelector(".or-status--fail")!.textContent).toBe("Offline 3d");
    expect(badgeTexts(second!)).toEqual(["acme/repo-1", "+2"]);
  });

  it("add the organization badge under All organizations", async () => {
    renderFleet({ user: allOrganizations });
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(badgeTexts(cards()[0]!)).toEqual(["acme/repo-1", "acme/repo-2", "Acme"]);
  });

  it("mark the open agent's card current", async () => {
    renderFleet({ agentId: AGENT_REVOKED });
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(cards()[2]!.getAttribute("aria-current")).toBe("true");
  });
});

describe("with no agents", () => {
  beforeEach(() => {
    data = {
      agents: [],
      summary: summary({ total: 0, online: 0, offline: 0, busy: 0 }),
      versionHistory: null,
    };
  });

  it("shows No agents yet with Enroll for admins", async () => {
    renderFleet();
    const empty = (await screen.findByRole("heading", { name: "No agents yet" })).closest(
      ".or-empty",
    ) as HTMLElement;
    await userEvent.click(within(empty).getByRole("button", { name: "Enroll" }));
    expect(await screen.findByRole("dialog", { name: "Enroll an agent" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows members no Enroll", async () => {
    renderFleet({ user: member });
    const heading = await screen.findByRole("heading", { name: "No agents yet" });
    expect(within(heading.closest(".or-empty") as HTMLElement).queryByRole("button")).toBeNull();
  });
});

describe("live updates", () => {
  async function connected(live: ReturnType<typeof fakeAbly>, organizationId: string) {
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`),
    );
  }
  const deliver = (
    live: ReturnType<typeof fakeAbly>,
    organizationId: string,
    event: Parameters<typeof changeEvent>[1],
  ) =>
    act(() =>
      live.current().deliver(`org:${organizationId}:changes`, changeEvent(organizationId, event)),
    );

  it("turns a row Offline and updates Health when the liveness cron marks an agent offline", async () => {
    const live = fakeAbly();
    renderFleet({ live });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    await connected(live, TEST_ORGANIZATION_ID);
    expect(healthCell().querySelector(".or-stats__value")!.textContent).toBe(
      "1 of 2 online · 1 offline",
    );

    const next = fleet();
    next.agents[2] = {
      ...next.agents[2]!,
      online: false,
      status: { kind: "offline", label: "Offline 1m", tone: "fail" },
    };
    next.summary = { ...next.summary, online: 0, offline: 2 };
    data = next;
    deliver(live, TEST_ORGANIZATION_ID, { resource: "agent", ids: [AGENT_ALPHA] });

    await waitFor(() =>
      expect(within(bodyRows()[0]!).getAllByRole("cell")[1]!.textContent).toBe("Offline 1m"),
    );
    expect(healthCell().querySelector(".or-stats__value")!.textContent).toBe(
      "0 of 2 online · 2 offline",
    );
    expect(listRequests()).toHaveLength(2);
  });

  it("ignores another organization's agent events", async () => {
    const live = fakeAbly();
    renderFleet({ live });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    await connected(live, TEST_ORGANIZATION_ID);
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(BETA_ID, { resource: "agent", ids: [AGENT_BETA] }),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listRequests()).toHaveLength(1);
  });

  it("refetches on another organization's agent event under All organizations", async () => {
    const live = fakeAbly();
    renderFleet({ live, user: allOrganizations });
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    await connected(live, BETA_ID);
    deliver(live, BETA_ID, { resource: "agent", ids: [AGENT_BETA] });
    await waitFor(() => expect(listRequests()).toHaveLength(2));
  });
});

describe("the Enroll sheet", () => {
  function serveEnrollment(state: { enrolled: boolean }) {
    serve({
      "GET /api/ui/agents": () =>
        jsonResponse(
          state.enrolled
            ? {
                agents: [agentRow({ name: "build-box" })],
                summary: summary(),
                versionHistory: null,
              }
            : {
                agents: [],
                summary: summary({ total: 0, online: 0, offline: 0, busy: 0 }),
                versionHistory: null,
              },
        ),
      "POST /api/ui/agent-enrollments": () =>
        jsonResponse({
          ok: true,
          id: ENROLLMENT_ID,
          token: "ore_secret",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          command: "omniralph-agent enroll --server https://x --token ore_secret",
        }),
      [`GET /api/ui/agent-enrollments/${ENROLLMENT_ID}`]: () =>
        jsonResponse({
          id: ENROLLMENT_ID,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          agent: state.enrolled ? { id: AGENT_ALPHA, name: "build-box" } : null,
        }),
    });
  }

  async function generate(name: string) {
    await userEvent.click(screen.getAllByRole("button", { name: "Enroll" })[0]!);
    const sheet = await screen.findByRole("dialog", { name: "Enroll an agent" });
    if (name) await userEvent.type(within(sheet).getByLabelText("Name"), name);
    await userEvent.click(within(sheet).getByRole("button", { name: "Generate token" }));
    await within(sheet).findByLabelText("Token");
    return sheet;
  }

  it("creates an enrollment and shows the token and both commands with copy buttons", async () => {
    serveEnrollment({ enrolled: false });
    renderFleet();
    await screen.findByRole("heading", { name: "No agents yet" });
    const sheet = await generate("build-box");
    const post = seen.find((request) => request.method === "POST")!;
    expect(post.body).toEqual({ name: "build-box" });
    expect(within(sheet).getByLabelText("Token").textContent).toBe("ore_secret");
    expect(within(sheet).getByLabelText("Install command").textContent).toBe(
      "npm install -g @omniralph/agent",
    );
    expect(within(sheet).getByLabelText("Enroll command").textContent).toBe(
      "omniralph-agent enroll --server https://x --token ore_secret",
    );
    expect(within(sheet).getByRole("status").textContent).toBe("Waiting for build-box to connect…");
    for (const label of ["Copy install command", "Copy enroll command", "Copy token"]) {
      expect(within(sheet).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("copies with a toast", async () => {
    serveEnrollment({ enrolled: false });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderFleet();
    await screen.findByRole("heading", { name: "No agents yet" });
    const sheet = await generate("");
    await userEvent.click(within(sheet).getByRole("button", { name: "Copy token" }));
    expect(writeText).toHaveBeenCalledWith("ore_secret");
    expect(ui.toast).toHaveBeenCalledWith("Token copied");
    expect(within(sheet).getByRole("status").textContent).toBe("Waiting for the agent to connect…");
  });

  it("says when copying fails", async () => {
    serveEnrollment({ enrolled: false });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    renderFleet();
    await screen.findByRole("heading", { name: "No agents yet" });
    const sheet = await generate("");
    await userEvent.click(within(sheet).getByRole("button", { name: "Copy enroll command" }));
    expect(ui.toast).toHaveBeenCalledWith("Couldn't copy to the clipboard", {
      variant: "danger",
    });
  });

  it("switches to Connected when the new agent's event arrives, and lists the agent", async () => {
    const state = { enrolled: false };
    serveEnrollment(state);
    const live = fakeAbly();
    renderFleet({ live });
    await screen.findByRole("heading", { name: "No agents yet" });
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const sheet = await generate("build-box");

    // The agent redeems the token: enrolling publishes its `agent` event.
    state.enrolled = true;
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "agent", ids: [AGENT_ALPHA] }),
        ),
    );
    await waitFor(() => expect(within(sheet).getByRole("status").textContent).toBe("Connected"));
    const open = within(sheet).getByRole("link", { name: "Open build-box" });
    expect(open.getAttribute("href")).toBe(`/fleet/${AGENT_ALPHA}`);
    // The table behind the sheet (hidden from assistive tech while it's open) shows the agent
    // without a reload.
    const behind = () =>
      within(screen.getByRole("table", { name: "Agents", hidden: true }))
        .getAllByRole("row", { hidden: true })
        .slice(1);
    await waitFor(() => expect(behind()).toHaveLength(1));
    expect(behind()[0]!.textContent).toContain("build-box");
    expect(listRequests()).toHaveLength(2);
  });

  it("forgets the token when it closes", async () => {
    serveEnrollment({ enrolled: false });
    renderFleet();
    await screen.findByRole("heading", { name: "No agents yet" });
    const sheet = await generate("build-box");
    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(screen.getAllByRole("button", { name: "Enroll" })[0]!);
    const again = await screen.findByRole("dialog", { name: "Enroll an agent" });
    expect(within(again).queryByLabelText("Token")).toBeNull();
    expect(within(again).getByRole("button", { name: "Generate token" })).toBeTruthy();
  });
});
