// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type { AgentDetail, AgentList, FleetAgentRow } from "@/lib/api/agents";
import {
  INSTALL_ALLOW_LIST,
  NOT_ON_ALLOW_LIST,
  PACKAGE_NAME_REQUIRED,
  REMOVE_DESCRIPTION,
  REVOKE_DESCRIPTION,
} from "./agent-actions";
import { AGENT_NOT_FOUND } from "./agent-panel";
import { FleetView } from "./fleet-view";
import {
  AGENT_ALPHA,
  AGENT_BETA,
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

const nav = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/fleet",
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

let data: AgentList;
let details: Record<string, AgentDetail>;
let seen: SeenRequest[];
/** While true, every read (list and details) stays pending: a refetch never lands. */
let holdReads: boolean;

function serve(extra: Parameters<typeof mockFetch>[0] = {}) {
  const reads: Parameters<typeof mockFetch>[0] = {
    "GET /api/ui/agents": () => jsonResponse(data),
    ...detailRoutes(
      () => data,
      () => details,
    ),
  };
  const held = Object.fromEntries(
    Object.entries(reads).map(([key, route]) => [
      key,
      (request: SeenRequest) =>
        holdReads
          ? new Promise<Response>(() => {})
          : (route as (request: SeenRequest) => Response)(request),
    ]),
  );
  seen = mockFetch({ ...held, ...extra });
}

beforeEach(() => {
  data = fleet();
  details = {};
  holdReads = false;
  ui.toast.mockClear();
  nav.router.push.mockClear();
  serve();
});

function renderFleet(
  options: { agentId?: string; user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {},
) {
  const view = <FleetView agentId={options.agentId} />;
  return render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
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
const tableRow = (name: string) =>
  within(screen.getByRole("table", { name: "Agents", hidden: true })).queryByRole("row", {
    name: new RegExp(`^${name}\\b`),
    hidden: true,
  });
const writes = (method: string, path: string) =>
  seen.filter((request) => request.method === method && request.path === path);

async function openAgent(
  id: string,
  name: string,
  options: Parameters<typeof renderFleet>[0] = {},
) {
  renderFleet({ ...options, agentId: id });
  await within(panel()).findByRole("heading", { level: 2, name });
  await screen.findByRole("table", { name: "Agents" });
}

/** Opens the ⋯ menu and answers its items' labels, "—" for a separator. */
async function openMenu() {
  const toolbar = within(panel()).getByRole("toolbar", { name: "Agent actions" });
  await userEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
  const menu = await screen.findByRole("menu");
  const items = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((item) =>
    item.getAttribute("role") === "separator" ? "—" : item.textContent!.trim(),
  );
  return { menu, items };
}

async function choose(label: string) {
  const { menu } = await openMenu();
  await userEvent.click(within(menu).getByRole("menuitem", { name: label }));
}

/** The test organization's agents, with the user's role there. */
function withRole(role: "admin" | "member") {
  data = {
    ...data,
    agents: data.agents.map((row) => ({ ...row, organization: { ...row.organization, role } })),
  };
}

describe("the ⋯ menu", () => {
  it("offers an admin Install package…, Audit log, Copy agent ID, then Revoke agent… on a live agent", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    expect((await openMenu()).items).toEqual([
      "Install package…",
      "Audit log",
      "Copy agent ID",
      "—",
      "Revoke agent…",
    ]);
  });

  it("offers an admin Audit log, Copy agent ID, then Remove agent… on a revoked agent", async () => {
    await openAgent(AGENT_REVOKED, "aardvark");
    expect((await openMenu()).items).toEqual(["Audit log", "Copy agent ID", "—", "Remove agent…"]);
  });

  it.each([
    ["a live", AGENT_ALPHA, "coder-1"],
    ["a revoked", AGENT_REVOKED, "aardvark"],
  ])("offers a member only Audit log and Copy agent ID on %s agent", async (_, id, name) => {
    withRole("member");
    await openAgent(id, name, {
      user: {
        ...testUser,
        role: "member",
        organizations: [{ ...testUser.organization, role: "member" }],
      },
    });
    expect((await openMenu()).items).toEqual(["Audit log", "Copy agent ID"]);
  });

  it("follows the role in the agent's own organization under All organizations", async () => {
    const beta: FleetAgentRow = agentRow({
      id: AGENT_BETA,
      name: "beta-1",
      organization: { id: BETA_ID, name: "Beta", role: "member" },
    });
    data = { ...data, agents: [...data.agents, beta] };
    serve();
    await openAgent(AGENT_BETA, "beta-1", {
      user: {
        ...testUser,
        scope: "all",
        organizations: [
          { ...testUser.organization, role: "admin" },
          { id: BETA_ID, name: "Beta", role: "member" },
        ],
      },
    });
    expect((await openMenu()).items).toEqual(["Audit log", "Copy agent ID"]);
  });

  it("copies the agent ID, or says it couldn't", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Copy agent ID");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(AGENT_ALPHA));
    expect(ui.toast).toHaveBeenCalledWith("Agent ID copied");

    writeText.mockRejectedValue(new Error("denied"));
    await choose("Copy agent ID");
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Couldn't copy to the clipboard", {
        variant: "danger",
      }),
    );
  });
});

describe("Install package…", () => {
  const sheet = () => screen.getByRole("dialog", { name: "Install package" });
  const field = (name: string) => within(sheet()).getByRole("textbox", { name });

  it("asks for a package (required, at most 214) and an optional version", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Install package…");
    expect(within(sheet()).getByText(INSTALL_ALLOW_LIST)).toBeTruthy();
    expect(field("Package").getAttribute("maxlength")).toBe("214");
    expect(field("Version").getAttribute("placeholder")).toBe("latest");

    await userEvent.click(within(sheet()).getByRole("button", { name: "Install" }));
    expect(within(sheet()).getByText(PACKAGE_NAME_REQUIRED)).toBeTruthy();
    await userEvent.type(field("Package"), "   ");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Install" }));
    expect(writes("POST", `/api/ui/agents/${AGENT_ALPHA}/installs`)).toEqual([]);
  });

  it("queues the install, closes, and shows Installing… before any refetch lands", async () => {
    serve({
      [`POST /api/ui/agents/${AGENT_ALPHA}/installs`]: () =>
        jsonResponse({ ok: true, jobId: "job-install" }),
    });
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Install package…");
    await userEvent.type(field("Package"), " ripgrep ");
    holdReads = true;
    await userEvent.click(within(sheet()).getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Install package" })).toBeNull(),
    );
    const packages = within(panel()).getByRole("region", { name: "Packages" });
    expect(within(packages).getByText("Installing ripgrep…")).toBeTruthy();
    expect(writes("POST", `/api/ui/agents/${AGENT_ALPHA}/installs`)[0]!.body).toEqual({
      name: "ripgrep",
    });
    expect(ui.toast).toHaveBeenCalledWith("Installing ripgrep on coder-1");
  });

  it("sends the version when one is given", async () => {
    serve({
      [`POST /api/ui/agents/${AGENT_ALPHA}/installs`]: () =>
        jsonResponse({ ok: true, jobId: "job-install" }),
    });
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Install package…");
    await userEvent.type(field("Package"), "@acme/tool");
    await userEvent.type(field("Version"), "1.2.3");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(writes("POST", `/api/ui/agents/${AGENT_ALPHA}/installs`)[0]!.body).toEqual({
        name: "@acme/tool",
        version: "1.2.3",
      }),
    );
  });

  it("says which packages the agent's reported allow-list lets it install", async () => {
    details[AGENT_ALPHA] = {
      ...agentDetail(data.agents.find((row) => row.id === AGENT_ALPHA)!),
      local: { poolLimits: null, versionPin: null, installablesAllow: ["@omniralph/*", "gh"] },
    };
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Install package…");
    expect(within(sheet()).getByText(INSTALL_ALLOW_LIST)).toBeTruthy();
    expect(
      within(sheet()).getByText("This agent only installs packages that match @omniralph/* or gh."),
    ).toBeTruthy();
  });

  it("says when the agent allows no installs, and nothing before it reports an allow-list", async () => {
    const alpha = data.agents.find((row) => row.id === AGENT_ALPHA)!;
    details[AGENT_ALPHA] = {
      ...agentDetail(alpha),
      local: { poolLimits: null, versionPin: null, installablesAllow: [] },
    };
    const { unmount } = renderFleet({ agentId: AGENT_ALPHA });
    await within(panel()).findByRole("heading", { level: 2, name: "coder-1" });
    await choose("Install package…");
    expect(
      within(sheet()).getByText("This agent doesn't allow any package installs."),
    ).toBeTruthy();
    unmount();

    details[AGENT_ALPHA] = {
      ...agentDetail(alpha),
      local: { poolLimits: null, versionPin: null, installablesAllow: null },
    };
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Install package…");
    expect(within(sheet()).queryByText(/^This agent /)).toBeNull();
    await userEvent.type(field("Package"), "anything");
    expect(within(sheet()).queryByText(NOT_ON_ALLOW_LIST)).toBeNull();
  });

  it("flags a name outside the allow-list but still sends it, because the agent decides", async () => {
    serve({
      [`POST /api/ui/agents/${AGENT_ALPHA}/installs`]: () =>
        jsonResponse({ ok: true, jobId: "job-install" }),
    });
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Install package…");
    // The fixture reports `@omniralph/*`.
    await userEvent.type(field("Package"), "@omniralph/linear");
    expect(within(sheet()).queryByText(NOT_ON_ALLOW_LIST)).toBeNull();
    expect(field("Package").getAttribute("aria-invalid")).not.toBe("true");

    await userEvent.clear(field("Package"));
    await userEvent.type(field("Package"), "left-pad");
    expect(within(sheet()).getByText(NOT_ON_ALLOW_LIST)).toBeTruthy();
    const install = within(sheet()).getByRole("button", { name: "Install" });
    expect((install as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(install);
    await waitFor(() =>
      expect(writes("POST", `/api/ui/agents/${AGENT_ALPHA}/installs`)[0]!.body).toEqual({
        name: "left-pad",
      }),
    );
  });

  it("shows the server's refusal in the sheet", async () => {
    serve({
      [`POST /api/ui/agents/${AGENT_ALPHA}/installs`]: () =>
        jsonResponse({ ok: false, error: "That isn't a valid package name." }, 400),
    });
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Install package…");
    await userEvent.type(field("Package"), "Not A Package");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Install" }));
    const alert = await within(sheet()).findByRole("alert");
    expect(alert.textContent).toBe("That isn't a valid package name.");
    // The sheet stays open over the panel (aria-hidden behind it); nothing is installing.
    const packages = screen.getByRole("region", { name: "Packages", hidden: true });
    expect(within(packages).queryByText(/Installing/)).toBeNull();
  });
});

describe("Audit log", () => {
  it("lists the agent's events newest first as sentences with the IP and time", async () => {
    details[AGENT_ALPHA] = {
      ...agentDetail(data.agents.find((row) => row.id === AGENT_ALPHA)!),
      audit: [
        {
          id: "a3",
          event: "revoke",
          ip: "192.0.2.10",
          detail: { revokedBy: "user-9" },
          actor: "Steve McMaster",
          createdAt: "2026-10-21T09:00:00.000Z",
        },
        {
          id: "a2",
          event: "token_refresh",
          ip: "192.0.2.7",
          detail: {},
          actor: null,
          createdAt: "2026-10-20T09:00:00.000Z",
        },
        {
          id: "a1",
          event: "enroll",
          ip: null,
          detail: {},
          actor: null,
          createdAt: "2026-10-07T10:00:00.000Z",
        },
      ],
    };
    withRole("member");
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Audit log");
    const sheet = screen.getByRole("dialog", { name: "Audit log" });
    const events = within(sheet).getAllByRole("listitem");
    expect(events.map((item) => item.querySelector(".or-agent-audit__label")!.textContent)).toEqual(
      ["Revoked by Steve McMaster", "Refreshed its token", "Enrolled"],
    );
    const ip = within(events[0]!).getByText("192.0.2.10");
    expect(ip.classList.contains("or-mono")).toBe(true);
    expect(events[0]!.querySelector("time")!.getAttribute("dateTime")).toBe(
      "2026-10-21T09:00:00.000Z",
    );
    expect(sheet.textContent).not.toMatch(/token_refresh|revoke\b|enroll\b/);
  });

  it("says when there are none", async () => {
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Audit log");
    expect(
      within(screen.getByRole("dialog", { name: "Audit log" })).getByText("No audit events"),
    ).toBeTruthy();
  });
});

describe("Revoke agent…", () => {
  async function openRevoke() {
    await openAgent(AGENT_ALPHA, "coder-1");
    await choose("Revoke agent…");
    return screen.getByRole("alertdialog", { name: "Revoke coder-1?" });
  }

  it("asks to type the agent's exact name before Revoke enables", async () => {
    const dialog = await openRevoke();
    expect(within(dialog).getByText(REVOKE_DESCRIPTION)).toBeTruthy();
    const input = within(dialog).getByRole("textbox", { name: "Type coder-1 to revoke it." });
    const revoke = within(dialog).getByRole("button", { name: "Revoke" }) as HTMLButtonElement;
    expect(revoke.disabled).toBe(true);
    await userEvent.type(input, "coder-");
    expect(revoke.disabled).toBe(true);
    await userEvent.type(input, "1");
    expect(revoke.disabled).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(writes("POST", `/api/ui/agents/${AGENT_ALPHA}/revoke`)).toEqual([]);
  });

  it("revokes it: the row and the panel show Revoked before any refetch lands", async () => {
    serve({ [`POST /api/ui/agents/${AGENT_ALPHA}/revoke`]: () => jsonResponse({ ok: true }) });
    const dialog = await openRevoke();
    await userEvent.type(within(dialog).getByRole("textbox"), "coder-1");
    holdReads = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(writes("POST", `/api/ui/agents/${AGENT_ALPHA}/revoke`)).toHaveLength(1),
    );
    expect(within(panel()).getByText(/^Revoked/)).toBeTruthy();
    expect(within(tableRow("coder-1")!).getByText("Revoked")).toBeTruthy();
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("coder-1 revoked"));
    // A revoked agent offers Remove next.
    expect((await openMenu()).items).toEqual(["Audit log", "Copy agent ID", "—", "Remove agent…"]);
  });

  it("puts the agent back when the server refuses", async () => {
    serve({
      [`POST /api/ui/agents/${AGENT_ALPHA}/revoke`]: () =>
        jsonResponse({ error: "This action requires the admin role." }, 403),
    });
    const dialog = await openRevoke();
    await userEvent.type(within(dialog).getByRole("textbox"), "coder-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("This action requires the admin role.", {
        variant: "danger",
      }),
    );
    expect(within(tableRow("coder-1")!).getByText("Running 2")).toBeTruthy();
    expect(within(panel()).queryByText(/^Revoked/)).toBeNull();
  });
});

describe("Remove agent…", () => {
  it("confirms, removes the agent from the list at once and goes to /fleet", async () => {
    serve({ [`DELETE /api/ui/agents/${AGENT_REVOKED}`]: () => jsonResponse({ ok: true }) });
    await openAgent(AGENT_REVOKED, "aardvark");
    await choose("Remove agent…");
    const dialog = screen.getByRole("alertdialog", { name: "Remove aardvark from Fleet?" });
    expect(within(dialog).getByText(REMOVE_DESCRIPTION)).toBeTruthy();
    holdReads = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(tableRow("aardvark")).toBeNull());
    expect(tableRow("coder-1")).not.toBeNull();
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith("/fleet"));
    expect(writes("DELETE", `/api/ui/agents/${AGENT_REVOKED}`)).toHaveLength(1);
    expect(ui.toast).toHaveBeenCalledWith("aardvark removed");
  });

  it("keeps the agent when the server refuses", async () => {
    serve({
      [`DELETE /api/ui/agents/${AGENT_REVOKED}`]: () =>
        jsonResponse({ error: "That agent doesn't exist." }, 400),
    });
    await openAgent(AGENT_REVOKED, "aardvark");
    await choose("Remove agent…");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("That agent doesn't exist.", { variant: "danger" }),
    );
    expect(tableRow("aardvark")).not.toBeNull();
    expect(nav.router.push).not.toHaveBeenCalled();
  });
});

describe("another admin's revoke or remove", () => {
  async function connected(live: ReturnType<typeof fakeAbly>) {
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
  }
  const deliver = (live: ReturnType<typeof fakeAbly>, ids: string[]) =>
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "agent", ids }),
        ),
    );

  it("shows the agent revoked through its agent event", async () => {
    const live = fakeAbly();
    await openAgent(AGENT_ALPHA, "coder-1", { live });
    await connected(live);
    data = {
      ...data,
      agents: data.agents.map((row) =>
        row.id === AGENT_ALPHA
          ? {
              ...row,
              revoked: true,
              online: false,
              runningCount: 0,
              revokedAt: "2026-10-27T09:00:00.000Z",
              status: { kind: "revoked", label: "Revoked", tone: "neutral" },
            }
          : row,
      ),
    };
    deliver(live, [AGENT_ALPHA]);
    await waitFor(() => expect(within(panel()).getByText(/^Revoked/)).toBeTruthy());
    expect(within(tableRow("coder-1")!).getByText("Revoked")).toBeTruthy();
  });

  it("drops a removed agent through its agent event", async () => {
    const live = fakeAbly();
    await openAgent(AGENT_ALPHA, "coder-1", { live });
    await connected(live);
    data = { ...data, agents: data.agents.filter((row) => row.id !== AGENT_ALPHA) };
    serve({
      [`GET /api/ui/agents/${AGENT_ALPHA}`]: () =>
        jsonResponse({ ok: false, error: "Not found" }, 404),
    });
    deliver(live, [AGENT_ALPHA]);
    expect(await within(panel()).findByText(AGENT_NOT_FOUND)).toBeTruthy();
    await waitFor(() => expect(tableRow("coder-1")).toBeNull());
  });
});
