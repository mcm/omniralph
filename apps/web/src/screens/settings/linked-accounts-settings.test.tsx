// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LinkedAccountsSettingsPage from "@/app/(app)/settings/linked-accounts/page";
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
import type { ChatAccount } from "@/lib/api/organization";
import { SettingsLayoutView } from "./settings-layout-view";
import { organizationSettings } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/linked-accounts",
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const BETA_ID = "22222222-2222-4222-8222-222222222222";

const slack: ChatAccount = {
  organizationId: TEST_ORGANIZATION_ID,
  organizationName: "Acme",
  platform: "slack",
  workspace: "Acme Engineering",
  externalUserId: "U1",
  displayName: "ada",
  source: "manual",
  linkedAt: "2026-10-20T10:00:00.000Z",
};
const discord: ChatAccount = {
  organizationId: BETA_ID,
  organizationName: "Beta",
  platform: "discord",
  workspace: null,
  externalUserId: "D1",
  displayName: null,
  source: "manual",
  linkedAt: "2026-10-21T10:00:00.000Z",
};

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [
    { ...testUser.organization, role: "member" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

let identities: ChatAccount[];
let seen: SeenRequest[];
/** While set, `GET /api/ui/chat-accounts` never answers: the view shows the cache. */
let holdReads: boolean;
let unlinkResponse: () => Response;

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.refresh.mockReset();
  identities = [slack, discord];
  holdReads = false;
  unlinkResponse = () => jsonResponse({ ok: true });
  seen = mockFetch({
    "GET /api/ui/connections": { connections: [] },
    "GET /api/ui/organization": () => jsonResponse(organizationSettings()),
    "GET /api/ui/chat-accounts": () =>
      holdReads ? new Promise<Response>(() => {}) : jsonResponse({ identities }),
    "POST /api/ui/chat-accounts/unlink": () => unlinkResponse(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAccounts(options: { live?: ReturnType<typeof fakeAbly> } = {}) {
  const page = (
    <SettingsLayoutView>
      <LinkedAccountsSettingsPage />
    </SettingsLayoutView>
  );
  render(
    <CurrentUserProvider user={member}>
      <ShowAdvancedProvider initial={false}>
        <QueryClientProvider client={createTestQueryClient()}>
          <UiProvider linkComponent={TestLink}>
            {options.live ? (
              <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
                {page}
              </LiveProvider>
            ) : (
              page
            )}
          </UiProvider>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
}

const table = () => screen.findByRole("table", { name: "Linked chat accounts" });
/** The table's rows (desktop): the chat username, the workspace and the organization. */
async function tableRows() {
  const rows = within(await table())
    .getAllByRole("row")
    .slice(1);
  return rows.map((row) => {
    const [account, workspace, organization] = within(row).getAllByRole("cell");
    return [
      account!.querySelector(".or-linked-account > span")!.textContent,
      workspace!.textContent,
      organization!.textContent!.trim(),
    ];
  });
}
/** The phone cards (the same rows as stacked cards at 768 px and narrower). */
const cards = () =>
  within(screen.getByRole("list", { name: "Linked chat accounts" })).getAllByRole("listitem");
const chatAccountReads = () =>
  seen.filter((request) => request.method === "GET" && request.path === "/api/ui/chat-accounts");

describe("Linked chat accounts", () => {
  it("lists the user's accounts in every organization, with brand, workspace and organization", async () => {
    renderAccounts();
    expect(
      within(screen.getByRole("region", { name: "Setting" })).getByRole("heading", {
        level: 2,
        name: "Linked chat accounts",
      }),
    ).toBeTruthy();
    expect(await tableRows()).toEqual([
      ["ada", "Acme Engineering", "Acme"],
      // No display name: the chat user ID; the server unknown: the platform.
      ["D1", "Discord", "Beta"],
    ]);
    const [first, second] = within(await table())
      .getAllByRole("row")
      .slice(1);
    expect(within(first!).getByRole("img", { name: "Slack" })).toBeTruthy();
    expect(within(first!).getByRole("img", { name: "Organization" })).toBeTruthy();
    expect(within(second!).getByRole("img", { name: "Discord" })).toBeTruthy();
    expect(within(first!).getByRole("button", { name: "Unlink ada" })).toBeTruthy();
  });

  it("shows the same accounts as phone cards", async () => {
    renderAccounts();
    await table();
    const [first, second] = cards();
    expect(within(first!).getByRole("img", { name: "Slack" })).toBeTruthy();
    expect(first!.textContent).toContain("ada");
    expect(first!.textContent).toContain("Acme Engineering");
    expect(within(first!).getByRole("button", { name: "Unlink ada" })).toBeTruthy();
    expect(within(second!).getByRole("img", { name: "Discord" })).toBeTruthy();
    expect(second!.textContent).toContain("Beta");
  });

  it("shows an empty state without linked accounts", async () => {
    identities = [];
    renderAccounts();
    expect(await screen.findByRole("heading", { name: "No linked chat accounts" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("unlinking", () => {
  const unlinkButton = async (name: string) =>
    within(await table()).getByRole("button", { name: `Unlink ${name}` });

  it("confirms, then removes the row at once, before any refetch", async () => {
    renderAccounts();
    await userEvent.click(await unlinkButton("ada"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Unlink ada?" })).toBeTruthy();
    expect(dialog.textContent).toContain(
      "Om won't recognize your messages from Acme Engineering until you link it again.",
    );
    holdReads = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(async () => expect(await tableRows()).toHaveLength(1));
    expect((await tableRows())[0]![0]).toBe("D1");
    expect(
      seen.filter((request) => request.path === "/api/ui/chat-accounts/unlink").map((r) => r.body),
    ).toEqual([{ organizationId: TEST_ORGANIZATION_ID, platform: "slack", externalUserId: "U1" }]);
  });

  it("names the platform when the workspace isn't known", async () => {
    renderAccounts();
    await userEvent.click(await unlinkButton("D1"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Unlink D1?" })).toBeTruthy();
    expect(dialog.textContent).toContain("Om won't recognize your messages from Discord");
  });

  it("keeps the row when cancelled", async () => {
    renderAccounts();
    await userEvent.click(await unlinkButton("ada"));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(await tableRows()).toHaveLength(2);
    expect(seen.some((request) => request.path === "/api/ui/chat-accounts/unlink")).toBe(false);
  });

  it("puts the row back with a toast when the server refuses", async () => {
    unlinkResponse = () =>
      jsonResponse({ ok: false, error: "That chat account isn't linked to you." }, 400);
    renderAccounts();
    await userEvent.click(await unlinkButton("ada"));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unlink" }),
    );
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        expect.stringContaining("That chat account isn't linked to you."),
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(await tableRows()).toHaveLength(2);
  });
});

describe("live updates", () => {
  const connected = (live: ReturnType<typeof fakeAbly>) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`user:${member.id}:changes`));

  it.each([
    ["the active organization", TEST_ORGANIZATION_ID],
    ["another of the user's organizations", BETA_ID],
  ])("shows a link completed in another tab, in %s", async (_, organizationId) => {
    const live = fakeAbly();
    renderAccounts({ live });
    expect(await tableRows()).toHaveLength(2);
    await connected(live);
    const reads = chatAccountReads().length;
    identities = [
      ...identities,
      { ...slack, organizationId, externalUserId: "U2", displayName: "ada-two" },
    ];
    act(() =>
      live
        .current()
        .deliver(
          `user:${member.id}:changes`,
          changeEvent(organizationId, { resource: "settings", section: "linked_accounts" }),
        ),
    );
    await waitFor(async () => expect(await tableRows()).toHaveLength(3));
    expect(chatAccountReads().length).toBe(reads + 1);
    expect((await tableRows())[2]![0]).toBe("ada-two");
    // Not a change to the user's own record: no server refresh.
    expect(nav.router.refresh).not.toHaveBeenCalled();
  });

  it("ignores other changes", async () => {
    const live = fakeAbly();
    renderAccounts({ live });
    expect(await tableRows()).toHaveLength(2);
    await connected(live);
    const reads = chatAccountReads().length;
    act(() => {
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "organization" }),
        );
      live
        .current()
        .deliver(
          `user:${member.id}:changes`,
          changeEvent(BETA_ID, { resource: "inbox_state", ids: ["manual_story:1"] }),
        );
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chatAccountReads().length).toBe(reads);
  });
});
