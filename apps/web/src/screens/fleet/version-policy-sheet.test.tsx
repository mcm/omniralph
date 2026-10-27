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
import type { AgentList } from "@/lib/api/agents";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
import type { VersionPolicy } from "@/lib/fleet/status";
import { FleetView } from "./fleet-view";
import { AGENT_ALPHA, agentRow, BETA_ID, detailRoutes, fleet, summary } from "./test-fixtures";
import { VERSION_REQUIRED, withVersionPolicy } from "./version-policy-sheet";

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
    { id: BETA_ID, name: "Beta", role: "admin" },
  ],
};

const TOO_OLD = "Agents run @omniralph/agent 2.0.0 or later: enter 2.0.0 or a later version.";

function change(overrides: Partial<SettingsHistoryEntry> = {}): SettingsHistoryEntry {
  return {
    id: "change-1",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    section: "agent_defaults",
    subjectId: null,
    actor: { id: "user-2", name: "Grace" },
    changedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    changes: [
      { field: "desiredVersion", label: "Agent version", before: "2.0.2", after: "latest" },
    ],
    runsSince: 3,
    ...overrides,
  };
}

let data: AgentList;
let seen: SeenRequest[];
/** While set, `GET /api/ui/agents` never answers: the view shows the cache. */
let holdReads: boolean;
let saveResponse: (request: SeenRequest) => Response;

beforeEach(() => {
  ui.toast.mockReset();
  data = fleet();
  holdReads = false;
  saveResponse = (request) => {
    const version = (request.body as { version: string }).version;
    const versionPolicy: VersionPolicy =
      version === "latest"
        ? { mode: "latest", version: null, target: "2.2.0" }
        : { mode: "pinned", version, target: version };
    return jsonResponse({ ok: true, versionPolicy });
  };
  seen = mockFetch({
    "GET /api/ui/agents": () => (holdReads ? new Promise<Response>(() => {}) : jsonResponse(data)),
    ...detailRoutes(() => data),
    "PUT /api/ui/agent-defaults": (request) => saveResponse(request),
    "GET /api/ui/settings-history": () =>
      jsonResponse({
        latest: data.versionHistory,
        entries: data.versionHistory ? [data.versionHistory] : [],
        next: null,
      }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderFleet(options: { user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {}) {
  const client = createTestQueryClient();
  const view = <FleetView />;
  render(
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
  return client;
}

/** The page behind an open sheet is `aria-hidden`: look it up hidden too. */
const versionCell = () => screen.getByRole("group", { name: "Version policy", hidden: true });
const versionValue = () => versionCell().querySelector(".or-stats__value")!.textContent;
/** The detail line without its "Edit". */
const versionDetail = () => {
  const detail = versionCell().querySelector(".or-stats__detail")!.cloneNode(true) as HTMLElement;
  detail.querySelector("button")?.remove();
  return detail.textContent;
};
const editButton = () => within(versionCell()).queryByRole("button", { name: "Edit" });
const saves = () => seen.filter((r) => r.method === "PUT" && r.path === "/api/ui/agent-defaults");
const listRequests = () => seen.filter((r) => r.method === "GET" && r.path === "/api/ui/agents");
const sheet = () => screen.getByRole("dialog", { name: "Version policy" });

async function openSheet() {
  await waitFor(() => expect(editButton()).not.toBeNull());
  await userEvent.click(editButton()!);
  return sheet();
}

describe("the Version policy cell", () => {
  it("has Edit for admins of one organization; Org defaults never has one", async () => {
    renderFleet();
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    expect(editButton()).not.toBeNull();
    const defaults = screen.getByRole("group", { name: "Org defaults" });
    expect(within(defaults).queryByRole("button")).toBeNull();
    expect(within(defaults).queryByRole("link")).toBeNull();
  });

  it("shows members no Edit, but the change history", async () => {
    renderFleet({ user: member });
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    expect(editButton()).toBeNull();
    expect(within(versionCell()).getByRole("button", { name: "Change history" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Org defaults" })).queryByRole("button")).toBe(
      null,
    );
  });

  it("shows no Edit and no change history under All organizations", async () => {
    renderFleet({ user: allOrganizations });
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    expect(editButton()).toBeNull();
    expect(within(versionCell()).queryByRole("button", { name: "Change history" })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Org defaults" })).queryByRole("button")).toBe(
      null,
    );
  });

  it("opens the agent_defaults history from its ⓘ", async () => {
    data = { ...fleet(), versionHistory: change() };
    renderFleet();
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    await userEvent.click(within(versionCell()).getByRole("button", { name: "Change history" }));
    expect(await screen.findByText(/^Last changed by Grace, .*, 3 runs since$/)).toBeTruthy();
    expect(await screen.findByText("Agent version: 2.0.2 → latest")).toBeTruthy();
    const history = seen.find((r) => r.path === "/api/ui/settings-history")!;
    expect(history.query.get("section")).toBe("agent_defaults");
  });

  it("says when nothing has changed yet", async () => {
    renderFleet();
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    await userEvent.click(within(versionCell()).getByRole("button", { name: "Change history" }));
    expect(await screen.findByText("No changes recorded yet")).toBeTruthy();
  });
});

describe("the version policy sheet", () => {
  it("offers Track latest or Pin a version, starting from the saved policy", async () => {
    renderFleet();
    const dialog = await openSheet();
    const choice = within(dialog).getByRole("radiogroup", { name: "Version policy" });
    expect(
      within(choice)
        .getAllByRole("radio")
        .map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]),
    ).toEqual([
      ["Track latest", "true"],
      ["Pin a version", "false"],
    ]);
    expect(within(dialog).queryByRole("textbox", { name: "Version" })).toBeNull();
    await userEvent.click(within(choice).getByRole("radio", { name: "Pin a version" }));
    const field = within(dialog).getByRole("textbox", { name: "Version" }) as HTMLInputElement;
    // The version agents are on now, ready to edit.
    expect(field.value).toBe("2.0.3");
    expect(field.className).toContain("or-input--mono");
  });

  it("pins a version and shows it in the cell at once, without a refetch", async () => {
    renderFleet();
    const dialog = await openSheet();
    await waitFor(() => expect(listRequests()).toHaveLength(1));
    holdReads = true;
    await userEvent.click(within(dialog).getByRole("radio", { name: "Pin a version" }));
    const field = within(dialog).getByRole("textbox", { name: "Version" });
    await userEvent.clear(field);
    await userEvent.type(field, " 2.1.0 ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(versionValue()).toBe("Pinned to 2.1.0"));
    expect(saves().map((r) => r.body)).toEqual([{ version: "2.1.0" }]);
    // coder-1 (online, on 2.0.3) is now behind; the reconcile refetch is still pending.
    expect(versionDetail()).toBe("1 agent behind");
    expect(listRequests().length).toBeGreaterThan(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ui.toast).toHaveBeenCalledWith(
      "Saved. Agents update to 2.1.0 with their next heartbeat.",
    );
  });

  it("switches a pinned fleet to Track latest", async () => {
    data = {
      ...fleet(),
      summary: summary({
        total: 2,
        online: 1,
        offline: 1,
        busy: 1,
        versionPolicy: { mode: "pinned", version: "2.0.3", target: "2.0.3" },
      }),
    };
    renderFleet();
    const dialog = await openSheet();
    await waitFor(() => expect(listRequests()).toHaveLength(1));
    holdReads = true;
    expect(within(dialog).getByRole("radio", { name: "Pin a version" })).toHaveProperty(
      "ariaChecked",
      "true",
    );
    await userEvent.click(within(dialog).getByRole("radio", { name: "Track latest" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    expect(saves().map((r) => r.body)).toEqual([{ version: "latest" }]);
    expect(versionDetail()).toBe("1 agent behind");
    expect(ui.toast).toHaveBeenCalledWith("Saved. Agents follow the latest release.");
  });

  it("asks for a version before pinning, without a request", async () => {
    renderFleet();
    const dialog = await openSheet();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Pin a version" }));
    const field = within(dialog).getByRole("textbox", { name: "Version" });
    await userEvent.clear(field);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText(VERSION_REQUIRED)).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(saves()).toEqual([]);
    // Typing clears it.
    await userEvent.type(field, "2");
    expect(within(dialog).queryByText(VERSION_REQUIRED)).toBeNull();
  });

  it("shows the server's field error for a version below 2.0.0 and keeps the policy", async () => {
    saveResponse = () => jsonResponse({ error: TOO_OLD, fieldErrors: { version: TOO_OLD } }, 400);
    renderFleet();
    const dialog = await openSheet();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Pin a version" }));
    const field = within(dialog).getByRole("textbox", { name: "Version" });
    await userEvent.clear(field);
    await userEvent.type(field, "1.9.9");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText(TOO_OLD)).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(sheet()).toBeTruthy();
    expect(versionValue()).toBe("Track latest");
    expect(ui.toast).toHaveBeenCalledWith(TOO_OLD, { variant: "danger" });
  });

  it("shows why tracking latest failed, in the sheet", async () => {
    const error = "Couldn't read the latest version: the registry answered 500.";
    data = {
      ...fleet(),
      summary: summary({ versionPolicy: { mode: "pinned", version: "2.0.3", target: "2.0.3" } }),
    };
    saveResponse = () => jsonResponse({ error }, 400);
    renderFleet();
    const dialog = await openSheet();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Track latest" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(error);
    expect(versionValue()).toBe("Pinned to 2.0.3");
  });

  it("closes on Cancel without saving, and starts over when opened again", async () => {
    renderFleet();
    let dialog = await openSheet();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Pin a version" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saves()).toEqual([]);
    dialog = await openSheet();
    expect(within(dialog).getByRole("radio", { name: "Track latest" })).toHaveProperty(
      "ariaChecked",
      "true",
    );
  });
});

describe("live updates", () => {
  const connected = (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`));

  it("shows another admin's change and its provenance through the settings event", async () => {
    const live = fakeAbly();
    renderFleet({ live, user: member });
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    await connected(live, TEST_ORGANIZATION_ID);

    data = {
      ...fleet(),
      summary: summary({ versionPolicy: { mode: "pinned", version: "2.0.4", target: "2.0.4" } }),
      versionHistory: change({
        actor: { id: "user-3", name: "Lin" },
        changes: [
          { field: "desiredVersion", label: "Agent version", before: "latest", after: "2.0.4" },
        ],
        runsSince: 0,
      }),
    };
    act(() =>
      live.current().deliver(
        `org:${TEST_ORGANIZATION_ID}:changes`,
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "settings",
          section: "agent_defaults",
          ids: [TEST_ORGANIZATION_ID],
        }),
      ),
    );
    await waitFor(() => expect(versionValue()).toBe("Pinned to 2.0.4"));
    await userEvent.click(within(versionCell()).getByRole("button", { name: "Change history" }));
    expect(await screen.findByText(/^Last changed by Lin, .*, 0 runs since$/)).toBeTruthy();
  });

  it("ignores another organization's settings events", async () => {
    const live = fakeAbly();
    renderFleet({ live });
    await waitFor(() => expect(versionValue()).toBe("Track latest"));
    await connected(live, TEST_ORGANIZATION_ID);
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(BETA_ID, { resource: "settings", section: "agent_defaults", ids: [BETA_ID] }),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listRequests()).toHaveLength(1);
  });
});

describe("withVersionPolicy", () => {
  const pinned = (version: string): VersionPolicy => ({ mode: "pinned", version, target: version });

  it("recomputes the organization's agents and the counts, keeping overrides", () => {
    const list: AgentList = {
      agents: [
        agentRow({ id: AGENT_ALPHA, name: "on-target", version: "2.1.0" }),
        agentRow({
          name: "overridden",
          version: "2.0.3",
          desiredVersionOverride: "2.0.3",
          tracksLatest: false,
        }),
        agentRow({
          name: "manual",
          version: "2.0.3",
          selfUpdate: "unsupported",
          status: { kind: "idle", label: "Idle", tone: "neutral" },
        }),
        agentRow({
          name: "beta",
          organization: { id: BETA_ID, name: "Beta", role: "admin" },
          version: "2.0.3",
        }),
      ],
      summary: summary(),
      versionHistory: null,
    };
    const next = withVersionPolicy(list, TEST_ORGANIZATION_ID, pinned("2.1.0"));
    expect(
      next.agents.map((a) => [a.name, a.desiredVersion, a.tracksLatest, a.updateStatus]),
    ).toEqual([
      ["on-target", "2.1.0", false, "up_to_date"],
      ["overridden", "2.0.3", false, "up_to_date"],
      ["manual", "2.1.0", false, "manual"],
      // Another organization's agent keeps its own policy.
      ["beta", "2.0.3", true, "up_to_date"],
    ]);
    expect(next.summary.versionPolicy).toEqual(pinned("2.1.0"));
    expect(next.summary.versions).toEqual({ onTarget: 3, behind: 1, updateFailed: 0 });
  });

  it("marks an agent whose new target failed before as Update failed", () => {
    const list: AgentList = {
      agents: [agentRow({ version: "2.0.3", failedVersions: ["2.1.0"] })],
      summary: summary(),
      versionHistory: null,
    };
    const next = withVersionPolicy(list, TEST_ORGANIZATION_ID, pinned("2.1.0"));
    expect(next.agents[0]!.status).toMatchObject({ kind: "update_failed", label: "Update failed" });
    expect(next.summary.versions).toEqual({ onTarget: 0, behind: 0, updateFailed: 1 });
  });
});
