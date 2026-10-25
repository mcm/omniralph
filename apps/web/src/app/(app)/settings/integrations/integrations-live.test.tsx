// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
} from "@/components/query-test-utils";
import type * as OmniralphUi from "@omniralph/ui";
import type { IntegrationsSettings, SlackWorkspace } from "@/lib/api/integrations";
import { IntegrationsView } from "./integrations-view";

const navigation = vi.hoisted(() => ({
  search: new URLSearchParams(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect ${path}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/integrations",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => navigation.search,
  redirect: navigation.redirect,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: toasts.toast,
}));

const PATH = "/api/ui/integrations";
const SLACK_ID = "a1111111-1111-4111-8111-111111111111";
const OTHER_SLACK_ID = "a2222222-2222-4222-8222-222222222222";

const workspace = (id: string, name: string): SlackWorkspace => ({
  id,
  name,
  workspaceId: `T-${name}`,
  installedBy: "ada@acme.test",
  connectedAt: "2026-10-02T00:00:00.000Z",
});

function settings(overrides: Partial<IntegrationsSettings> = {}): IntegrationsSettings {
  const slack = overrides.slack ?? [workspace(SLACK_ID, "Acme Slack")];
  return {
    linear: { name: "Acme", workspaceId: "W01", connectedAt: "2026-10-01T00:00:00.000Z" },
    linearConfigured: true,
    slack,
    slackConfigured: true,
    discord: [],
    discordConfigured: true,
    chatPlaybooks: {
      defaults: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" },
      builtinDefaults: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" },
      choices: {
        ask: [
          { id: "builtin:ask-about-code", name: "Ask about code", builtin: true },
          { id: "custom-query", name: "Security Q and A", builtin: false },
        ],
        startWork: [{ id: "builtin:handle-request", name: "Handle a request", builtin: true }],
      },
      connections: slack.map((s) => ({
        id: s.id,
        name: s.name,
        platform: "slack" as const,
        channels: [],
      })),
    },
    ...overrides,
  };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(<IntegrationsView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

/** The card titled `title`: the heading's closest ancestor with buttons. */
function card(title: string): HTMLElement {
  // The last one: OAuth notices above the cards have headings too ("Slack connected").
  let element = screen.getAllByRole("heading", { name: new RegExp(`^${title}`) }).at(-1)!;
  while (!element.querySelector("button") && element.parentElement) {
    element = element.parentElement;
  }
  return element;
}
/** A Slack workspace's name in the Slack card. */
const slackNamed = (name: string) =>
  within(card("Slack")).queryByText(name, { selector: "strong" });

beforeEach(() => {
  vi.unstubAllGlobals();
  toasts.toast.mockReset();
  navigation.search = new URLSearchParams();
});

describe("IntegrationsView", () => {
  it("shows a skeleton, then the integrations", async () => {
    mockFetch({ [`GET ${PATH}`]: settings() });
    renderView();
    expect(screen.getByLabelText("Loading the integrations")).toBeTruthy();
    await waitFor(() => expect(slackNamed("Acme Slack")).toBeTruthy());
    expect(screen.getByText(/Connected to the/)).toBeTruthy();
  });

  it("shows the OAuth outcome from the URL above the cards", async () => {
    mockFetch({ [`GET ${PATH}`]: settings() });
    navigation.search = new URLSearchParams("slack=connected&linear=bogus");
    renderView();
    expect(screen.getByText("Slack connected")).toBeTruthy();
    expect(screen.queryByText(/^Linear/, { selector: "h2" })).toBeNull();
    await waitFor(() => expect(slackNamed("Acme Slack")).toBeTruthy());
  });

  it("sends members to the access-denied page", () => {
    mockFetch({});
    expect(() => renderView("member")).toThrow("redirect /access-denied?reason=forbidden");
  });

  it("shows an error with a retry when the integrations don't load", async () => {
    let fail = true;
    mockFetch({
      [`GET ${PATH}`]: () =>
        fail ? jsonResponse({ error: "Database down." }, 500) : jsonResponse(settings()),
    });
    renderView();
    expect(await screen.findByText("Couldn't load the integrations")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(slackNamed("Acme Slack")).toBeTruthy());
  });

  it("shows a workspace connected elsewhere (another tab's install) on the next refetch", async () => {
    let slack = [workspace(SLACK_ID, "Acme Slack")];
    mockFetch({ [`GET ${PATH}`]: () => jsonResponse(settings({ slack })) });
    const client = renderView();
    await waitFor(() => expect(slackNamed("Acme Slack")).toBeTruthy());
    slack = [...slack, workspace(OTHER_SLACK_ID, "Acme Grid")];
    await client.invalidateQueries();
    await waitFor(() => expect(slackNamed("Acme Grid")).toBeTruthy());
    expect(screen.getByText("Connect another workspace")).toBeTruthy();
  });

  it("disconnects a workspace and shows the list without it, without a reload", async () => {
    let slack = [workspace(SLACK_ID, "Acme Slack"), workspace(OTHER_SLACK_ID, "Acme Grid")];
    const seen = mockFetch({
      [`GET ${PATH}`]: () => jsonResponse(settings({ slack })),
      [`DELETE ${PATH}/slack/${SLACK_ID}`]: () => {
        slack = slack.filter((s) => s.id !== SLACK_ID);
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(slackNamed("Acme Grid")).toBeTruthy());
    await userEvent.click(within(card("Slack")).getAllByRole("button", { name: /Disconnect/ })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Disconnect Acme Slack?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(slackNamed("Acme Slack")).toBeNull());
    expect(slackNamed("Acme Grid")).toBeTruthy();
    expect(seen.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(toasts.toast).toHaveBeenCalledWith("Disconnected Acme Slack");
    // The repository Coding tab's Linear status and run lists refetch too.
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify([testUser.organization.id, "connections"]),
        JSON.stringify([testUser.organization.id, "runs"]),
      ]),
    );
  });

  it("shows a disconnect's warning (token not revoked) instead of the success toast", async () => {
    let linear: IntegrationsSettings["linear"] = settings().linear;
    mockFetch({
      [`GET ${PATH}`]: () => jsonResponse(settings({ linear })),
      [`DELETE ${PATH}/linear`]: () => {
        linear = null;
        return jsonResponse({ ok: true, warning: "Disconnected Acme, but Linear didn't confirm." });
      },
    });
    renderView();
    await userEvent.click(
      within(
        await screen.findByText(/Connected to the/).then((el) => el.closest("div")!.parentElement!),
      ).getByRole("button", { name: /Disconnect/ }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
    );
    expect(
      await screen.findByText(/Install the Omniralph app in one Linear workspace/),
    ).toBeTruthy();
    expect(toasts.toast).toHaveBeenCalledWith("Disconnected Acme, but Linear didn't confirm.", {
      variant: "warning",
    });
  });
});
