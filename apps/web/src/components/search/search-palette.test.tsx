// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse, SearchResult } from "@/lib/api/search";
import { CurrentUserProvider, type SessionUser } from "../current-user";
import { jsonResponse, mockFetch, TEST_ORGANIZATION_ID, testUser } from "../query-test-utils";
import { ShortcutProvider, type ShortcutPlatform } from "@omniralph/ui";
import { SHORTCUTS } from "@/lib/shortcuts";
import { NO_RECENT_MESSAGE, SEARCH_DEBOUNCE_MS, SearchProvider, useSearch } from "./search-palette";

const nav = vi.hoisted(() => ({ router: { push: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => nav.router }));

const ACME = { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" as const };
const BETA = { id: "22222222-2222-4222-8222-222222222222", name: "Beta", role: "member" as const };
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const REPO_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const iso = "2026-10-28T10:00:00.000Z";

const run: SearchResult = {
  kind: "run",
  id: RUN_ID,
  href: `/runs/${RUN_ID}`,
  run: {
    id: RUN_ID,
    kind: "epic",
    status: "running",
    origin: "tracker",
    tracker: "linear",
    organization: BETA,
    title: "Fix the login form",
    workItem: { id: "linear-1", tracker: "linear", identifier: "SOC-1719", url: null },
    repository: { id: REPO_ID, provider: "gitlab", fullPath: "acme/web" },
    branch: null,
    pullRequest: { provider: "gitlab", number: 42, url: null },
    agent: null,
    progress: null,
    tokens: { in: 0, out: 0 },
    createdAt: iso,
    startedAt: null,
    finishedAt: null,
    updatedAt: iso,
  },
};
const workItem: SearchResult = {
  kind: "workItem",
  id: "linear-2",
  href: "/backlog/linear-2",
  workItem: {
    id: "linear-2",
    tracker: "linear",
    identifier: "SOC-1720",
    title: "Add a logout button",
    url: "https://linear.app/acme/issue/SOC-1720",
    organization: ACME,
    repository: null,
    kind: null,
    size: "S",
    group: "ready",
    blocked: false,
    blockers: [],
    blockedLabels: [],
    manual: false,
    triageRunning: false,
    source: { kind: "team", id: "team-1", name: "SOC" },
  },
};
const repository: SearchResult = {
  kind: "repository",
  id: REPO_ID,
  href: `/repos/${REPO_ID}`,
  repository: { id: REPO_ID, organization: ACME, provider: "github", fullPath: "acme/api" },
};
const agent: SearchResult = {
  kind: "agent",
  id: AGENT_ID,
  href: `/fleet/${AGENT_ID}`,
  agent: {
    id: AGENT_ID,
    organization: ACME,
    name: "builder-1",
    status: { label: "Online", tone: "good" },
  },
};
const settings: SearchResult = {
  kind: "settings",
  id: "/settings/members",
  href: "/settings/members",
  settings: { title: "Members", section: "Organization" },
};

const RESULTS: SearchResponse = {
  mode: "results",
  groups: [
    { id: "run", label: "Runs", results: [run] },
    { id: "workItem", label: "Work items", results: [workItem] },
    { id: "repository", label: "Repos", results: [repository] },
    { id: "agent", label: "Agents", results: [agent] },
    { id: "settings", label: "Settings", results: [settings] },
  ],
};
const RECENT: SearchResponse = {
  mode: "recent",
  groups: [{ id: "recent", label: "Recent", results: [repository, settings] }],
};

function Opener() {
  const { openSearch } = useSearch();
  return (
    <button type="button" onClick={openSearch}>
      Open search
    </button>
  );
}

function renderSearch(user: SessionUser = testUser, platform: ShortcutPlatform = "other") {
  return render(
    <ShortcutProvider definitions={SHORTCUTS} platform={platform}>
      <CurrentUserProvider user={user}>
        <SearchProvider>
          <Opener />
          <p>Page</p>
        </SearchProvider>
      </CurrentUserProvider>
    </ShortcutProvider>,
  );
}

/** Answers `GET /api/ui/search` with `results` for a long query and `recent` otherwise. */
function searchRoutes(results: SearchResponse = RESULTS, recent: SearchResponse = RECENT) {
  return mockFetch({
    "GET /api/ui/search": (request) =>
      jsonResponse((request.query.get("q") ?? "").length >= 2 ? results : recent),
    "POST /api/ui/search/recent": { ok: true },
  });
}

async function openPalette() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open search" }));
  const dialog = await screen.findByRole("dialog", { name: "Search or jump to…" });
  return { user, dialog, input: within(dialog).getByRole("combobox") };
}

beforeEach(() => {
  nav.router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SearchProvider", () => {
  it("opens with ⌘K on Apple platforms anywhere, with focus in the input", async () => {
    searchRoutes();
    renderSearch(testUser, "apple");
    const user = userEvent.setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Search or jump to…" });
    expect(document.activeElement).toBe(within(dialog).getByRole("combobox"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("opens with Ctrl+K elsewhere", async () => {
    searchRoutes();
    renderSearch();
    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "Search or jump to…" })).toBeTruthy();
  });

  it("shows the recent items for an empty or one-character query, without a debounce", async () => {
    const seen = searchRoutes();
    renderSearch();
    const { user, dialog, input } = await openPalette();
    const recent = await within(dialog).findByRole("group", { name: "Recent" });
    expect(
      within(recent)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining("api"), expect.stringContaining("Members")]);
    expect(seen[0]!.query.get("q")).toBe("");
    expect(seen[0]!.query.get("organization")).toBe(TEST_ORGANIZATION_ID);
    await user.type(input, "s");
    // One character: still the recent items (`q` empty).
    await waitFor(() => expect(seen.length).toBe(2));
    expect(seen[1]!.query.get("q")).toBe("");
  });

  it("says how to search while there are no recent items", async () => {
    searchRoutes(RESULTS, {
      mode: "recent",
      groups: [{ id: "recent", label: "Recent", results: [] }],
    });
    renderSearch();
    const { dialog } = await openPalette();
    await waitFor(() =>
      expect(within(dialog).getByRole("status").textContent).toBe(NO_RECENT_MESSAGE),
    );
  });

  it("searches once typing pauses, grouping results with their list rows' badges", async () => {
    const seen = searchRoutes();
    renderSearch();
    const { user, dialog, input } = await openPalette();
    await within(dialog).findByRole("group", { name: "Recent" });
    await user.type(input, "soc-17");
    await within(dialog).findByRole("group", { name: "Runs" });
    // Typing faster than the debounce sends one search, for the whole query.
    const searches = seen.filter((request) => request.query.get("q") !== "");
    expect(searches.map((request) => request.query.get("q"))).toEqual(["soc-17"]);
    const listbox = within(dialog).getByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby") && group.firstChild?.textContent),
    ).toEqual(["Runs", "Work items", "Repos", "Agents", "Settings"]);
    const runRow = within(listbox).getByRole("option", { name: /Fix the login form/ });
    // Its list row's look: the kind's avatar with the state's dot, no kind line.
    expect(runRow.querySelector(".or-row-avatar svg")!.getAttribute("class")).toContain(
      "tabler-icon-stack-2",
    );
    expect(runRow.querySelector(".or-row__kind")).toBeNull();
    expect(within(runRow).getByRole("img", { name: "Epic, running" })).toBeTruthy();
    expect(within(runRow).getByText("SOC-1719")).toBeTruthy();
    expect(within(runRow).getByText("acme/web")).toBeTruthy();
    expect(within(runRow).getByText("!42")).toBeTruthy();
    // One organization in scope: no organization badges.
    expect(within(listbox).queryByText("Beta")).toBeNull();
    const workItemRow = within(listbox).getByRole("option", { name: /Add a logout button/ });
    expect(within(workItemRow).getByText("SOC-1720")).toBeTruthy();
    const agentRow = within(listbox).getByRole("option", { name: /builder-1/ });
    expect(within(agentRow).getByRole("img", { name: "Agent, Online" })).toBeTruthy();
    const settingsRow = within(listbox).getByRole("option", { name: /Members/ });
    expect([...settingsRow.querySelectorAll(".or-ref")].map((badge) => badge.textContent)).toEqual([
      "Settings",
      "Organization",
    ]);
    // No keyboard hints (Design rule 7).
    expect(dialog.textContent).not.toMatch(/⌘|Ctrl/);
  });

  it("puts the organization badge first under All organizations", async () => {
    searchRoutes();
    renderSearch({ ...testUser, scope: "all", organizations: [ACME, BETA] });
    const { dialog, input } = await openPalette();
    await userEvent.setup().type(input, "soc");
    const runRow = await within(dialog).findByRole("option", { name: /Fix the login form/ });
    const badges = runRow.querySelector(".or-row__meta")!;
    expect(badges.firstElementChild?.textContent?.trim()).toBe("Beta");
    expect(seenOrganization()).toBe("all");

    function seenOrganization() {
      const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
      return new URL(calls.at(-1)![0], "http://localhost").searchParams.get("organization");
    }
  });

  it("says when nothing matches", async () => {
    searchRoutes({ mode: "results", groups: [] });
    renderSearch();
    const { user, dialog, input } = await openPalette();
    await user.type(input, "zzz");
    await waitFor(() =>
      expect(within(dialog).getByRole("status").textContent).toBe("No matches for “zzz”"),
    );
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
  });

  it("opens the highlighted result with Enter, remembers it and closes", async () => {
    const seen = searchRoutes();
    renderSearch();
    const { user, dialog, input } = await openPalette();
    await user.type(input, "soc");
    await within(dialog).findByRole("group", { name: "Runs" });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(nav.router.push).toHaveBeenCalledWith("/backlog/linear-2");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(seen.find((request) => request.method === "POST")?.body).toEqual({
        kind: "workItem",
        id: "linear-2",
      }),
    );
    // Focus goes back to where search was opened from.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open search" }));
  });

  it("opens a result on click", async () => {
    searchRoutes();
    renderSearch();
    const { user, dialog, input } = await openPalette();
    await user.type(input, "api");
    // The recent items list acme/api too: wait for the search's answer before clicking it.
    // A repo reads as its list row: the name as the title, its namespace a badge.
    const repos = await within(dialog).findByRole("group", { name: "Repos" });
    const repoTitle = within(repos).getByText("api", { selector: ".or-row__title" });
    await user.click(repoTitle.closest<HTMLElement>("[role='option']")!);
    expect(nav.router.push).toHaveBeenCalledWith(`/repos/${REPO_ID}`);
  });

  it("closes on Escape without navigating, and starts over next time", async () => {
    searchRoutes();
    renderSearch();
    const { user, input } = await openPalette();
    await user.type(input, "soc");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(nav.router.push).not.toHaveBeenCalled();
    const again = await openPalette();
    expect((again.input as HTMLInputElement).value).toBe("");
  });

  it("aborts the previous search when the query changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const searches: Array<{ q: string; signal: AbortSignal }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init: RequestInit) => {
        const q = new URL(input, "http://localhost").searchParams.get("q") ?? "";
        if (!q) return Promise.resolve(jsonResponse(RECENT));
        searches.push({ q, signal: init.signal! });
        // Searches never answer.
        return new Promise<Response>((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(new DOMException("", "AbortError"))),
        );
      }),
    );
    renderSearch();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: "Open search" }));
    const input = await screen.findByRole("combobox");
    await user.type(input, "so");
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(searches.map((search) => search.q)).toEqual(["so"]);
    await user.type(input, "c");
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(searches.map((search) => search.q)).toEqual(["so", "soc"]);
    expect(searches[0]!.signal.aborted).toBe(true);
    expect(searches[1]!.signal.aborted).toBe(false);
  });
});
