// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
  AskCardInput,
  PlaybooksCard,
  PlaybooksCardInput,
  RepositoryDetail,
  RepositoryListItem,
} from "@/lib/api/repositories";
import * as removeDialog from "./remove-repo-dialog";
import { REMOVE_REPO_DESCRIPTION } from "./remove-repo-dialog";
import { ReposView } from "./repos-view";
import { portalRow, REPO_PORTAL, REPO_WEB, repoDetail, webRow } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

// The real dialog, wrapped so a test can see which component the menu and the button open.
vi.mock("./remove-repo-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof removeDialog>();
  return { ...actual, RemoveRepoDialog: vi.fn(actual.RemoveRepoDialog) };
});

vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
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

const playbooksCard = (): PlaybooksCard => ({
  bindings: {
    review: ["builtin:review"],
    correlation: "builtin:correlate",
    story: "builtin:implement-story",
    request: "builtin:handle-request",
  },
  choices: {
    review: [
      { id: "pb-security", name: "Security review", builtin: false },
      { id: "builtin:review", name: "Review a pull request", builtin: true },
    ],
    correlation: [
      { id: "builtin:correlate", name: "Combine findings", builtin: true },
      { id: "pb-strict", name: "Strict combine", builtin: false },
    ],
    story: [
      { id: "builtin:implement-story", name: "Implement a story", builtin: true },
      { id: "pb-careful", name: "Careful", builtin: false },
    ],
    request: [
      { id: "builtin:handle-request", name: "Handle a request", builtin: true },
      { id: "pb-triage", name: "Triage first", builtin: false },
    ],
  },
});

let rows: RepositoryListItem[];
let details: Record<string, RepositoryDetail>;
let seen: SeenRequest[];
/** While set, reads never answer: what the view shows then comes from the cache. */
let holdReads: boolean;

const pending = () => new Promise<Response>(() => {});

beforeEach(() => {
  nav.router.push.mockReset();
  nav.router.refresh.mockReset();
  ui.toast.mockReset();
  vi.mocked(removeDialog.RemoveRepoDialog).mockClear();
  rows = [portalRow(), webRow()];
  details = {
    [REPO_PORTAL]: repoDetail(portalRow(), { playbooks: playbooksCard() }),
    [REPO_WEB]: repoDetail(webRow()),
  };
  holdReads = false;
  window.history.replaceState(null, "", `/repos/${REPO_PORTAL}`);
  seen = mockFetch({
    "GET /api/ui/repositories": () =>
      holdReads ? pending() : jsonResponse({ repositories: rows, truncated: false }),
    ...Object.fromEntries(
      [REPO_PORTAL, REPO_WEB].flatMap((id) => [
        [
          `GET /api/ui/repositories/${id}`,
          () => (holdReads ? pending() : jsonResponse(details[id])),
        ],
        [`GET /api/ui/repositories/${id}/rules`, { rules: [] }],
        [
          `PUT /api/ui/repositories/${id}/ask`,
          (request: SeenRequest) =>
            jsonResponse({
              ok: true,
              card: { enabled: (request.body as AskCardInput).askEnabled },
            }),
        ],
        [
          `PUT /api/ui/repositories/${id}/playbooks`,
          (request: SeenRequest) =>
            jsonResponse({
              ok: true,
              card: {
                ...details[id]!.playbooks,
                bindings: (request.body as PlaybooksCardInput).bindings,
              },
            }),
        ],
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
    user?: SessionUser;
    showAdvanced?: boolean;
    live?: ReturnType<typeof fakeAbly>;
  } = {},
) {
  const client = createTestQueryClient();
  const tree = (showAdvanced: boolean) => {
    const view = <ReposView repositoryId={REPO_PORTAL} />;
    const content: ReactNode = options.live ? (
      <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
        {view}
      </LiveProvider>
    ) : (
      view
    );
    return (
      <CurrentUserProvider user={options.user ?? testUser}>
        <ShowAdvancedProvider initial={showAdvanced}>
          <QueryClientProvider client={client}>
            <UiProvider linkComponent={TestLink}>
              <UnsavedChangesProvider>{content}</UnsavedChangesProvider>
            </UiProvider>
          </QueryClientProvider>
        </ShowAdvancedProvider>
      </CurrentUserProvider>
    );
  };
  const utils = render(tree(options.showAdvanced ?? false));
  return { client, rerender: (showAdvanced: boolean) => utils.rerender(tree(showAdvanced)) };
}

const askCard = () => screen.findByRole("region", { name: "Ask" });
const playbooks = () => screen.queryByRole("region", { name: "Playbooks" });
const dangerZone = () => screen.queryByRole("region", { name: "Danger zone" });
const advanced = () => screen.getByRole("region", { name: "Advanced" });
const saveBar = (card: HTMLElement) =>
  within(card).queryByRole("region", { name: "Unsaved changes" });
const pendingItems = (card: HTMLElement) =>
  [...(saveBar(card)?.querySelectorAll(".or-pending__item") ?? [])].map((item) => ({
    label: item.querySelector(".or-pending__label")?.textContent,
    from: item.querySelector(".or-pending__from")?.textContent,
    to: item.querySelector(".or-pending__to")?.textContent,
    effect: item.querySelector(".or-pending__effect")?.textContent,
  }));
const reads = () => seen.filter((request) => request.method === "GET");
const saves = () => seen.filter((request) => request.method === "PUT");
const askIcon = () =>
  within(screen.getByRole("region", { name: "Repos" })).getAllByRole("img", {
    name: /^Ask (on|off)$/,
  })[0]!;

describe("the Ask card", () => {
  it("sits right after Coding with its change history, switch and help line", async () => {
    renderRepos();
    const card = await askCard();
    expect(card.closest("section#ask")).toBeTruthy();
    expect(card.closest("section#ask")!.previousElementSibling?.id).toBe("coding");
    const heading = within(card).getByRole("heading", { level: 2, name: "Ask" });
    expect(heading.nextElementSibling).toBe(
      within(card).getByRole("button", { name: "Change history" }),
    );
    expect(within(card).getByRole("switch", { name: "Ask" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(card).getByText("Om answers questions about this repo's code in Ask and chat."),
    ).toBeTruthy();
    expect(saveBar(card)).toBeNull();
  });

  it("stages Ask off with its effect and saves it once, updating the card and rail icon with no GET", async () => {
    renderRepos();
    const card = await askCard();
    await waitFor(() => expect(askIcon().getAttribute("aria-label")).toBe("Ask on"));
    const user = userEvent.setup();
    await user.click(within(card).getByRole("switch", { name: "Ask" }));
    expect(pendingItems(card)).toEqual([
      {
        label: "Ask",
        from: "On",
        to: "Off",
        effect: "Om won't answer questions about this repo's code.",
      },
    ]);
    holdReads = true;
    const readsBefore = reads().length;
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.path).toBe(`/api/ui/repositories/${REPO_PORTAL}/ask`);
    expect(saves()[0]!.body).toEqual({ askEnabled: false });
    expect(within(card).getByRole("switch", { name: "Ask" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(askIcon().getAttribute("aria-label")).toBe("Ask off");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads()).toHaveLength(readsBefore);
  });

  it("stages Ask on with its effect and saves it", async () => {
    rows = [{ ...portalRow(), askEnabled: false }, webRow()];
    details[REPO_PORTAL] = repoDetail(rows[0]!, {
      playbooks: playbooksCard(),
      ask: { enabled: false },
    });
    renderRepos();
    const card = await askCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("switch", { name: "Ask" }));
    expect(pendingItems(card)).toEqual([
      {
        label: "Ask",
        from: "Off",
        to: "On",
        effect: "Om answers questions about this repo's code.",
      },
    ]);
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.body).toEqual({ askEnabled: true });
    await waitFor(() => expect(askIcon().getAttribute("aria-label")).toBe("Ask on"));
  });

  it("discards a staged Ask change", async () => {
    renderRepos();
    const card = await askCard();
    const user = userEvent.setup();
    await user.click(within(card).getByRole("switch", { name: "Ask" }));
    await user.click(within(saveBar(card)!).getByRole("button", { name: "Discard" }));
    expect(saveBar(card)).toBeNull();
    expect(within(card).getByRole("switch", { name: "Ask" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(saves()).toHaveLength(0);
  });

  it("is read-only for members: switch disabled, no save bar", async () => {
    rows = [portalRow({ organization: { ...portalRow().organization, role: "member" } })];
    details[REPO_PORTAL] = repoDetail(rows[0]!, { playbooks: playbooksCard() });
    renderRepos({ user: member });
    const card = await askCard();
    const toggle = within(card).getByRole("switch", { name: "Ask" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(saveBar(card)).toBeNull();
  });
});

describe("the Advanced section", () => {
  it("shows only the Danger zone while advanced settings are hidden", async () => {
    renderRepos({ showAdvanced: false });
    await askCard();
    expect(playbooks()).toBeNull();
    const section = advanced();
    const cards = within(section).getAllByRole("region");
    expect(cards).toEqual([dangerZone()]);
  });

  it("shows the Playbooks card with built-ins first, staging a binding change with its effect", async () => {
    renderRepos({ showAdvanced: true });
    await askCard();
    const card = playbooks()!;
    expect(card.closest("section#advanced")).toBeTruthy();
    const heading = within(card).getByRole("heading", { name: "Playbooks" });
    expect(heading.nextElementSibling).toBe(
      within(card).getByRole("button", { name: "Change history" }),
    );
    const selects = within(card).getAllByRole<HTMLSelectElement>("combobox");
    expect(selects.map((select) => select.labels?.[0]?.textContent)).toEqual([
      "Review",
      "Combine review findings",
      "Stories",
      "Requests",
    ]);
    const review = within(card).getByRole<HTMLSelectElement>("combobox", { name: "Review" });
    expect([...review.options].map((option) => option.textContent)).toEqual([
      "Review a pull request",
      "Security review",
    ]);
    expect(review.value).toBe("builtin:review");
    // The Danger zone comes last.
    const regions = within(advanced()).getAllByRole("region");
    expect(regions).toEqual([card, dangerZone()]);

    const user = userEvent.setup();
    await user.selectOptions(within(card).getByRole("combobox", { name: "Stories" }), "pb-careful");
    expect(pendingItems(card)).toEqual([
      {
        label: "Stories playbook",
        from: "Implement a story",
        to: "Careful",
        effect: "New story runs use Careful.",
      },
    ]);
    holdReads = true;
    const readsBefore = reads().length;
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.path).toBe(`/api/ui/repositories/${REPO_PORTAL}/playbooks`);
    expect(saves()[0]!.body).toEqual({
      bindings: {
        review: ["builtin:review"],
        correlation: "builtin:correlate",
        story: "pb-careful",
        request: "builtin:handle-request",
      },
    });
    expect(within(card).getByRole<HTMLSelectElement>("combobox", { name: "Stories" }).value).toBe(
      "pb-careful",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads()).toHaveLength(readsBefore);
  });

  it("stages and saves the Combine review findings and Requests bindings; Discard restores them", async () => {
    renderRepos({ showAdvanced: true });
    await askCard();
    const card = playbooks()!;
    const user = userEvent.setup();
    const combine = within(card).getByRole<HTMLSelectElement>("combobox", {
      name: "Combine review findings",
    });
    const requests = within(card).getByRole<HTMLSelectElement>("combobox", { name: "Requests" });
    await user.selectOptions(combine, "pb-strict");
    await user.selectOptions(requests, "pb-triage");
    expect(pendingItems(card)).toEqual([
      {
        label: "Combine review findings playbook",
        from: "Combine findings",
        to: "Strict combine",
        effect: "New correlation runs use Strict combine.",
      },
      {
        label: "Requests playbook",
        from: "Handle a request",
        to: "Triage first",
        effect: "New request runs use Triage first.",
      },
    ]);
    await user.click(within(saveBar(card)!).getByRole("button", { name: "Discard" }));
    expect(saveBar(card)).toBeNull();
    expect(combine.value).toBe("builtin:correlate");
    expect(requests.value).toBe("builtin:handle-request");

    await user.selectOptions(combine, "pb-strict");
    await user.selectOptions(requests, "pb-triage");
    await user.click(within(card).getByRole("button", { name: "Save 2 changes" }));
    await waitFor(() => expect(saveBar(card)).toBeNull());
    expect(saves()).toHaveLength(1);
    expect(saves()[0]!.body).toEqual({
      bindings: {
        review: ["builtin:review"],
        correlation: "pb-strict",
        story: "builtin:implement-story",
        request: "pb-triage",
      },
    });
  });

  it("saves a review choice as the binding's first entry", async () => {
    details[REPO_PORTAL] = repoDetail(portalRow(), {
      playbooks: {
        ...playbooksCard(),
        bindings: { ...playbooksCard().bindings, review: ["builtin:review", "builtin:summary"] },
      },
    });
    renderRepos({ showAdvanced: true });
    await askCard();
    const card = playbooks()!;
    const user = userEvent.setup();
    await user.selectOptions(within(card).getByRole("combobox", { name: "Review" }), "pb-security");
    expect(pendingItems(card)[0]!.effect).toBe("New review runs use Security review.");
    await user.click(within(card).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect((saves()[0]!.body as PlaybooksCardInput).bindings.review).toEqual([
      "pb-security",
      "builtin:summary",
    ]);
  });

  it("shows the Playbooks card when the preference is turned on elsewhere, without a reload", async () => {
    const live = fakeAbly();
    const { rerender } = renderRepos({ showAdvanced: false, live });
    await askCard();
    await waitFor(() => expect(live.current().subscribed()).toContain("user:user-1:changes"));
    expect(playbooks()).toBeNull();
    // The shell re-renders from the server on the user's own record change: now on.
    nav.router.refresh.mockImplementation(() => rerender(true));
    act(() =>
      live.current().deliver(
        "user:user-1:changes",
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "settings",
          section: "profile",
        }),
      ),
    );
    expect(nav.router.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(playbooks()).not.toBeNull());
  });

  it("shows members the Playbooks card read-only and no Danger zone", async () => {
    rows = [portalRow({ organization: { ...portalRow().organization, role: "member" } })];
    details[REPO_PORTAL] = repoDetail(rows[0]!, { playbooks: playbooksCard() });
    renderRepos({ user: member, showAdvanced: true });
    await askCard();
    const card = playbooks()!;
    for (const select of within(card).getAllByRole("combobox")) {
      expect(select.hasAttribute("disabled")).toBe(true);
    }
    expect(saveBar(card)).toBeNull();
    expect(dangerZone()).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove repo" })).toBeNull();
  });
});

describe("the Danger zone", () => {
  it("describes removal, and its button opens the same dialog as the menu's Remove repo…", async () => {
    renderRepos();
    await askCard();
    const zone = dangerZone()!;
    expect(within(zone).getByText(REMOVE_REPO_DESCRIPTION)).toBeTruthy();
    const user = userEvent.setup();
    const RemoveRepoDialog = vi.mocked(removeDialog.RemoveRepoDialog);
    const openDialogs = () =>
      RemoveRepoDialog.mock.calls.filter(([props]) => props.open).map(([props]) => props);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove repo…" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByRole("heading", { name: "Remove managed-services/customer-portal?" }),
    ).toBeTruthy();
    const fromMenu = openDialogs().length;
    expect(fromMenu).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    RemoveRepoDialog.mockClear();
    const button = within(zone).getByRole("button", { name: "Remove repo" });
    expect(button.className).toContain("or-btn--danger");
    await user.click(button);
    dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByRole("heading", { name: "Remove managed-services/customer-portal?" }),
    ).toBeTruthy();
    expect(within(dialog).getByText(REMOVE_REPO_DESCRIPTION)).toBeTruthy();
    expect(openDialogs().length).toBeGreaterThan(0);
    expect(openDialogs()[0]!.repository.fullPath).toBe("managed-services/customer-portal");
  });
});
