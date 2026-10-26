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
  CodingCard,
  CodingCardInput,
  CodingMatchWarning,
  CodingTrackerOptions,
  RepositoryDetail,
  RepositoryListItem,
} from "@/lib/api/repositories";
import { CONNECT_TRACKER_HREF, savedConflictsWarning } from "./coding-card";
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

const LINEAR = { tracker: "linear" as const, id: "lin-1", workspaceName: "Acme Linear" };
const SOC_MATCH = {
  tracker: "linear" as const,
  team: "SOC",
  project: "Portal",
  withoutProject: false,
  labels: ["bug", "ui"],
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const WEB_CONFLICT: CodingMatchWarning = {
  id: REPO_WEB,
  fullPath: "acme/web",
  provider: "github",
  message: "acme/web matches the same work items.",
};

let rows: RepositoryListItem[];
let details: Record<string, RepositoryDetail>;
let seen: SeenRequest[];
let saveAnswer: (body: CodingCardInput) => Response;
let conflicts: CodingMatchWarning[];
let trackerOptions: CodingTrackerOptions;
/** While set, reads never answer: what the view shows then comes from the cache. */
let holdReads: boolean;

const pending = () => new Promise<Response>(() => {});

/** The card a save of `body` answers with. */
const savedCard = (body: CodingCardInput): CodingCard => ({
  ...details[REPO_PORTAL]!.coding,
  enabled: body.codingEnabled,
  workItemMatch: body.workItemMatch
    ? {
        tracker: body.workItemMatch.tracker,
        team: body.workItemMatch.team,
        project: body.workItemMatch.project ?? null,
        withoutProject: body.workItemMatch.withoutProject ?? false,
        labels: body.workItemMatch.labels ?? [],
        updatedAt: "2026-10-26T00:00:00.000Z",
      }
    : null,
  codingInstructions: (body.codingInstructions ?? "").trim(),
  openPullRequestEarly: body.openPullRequestEarly,
  historyRewrite: body.historyRewrite,
  respondToReviewsAndCi: body.respondToReviewsAndCi,
});

/** The portal's detail with `coding` over its defaults. */
function portal(coding: Partial<CodingCard> = {}, extra: Partial<RepositoryDetail> = {}) {
  const base = repoDetail(portalRow());
  return { ...base, coding: { ...base.coding, ...coding }, ...extra };
}

beforeEach(() => {
  nav.router.push.mockReset();
  ui.toast.mockReset();
  rows = [portalRow(), webRow()];
  details = {
    [REPO_PORTAL]: portal({}, { trackers: [LINEAR] }),
    [REPO_WEB]: repoDetail(webRow()),
  };
  holdReads = false;
  conflicts = [];
  trackerOptions = {
    status: "connected",
    teams: [
      { key: "OPS", name: "Operations" },
      { key: "SOC", name: "Social" },
    ],
    projects: ["Portal", "Website"],
    labels: ["bug", "ui"],
  };
  saveAnswer = (body) => jsonResponse({ ok: true, card: savedCard(body), warnings: conflicts });
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
    [`PUT /api/ui/repositories/${REPO_PORTAL}/coding`]: (request: SeenRequest) =>
      saveAnswer(request.body as CodingCardInput),
    [`POST /api/ui/repositories/${REPO_PORTAL}/coding/match-check`]: () =>
      jsonResponse({ warnings: conflicts }),
    [`GET /api/ui/repositories/${REPO_PORTAL}/coding/tracker-options`]: () =>
      jsonResponse(trackerOptions),
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
    showAdvanced?: boolean;
  } = {},
) {
  const client = createTestQueryClient();
  const view = <ReposView repositoryId={options.repositoryId ?? REPO_PORTAL} />;
  render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial={options.showAdvanced ?? false}>
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

const codingCard = () => screen.findByRole("region", { name: "Coding" });
const saveBar = (card: HTMLElement) =>
  within(card).queryByRole("region", { name: "Unsaved changes" });
const pendingItems = (card: HTMLElement) =>
  [...(saveBar(card)?.querySelectorAll(".or-pending__item") ?? [])].map((item) => ({
    label: item.querySelector(".or-pending__label")?.textContent,
    from: item.querySelector(".or-pending__from")?.textContent,
    to: item.querySelector(".or-pending__to")?.textContent,
    effect: item.querySelector(".or-pending__effect")?.textContent,
  }));
const rewriteOption = (card: HTMLElement, name: string) =>
  within(within(card).getByRole("radiogroup", { name: "Rewrite history" })).getByRole("radio", {
    name,
  });
const instructions = (card: HTMLElement) =>
  within(card).getByRole<HTMLTextAreaElement>("textbox", { name: "Extra instructions" });
const editor = (card: HTMLElement) => within(card).getByRole("group", { name: "Work item match" });
const reads = () => seen.filter((request) => request.method === "GET");
const saves = () => seen.filter((request) => request.method === "PUT");
const matchChecks = () => seen.filter((request) => request.path.endsWith("/match-check"));
const railRow = (name: string) =>
  within(screen.getByRole("region", { name: "Repos" }))
    .getAllByRole("listitem")
    .find((row) => row.textContent!.includes(name))!;
const badgeTexts = (element: Element) =>
  [...element.querySelectorAll(".or-ref__text")].map((badge) => badge.textContent);

describe("savedConflictsWarning", () => {
  it("names every conflicting repo, or says nothing without conflicts", () => {
    expect(savedConflictsWarning([])).toBeUndefined();
    expect(savedConflictsWarning([{ fullPath: "acme/web" }])).toBe(
      "Saved. acme/web matches the same work items, so Om will ask which repo to use.",
    );
    expect(
      savedConflictsWarning([
        { fullPath: "acme/web" },
        { fullPath: "acme/api" },
        { fullPath: "acme/docs" },
      ]),
    ).toBe(
      "Saved. acme/web, acme/api and acme/docs match the same work items, so Om will ask which repo to use.",
    );
  });
});

describe("the Coding card", () => {
  it("shows the switch, help line, the match as badges, routing rules and pull request fields (GitLab)", async () => {
    details[REPO_PORTAL] = portal(
      {
        enabled: true,
        workItemMatch: SOC_MATCH,
        roundLimits: { review: 3, fix: 2 },
        routingRules: [
          { position: 1, description: "Label is security" },
          { position: 4, description: "Team is SOC and project is Portal" },
        ],
      },
      { trackers: [LINEAR] },
    );
    renderRepos();
    const card = await codingCard();
    expect(card.closest("section#coding")).toBeTruthy();
    const heading = within(card).getByRole("heading", { level: 2, name: "Coding" });
    expect(heading.nextElementSibling).toBe(
      within(card).getByRole("button", { name: "Change history" }),
    );
    expect(within(card).getByRole("switch", { name: "Coding" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(card).getByText(
        "Om builds work items that match below, story by story, ending in a merge request.",
      ),
    ).toBeTruthy();
    const sentence = card.querySelector(".or-repo-match__sentence")!;
    expect(sentence.getAttribute("aria-label")).toBe(
      "Linear team SOC in project Portal and label bug or ui",
    );
    expect(within(sentence as HTMLElement).getByRole("img", { name: "Linear" })).toBeTruthy();
    expect(sentence.textContent).toContain("Acme Linear");
    expect(badgeTexts(sentence)).toEqual(["SOC", "Portal", "bug", "ui"]);
    expect(within(card).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(card).getByText("Most specific match wins across repos.")).toBeTruthy();
    expect(
      within(card).getByText("Routing rules also send work here (they run before matches):"),
    ).toBeTruthy();
    expect(
      [...card.querySelectorAll(".or-repo-match__rule")].map((rule) => rule.textContent),
    ).toEqual(["Rule 1Label is security", "Rule 4Team is SOC and project is Portal"]);
    const requests = within(card).getByRole("group", { name: "Merge requests" });
    expect(
      within(requests).getByRole<HTMLInputElement>("checkbox", {
        name: "Open a draft MR after the first story",
      }).checked,
    ).toBe(false);
    expect(
      within(requests).getByRole<HTMLInputElement>("checkbox", {
        name: "Fix review comments and CI failures (up to 3 rounds each)",
      }).checked,
    ).toBe(true);
    expect(rewriteOption(card, "When asked").getAttribute("aria-checked")).toBe("true");
    expect(saveBar(card)).toBeNull();
  });

  it("says pull request on GitHub", async () => {
    renderRepos({ repositoryId: REPO_WEB });
    const card = await codingCard();
    expect(
      within(card).getByText(
        "Om builds work items that match below, story by story, ending in a pull request.",
      ),
    ).toBeTruthy();
    expect(
      within(card).getByRole("checkbox", { name: "Open a draft PR after the first story" }),
    ).toBeTruthy();
    expect(within(card).getByRole("group", { name: "Pull requests" })).toBeTruthy();
  });

  it("says when there is no match, and with no tracker links to connecting one", async () => {
    details[REPO_PORTAL] = portal({}, { trackers: [] });
    renderRepos();
    const card = await codingCard();
    expect(within(card).getByText("No work item match")).toBeTruthy();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Add match" }));
    expect(within(editor(card)).getByText("No tracker connected.")).toBeTruthy();
    expect(
      within(editor(card)).getByRole("link", { name: "Connect a tracker" }).getAttribute("href"),
    ).toBe(CONNECT_TRACKER_HREF);
    expect(
      within(editor(card)).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled,
    ).toBe(true);
  });

  it("adds a match with Coding on, flags its conflict, confirms and saves once without a GET", async () => {
    conflicts = [WEB_CONFLICT];
    renderRepos();
    const card = await codingCard();
    await waitFor(() => expect(railRow("customer-portal")).toBeTruthy());
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Add match" }));
    const form = editor(card);
    expect(within(form).getByRole<HTMLSelectElement>("combobox", { name: "Tracker" }).value).toBe(
      "lin-1",
    );
    const team = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Team" });
    await waitFor(() =>
      expect(within(team).getByRole("option", { name: "SOC · Social" })).toBeTruthy(),
    );
    await user.click(within(form).getByRole("button", { name: "Done" }));
    expect(within(form).getByText("Choose a team.")).toBeTruthy();
    await user.selectOptions(team, "SOC");
    const project = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Project" });
    expect([...project.options].map((option) => option.textContent)).toEqual([
      "Any project",
      "No project",
      "Portal",
      "Website",
    ]);
    await user.selectOptions(project, "No project");
    await user.type(within(form).getByRole("combobox", { name: "Labels" }), "bug{Enter}");
    await user.click(within(form).getByRole("button", { name: "Done" }));
    expect(within(card).queryByRole("group", { name: "Work item match" })).toBeNull();
    expect(card.querySelector(".or-repo-match__sentence")?.getAttribute("aria-label")).toBe(
      "Linear team SOC with no project and label bug",
    );
    const conflictList = await within(card).findByRole("list", { name: "Match conflicts" });
    expect(conflictList.textContent).toContain(
      "matches the same work items, so Om will ask which repo to use.",
    );
    expect(badgeTexts(conflictList)).toEqual(["acme/web"]);
    expect(matchChecks()[0]!.body).toEqual({
      workItemMatch: {
        tracker: "linear",
        team: "SOC",
        project: null,
        withoutProject: true,
        labels: ["bug"],
      },
    });
    await user.click(within(card).getByRole("switch", { name: "Coding" }));
    await waitFor(() =>
      expect(pendingItems(card)).toEqual([
        {
          label: "Coding",
          from: "Off",
          to: "On",
          effect: "Om starts building work items that match.",
        },
        {
          label: "Work item match added",
          from: undefined,
          to: "Linear team SOC with no project and label bug",
          effect:
            "Work items matching Linear team SOC with no project and label bug route here. Om will ask between this repo and acme/web.",
        },
      ]),
    );
    holdReads = true;
    const readsBefore = reads().length;
    await user.click(within(card).getByRole("button", { name: "Save 2 changes" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save Coding changes?" });
    expect(dialog.textContent).toContain("Work item match added");
    expect(dialog.textContent).not.toContain("Om starts building");
    expect(saves()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.path).toBe(`/api/ui/repositories/${REPO_PORTAL}/coding`);
    expect(saves()[0]!.body).toEqual({
      codingEnabled: true,
      workItemMatch: {
        tracker: "linear",
        team: "SOC",
        project: null,
        withoutProject: true,
        labels: ["bug"],
      },
      codingInstructions: "",
      openPullRequestEarly: false,
      historyRewrite: "when-asked",
      respondToReviewsAndCi: true,
    });
    // The save's own conflict warnings name the conflicting repo once the staged list is gone.
    expect(ui.toast).toHaveBeenCalledWith(
      "Saved. acme/web matches the same work items, so Om will ask which repo to use.",
      { variant: "warning" },
    );
    expect(ui.toast).not.toHaveBeenCalledWith("Saved");
    expect(within(card).getByRole("switch", { name: "Coding" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      await within(railRow("customer-portal")).findByRole("img", { name: "Coding on" }),
    ).toBeTruthy();
    expect(within(card).queryByRole("list", { name: "Match conflicts" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads()).toHaveLength(readsBefore);
  });

  it("confirms turning Coding off and removing the match; Cancel saves nothing", async () => {
    details[REPO_PORTAL] = portal(
      { enabled: true, workItemMatch: SOC_MATCH },
      { trackers: [LINEAR] },
    );
    renderRepos();
    const card = await codingCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("switch", { name: "Coding" }));
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    await user.click(within(editor(card)).getByRole("button", { name: "Remove match" }));
    expect(within(card).getByText("No work item match")).toBeTruthy();
    expect(pendingItems(card)).toEqual([
      {
        label: "Coding",
        from: "On",
        to: "Off",
        effect: "Om stops picking up new work items for this repo. Runs already started finish.",
      },
      {
        label: "Work item match removed",
        from: "Linear team SOC in project Portal and label bug or ui",
        to: undefined,
        effect: "No work items route here by match.",
      },
    ]);
    await user.click(within(card).getByRole("button", { name: "Save 2 changes" }));
    let dialog = await screen.findByRole("alertdialog", { name: "Save Coding changes?" });
    expect(dialog.textContent).toContain("Coding");
    expect(dialog.textContent).toContain("Om stops picking up new work items");
    expect(dialog.textContent).toContain("No work items route here by match.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(saves()).toEqual([]);
    expect(pendingItems(card)).toHaveLength(2);
    await user.click(within(card).getByRole("button", { name: "Save 2 changes" }));
    dialog = await screen.findByRole("alertdialog", { name: "Save Coding changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()[0]!.body).toMatchObject({ codingEnabled: false, workItemMatch: null });
    expect(matchChecks()).toEqual([]);
  });

  it("edits the match in place, starting from the saved one", async () => {
    details[REPO_PORTAL] = portal(
      { enabled: true, workItemMatch: SOC_MATCH },
      { trackers: [LINEAR] },
    );
    renderRepos();
    const card = await codingCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    const form = editor(card);
    const team = within(form).getByRole<HTMLSelectElement>("combobox", { name: "Team" });
    expect(team.value).toBe("SOC");
    expect(within(form).getByRole<HTMLSelectElement>("combobox", { name: "Project" }).value).toBe(
      "project:Portal",
    );
    expect(badgeTexts(form).length).toBe(0);
    expect([...form.querySelectorAll(".or-token__label")].map((t) => t.textContent)).toEqual([
      "bug",
      "ui",
    ]);
    await waitFor(() =>
      expect(within(team).getByRole("option", { name: "OPS · Operations" })).toBeTruthy(),
    );
    await user.selectOptions(team, "OPS");
    await user.click(within(form).getByRole("button", { name: "Done" }));
    expect(pendingItems(card)).toEqual([
      {
        label: "Work item match changed",
        from: "Linear team SOC in project Portal and label bug or ui",
        to: "Linear team OPS in project Portal and label bug or ui",
        effect:
          "Work items matching Linear team OPS in project Portal and label bug or ui route here instead of Linear team SOC in project Portal and label bug or ui.",
      },
    ]);
    await waitFor(() => expect(matchChecks()).toHaveLength(1));
    // Setting it back un-stages it.
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    await user.selectOptions(within(editor(card)).getByRole("combobox", { name: "Team" }), "SOC");
    await user.click(within(editor(card)).getByRole("button", { name: "Done" }));
    expect(saveBar(card)).toBeNull();
  });

  it("saves instructions and pull request fields without confirming, and confirms Rewrite history", async () => {
    renderRepos();
    const card = await codingCard();
    const user = userEvent.setup();
    await user.type(instructions(card), "Use pnpm.");
    await user.click(
      within(card).getByRole("checkbox", { name: "Open a draft MR after the first story" }),
    );
    await user.click(
      within(card).getByRole("checkbox", {
        name: "Fix review comments and CI failures (up to 3 rounds each)",
      }),
    );
    expect(pendingItems(card).map((item) => [item.label, item.effect])).toEqual([
      ["Extra instructions edited", "Applies to new stories."],
      [
        "Open a draft MR after the first story",
        "Om opens a draft merge request after the first story.",
      ],
      [
        "Fix review comments and CI failures (up to 3 rounds each)",
        "Om leaves review comments and CI failures to you.",
      ],
    ]);
    await user.click(within(card).getByRole("button", { name: "Save 3 changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(saves()[0]!.body).toMatchObject({
      codingInstructions: "Use pnpm.",
      openPullRequestEarly: true,
      respondToReviewsAndCi: false,
    });
    expect(instructions(card).value).toBe("Use pnpm.");

    await user.click(rewriteOption(card, "Always"));
    expect(pendingItems(card)).toEqual([
      {
        label: "Rewrite history",
        from: "When asked",
        to: "Always",
        effect: "Om rebases instead of merging the base branch, and force-pushes its branch.",
      },
    ]);
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save Coding changes?" });
    expect(dialog.textContent).toContain("Rewrite history");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(2);
    expect(saves()[1]!.body).toMatchObject({ historyRewrite: "always" });
  });

  it("shows “Add a work item match…” under the switch", async () => {
    saveAnswer = () =>
      jsonResponse(
        {
          error: "Add a work item match before turning on Coding.",
          code: "work_item_match_required",
        },
        409,
      );
    renderRepos();
    const card = await codingCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("switch", { name: "Coding" }));
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    const alert = await within(saveBar(card)!).findByRole("alert");
    expect(alert.textContent).toBe("Add a work item match before turning on Coding.");
    const help = within(card).getByText(
      "Om builds work items that match below, story by story, ending in a merge request.",
    );
    expect(help.nextElementSibling?.textContent).toBe(
      "Add a work item match before turning on Coding.",
    );
    expect(card.querySelector(".or-repo-match .or-field-error")).toBeNull();
    // The refused change stays staged.
    expect(pendingItems(card).map((item) => item.label)).toEqual(["Coding"]);
  });

  it("shows “Turn off Coding…” under the match", async () => {
    details[REPO_PORTAL] = portal(
      { enabled: true, workItemMatch: SOC_MATCH },
      { trackers: [LINEAR] },
    );
    saveAnswer = () =>
      jsonResponse(
        { error: "Turn off Coding before removing the work item match.", code: "coding_enabled" },
        409,
      );
    renderRepos();
    const card = await codingCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    await user.click(within(editor(card)).getByRole("button", { name: "Remove match" }));
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save changes" }),
    );
    await within(saveBar(card)!).findByRole("alert");
    expect(card.querySelector(".or-repo-match .or-field-error")?.textContent).toBe(
      "Turn off Coding before removing the work item match.",
    );
    expect(pendingItems(card).map((item) => item.label)).toEqual(["Work item match removed"]);
  });

  it("lists the routing rules with “Show advanced settings” on too", async () => {
    details[REPO_PORTAL] = portal(
      { routingRules: [{ position: 2, description: "Label is security" }] },
      { trackers: [LINEAR] },
    );
    renderRepos({ showAdvanced: true });
    const card = await codingCard();
    expect(
      within(card).getByText("Routing rules also send work here (they run before matches):"),
    ).toBeTruthy();
    expect(
      [...card.querySelectorAll(".or-repo-match__rule")].map((rule) => rule.textContent),
    ).toEqual(["Rule 2Label is security"]);
  });

  it("saves a changed match after confirming; labels put back in another order stage nothing", async () => {
    details[REPO_PORTAL] = portal(
      { enabled: true, workItemMatch: SOC_MATCH },
      { trackers: [LINEAR] },
    );
    renderRepos();
    const card = await codingCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    await user.click(within(editor(card)).getByRole("button", { name: "Remove bug" }));
    await user.type(within(editor(card)).getByRole("combobox", { name: "Labels" }), "bug{Enter}");
    await user.click(within(editor(card)).getByRole("button", { name: "Done" }));
    expect(saveBar(card)).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Edit" }));
    const team = within(editor(card)).getByRole<HTMLSelectElement>("combobox", { name: "Team" });
    await waitFor(() =>
      expect(within(team).getByRole("option", { name: "OPS · Operations" })).toBeTruthy(),
    );
    await user.selectOptions(team, "OPS");
    await user.click(within(editor(card)).getByRole("button", { name: "Done" }));
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Save Coding changes?" });
    expect(dialog.textContent).toContain(
      "Work item match changed Work items matching Linear team OPS in project Portal and label ui or bug route here instead of Linear team SOC in project Portal and label bug or ui.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.body).toMatchObject({
      codingEnabled: true,
      workItemMatch: { tracker: "linear", team: "OPS", project: "Portal" },
    });
    expect(card.querySelector(".or-repo-match__sentence")?.getAttribute("aria-label")).toBe(
      "Linear team OPS in project Portal and label ui or bug",
    );
  });

  it("discards every staged field, closing the match editor", async () => {
    details[REPO_PORTAL] = portal(
      { enabled: true, workItemMatch: SOC_MATCH },
      { trackers: [LINEAR] },
    );
    renderRepos();
    const card = await codingCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("switch", { name: "Coding" }));
    await user.type(instructions(card), "Use pnpm.");
    await user.click(rewriteOption(card, "Never"));
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    expect(pendingItems(card)).toHaveLength(3);
    await user.click(within(saveBar(card)!).getByRole("button", { name: "Discard" }));
    expect(saveBar(card)).toBeNull();
    expect(within(card).queryByRole("group", { name: "Work item match" })).toBeNull();
    expect(within(card).getByRole("switch", { name: "Coding" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(instructions(card).value).toBe("");
    expect(rewriteOption(card, "When asked").getAttribute("aria-checked")).toBe("true");
    expect(saves()).toHaveLength(0);
  });

  it("follows another admin's change from a repository event, keeping the edits", async () => {
    const live = fakeAbly();
    renderRepos({ live });
    const card = await codingCard();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const user = userEvent.setup();
    await user.type(instructions(card), "Mine.");
    details[REPO_PORTAL] = portal({ historyRewrite: "never" }, { trackers: [LINEAR] });
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "repository", ids: [REPO_PORTAL] }),
        ),
    );
    await waitFor(() =>
      expect(rewriteOption(card, "Never").getAttribute("aria-checked")).toBe("true"),
    );
    expect(instructions(card).value).toBe("Mine.");
    expect(pendingItems(card).map((item) => item.label)).toEqual(["Extra instructions edited"]);
  });

  it("is read-only for members: controls disabled, no Edit and no save bar", async () => {
    details[REPO_PORTAL] = repoDetail(
      portalRow({ organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" } }),
      { coding: { ...portal().coding, workItemMatch: SOC_MATCH }, trackers: [LINEAR] },
    );
    renderRepos({ user: member });
    const card = await codingCard();
    expect(within(card).getByRole<HTMLButtonElement>("switch", { name: "Coding" }).disabled).toBe(
      true,
    );
    for (const checkbox of within(card).getAllByRole<HTMLInputElement>("checkbox")) {
      expect(checkbox.disabled).toBe(true);
    }
    for (const radio of within(card).getAllByRole<HTMLButtonElement>("radio")) {
      expect(radio.disabled).toBe(true);
    }
    expect(instructions(card).disabled).toBe(true);
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Add match" })).toBeNull();
    await userEvent.setup().click(within(card).getByRole("switch", { name: "Coding" }));
    expect(saveBar(card)).toBeNull();
  });
});
