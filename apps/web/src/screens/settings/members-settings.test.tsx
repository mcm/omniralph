// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MembersSettingsPage from "@/app/(app)/settings/members/page";
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
import type { MemberRow, OrganizationSettings } from "@/lib/api/organization";
import { DOMAIN_JOIN_LABEL, domainChanges, invitationEmailError } from "./members-settings";
import { SettingsLayoutView } from "./settings-layout-view";
import { organizationSettings } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  pathname: "/settings/members",
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
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";
const LAST_ADMIN = "There must be at least one admin.";

const ada: MemberRow = {
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@acme.io",
  image: null,
  role: "admin",
  joinedAt: "2026-10-01T10:00:00.000Z",
};
const bo: MemberRow = {
  id: "user-2",
  name: "Bo Diddley",
  email: "bo@acme.io",
  image: null,
  role: "member",
  joinedAt: "2026-10-07T10:00:00.000Z",
};

const memberUser: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

let settings: OrganizationSettings;
let seen: SeenRequest[];
/** While set, `GET /api/ui/organization` never answers: the view shows the cache. */
let holdReads: boolean;
/** Answers for writes, by "METHOD path"; default `{ ok: true }`. */
let answers: Record<string, () => Response>;

function write(key: string) {
  return () => (answers[key] ?? (() => jsonResponse({ ok: true })))();
}

function routes() {
  return {
    "GET /api/ui/connections": { connections: [] },
    "GET /api/ui/organization": () =>
      holdReads ? new Promise<Response>(() => {}) : jsonResponse(settings),
    "GET /api/ui/settings-history": () =>
      jsonResponse({ latest: settings.history, entries: [settings.history], next: null }),
    "PATCH /api/ui/organization": write("PATCH /api/ui/organization"),
    "PATCH /api/ui/organization/members/user-1": write("PATCH member user-1"),
    "PATCH /api/ui/organization/members/user-2": write("PATCH member user-2"),
    "DELETE /api/ui/organization/members/user-2": write("DELETE member user-2"),
    "POST /api/ui/organization/invitations": write("POST invitation"),
    [`DELETE /api/ui/organization/invitations/${INVITATION_ID}`]: write("DELETE invitation"),
    "POST /api/ui/organization/domains": write("POST domain"),
    "DELETE /api/ui/organization/domains/acme.io": write("DELETE domain"),
  };
}

beforeEach(() => {
  nav.router.refresh.mockReset();
  ui.toast.mockReset();
  settings = organizationSettings({ members: [ada, bo], domains: ["acme.io"] });
  holdReads = false;
  answers = {};
  seen = mockFetch(routes());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderMembers(options: { user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {}) {
  const client = createTestQueryClient();
  const page = (
    <SettingsLayoutView>
      <MembersSettingsPage />
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

const requests = (method: string, path?: string) =>
  seen.filter((r) => r.method === method && (path === undefined || r.path === path));
const membersCard = () => screen.findByRole("region", { name: "Members" });
const table = async () => within(await membersCard()).getByRole("table");
const row = async (name: string) =>
  within(await table())
    .getAllByRole("row")
    .find((r) => r.textContent?.includes(name));
const roleSelect = async (name: string) =>
  within(await table()).getByRole<HTMLSelectElement>("combobox", { name: `Role for ${name}` });
const invitationsCard = () => screen.findByRole("region", { name: "Invitations" });
const domainsCard = () => screen.findByRole("region", { name: "Joining by domain" });
const domainJoin = async () =>
  within(await domainsCard()).getByRole("switch", { name: DOMAIN_JOIN_LABEL });

async function addTokens(label: string, card: HTMLElement, ...values: string[]) {
  const input = within(card).getByLabelText(label);
  for (const value of values) await userEvent.type(input, `${value}{Enter}`);
}

describe("Organization › Members: the members", () => {
  it("lists every member with avatar, name, email, role and join date, as a table and phone cards", async () => {
    renderMembers();
    expect(screen.getByText("Loading…")).toBeTruthy();
    const adaRow = await row("Ada Lovelace");
    expect(adaRow!.textContent).toContain("You");
    expect(adaRow!.textContent).toContain("ada@acme.io");
    expect(adaRow!.textContent).toContain("Oct 1");
    expect(adaRow!.querySelector(".or-avatar")!.textContent).toBe("AL");
    expect((await roleSelect("Ada Lovelace")).value).toBe("admin");
    expect((await roleSelect("Bo Diddley")).value).toBe("member");
    const options = within(await roleSelect("Bo Diddley")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Admin", "Member"]);
    const cards = within(await membersCard()).getByRole("list", { name: "Members" });
    expect(within(cards).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows the table as cards at 768 px and narrower", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../../../../../packages/ui/styles/lists.css"),
      "utf8",
    );
    expect(css).toMatch(/@media \(max-width: 768px\)[^]*?\.or-cards\s*\{[^}]*display:\s*flex/);
  });

  it("shows an error with a retry when the settings don't load", async () => {
    let fail = true;
    mockFetch({
      ...routes(),
      "GET /api/ui/organization": () =>
        fail ? jsonResponse({ error: "Database down." }, 500) : jsonResponse(settings),
    });
    renderMembers();
    expect(await screen.findByText("Couldn't load the organization")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await row("Bo Diddley")).toBeTruthy();
  });

  it("changes a role at once, before any refetch", async () => {
    renderMembers();
    const select = await roleSelect("Bo Diddley");
    holdReads = true;
    await userEvent.selectOptions(select, "admin");
    expect((await roleSelect("Bo Diddley")).value).toBe("admin");
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Bo Diddley is now admin"));
    expect(requests("PATCH", "/api/ui/organization/members/user-2")[0]!.body).toEqual({
      role: "admin",
    });
    expect((await roleSelect("Bo Diddley")).value).toBe("admin");
    expect(nav.router.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the shell when admins change their own role", async () => {
    settings = organizationSettings({ members: [ada, { ...bo, role: "admin" }] });
    renderMembers();
    await userEvent.selectOptions(await roleSelect("Ada Lovelace"), "member");
    await waitFor(() => expect(nav.router.refresh).toHaveBeenCalled());
  });

  it("rolls a refused role change back with the server's message", async () => {
    answers["PATCH member user-2"] = () => jsonResponse({ error: "Unknown role." }, 400);
    renderMembers();
    await userEvent.selectOptions(await roleSelect("Bo Diddley"), "admin");
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Unknown role.", { variant: "danger" }),
    );
    await waitFor(async () => expect((await roleSelect("Bo Diddley")).value).toBe("member"));
  });

  it("refuses to demote the last admin with today's message and no request", async () => {
    renderMembers();
    await userEvent.selectOptions(await roleSelect("Ada Lovelace"), "member");
    expect(ui.toast).toHaveBeenCalledWith(LAST_ADMIN, { variant: "danger" });
    expect((await roleSelect("Ada Lovelace")).value).toBe("admin");
    expect(requests("PATCH")).toHaveLength(0);
  });

  it("can't remove yourself", async () => {
    settings = organizationSettings({ members: [ada, { ...bo, role: "admin" }] });
    renderMembers();
    const remove = within(await table()).getByRole("button", { name: "Remove Ada Lovelace" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(remove);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const removeBo = within(await table()).getByRole("button", { name: "Remove Bo Diddley" });
    expect(removeBo.getAttribute("aria-disabled")).toBeNull();
  });

  it("can't remove the last admin", async () => {
    settings = organizationSettings({
      currentUserId: "user-3",
      members: [ada, bo, { ...bo, id: "user-3", name: "Cy Twombly" }],
    });
    renderMembers();
    const remove = within(await table()).getByRole("button", { name: "Remove Ada Lovelace" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(remove);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("removes a member after confirming, at once", async () => {
    renderMembers();
    await userEvent.click(within(await table()).getByRole("button", { name: "Remove Bo Diddley" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Bo Diddley?" });
    holdReads = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(async () => expect(await row("Bo Diddley")).toBeUndefined());
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Removed Bo Diddley"));
    expect(requests("DELETE", "/api/ui/organization/members/user-2")).toHaveLength(1);
  });

  it("keeps a member when the removal is cancelled", async () => {
    renderMembers();
    await userEvent.click(within(await table()).getByRole("button", { name: "Remove Bo Diddley" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Bo Diddley?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(requests("DELETE")).toHaveLength(0);
    expect(await row("Bo Diddley")).toBeTruthy();
  });

  it("puts a member back when the server refuses the removal", async () => {
    let release: () => void = () => {};
    answers["DELETE member user-2"] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse({ error: LAST_ADMIN }, 400));
      }) as unknown as Response;
    renderMembers();
    await userEvent.click(within(await table()).getByRole("button", { name: "Remove Bo Diddley" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Bo Diddley?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(async () => expect(await row("Bo Diddley")).toBeUndefined());
    release();
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith(LAST_ADMIN, { variant: "danger" }));
    await waitFor(async () => expect(await row("Bo Diddley")).toBeTruthy());
  });

  it("opens the organization section's change history from the card's ⓘ", async () => {
    renderMembers();
    await userEvent.click(
      within(await membersCard()).getByRole("button", { name: "Change history" }),
    );
    expect(await screen.findByText(/^Last changed by Grace, .*, 3 runs since$/)).toBeTruthy();
    expect(requests("GET", "/api/ui/settings-history")[0]!.query.get("section")).toBe(
      "organization",
    );
  });
});

describe("invitations", () => {
  it("says when there are no pending invitations", async () => {
    renderMembers();
    expect(within(await invitationsCard()).getByText("No pending invitations")).toBeTruthy();
  });

  it("lists pending invitations with their role and expiry", async () => {
    settings = organizationSettings({
      members: [ada],
      invitations: [
        {
          id: INVITATION_ID,
          email: "cy@acme.io",
          role: "admin",
          createdAt: "2026-10-20T10:00:00.000Z",
          expiresAt: "2026-11-03T10:00:00.000Z",
        },
      ],
    });
    renderMembers();
    const list = within(await invitationsCard()).getByRole("list", {
      name: "Pending invitations",
    });
    const [item] = within(list).getAllByRole("listitem");
    expect(item!.textContent).toContain("cy@acme.io");
    expect(item!.textContent).toContain("Admin");
    expect(item!.textContent).toContain("Expires Nov 3");
  });

  it("validates each email as a chip, in the organization's domains", async () => {
    renderMembers();
    const card = await invitationsCard();
    await addTokens("Emails", card, "not-an-email");
    expect(within(card).getByText("Enter a valid email address.")).toBeTruthy();
    await userEvent.clear(within(card).getByLabelText("Emails"));
    await addTokens("Emails", card, "eve@elsewhere.com");
    expect(
      within(card).getByText("That email isn't in one of this organization's email domains."),
    ).toBeTruthy();
    expect(invitationEmailError("x@any.com", [])).toBeNull();
  });

  it("explains how to add emails under the input", async () => {
    renderMembers();
    const card = await invitationsCard();
    expect(
      within(card).getByRole("textbox", {
        name: "Emails",
        description: "Press Enter or comma to add. Separate multiple emails with commas.",
      }),
    ).toBeTruthy();
  });

  it("invites a typed email without Enter, along with the chips", async () => {
    renderMembers();
    const card = await invitationsCard();
    const invite = within(card).getByRole("button", { name: "Invite" });
    expect(invite.hasAttribute("disabled")).toBe(true);
    await addTokens("Emails", card, "cy@acme.io");
    await userEvent.type(within(card).getByLabelText("Emails"), "Dee@acme.io");
    expect(invite.hasAttribute("disabled")).toBe(false);
    await userEvent.click(invite);
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Invited 2 people"));
    expect(requests("POST", "/api/ui/organization/invitations").map((r) => r.body)).toEqual([
      { email: "cy@acme.io", role: "member" },
      { email: "dee@acme.io", role: "member" },
    ]);
    expect(within(card).getByLabelText("Emails")).toHaveProperty("value", "");
  });

  it("splits typed emails on spaces", async () => {
    renderMembers();
    const card = await invitationsCard();
    await userEvent.type(within(card).getByLabelText("Emails"), "cy@acme.io dee@acme.io ");
    expect(within(card).getByRole("button", { name: "Remove cy@acme.io" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove dee@acme.io" })).toBeTruthy();
  });

  it("sends nothing when the typed email is invalid, keeping it with its error", async () => {
    renderMembers();
    const card = await invitationsCard();
    await addTokens("Emails", card, "cy@acme.io");
    const input = within(card).getByLabelText("Emails");
    await userEvent.type(input, "eve@elsewhere.com");
    await userEvent.click(within(card).getByRole("button", { name: "Invite" }));
    expect(
      within(card).getByText("That email isn't in one of this organization's email domains."),
    ).toBeTruthy();
    expect(input).toHaveProperty("value", "eve@elsewhere.com");
    expect(within(card).getByRole("button", { name: "Remove cy@acme.io" })).toBeTruthy();
    expect(requests("POST", "/api/ui/organization/invitations")).toEqual([]);
  });

  it("invites every email with the chosen role and shows them at once", async () => {
    renderMembers();
    const card = await invitationsCard();
    await addTokens("Emails", card, "cy@acme.io", "Dee@Acme.io");
    expect(within(card).getByRole("button", { name: "Remove cy@acme.io" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove dee@acme.io" })).toBeTruthy();
    await userEvent.selectOptions(within(card).getByLabelText("Role"), "admin");
    holdReads = true;
    await userEvent.click(within(card).getByRole("button", { name: "Invite" }));
    const list = within(card).getByRole("list", { name: "Pending invitations" });
    expect(list.textContent).toContain("cy@acme.io");
    expect(list.textContent).toContain("dee@acme.io");
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Invited 2 people"));
    expect(requests("POST", "/api/ui/organization/invitations").map((r) => r.body)).toEqual([
      { email: "cy@acme.io", role: "admin" },
      { email: "dee@acme.io", role: "admin" },
    ]);
    expect(within(card).queryByRole("button", { name: "Remove cy@acme.io" })).toBeNull();
    expect((within(card).getByLabelText("Role") as HTMLSelectElement).value).toBe("member");
  });

  it("rolls a refused invitation back and keeps its email in the input", async () => {
    const ALREADY = "That email already belongs to a member of this organization.";
    answers["POST invitation"] = () => jsonResponse({ error: ALREADY }, 400);
    renderMembers();
    const card = await invitationsCard();
    await addTokens("Emails", card, "bo@acme.io");
    await userEvent.click(within(card).getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith(ALREADY, { variant: "danger" }));
    expect(within(card).getByText("No pending invitations")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove bo@acme.io" })).toBeTruthy();
  });

  it("revokes an invitation after confirming, at once", async () => {
    settings = organizationSettings({
      members: [ada],
      invitations: [
        {
          id: INVITATION_ID,
          email: "cy@acme.io",
          role: "member",
          createdAt: "2026-10-20T10:00:00.000Z",
          expiresAt: "2026-11-03T10:00:00.000Z",
        },
      ],
    });
    renderMembers();
    const card = await invitationsCard();
    await userEvent.click(
      within(card).getByRole("button", { name: "Revoke invitation for cy@acme.io" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Revoke the invitation for cy@acme.io?",
    });
    holdReads = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(within(card).getByText("No pending invitations")).toBeTruthy());
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Revoked cy@acme.io"));
    expect(requests("DELETE", `/api/ui/organization/invitations/${INVITATION_ID}`)).toHaveLength(1);
  });
});

describe("joining by domain", () => {
  it("lists the domains as chips and stages added and removed ones", async () => {
    renderMembers();
    const card = await domainsCard();
    expect(within(card).getByText("acme.io")).toBeTruthy();
    await addTokens("Email domains", card, "nope");
    expect(within(card).getByText("Enter a valid domain, like example.com.")).toBeTruthy();
    await userEvent.clear(within(card).getByLabelText("Email domains"));
    await addTokens("Email domains", card, "@Acme.Dev");
    await userEvent.click(within(card).getByRole("button", { name: "Remove acme.io" }));
    expect(within(card).getByText("2 unsaved changes")).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Discard" }));
    expect(within(card).getByText("acme.io")).toBeTruthy();
    expect(within(card).queryByText("acme.dev")).toBeNull();
  });

  it("saves domains and the switch together, shown before any refetch", async () => {
    renderMembers();
    const card = await domainsCard();
    await addTokens("Email domains", card, "acme.dev");
    await userEvent.click(await domainJoin());
    expect((await domainJoin()).getAttribute("aria-checked")).toBe("true");
    holdReads = true;
    await userEvent.click(within(card).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Saved"));
    const writes = seen.filter((r) => r.method !== "GET");
    expect(writes.map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", "/api/ui/organization/domains", { domain: "acme.dev" }],
      ["PATCH", "/api/ui/organization", { allowDomainJoin: true }],
    ]);
    expect(within(card).queryByText(/unsaved change/)).toBeNull();
    expect(within(card).getByText("acme.dev")).toBeTruthy();
    expect((await domainJoin()).getAttribute("aria-checked")).toBe("true");
  });

  it("turns joining off when the last domain is removed", async () => {
    settings = organizationSettings({
      members: [ada],
      domains: ["acme.io"],
      organization: { id: TEST_ORGANIZATION_ID, name: "Acme", allowDomainJoin: true },
    });
    renderMembers();
    const card = await domainsCard();
    expect((await domainJoin()).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(within(card).getByRole("button", { name: "Remove acme.io" }));
    expect((await domainJoin()).getAttribute("aria-checked")).toBe("false");
    expect((await domainJoin()).hasAttribute("disabled")).toBe(true);
    await userEvent.click(within(card).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Saved"));
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.path])).toEqual([
      ["PATCH", "/api/ui/organization"],
      ["DELETE", "/api/ui/organization/domains/acme.io"],
    ]);
  });

  it("shows why a save failed and keeps the draft", async () => {
    answers["PATCH /api/ui/organization"] = () =>
      jsonResponse({ error: "Add an email domain before allowing people to join." }, 400);
    renderMembers();
    const card = await domainsCard();
    await userEvent.click(await domainJoin());
    await userEvent.click(within(card).getByRole("button", { name: /^Save/ }));
    expect(
      await within(card).findByText("Add an email domain before allowing people to join."),
    ).toBeTruthy();
    expect((await domainJoin()).getAttribute("aria-checked")).toBe("true");
  });

  it("lists each change in the save bar", () => {
    expect(
      domainChanges(
        { domains: ["a.io", "b.io"], allowDomainJoin: true },
        { domains: ["b.io", "c.io"], allowDomainJoin: true },
      ).map((c) => [c.label, c.to]),
    ).toEqual([
      ["c.io", "Added"],
      ["a.io", "Removed"],
    ]);
    expect(
      domainChanges(
        { domains: ["a.io"], allowDomainJoin: true },
        { domains: [], allowDomainJoin: true },
      ).map((c) => [c.label, c.to]),
    ).toEqual([
      ["a.io", "Removed"],
      ["Joining by domain", "Off"],
    ]);
  });
});

describe("as a member", () => {
  it("shows the members and domains read-only, without invitations", async () => {
    settings = organizationSettings({
      isAdmin: false,
      currentUserId: "user-2",
      members: [ada, bo],
      domains: ["acme.io"],
    });
    renderMembers({ user: memberUser });
    const adaRow = await row("Ada Lovelace");
    expect(adaRow!.textContent).toContain("Admin");
    expect(within(await table()).queryAllByRole("combobox")).toHaveLength(0);
    expect(within(await table()).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Invitations" })).toBeNull();
    const card = await domainsCard();
    expect(within(card).getByRole("list", { name: "Email domains" }).textContent).toBe("acme.io");
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect((await domainJoin()).hasAttribute("disabled")).toBe(true);
    expect(within(card).queryByRole("button", { name: /^Save/ })).toBeNull();
    // The ⓘ stays.
    expect(
      within(await membersCard()).getByRole("button", { name: "Change history" }),
    ).toBeTruthy();
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

  it("shows another admin's member, invitation and domain changes", async () => {
    const live = fakeAbly();
    renderMembers({ live });
    expect(await row("Bo Diddley")).toBeTruthy();
    await connected(live, TEST_ORGANIZATION_ID);
    settings = organizationSettings({
      members: [ada, { ...bo, role: "admin" }, { ...bo, id: "user-3", name: "Cy Twombly" }],
      domains: ["acme.io", "acme.dev"],
      invitations: [
        {
          id: INVITATION_ID,
          email: "dee@acme.io",
          role: "member",
          createdAt: "2026-10-20T10:00:00.000Z",
          expiresAt: "2026-11-03T10:00:00.000Z",
        },
      ],
    });
    deliver(live, TEST_ORGANIZATION_ID);
    expect(await within(await table()).findByText("Cy Twombly")).toBeTruthy();
    expect((await roleSelect("Bo Diddley")).value).toBe("admin");
    expect(within(await invitationsCard()).getByText("dee@acme.io")).toBeTruthy();
    expect(within(await domainsCard()).getByText("acme.dev")).toBeTruthy();
  });

  it("ignores another organization's events", async () => {
    const live = fakeAbly();
    renderMembers({
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
    expect(await row("Bo Diddley")).toBeTruthy();
    await connected(live, BETA_ID);
    const before = requests("GET", "/api/ui/organization").length;
    deliver(live, BETA_ID);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests("GET", "/api/ui/organization")).toHaveLength(before);
  });
});
