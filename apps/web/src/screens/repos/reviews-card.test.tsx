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
  RepositoryDetail,
  RepositoryListItem,
  ReviewsCard,
  ReviewsCardInput,
} from "@/lib/api/repositories";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
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
let saveAnswer: (body: ReviewsCardInput) => Response;
/** While set, reads never answer: what the view shows then comes from the cache. */
let holdReads: boolean;

const pending = () => new Promise<Response>(() => {});

/** The card a save of `body` answers with. */
const savedCard = (body: ReviewsCardInput): ReviewsCard => ({
  enabled: body.reviewsEnabled,
  triggers: body.triggers,
  depth: body.depth,
  pathExcludes: body.pathExcludes,
  reviewerInstructions: body.reviewerInstructions.trim(),
  documentation: body.documentation,
});

beforeEach(() => {
  nav.router.push.mockReset();
  ui.toast.mockReset();
  rows = [portalRow(), webRow()];
  details = {
    [REPO_PORTAL]: repoDetail(portalRow()),
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
        `PUT /api/ui/repositories/${id}/reviews`,
        (request: SeenRequest) => saveAnswer(request.body as ReviewsCardInput),
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

const reviewsCard = () => screen.findByRole("region", { name: "Reviews" });
const saveBar = (card: HTMLElement) =>
  within(card).queryByRole("region", { name: "Unsaved changes" });
const pendingItems = (card: HTMLElement) =>
  [...(saveBar(card)?.querySelectorAll(".or-pending__item") ?? [])].map((item) => ({
    label: item.querySelector(".or-pending__label")?.textContent,
    from: item.querySelector(".or-pending__from")?.textContent,
    to: item.querySelector(".or-pending__to")?.textContent,
    effect: item.querySelector(".or-pending__effect")?.textContent,
  }));
const depthOption = (card: HTMLElement, name: string) =>
  within(within(card).getByRole("radiogroup", { name: "Depth" })).getByRole("radio", { name });
const radioIn = (card: HTMLElement, group: string, name: string) =>
  within(within(card).getByRole("radiogroup", { name: group })).getByRole<HTMLButtonElement>(
    "radio",
    { name },
  );
const documentation = (card: HTMLElement) =>
  within(card).getByRole("region", { name: "Documentation" });
/** The detail of the portal (GitLab) with its documentation check set to `values`. */
const withDocumentation = (values: Partial<ReviewsCard["documentation"]>) => {
  const saved = repoDetail(portalRow());
  return {
    ...saved,
    reviews: {
      ...saved.reviews,
      documentation: { ...saved.reviews.documentation, ...values },
    },
  };
};
const instructions = (card: HTMLElement) =>
  within(card).getByRole<HTMLTextAreaElement>("textbox", { name: "Reviewer instructions" });
const reads = () => seen.filter((request) => request.method === "GET");
const saves = () => seen.filter((request) => request.method === "PUT");
const railRow = (name: string) =>
  within(screen.getByRole("region", { name: "Repos" }))
    .getAllByRole("listitem")
    .find((row) => row.textContent!.includes(name))!;

describe("the Reviews card", () => {
  it("shows the switch, help line, triggers, depth, skip paths and instructions (GitLab)", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      reviews: {
        enabled: true,
        triggers: { onOpen: true, onPush: false, drafts: true },
        depth: "standard",
        pathExcludes: ["dist/**"],
        reviewerInstructions: "Be brief.",
        documentation: { check: "off", depth: "standard", updateTargets: "omniralph" },
      },
    });
    renderRepos();
    const card = await reviewsCard();
    expect(card.closest("section#reviews")).toBeTruthy();
    const heading = within(card).getByRole("heading", { level: 2, name: "Reviews" });
    expect(heading.nextElementSibling).toBe(
      within(card).getByRole("button", { name: "Change history" }),
    );
    expect(within(card).getByRole("switch", { name: "Reviews" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(card).getByText("Om reviews merge requests and comments on them.")).toBeTruthy();
    const triggers = within(card).getByRole("group", { name: "Review when" });
    const box = (name: string) =>
      within(triggers).getByRole<HTMLInputElement>("checkbox", { name });
    expect(box("MR opened").checked).toBe(true);
    expect(box("New commits pushed").checked).toBe(false);
    expect(box("Drafts too").checked).toBe(true);
    expect(depthOption(card, "Standard").getAttribute("aria-checked")).toBe("true");
    expect(
      within(card).getByText("Reads the change and the code around it. The default."),
    ).toBeTruthy();
    expect(within(card).getByText("dist/**")).toBeTruthy();
    expect(instructions(card).value).toBe("Be brief.");
    expect(saveBar(card)).toBeNull();
  });

  it("says PR opened and pull requests on GitHub", async () => {
    renderRepos({ repositoryId: REPO_WEB });
    const card = await reviewsCard();
    expect(within(card).getByText("Om reviews pull requests and comments on them.")).toBeTruthy();
    expect(within(card).getByRole("checkbox", { name: "PR opened" })).toBeTruthy();
    expect(
      within(card).getByRole("textbox", { name: "Skip paths" }).getAttribute("placeholder"),
    ).toBe("Add a path or glob…");
  });

  it("opens the depth's review profile: model, token cap, passes, verification, security, reads, comments and typical time", async () => {
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(depthOption(card, "Deep"));
    await user.click(within(card).getByRole("button", { name: "Deep review profile" }));
    const profile = await screen.findByRole("dialog", { name: "Deep review profile" });
    const rowsText = [...profile.querySelectorAll(".or-pop__row")].map((row) => [
      row.querySelector("dt")!.textContent,
      row.querySelector("dd")!.textContent,
    ]);
    expect(rowsText).toEqual([
      ["Model", "Opus 5.5"],
      ["Token cap", "500k per pass"],
      ["Passes", "Up to 3 per check type"],
      ["Verification", "Every finding, in a fresh session"],
      ["Security", "At least 2 passes, up to 3"],
      ["Reads", "The diff and the whole repo"],
      ["Comments", "Inline findings plus a summary"],
      ["Typical time", "About 2× Standard"],
    ]);
  });

  it("stages Standard → Deep and an instructions edit with their effects, then saves once with no GET", async () => {
    renderRepos();
    const card = await reviewsCard();
    await waitFor(() => expect(reads().length).toBeGreaterThanOrEqual(2));
    const user = userEvent.setup();
    await user.click(depthOption(card, "Deep"));
    await user.type(instructions(card), "Check migrations.");
    expect(pendingItems(card)).toEqual([
      {
        label: "Depth",
        from: "Standard",
        to: "Deep",
        effect: "New reviews will take about 2× longer and use more tokens.",
      },
      {
        label: "Reviewer instructions edited",
        from: undefined,
        to: undefined,
        effect: "Applies to new reviews.",
      },
    ]);
    const readsBefore = reads().length;
    await user.click(within(card).getByRole("button", { name: "Save 2 changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.path).toBe(`/api/ui/repositories/${REPO_PORTAL}/reviews`);
    expect(saves()[0]!.body).toEqual({
      reviewsEnabled: true,
      triggers: { onOpen: true, onPush: true, drafts: false },
      depth: "deep",
      pathExcludes: [],
      reviewerInstructions: "Check migrations.",
      documentation: { check: "off", depth: "standard", updateTargets: "omniralph" },
    });
    expect(ui.toast).toHaveBeenCalledWith("Saved");
    expect(depthOption(card, "Deep").getAttribute("aria-checked")).toBe("true");
    expect(instructions(card).value).toBe("Check migrations.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads()).toHaveLength(readsBefore);
  });

  it("dims the rail's Reviews icon right after turning Reviews off and saving", async () => {
    renderRepos();
    const card = await reviewsCard();
    await waitFor(() => expect(railRow("customer-portal")).toBeTruthy());
    holdReads = true;
    const user = userEvent.setup();
    await user.click(within(card).getByRole("switch", { name: "Reviews" }));
    expect(pendingItems(card)).toEqual([
      {
        label: "Reviews",
        from: "On",
        to: "Off",
        effect: "New merge requests won't be reviewed.",
      },
    ]);
    expect(
      within(railRow("customer-portal")).getByRole("img", { name: "Reviews on" }),
    ).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    const icon = await within(railRow("customer-portal")).findByRole("img", {
      name: "Reviews off",
    });
    expect(icon.classList.contains("or-repo-row__switch--off")).toBe(true);
    expect(within(card).getByRole("switch", { name: "Reviews" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(saveBar(card)).toBeNull();
  });

  it("stages every trigger and skip path change, provider-worded", async () => {
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("checkbox", { name: "MR opened" }));
    await user.click(within(card).getByRole("checkbox", { name: "New commits pushed" }));
    await user.click(within(card).getByRole("checkbox", { name: "Drafts too" }));
    await user.type(within(card).getByRole("textbox", { name: "Skip paths" }), "vendor/**{Enter}");
    expect(pendingItems(card).map((item) => [item.label, item.effect])).toEqual([
      ["MR opened", "Opening a merge request won't start a review."],
      ["New commits pushed", "Pushing to an open merge request won't start a review."],
      ["Drafts too", "Draft merge requests are reviewed too."],
      ["Skip path added", "Reviews skip files matching vendor/**."],
    ]);
    await user.click(within(card).getByRole("button", { name: "Save 4 changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.body).toEqual({
      reviewsEnabled: true,
      triggers: { onOpen: false, onPush: false, drafts: true },
      depth: "standard",
      pathExcludes: ["vendor/**"],
      reviewerInstructions: "",
      documentation: { check: "off", depth: "standard", updateTargets: "omniralph" },
    });
    expect(
      within(card).getByRole<HTMLInputElement>("checkbox", { name: "Drafts too" }).checked,
    ).toBe(true);
  });

  it("stages a removed skip path with its effect and saves without it", async () => {
    const saved = repoDetail(portalRow());
    details[REPO_PORTAL] = { ...saved, reviews: { ...saved.reviews, pathExcludes: ["dist/**"] } };
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Remove dist/**" }));
    expect(pendingItems(card)).toEqual([
      {
        label: "Skip path removed",
        from: "dist/**",
        to: undefined,
        effect: "Reviews read files matching dist/** again.",
      },
    ]);
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.body).toMatchObject({ pathExcludes: [] });
  });

  it("stages nothing for a skip path removed and added back", async () => {
    const saved = repoDetail(portalRow());
    details[REPO_PORTAL] = {
      ...saved,
      reviews: { ...saved.reviews, pathExcludes: ["dist/**", "vendor/**"] },
    };
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Remove dist/**" }));
    expect(pendingItems(card)).toHaveLength(1);
    await user.type(within(card).getByRole("textbox", { name: "Skip paths" }), "dist/**{Enter}");
    expect(saveBar(card)).toBeNull();
  });

  it("refuses a skip path the shared schema rejects", async () => {
    renderRepos();
    const card = await reviewsCard();
    const input = within(card).getByRole("textbox", { name: "Skip paths" });
    await userEvent.setup().type(input, "!dist/**{Enter}");
    expect(saveBar(card)).toBeNull();
    expect(card.querySelector(".or-field-error")?.textContent).toBe(
      "Negated patterns (starting with !) aren't supported.",
    );
  });

  it("discards back to the saved values", async () => {
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(depthOption(card, "Quick"));
    await user.type(instructions(card), "x");
    await user.click(within(card).getByRole("button", { name: "Discard" }));
    expect(depthOption(card, "Standard").getAttribute("aria-checked")).toBe("true");
    expect(instructions(card).value).toBe("");
    expect(saveBar(card)).toBeNull();
    expect(saves()).toEqual([]);
  });

  it("shows a server field error under its field and in the save bar", async () => {
    saveAnswer = () =>
      jsonResponse(
        {
          error: "Check the highlighted fields.",
          code: "validation_failed",
          fieldErrors: { "pathExcludes.0": "Use a path relative to the repo." },
        },
        400,
      );
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.type(within(card).getByRole("textbox", { name: "Skip paths" }), "docs/**{Enter}");
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    const alert = await within(saveBar(card)!).findByRole("alert");
    expect(alert.textContent).toBe("Check the highlighted fields.");
    expect(within(card).getByText("Use a path relative to the repo.")).toBeTruthy();
    expect(pendingItems(card)).toHaveLength(1);
  });

  it("follows another admin's depth change from a repository event, keeping the edits", async () => {
    const live = fakeAbly();
    renderRepos({ live });
    const card = await reviewsCard();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const user = userEvent.setup();
    await user.type(instructions(card), "Mine.");
    const theirs = repoDetail(portalRow());
    details[REPO_PORTAL] = { ...theirs, reviews: { ...theirs.reviews, depth: "deep" } };
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "repository", ids: [REPO_PORTAL] }),
        ),
    );
    await waitFor(() =>
      expect(depthOption(card, "Deep").getAttribute("aria-checked")).toBe("true"),
    );
    expect(instructions(card).value).toBe("Mine.");
    expect(pendingItems(card).map((item) => item.label)).toEqual(["Reviewer instructions edited"]);
  });

  it("asks before leaving with unsaved changes", async () => {
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(depthOption(card, "Deep"));
    await user.click(within(railRow("web")).getByRole("link"));
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(dialog.textContent).toContain("Reviews");
    expect(nav.router.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Discard and leave" }));
    expect(nav.router.push).toHaveBeenCalledWith(`/repos/${REPO_WEB}`);
  });

  it("shows the latest change behind its info button", async () => {
    const latest: SettingsHistoryEntry = {
      id: "e1",
      organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
      section: "repository.reviews",
      subjectId: REPO_PORTAL,
      actor: { id: "u2", name: "Grace" },
      changedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      changes: [{ field: "depth", label: "Depth", before: "Standard", after: "Deep" }],
      runsSince: 4,
    };
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      history: { reviews: latest, coding: null, ask: null, agents: null, playbooks: null },
    });
    renderRepos();
    const card = await reviewsCard();
    await userEvent.setup().click(within(card).getByRole("button", { name: "Change history" }));
    const popover = await screen.findByRole("dialog", { name: "Change history" });
    expect(
      within(popover).getByText("Last changed by Grace, 2 min ago, 4 runs since"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        seen.some(
          (request) =>
            request.path === "/api/ui/settings-history" &&
            request.query.get("section") === "repository.reviews" &&
            request.query.get("subject") === REPO_PORTAL,
        ),
      ).toBe(true),
    );
  });

  it("is read-only for members: every control disabled and no save bar", async () => {
    details[REPO_PORTAL] = repoDetail(
      portalRow({ organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" } }),
    );
    renderRepos({ user: member });
    const card = await reviewsCard();
    expect(within(card).getByRole<HTMLButtonElement>("switch", { name: "Reviews" }).disabled).toBe(
      true,
    );
    for (const checkbox of within(card).getAllByRole<HTMLInputElement>("checkbox")) {
      expect(checkbox.disabled).toBe(true);
    }
    for (const radio of within(card).getAllByRole<HTMLButtonElement>("radio")) {
      expect(radio.disabled).toBe(true);
    }
    expect(
      within(card).getByRole<HTMLInputElement>("textbox", { name: "Skip paths" }).disabled,
    ).toBe(true);
    expect(instructions(card).disabled).toBe(true);
    await userEvent.setup().click(within(card).getByRole("switch", { name: "Reviews" }));
    expect(saveBar(card)).toBeNull();
  });

  it("shows members the documentation check read-only, targets included in Update mode", async () => {
    const detail = withDocumentation({ check: "update", updateTargets: "same-repo" });
    details[REPO_PORTAL] = {
      ...detail,
      repository: {
        ...detail.repository,
        organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" },
      },
      canEdit: false,
    };
    renderRepos({ user: member });
    const card = await reviewsCard();
    const section = documentation(card);
    for (const radio of within(section).getAllByRole<HTMLButtonElement>("radio")) {
      expect(radio.disabled).toBe(true);
    }
    expect(radioIn(card, "Documentation check", "Update").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      radioIn(card, "Commit documentation to", "Same-repo MRs too").getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.setup().click(radioIn(card, "Documentation check", "Off"));
    expect(saveBar(card)).toBeNull();
  });
});

describe("the Reviews card's Documentation section", () => {
  it("Off (the default): says Om doesn't check, shows the depth, hides the targets", async () => {
    renderRepos();
    const card = await reviewsCard();
    const section = documentation(card);
    expect(within(section).getByRole("heading", { level: 3, name: "Documentation" })).toBeTruthy();
    expect(radioIn(card, "Documentation check", "Off").getAttribute("aria-checked")).toBe("true");
    expect(within(section).getByText("Om doesn't check documentation.")).toBeTruthy();
    expect(radioIn(card, "Documentation depth", "Standard").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(section).getByText("Adds the comments and docstrings in the changed files."),
    ).toBeTruthy();
    expect(within(card).queryByRole("radiogroup", { name: "Commit documentation to" })).toBeNull();
  });

  it("Comment: explains the comment and hides the targets (GitHub wording)", async () => {
    details[REPO_WEB] = {
      ...repoDetail(webRow()),
      reviews: {
        ...repoDetail(webRow()).reviews,
        documentation: { check: "comment", depth: "quick", updateTargets: "omniralph" },
      },
    };
    renderRepos({ repositoryId: REPO_WEB });
    const card = await reviewsCard();
    const section = documentation(card);
    expect(radioIn(card, "Documentation check", "Comment").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(section).getByText(
        "Om comments on each pull request with the documentation the change makes wrong or incomplete.",
      ),
    ).toBeTruthy();
    expect(
      within(section).getByText(
        "Checks Markdown docs, READMEs, docs/ and agent instruction files.",
      ),
    ).toBeTruthy();
    expect(within(card).queryByRole("radiogroup", { name: "Commit documentation to" })).toBeNull();
  });

  it("Update: shows the targets with their one-line explanation", async () => {
    details[REPO_PORTAL] = withDocumentation({ check: "update" });
    renderRepos();
    const card = await reviewsCard();
    const section = documentation(card);
    expect(
      within(section).getByText(
        "Om commits the documentation updates to the merge requests chosen below and comments on the rest.",
      ),
    ).toBeTruthy();
    expect(radioIn(card, "Commit documentation to", "Om's MRs").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(section).getByText(
        "Only merge requests Om opened. People's merge requests get the comment.",
      ),
    ).toBeTruthy();
    await userEvent.setup().click(radioIn(card, "Commit documentation to", "Same-repo MRs too"));
    expect(
      within(section).getByText(
        "Also people's merge requests whose branch is in this repo. Forks get the comment.",
      ),
    ).toBeTruthy();
  });

  it("opens the documentation depth's details: model, token cap, iterations and reads", async () => {
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(radioIn(card, "Documentation depth", "Deep"));
    await user.click(within(card).getByRole("button", { name: "Deep documentation check" }));
    const popover = await screen.findByRole("dialog", { name: "Deep documentation check" });
    expect(
      [...popover.querySelectorAll(".or-pop__row")].map((row) => [
        row.querySelector("dt")!.textContent,
        row.querySelector("dd")!.textContent,
      ]),
    ).toEqual([
      ["Model", "Opus 5.5"],
      ["Token cap", "500k per iteration"],
      ["Iterations", "Up to 4"],
      ["Reads", "Standard's files, plus comments and docstrings across the repo"],
    ]);
  });

  it("stages Off → Update, a deeper depth and same-repo targets with their effects, then saves them", async () => {
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(radioIn(card, "Documentation check", "Update"));
    await user.click(radioIn(card, "Documentation depth", "Deep"));
    await user.click(radioIn(card, "Commit documentation to", "Same-repo MRs too"));
    expect(pendingItems(card)).toEqual([
      {
        label: "Documentation",
        from: "Off",
        to: "Update",
        effect:
          "New reviews commit documentation updates to the merge requests allowed below and comment on the rest.",
      },
      {
        label: "Documentation depth",
        from: "Standard",
        to: "Deep",
        effect: "New documentation checks will read more of the repo and use more tokens.",
      },
      {
        label: "Commit documentation to",
        from: "Om's MRs",
        to: "Same-repo MRs too",
        effect: "People's merge requests from branches in this repo get documentation commits too.",
      },
    ]);
    await user.click(within(card).getByRole("button", { name: "Save 3 changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.body).toMatchObject({
      documentation: { check: "update", depth: "deep", updateTargets: "same-repo" },
    });
    expect(radioIn(card, "Commit documentation to", "Same-repo MRs too")).toBeTruthy();
  });

  it("stages Comment → Off and a shallower depth with their effects", async () => {
    details[REPO_PORTAL] = withDocumentation({ check: "comment" });
    renderRepos();
    const card = await reviewsCard();
    const user = userEvent.setup();
    await user.click(radioIn(card, "Documentation check", "Off"));
    await user.click(radioIn(card, "Documentation depth", "Quick"));
    expect(pendingItems(card).map((item) => [item.label, item.effect])).toEqual([
      ["Documentation", "New reviews won't check documentation."],
      [
        "Documentation depth",
        "New documentation checks will be faster, use fewer tokens and read less of the repo.",
      ],
    ]);
  });

  it("stages Off → Comment with its effect", async () => {
    renderRepos();
    const card = await reviewsCard();
    await userEvent.setup().click(radioIn(card, "Documentation check", "Comment"));
    expect(pendingItems(card).map((item) => item.effect)).toEqual([
      "New reviews comment on each merge request with the documentation it should update.",
    ]);
  });
});
