// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GeneralSettingsPage from "@/app/(app)/settings/general/page";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import { LiveCurrentUser } from "@/components/live-current-user";
import { LiveProvider } from "@/components/live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "@/components/live/live-test-utils";
import { OrganizationPicker } from "@/components/organization-picker";
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
import type { OrganizationSettings } from "@/lib/api/organization";
import { LEAVE_DESCRIPTION } from "./general-settings";
import { SettingsLayoutView } from "./settings-layout-view";
import { organizationChange, organizationSettings } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

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
const LAST_ADMIN = "You're the last admin. Make another member an admin before leaving.";

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

let settings: OrganizationSettings;
let seen: SeenRequest[];
/** While set, `GET /api/ui/organization` never answers: the view shows the cache. */
let holdReads: boolean;
let leaveResponse: () => Response;

beforeEach(() => {
  nav.pathname = "/settings/general";
  nav.router.push.mockReset();
  nav.router.refresh.mockReset();
  ui.toast.mockReset();
  settings = organizationSettings();
  holdReads = false;
  leaveResponse = () => jsonResponse({ ok: true });
  seen = mockFetch({
    "GET /api/ui/connections": { connections: [] },
    "GET /api/ui/organization": () =>
      holdReads ? new Promise<Response>(() => {}) : jsonResponse(settings),
    "PATCH /api/ui/organization": () => jsonResponse({ ok: true }),
    "POST /api/ui/organization/leave": () => leaveResponse(),
    "GET /api/ui/settings-history": () =>
      jsonResponse({ latest: settings.history, entries: [settings.history], next: null }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** General in Settings, with the shell's organization picker, as the app shell renders them. */
function renderGeneral(options: { user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {}) {
  const client = createTestQueryClient();
  const page = (
    <>
      <OrganizationPicker />
      <SettingsLayoutView>
        <GeneralSettingsPage />
      </SettingsLayoutView>
    </>
  );
  render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial={false}>
        <QueryClientProvider client={client}>
          <LiveCurrentUser>
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
          </LiveCurrentUser>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
  return { client };
}

const generalCard = () => screen.findByRole("region", { name: "Organization" });
const nameField = async () =>
  within(await generalCard()).getByRole<HTMLInputElement>("textbox", { name: "Name" });
const sectionNavBadge = () =>
  screen.getByRole("navigation", { name: "Settings" }).querySelector(".or-subnav__badge")!;
const picker = (name: string) => screen.queryByRole("button", { name: `Organization: ${name}` });
const requests = (method: string, path: string) =>
  seen.filter((request) => request.method === method && request.path === path);

/** Types `to` over the organization's name. */
async function rename(to: string) {
  const field = await nameField();
  await userEvent.clear(field);
  await userEvent.type(field, to);
}

describe("Organization › General", () => {
  it("shows the organization's name in a required field with today's length limit", async () => {
    renderGeneral();
    const field = await nameField();
    expect(field.value).toBe("Acme");
    expect(field.required).toBe(true);
    expect(field.maxLength).toBe(100);
    expect(field.readOnly).toBe(false);
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("stages a rename in the save bar and discards it", async () => {
    renderGeneral();
    await rename("Acme Labs");
    const card = await generalCard();
    expect(within(card).getByText("1 unsaved change")).toBeTruthy();
    const bar = card.querySelector<HTMLElement>(".or-savebar")!;
    expect(within(bar).getByText("Name")).toBeTruthy();
    expect(within(bar).getByText("Acme Labs")).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Discard" }));
    expect((await nameField()).value).toBe("Acme");
    expect(within(card).queryByText("1 unsaved change")).toBeNull();
  });

  it("doesn't stage spaces around the same name", async () => {
    renderGeneral();
    await rename(" Acme ");
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("saves in one PATCH and shows the new name everywhere before any refetch", async () => {
    renderGeneral();
    await waitFor(() => expect(picker("Acme")).not.toBeNull());
    await rename("  Acme Labs ");
    holdReads = true;
    await userEvent.click(within(await generalCard()).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Renamed"));
    expect(requests("PATCH", "/api/ui/organization").map((request) => request.body)).toEqual([
      { name: "Acme Labs" },
    ]);
    // The field, the section nav's badge and the shell's picker, from the saved answer.
    expect((await nameField()).value).toBe("Acme Labs");
    expect(sectionNavBadge().textContent).toContain("Acme Labs");
    expect(picker("Acme Labs")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });

  it("shows why a rename failed in the save bar", async () => {
    mockFetch({
      "GET /api/ui/connections": { connections: [] },
      "GET /api/ui/organization": () => jsonResponse(settings),
      "PATCH /api/ui/organization": () =>
        jsonResponse({ error: "Enter a name for the organization." }, 400),
    });
    renderGeneral();
    await rename(" ");
    await userEvent.click(within(await generalCard()).getByRole("button", { name: /^Save/ }));
    expect(
      await within(await generalCard()).findByText("Enter a name for the organization."),
    ).toBeTruthy();
    expect(picker("Acme")).not.toBeNull();
  });

  it("shows members the name read-only, with no save bar", async () => {
    settings = organizationSettings({ isAdmin: false });
    renderGeneral({ user: member });
    const field = await nameField();
    expect(field.readOnly).toBe(true);
    await userEvent.type(field, " Labs");
    expect(field.value).toBe("Acme");
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
    // Says why, once.
    expect(screen.getAllByText("Only admins can change these settings.")).toHaveLength(1);
  });

  it("doesn't tell admins only admins can change the settings", async () => {
    renderGeneral();
    await nameField();
    expect(screen.queryByText(/Only admins can change/)).toBeNull();
  });
});

describe("its change history", () => {
  it("opens the organization section's history from the card's ⓘ", async () => {
    renderGeneral();
    const card = await generalCard();
    await userEvent.click(within(card).getByRole("button", { name: "Change history" }));
    expect(await screen.findByText(/^Last changed by Grace, .*, 3 runs since$/)).toBeTruthy();
    expect(await screen.findByText("Name: Acme Corp → Acme")).toBeTruthy();
    const [history] = requests("GET", "/api/ui/settings-history");
    expect(history!.query.get("section")).toBe("organization");
    expect(history!.query.get("subject")).toBeNull();
  });

  it("says when nothing has changed yet", async () => {
    settings = organizationSettings({ history: null });
    mockFetch({
      "GET /api/ui/connections": { connections: [] },
      "GET /api/ui/organization": () => jsonResponse(settings),
      "GET /api/ui/settings-history": { latest: null, entries: [], next: null },
    });
    renderGeneral();
    await userEvent.click(
      within(await generalCard()).getByRole("button", { name: "Change history" }),
    );
    expect(await screen.findByText("No changes recorded yet")).toBeTruthy();
  });
});

describe("live updates", () => {
  const connected = (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`));
  const deliver = (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    act(() =>
      live
        .current()
        .deliver(
          `org:${organizationId}:changes`,
          changeEvent(organizationId, { resource: "organization", ids: [organizationId] }),
        ),
    );

  it("shows another admin's rename on the page, the badge and the picker", async () => {
    const live = fakeAbly();
    renderGeneral({ live });
    expect((await nameField()).value).toBe("Acme");
    await connected(live, TEST_ORGANIZATION_ID);
    settings = organizationSettings({
      organization: { ...settings.organization, name: "Acme Industries" },
      history: organizationChange({
        changes: [{ field: "name", label: "Name", before: "Acme", after: "Acme Industries" }],
      }),
    });
    deliver(live, TEST_ORGANIZATION_ID);
    await waitFor(async () => expect((await nameField()).value).toBe("Acme Industries"));
    expect(sectionNavBadge().textContent).toContain("Acme Industries");
    expect(picker("Acme Industries")).not.toBeNull();
  });

  it("keeps the user's edit when another admin's rename arrives", async () => {
    const live = fakeAbly();
    renderGeneral({ live });
    await connected(live, TEST_ORGANIZATION_ID);
    await rename("Acme Labs");
    settings = organizationSettings({
      organization: { ...settings.organization, name: "Acme Industries" },
    });
    deliver(live, TEST_ORGANIZATION_ID);
    await waitFor(() => expect(picker("Acme Industries")).not.toBeNull());
    expect((await nameField()).value).toBe("Acme Labs");
  });

  it("ignores another organization's events", async () => {
    const live = fakeAbly();
    renderGeneral({
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
    expect((await nameField()).value).toBe("Acme");
    await connected(live, BETA_ID);
    const before = requests("GET", "/api/ui/organization").length;
    deliver(live, BETA_ID);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests("GET", "/api/ui/organization")).toHaveLength(before);
  });
});

describe("leaving the organization", () => {
  const leaveButton = async () =>
    within(await screen.findByRole("region", { name: "Leave organization" })).getByRole("button", {
      name: "Leave organization",
    });

  it("confirms, leaves and starts over from the dashboard", async () => {
    renderGeneral();
    await userEvent.click(await leaveButton());
    const dialog = await screen.findByRole("alertdialog", { name: "Leave Acme?" });
    expect(within(dialog).getByText(LEAVE_DESCRIPTION)).toBeTruthy();
    expect(LEAVE_DESCRIPTION).toBe("You lose access to its repos, runs and agents.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith("/"));
    expect(nav.router.refresh).toHaveBeenCalled();
    expect(requests("POST", "/api/ui/organization/leave")).toHaveLength(1);
    expect(ui.toast).toHaveBeenCalledWith("Left Acme");
  });

  it("stays when cancelled", async () => {
    renderGeneral();
    await userEvent.click(await leaveButton());
    const dialog = await screen.findByRole("alertdialog", { name: "Leave Acme?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requests("POST", "/api/ui/organization/leave")).toHaveLength(0);
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("is refused with the server's message for the last admin", async () => {
    leaveResponse = () => jsonResponse({ error: LAST_ADMIN }, 400);
    renderGeneral();
    await userEvent.click(await leaveButton());
    const dialog = await screen.findByRole("alertdialog", { name: "Leave Acme?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith(LAST_ADMIN, { variant: "danger" }));
    expect(nav.router.push).not.toHaveBeenCalled();
    expect((await leaveButton()).hasAttribute("disabled")).toBe(false);
  });

  it("is offered to members too", async () => {
    settings = organizationSettings({ isAdmin: false });
    renderGeneral({ user: member });
    expect(await leaveButton()).toBeTruthy();
  });
});
