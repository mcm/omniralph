// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatOverridesSettingsPage from "@/app/(app)/settings/advanced/chat/page";
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
import type { ChatPlaybooksSettings } from "@/lib/api/integrations";
import { SettingsLayoutView } from "../settings-layout-view";
import { organizationSettings } from "../test-fixtures";
import {
  NO_CHAT_CONNECTION,
  NO_OVERRIDES,
  PLAYBOOK_REQUIRED,
  withOverride,
  withoutOverride,
} from "./chat-overrides-settings";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/advanced/chat",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const SLACK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISCORD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECURITY_QA = "11111111-1111-4111-8111-111111111111";
const HOTFIX = "22222222-2222-4222-8222-222222222222";
const OTHER_ORGANIZATION_ID = "99999999-9999-4999-8999-999999999999";

function chatSettings(overrides: Partial<ChatPlaybooksSettings> = {}): ChatPlaybooksSettings {
  return {
    defaults: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" },
    builtinDefaults: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" },
    choices: {
      ask: [
        { id: "builtin:ask-about-code", name: "Ask about code", builtin: true },
        { id: SECURITY_QA, name: "Security Q&A", builtin: false },
      ],
      startWork: [
        { id: "builtin:handle-request", name: "Handle a request", builtin: true },
        { id: HOTFIX, name: "Hotfix", builtin: false },
      ],
    },
    connections: [
      {
        id: SLACK_ID,
        name: "Acme Engineering",
        platform: "slack",
        channels: [
          { channelId: "slack:C0OPS0001", channel: "C0OPS0001", ask: SECURITY_QA, startWork: null },
        ],
      },
      { id: DISCORD_ID, name: "Acme Gaming", platform: "discord", channels: [] },
    ],
    ...overrides,
  };
}

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

let settings: ChatPlaybooksSettings;
let seen: SeenRequest[];
/** While set, `GET /api/ui/integrations/chat-tasks` never answers: the view shows the cache. */
let holdReads: boolean;
let defaultsResponse: () => Response;
let channelResponse: (request: SeenRequest) => Response;
let removeResponse: () => Response;

const channelsPath = (id: string) => `/api/ui/integrations/chat-connections/${id}/channels`;

beforeEach(() => {
  ui.toast.mockReset();
  settings = chatSettings();
  holdReads = false;
  defaultsResponse = () => jsonResponse({ ok: true });
  channelResponse = (request) => {
    const body = request.body as { channel: string; ask: string | null; startWork: string | null };
    const channel = body.channel.startsWith("#") ? "C0RELEASE" : body.channel;
    return jsonResponse({
      ok: true,
      channel: { channelId: `slack:${channel}`, channel, ask: body.ask, startWork: body.startWork },
    });
  };
  removeResponse = () => jsonResponse({ ok: true });
  seen = mockFetch({
    "GET /api/ui/connections": { connections: [] },
    "GET /api/ui/organization": () => jsonResponse(organizationSettings()),
    "GET /api/ui/integrations/chat-tasks": () =>
      holdReads ? new Promise<Response>(() => {}) : jsonResponse(settings),
    "PUT /api/ui/integrations/chat-tasks": () => defaultsResponse(),
    [`PUT ${channelsPath(SLACK_ID)}`]: (request) => channelResponse(request),
    [`PUT ${channelsPath(DISCORD_ID)}`]: (request) => channelResponse(request),
    [`DELETE ${channelsPath(SLACK_ID)}`]: () => removeResponse(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage(options: { user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {}) {
  const page = (
    <SettingsLayoutView>
      <ChatOverridesSettingsPage />
    </SettingsLayoutView>
  );
  render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial>
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

const defaultsCard = () => screen.findByRole("region", { name: "Organization default" });
const overridesCard = () => screen.findByRole("region", { name: "Channel overrides" });
const select = (name: string) => screen.findByRole<HTMLSelectElement>("combobox", { name });
const selectedText = (element: HTMLSelectElement) =>
  element.options[element.selectedIndex]?.textContent;
const table = () => screen.findByRole("table", { name: "Channel overrides" });

/** The table's rows (desktop): channel, workspace and each slot's playbook. */
async function tableRows() {
  return within(await table())
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .slice(0, 4)
        .map((cell) => {
          const copy = cell.cloneNode(true) as HTMLElement;
          copy.querySelectorAll("svg, title").forEach((node) => node.remove());
          return copy.textContent!.trim();
        }),
    );
}

const chatReads = () =>
  seen.filter(
    (request) => request.method === "GET" && request.path === "/api/ui/integrations/chat-tasks",
  );
const writes = () => seen.filter((request) => request.method !== "GET");

describe("Organization default", () => {
  it("shows the two selects with the organization's playbooks, defaulting to the built-ins", async () => {
    renderPage();
    const card = await defaultsCard();
    const ask = await select("Answer questions with");
    const startWork = await select("Start work with");
    expect(card.contains(ask) && card.contains(startWork)).toBe(true);
    expect(selectedText(ask)).toBe("Ask about code (built-in)");
    expect(selectedText(startWork)).toBe("Handle a request (built-in)");
    // Only playbooks of each slot's role: chat-ask, then request.
    expect([...ask.options].map((option) => option.textContent)).toEqual([
      "Ask about code (built-in)",
      "Security Q&A",
    ]);
    expect([...startWork.options].map((option) => option.textContent)).toEqual([
      "Handle a request (built-in)",
      "Hotfix",
    ]);
  });

  it("stages a change in the save bar and saves it, shown before any refetch", async () => {
    renderPage();
    await userEvent.selectOptions(await select("Answer questions with"), SECURITY_QA);
    const card = await defaultsCard();
    expect(card.textContent).toContain("Answer questions with");
    expect(card.textContent).toContain("Security Q&A");
    holdReads = true;
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Saved the chat playbooks"));
    expect(writes().map((request) => [request.method, request.path, request.body])).toEqual([
      [
        "PUT",
        "/api/ui/integrations/chat-tasks",
        { ask: SECURITY_QA, startWork: "builtin:handle-request" },
      ],
    ]);
    expect(selectedText(await select("Answer questions with"))).toBe("Security Q&A");
    expect(within(await defaultsCard()).queryByRole("button", { name: "Save" })).toBeNull();
    // The new default shows in the override sheet without a refetch answering.
    await userEvent.click(
      within(await overridesCard()).getByRole("button", { name: "Add override" }),
    );
    const sheet = await screen.findByRole("dialog");
    const sheetAsk = within(sheet).getByRole<HTMLSelectElement>("combobox", {
      name: "Answer questions with",
    });
    expect(sheetAsk.options[0]!.textContent).toBe("Organization default (Security Q&A)");
  });

  it("discards a staged change", async () => {
    renderPage();
    await userEvent.selectOptions(await select("Start work with"), HOTFIX);
    await userEvent.click(within(await defaultsCard()).getByRole("button", { name: "Discard" }));
    expect(selectedText(await select("Start work with"))).toBe("Handle a request (built-in)");
    expect(writes()).toEqual([]);
  });

  it("shows a role mismatch's message under its select, and keeps the change staged", async () => {
    const error = "Ask about code needs a chat-ask playbook; Security Q&A is a request playbook.";
    defaultsResponse = () => jsonResponse({ error, fieldErrors: { ask: error } }, 400);
    renderPage();
    await userEvent.selectOptions(await select("Answer questions with"), SECURITY_QA);
    await userEvent.click(within(await defaultsCard()).getByRole("button", { name: "Save" }));
    const ask = await select("Answer questions with");
    await waitFor(() => {
      const describedBy = ask.getAttribute("aria-describedby") ?? "";
      const text = describedBy
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
      expect(text).toContain(error);
    });
    expect(selectedText(ask)).toBe("Security Q&A");
    expect(within(await defaultsCard()).getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("offers a saved playbook the organization no longer has, by its ID", async () => {
    settings = chatSettings({
      defaults: { ask: "gone-playbook", startWork: "builtin:handle-request" },
    });
    renderPage();
    expect(selectedText(await select("Answer questions with"))).toBe("gone-playbook");
  });
});

describe("Channel overrides", () => {
  it("lists each connection's overrides with brand, workspace, channel and both playbooks", async () => {
    renderPage();
    expect(await tableRows()).toEqual([
      ["C0OPS0001", "Acme Engineering", "Security Q&A", "Organization default"],
    ]);
    const [row] = within(await table())
      .getAllByRole("row")
      .slice(1);
    expect(within(row!).getByRole("img", { name: "Slack" })).toBeTruthy();
    expect(within(row!).getByRole("button", { name: "Edit override for C0OPS0001" })).toBeTruthy();
    expect(
      within(row!).getByRole("button", { name: "Remove override for C0OPS0001" }),
    ).toBeTruthy();
    // The same rows as phone cards.
    const [card] = within(screen.getByRole("list", { name: "Channel overrides" })).getAllByRole(
      "listitem",
    );
    expect(card!.textContent).toContain("C0OPS0001");
    expect(within(card!).getByRole("button", { name: "Edit override for C0OPS0001" })).toBeTruthy();
  });

  it("says so when no channel overrides a playbook", async () => {
    settings = chatSettings({
      connections: chatSettings().connections.map((c) => ({ ...c, channels: [] })),
    });
    renderPage();
    expect((await overridesCard()).textContent).toContain(NO_OVERRIDES);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("asks for a chat connection first, with a link to add one", async () => {
    settings = chatSettings({ connections: [] });
    renderPage();
    const card = await overridesCard();
    expect(card.textContent).toContain(NO_CHAT_CONNECTION);
    expect(within(card).getByRole("link", { name: "Add connection" }).getAttribute("href")).toBe(
      "/settings/connections/new",
    );
    expect(within(card).queryByRole("button", { name: "Add override" })).toBeNull();
  });

  it("adds an override by channel name, shown before any refetch", async () => {
    renderPage();
    await userEvent.click(
      within(await overridesCard()).getByRole("button", { name: "Add override" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Add override" });
    const connection = within(sheet).getByRole<HTMLSelectElement>("combobox", {
      name: "Connection",
    });
    expect([...connection.options].map((option) => option.textContent)).toEqual([
      "Slack · Acme Engineering",
      "Discord · Acme Gaming",
    ]);
    const startWork = within(sheet).getByRole<HTMLSelectElement>("combobox", {
      name: "Start work with",
    });
    expect(startWork.options[0]!.textContent).toBe("Organization default (Handle a request)");
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Channel" }), "#release");
    await userEvent.selectOptions(startWork, HOTFIX);
    holdReads = true;
    await userEvent.click(within(sheet).getByRole("button", { name: "Add override" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes().map((request) => [request.method, request.path, request.body])).toEqual([
      ["PUT", channelsPath(SLACK_ID), { channel: "#release", ask: null, startWork: HOTFIX }],
    ]);
    expect(await tableRows()).toEqual([
      ["C0OPS0001", "Acme Engineering", "Security Q&A", "Organization default"],
      ["C0RELEASE", "Acme Engineering", "Organization default", "Hotfix"],
    ]);
    expect(ui.toast).toHaveBeenCalledWith("Added C0RELEASE");
  });

  it("refuses an override without a channel or a playbook before any request", async () => {
    renderPage();
    await userEvent.click(
      within(await overridesCard()).getByRole("button", { name: "Add override" }),
    );
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(within(sheet).getByRole("button", { name: "Add override" }));
    expect(
      within(sheet).getByRole("textbox", { name: "Channel" }).getAttribute("aria-invalid"),
    ).toBe("true");
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Channel" }), "C0NEW0001");
    await userEvent.click(within(sheet).getByRole("button", { name: "Add override" }));
    expect(within(sheet).getByRole("alert").textContent).toBe(PLAYBOOK_REQUIRED);
    expect(writes()).toEqual([]);
  });

  it("shows the server's refusal in the sheet: a channel it can't find, a role mismatch", async () => {
    const channelError =
      "Om can't find #nowhere in Acme Engineering. Enter its channel ID instead.";
    channelResponse = () =>
      jsonResponse({ error: channelError, fieldErrors: { channel: channelError } }, 400);
    renderPage();
    await userEvent.click(
      within(await overridesCard()).getByRole("button", { name: "Add override" }),
    );
    const sheet = await screen.findByRole("dialog");
    const channel = within(sheet).getByRole("textbox", { name: "Channel" });
    await userEvent.type(channel, "nowhere");
    await userEvent.selectOptions(
      within(sheet).getByRole("combobox", { name: "Answer questions with" }),
      SECURITY_QA,
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Add override" }));
    await waitFor(() => expect(channel.getAttribute("aria-invalid")).toBe("true"));
    expect(sheet.textContent).toContain(channelError);
    expect(ui.toast).toHaveBeenCalledWith(channelError, { variant: "danger" });

    const roleError = "Start work needs a request playbook; Hotfix is a chat-ask playbook.";
    channelResponse = () =>
      jsonResponse({ error: roleError, fieldErrors: { startWork: roleError } }, 400);
    await userEvent.clear(channel);
    await userEvent.type(channel, "C0NEW0001");
    await userEvent.selectOptions(
      within(sheet).getByRole("combobox", { name: "Start work with" }),
      HOTFIX,
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Add override" }));
    await waitFor(() => expect(sheet.textContent).toContain(roleError));
    // The sheet stays open; once closed, nothing was added.
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await tableRows()).toHaveLength(1);
  });

  it("edits an override, shown before any refetch", async () => {
    renderPage();
    await userEvent.click(
      within(await table()).getByRole("button", { name: "Edit override for C0OPS0001" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Edit override for C0OPS0001" });
    expect(
      within(sheet).getByRole<HTMLSelectElement>("combobox", { name: "Connection" }).disabled,
    ).toBe(true);
    expect(within(sheet).getByRole<HTMLInputElement>("textbox", { name: "Channel" }).readOnly).toBe(
      true,
    );
    const ask = within(sheet).getByRole<HTMLSelectElement>("combobox", {
      name: "Answer questions with",
    });
    expect(selectedText(ask)).toBe("Security Q&A");
    await userEvent.selectOptions(ask, "");
    await userEvent.selectOptions(
      within(sheet).getByRole("combobox", { name: "Start work with" }),
      HOTFIX,
    );
    holdReads = true;
    await userEvent.click(within(sheet).getByRole("button", { name: "Save override" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes().map((request) => [request.method, request.path, request.body])).toEqual([
      ["PUT", channelsPath(SLACK_ID), { channel: "C0OPS0001", ask: null, startWork: HOTFIX }],
    ]);
    expect(await tableRows()).toEqual([
      ["C0OPS0001", "Acme Engineering", "Organization default", "Hotfix"],
    ]);
  });

  it("removes an override after confirming, before any refetch", async () => {
    renderPage();
    await userEvent.click(
      within(await table()).getByRole("button", { name: "Remove override for C0OPS0001" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByRole("heading", { name: "Remove the override for C0OPS0001?" }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      "C0OPS0001 in Acme Engineering uses the organization default again.",
    );
    holdReads = true;
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect((await overridesCard()).textContent).toContain(NO_OVERRIDES);
    expect(writes().map((request) => [request.method, request.path, request.body])).toEqual([
      ["DELETE", channelsPath(SLACK_ID), { channelId: "slack:C0OPS0001" }],
    ]);
  });

  it("puts a removed override back with a toast when the server refuses", async () => {
    removeResponse = () =>
      jsonResponse({ ok: false, error: "That channel has no playbook overrides." }, 400);
    renderPage();
    await userEvent.click(
      within(await table()).getByRole("button", { name: "Remove override for C0OPS0001" }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("That channel has no playbook overrides.", {
        variant: "danger",
      }),
    );
    expect(await tableRows()).toHaveLength(1);
  });
});

describe("members", () => {
  it("see both cards read-only", async () => {
    renderPage({ user: member });
    expect((await select("Answer questions with")).disabled).toBe(true);
    expect((await select("Start work with")).disabled).toBe(true);
    expect(within(await defaultsCard()).queryByRole("button")).toBeNull();
    expect(await tableRows()).toEqual([
      ["C0OPS0001", "Acme Engineering", "Security Q&A", "Organization default"],
    ]);
    const overrides = await overridesCard();
    expect(within(overrides).queryByRole("button", { name: /override/ })).toBeNull();
    expect(within(overrides).queryByRole("button", { name: "Add override" })).toBeNull();
  });

  it("see the link to add a chat connection when there is none", async () => {
    settings = chatSettings({ connections: [] });
    renderPage({ user: member });
    const card = await overridesCard();
    expect(card.textContent).toContain(NO_CHAT_CONNECTION);
    expect(within(card).getByRole("link", { name: "Add connection" })).toBeTruthy();
  });
});

describe("loading", () => {
  it("offers a retry when the read fails", async () => {
    let fail = true;
    seen = mockFetch({
      "GET /api/ui/connections": { connections: [] },
      "GET /api/ui/organization": () => jsonResponse(organizationSettings()),
      "GET /api/ui/integrations/chat-tasks": () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(settings),
    });
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Couldn't load the chat playbooks" }),
    ).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await defaultsCard()).toBeTruthy();
  });
});

describe("live updates", () => {
  const channel = `org:${TEST_ORGANIZATION_ID}:changes`;
  const connected = (live: ReturnType<typeof fakeAbly>) =>
    waitFor(() => expect(live.current().subscribed()).toContain(channel));

  it("shows another admin's saves from a chat_playbooks event", async () => {
    const live = fakeAbly();
    renderPage({ live });
    expect(await tableRows()).toHaveLength(1);
    await connected(live);
    settings = withOverride(
      { ...settings, defaults: { ask: SECURITY_QA, startWork: HOTFIX } },
      DISCORD_ID,
      { channelId: "discord:G1:123", channel: "123", ask: null, startWork: HOTFIX },
    );
    act(() =>
      live.current().deliver(
        channel,
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "settings",
          section: "chat_playbooks",
          ids: [TEST_ORGANIZATION_ID],
        }),
      ),
    );
    await waitFor(async () => expect(await tableRows()).toHaveLength(2));
    expect((await tableRows())[1]).toEqual([
      "123",
      "Acme Gaming",
      "Organization default",
      "Hotfix",
    ]);
    expect(selectedText(await select("Answer questions with"))).toBe("Security Q&A");
    expect(selectedText(await select("Start work with"))).toBe("Hotfix");
  });

  it("follows a playbook's rename and a chat connection's removal", async () => {
    const live = fakeAbly();
    renderPage({ live });
    expect(await tableRows()).toHaveLength(1);
    await connected(live);
    settings = chatSettings({
      choices: {
        ...settings.choices,
        ask: [
          settings.choices.ask[0]!,
          { id: SECURITY_QA, name: "Security answers", builtin: false },
        ],
      },
    });
    act(() =>
      live.current().deliver(
        channel,
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "settings",
          section: "playbooks",
          ids: [SECURITY_QA],
          subjectId: SECURITY_QA,
        }),
      ),
    );
    await waitFor(async () => expect((await tableRows())[0]![2]).toBe("Security answers"));

    settings = withoutOverride(
      { ...settings, connections: settings.connections.slice(0, 1) },
      SLACK_ID,
      "slack:C0OPS0001",
    );
    act(() =>
      live
        .current()
        .deliver(
          channel,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "connection", ids: [SLACK_ID] }),
        ),
    );
    await waitFor(async () => expect((await overridesCard()).textContent).toContain(NO_OVERRIDES));
  });

  it("ignores another organization's changes", async () => {
    const live = fakeAbly();
    renderPage({ live });
    expect(await tableRows()).toHaveLength(1);
    await connected(live);
    const reads = chatReads().length;
    act(() =>
      live.current().deliver(
        channel,
        changeEvent(OTHER_ORGANIZATION_ID, {
          resource: "settings",
          section: "chat_playbooks",
          ids: [OTHER_ORGANIZATION_ID],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chatReads().length).toBe(reads);
  });
});

describe("phone layout", () => {
  it("stacks the overrides as cards at 768 px and narrower (DataTable's phone cards)", () => {
    const view = readFileSync(path.resolve(__dirname, "chat-overrides-settings.tsx"), "utf8");
    expect(view).toMatch(/<DataTable\b/);
    const uiStyles = path.dirname(
      createRequire(import.meta.url).resolve("@omniralph/ui/styles.css"),
    );
    const lists = readFileSync(path.join(uiStyles, "lists.css"), "utf8");
    const phone = /@media \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(lists)?.[1] ?? "";
    expect(phone).toMatch(/\.or-tblwrap\s*\{\s*display: none;/);
    expect(phone).toMatch(/\.or-cards\s*\{\s*display: flex;/);
    // Nothing here overrides it.
    const own = readFileSync(path.resolve(__dirname, "chat.css"), "utf8");
    expect(own).not.toMatch(/\.or-(tblwrap|cards)\b/);
  });
});
