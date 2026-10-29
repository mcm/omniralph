// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
import { ShowAdvancedProvider } from "@/components/show-advanced";
import { UnsavedChangesProvider } from "@/components/unsaved-changes";
import type {
  AgentsCard,
  AgentsCardInput,
  PinnedAgent,
  RepositoryDetail,
  RepositoryListItem,
} from "@/lib/api/repositories";
import { ReposView } from "./repos-view";
import { portalRow, REPO_PORTAL, REPO_WEB, repoDetail, webRow } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/repos",
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

let rows: RepositoryListItem[];
let details: Record<string, RepositoryDetail>;
let seen: SeenRequest[];
let saveAnswer: (body: AgentsCardInput) => Response;
/** While set, reads never answer: what the view shows then comes from the cache. */
let holdReads: boolean;

const pending = () => new Promise<Response>(() => {});

const BUILD_1 = "a1111111-1111-4111-8111-111111111111";
const BUILD_2 = "a2222222-2222-4222-8222-222222222222";
const BUILD_3 = "a3333333-3333-4333-8333-333333333333";
const OLD_BOX = "a4444444-4444-4444-8444-444444444444";

const NAMES: Record<string, string> = {
  [BUILD_1]: "build-1",
  [BUILD_2]: "build-2",
  [BUILD_3]: "build-3",
  [OLD_BOX]: "old-box",
};

const pinned = (id: string, state: PinnedAgent["state"], runningForRepo = 0): PinnedAgent => ({
  id,
  name: NAMES[id]!,
  state,
  runningForRepo,
});

const agentsCardData = (): AgentsCard => ({
  pinned: [pinned(BUILD_1, "running", 2), pinned(BUILD_2, "idle")],
  pinnable: [{ id: BUILD_3, name: "build-3" }],
});

/** The card a save of `body` answers with: the pins, idle unless already known. */
const savedCard = (body: AgentsCardInput): AgentsCard => ({
  pinned: body.pinnedAgentIds.map(
    (id) =>
      details[REPO_PORTAL]!.agents.pinned.find((agent) => agent.id === id) ?? pinned(id, "idle"),
  ),
  pinnable: Object.keys(NAMES)
    .filter((id) => id !== OLD_BOX && !body.pinnedAgentIds.includes(id))
    .map((id) => ({ id, name: NAMES[id]! })),
});

beforeEach(() => {
  nav.router.push.mockReset();
  ui.toast.mockReset();
  rows = [portalRow(), webRow()];
  details = {
    [REPO_PORTAL]: repoDetail(portalRow(), { agents: agentsCardData() }),
    [REPO_WEB]: repoDetail(webRow()),
  };
  holdReads = false;
  saveAnswer = (body) => jsonResponse({ ok: true, card: savedCard(body) });
  window.history.replaceState(null, "", `/repos/${REPO_PORTAL}`);
  seen = mockFetch({
    "GET /api/ui/repositories": () =>
      holdReads ? pending() : jsonResponse({ repositories: rows, truncated: false }),
    ...Object.fromEntries(
      [REPO_PORTAL, REPO_WEB].map((id) => [
        `GET /api/ui/repositories/${id}`,
        () => (holdReads ? pending() : jsonResponse(details[id])),
      ]),
    ),
    ...Object.fromEntries(
      [REPO_PORTAL, REPO_WEB].map((id) => [
        `PUT /api/ui/repositories/${id}/agents`,
        (request: SeenRequest) => saveAnswer(request.body as AgentsCardInput),
      ]),
    ),
    "GET /api/ui/settings-history": { latest: null, entries: [], next: null },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderRepos(
  options: {
    repositoryId?: string;
    user?: SessionUser;
    live?: ReturnType<typeof fakeAbly>;
  } = {},
) {
  const client = createTestQueryClient();
  const view = <ReposView repositoryId={options.repositoryId ?? REPO_PORTAL} />;
  render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial={false}>
        <QueryClientProvider client={client}>
          <UiProvider linkComponent={TestLink}>
            <UnsavedChangesProvider>
              {options.live ? (
                <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
                  {view}
                </LiveProvider>
              ) : (
                view
              )}
            </UnsavedChangesProvider>
          </UiProvider>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
  return { client };
}

const agentsCard = () => screen.findByRole("region", { name: "Agents" });
const saveBar = (card: HTMLElement) =>
  within(card).queryByRole("region", { name: "Unsaved changes" });
const pendingItems = (card: HTMLElement) =>
  [...(saveBar(card)?.querySelectorAll(".or-pending__item") ?? [])].map((item) => ({
    label: item.querySelector(".or-pending__label")?.textContent,
    from: item.querySelector(".or-pending__from")?.textContent,
    to: item.querySelector(".or-pending__to")?.textContent,
    effect: item.querySelector(".or-pending__effect")?.textContent,
  }));
/** Each pinned-agent row: its name, state text and whether it is a staged pin. */
const agentRows = (card: HTMLElement) =>
  [...card.querySelectorAll<HTMLElement>(".or-repo-agents__row")].map((row) => ({
    name: row.querySelector("a")?.textContent?.trim(),
    state: row.querySelector(".or-status")?.textContent ?? null,
    pending: row.dataset.pending === "true",
  }));
const reads = () => seen.filter((request) => request.method === "GET");
const saves = () => seen.filter((request) => request.method === "PUT");

async function pinFromMenu(card: HTMLElement, name: string) {
  const user = userEvent.setup();
  await user.click(within(card).getByRole("button", { name: "Pin agent" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

describe("the Agents card", () => {
  it("shows the help line, change history and one row per pinned agent with its state", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      agents: {
        pinned: [
          pinned(BUILD_1, "running", 2),
          pinned(BUILD_2, "idle"),
          pinned(BUILD_3, "offline"),
          { ...pinned(OLD_BOX, "updating"), name: "updater" },
        ],
        pinnable: [],
      },
    });
    renderRepos();
    const card = await agentsCard();
    expect(card.closest("section#agents")).toBeTruthy();
    const heading = within(card).getByRole("heading", { level: 2, name: "Agents" });
    expect(heading.nextElementSibling).toBe(
      within(card).getByRole("button", { name: "Change history" }),
    );
    expect(
      within(card).getByText(
        "Work for this repo runs only on pinned agents. With none pinned, any agent can take it.",
      ),
    ).toBeTruthy();
    const list = within(card).getByRole("list", { name: "Pinned agents" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(items[0]!).getByRole("img", { name: "Running 2" })).toBeTruthy();
    expect(items[0]!.querySelector(".or-status--run")?.textContent).toBe("Running 2");
    expect(
      within(items[0]!)
        .getByRole("link", { name: /build-1/ })
        .getAttribute("href"),
    ).toBe(`/fleet/${BUILD_1}`);
    expect(items[1]!.querySelector(".or-status--neutral")?.textContent).toBe("Idle");
    expect(items[2]!.querySelector(".or-status--fail")?.textContent).toBe("Offline");
    expect(items[3]!.querySelector(".or-status--neutral")?.textContent).toBe("Updating");
    expect(within(items[1]!).getByRole("button", { name: "Unpin build-2" })).toBeTruthy();
    expect(saveBar(card)).toBeNull();
  });

  it("shows only the help line with no agent pinned", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      agents: { pinned: [], pinnable: [{ id: BUILD_3, name: "build-3" }] },
    });
    renderRepos();
    const card = await agentsCard();
    expect(within(card).queryByRole("list", { name: "Pinned agents" })).toBeNull();
    expect(within(card).getByText(/With none pinned, any agent can take it\./)).toBeTruthy();
  });

  it("pins one and unpins another: the bar shows both, Save sends the list once with no GET", async () => {
    renderRepos();
    const card = await agentsCard();
    await waitFor(() => expect(reads().length).toBeGreaterThanOrEqual(2));
    await pinFromMenu(card, "build-3");
    expect(agentRows(card)).toEqual([
      { name: "build-1", state: "Running 2", pending: false },
      { name: "build-2", state: "Idle", pending: false },
      { name: "build-3", state: null, pending: true },
    ]);
    expect(within(card).getByText("Pending")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Unpin build-2" }));
    expect(pendingItems(card)).toEqual([
      {
        label: "Agent unpinned",
        from: "build-2",
        to: undefined,
        effect: "build-2 no longer takes this repo's work.",
      },
      {
        label: "Agent pinned",
        from: undefined,
        to: "build-3",
        effect: "Work for this repo runs only on pinned agents.",
      },
    ]);
    const readsBefore = reads().length;
    await user.click(within(card).getByRole("button", { name: "Save 2 changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.path).toBe(`/api/ui/repositories/${REPO_PORTAL}/agents`);
    expect(saves()[0]!.body).toEqual({ pinnedAgentIds: [BUILD_1, BUILD_3] });
    expect(ui.toast).toHaveBeenCalledWith("Saved");
    expect(agentRows(card)).toEqual([
      { name: "build-1", state: "Running 2", pending: false },
      { name: "build-3", state: "Idle", pending: false },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads()).toHaveLength(readsBefore);
  });

  it("says any agent can take the work when the last pin goes", async () => {
    renderRepos();
    const card = await agentsCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Unpin build-1" }));
    await user.click(within(card).getByRole("button", { name: "Unpin build-2" }));
    expect(pendingItems(card).map((item) => item.effect)).toEqual([
      "build-1 no longer takes this repo's work.",
      "Any agent can take this repo's work.",
    ]);
    expect(within(card).queryByRole("list", { name: "Pinned agents" })).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Save 2 changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()[0]!.body).toEqual({ pinnedAgentIds: [] });
  });

  it("shows a revoked pinned agent as Revoked and lets it be unpinned", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      agents: { pinned: [pinned(BUILD_1, "idle"), pinned(OLD_BOX, "revoked")], pinnable: [] },
    });
    renderRepos();
    const card = await agentsCard();
    expect(agentRows(card)[1]).toEqual({ name: "old-box", state: "Revoked", pending: false });
    expect(card.querySelectorAll(".or-status--fail")).toHaveLength(1);
    await userEvent.setup().click(within(card).getByRole("button", { name: "Unpin old-box" }));
    expect(pendingItems(card).map((item) => [item.label, item.effect])).toEqual([
      ["Agent unpinned", "old-box no longer takes this repo's work."],
    ]);
    await userEvent.setup().click(within(card).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()[0]!.body).toEqual({ pinnedAgentIds: [BUILD_1] });
  });

  it("discards back to the saved pins", async () => {
    renderRepos();
    const card = await agentsCard();
    await pinFromMenu(card, "build-3");
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Unpin build-1" }));
    expect(pendingItems(card)).toHaveLength(2);
    await user.click(within(card).getByRole("button", { name: "Discard" }));
    expect(agentRows(card)).toEqual([
      { name: "build-1", state: "Running 2", pending: false },
      { name: "build-2", state: "Idle", pending: false },
    ]);
    expect(saveBar(card)).toBeNull();
    expect(saves()).toEqual([]);
  });

  it("disables Pin agent with a reason when every agent is pinned", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      agents: { pinned: [pinned(BUILD_1, "idle")], pinnable: [] },
    });
    renderRepos();
    const card = await agentsCard();
    const button = within(card).getByRole("button", { name: "Pin agent" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const user = userEvent.setup();
    await user.hover(button);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Every agent is already pinned");
    await user.click(button);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers each pinnable agent as its agent badge (Design rule 1)", async () => {
    renderRepos();
    const card = await agentsCard();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Pin agent" }));
    const item = await screen.findByRole("menuitem", { name: "build-3" });
    const badge = item.querySelector('[data-or-badge="agent"]');
    expect(badge?.querySelector(".or-ref__text")?.textContent).toBe("build-3");
  });

  it("offers an agent unpinned in the draft again, and re-pinning un-stages it", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      agents: { pinned: [pinned(BUILD_1, "idle")], pinnable: [] },
    });
    renderRepos();
    const card = await agentsCard();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Unpin build-1" }));
    expect(pendingItems(card)).toHaveLength(1);
    await pinFromMenu(card, "build-1");
    expect(saveBar(card)).toBeNull();
  });

  it("has nothing to save, and doesn't ask before leaving, after unpinning and re-pinning one of two", async () => {
    renderRepos();
    const card = await agentsCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Unpin build-1" }));
    expect(pendingItems(card)).toHaveLength(1);
    await pinFromMenu(card, "build-1");
    expect(saveBar(card)).toBeNull();
    const web = within(screen.getByRole("region", { name: "Repos" }))
      .getAllByRole("link")
      .find((link) => link.getAttribute("href") === `/repos/${REPO_WEB}`)!;
    await user.click(web);
    expect(screen.queryByRole("alertdialog", { name: "Leave without saving?" })).toBeNull();
    expect(nav.router.push).toHaveBeenCalledWith(`/repos/${REPO_WEB}`);
  });

  it("updates a row's state from an agent change event", async () => {
    const live = fakeAbly();
    renderRepos({ live });
    const card = await agentsCard();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    expect(agentRows(card)[1]!.state).toBe("Idle");
    const detailReads = () =>
      reads().filter((request) => request.path === `/api/ui/repositories/${REPO_PORTAL}`).length;
    const before = detailReads();
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      agents: { pinned: [pinned(BUILD_1, "running", 2), pinned(BUILD_2, "offline")], pinnable: [] },
    });
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "agent", ids: [BUILD_2] }),
        ),
    );
    await waitFor(() => expect(agentRows(card)[1]!.state).toBe("Offline"));
    expect(detailReads()).toBeGreaterThan(before);
  });

  it("shows members the list with no pin or unpin controls and no save bar", async () => {
    details[REPO_PORTAL] = repoDetail(
      portalRow({ organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" } }),
      { agents: agentsCardData() },
    );
    renderRepos({ user: member });
    const card = await agentsCard();
    expect(agentRows(card)).toHaveLength(2);
    expect(within(card).queryByRole("button", { name: "Pin agent" })).toBeNull();
    expect(within(card).queryByRole("button", { name: /^Unpin / })).toBeNull();
    expect(saveBar(card)).toBeNull();
  });
});
