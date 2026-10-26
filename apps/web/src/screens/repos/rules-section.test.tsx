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
import type { RepositoryDetail, RepositoryListItem } from "@/lib/api/repositories";
import type { RepositoryRules } from "@/lib/api/rules";
import type { RuleView } from "@/lib/rules/display";
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

const RULES_PATH = `/api/ui/repositories/${REPO_PORTAL}/rules`;

function rule(n: number, overrides: Partial<RuleView> = {}): RuleView {
  return {
    id: `66666666-7777-4888-8999-${String(n).padStart(12, "0")}`,
    kind: "custom",
    text: `Rule number ${n}`,
    enabled: true,
    createdAt: "2026-10-16T10:00:00.000Z",
    createdBy: "Ada Admin",
    sourceFinding: null,
    ...overrides,
  };
}

const learnedRule = (n: number, overrides: Partial<RuleView> = {}) =>
  rule(n, {
    kind: "learned",
    text: `Learned rule ${n}`,
    createdBy: null,
    sourceFinding: {
      href: "/runs/r1?step=p&tab=findings#finding-f",
      title: "Null check on config",
      path: "src/config.ts",
    },
    ...overrides,
  });

const rulesOf = (list: RuleView[]): RepositoryRules => ({
  repository: {
    id: REPO_PORTAL,
    provider: "gitlab",
    fullPath: "managed-services/customer-portal",
    webUrl: "https://gitlab.example.com/managed-services/customer-portal",
  },
  rules: list,
});

let rows: RepositoryListItem[];
let details: Record<string, RepositoryDetail>;
let rules: RuleView[];
let seen: SeenRequest[];
/** While set, reads never answer: what the view shows then comes from the cache. */
let holdReads: boolean;
let writeAnswer: ((request: SeenRequest) => Response | Promise<Response>) | null;

const pending = () => new Promise<Response>(() => {});

beforeEach(() => {
  nav.router.push.mockReset();
  ui.toast.mockReset();
  rows = [portalRow(), webRow()];
  details = {
    [REPO_PORTAL]: repoDetail(portalRow()),
    [REPO_WEB]: repoDetail(webRow()),
  };
  rules = [rule(1), learnedRule(2)];
  holdReads = false;
  writeAnswer = null;
  window.history.replaceState(null, "", `/repos/${REPO_PORTAL}`);
  const ruleId = (request: SeenRequest) => request.path.split("/").pop()!;
  seen = mockFetch({
    "GET /api/ui/repositories": () =>
      holdReads ? pending() : jsonResponse({ repositories: rows, truncated: false }),
    ...Object.fromEntries(
      [REPO_PORTAL, REPO_WEB].map((id) => [
        `GET /api/ui/repositories/${id}`,
        () => (holdReads ? pending() : jsonResponse(details[id])),
      ]),
    ),
    [`GET ${RULES_PATH}`]: () => (holdReads ? pending() : jsonResponse(rulesOf(rules))),
    [`GET /api/ui/repositories/${REPO_WEB}/rules`]: () => jsonResponse(rulesOf([])),
    [`POST ${RULES_PATH}`]: (request) => {
      if (writeAnswer) return writeAnswer(request);
      const added = rule(9, { text: (request.body as { text: string }).text });
      rules = [...rules, added];
      return jsonResponse({ ok: true, rule: added });
    },
    ...Object.fromEntries(
      [1, 2].flatMap((n) => [
        [
          `PATCH ${RULES_PATH}/${rule(n).id}`,
          (request: SeenRequest) => {
            if (writeAnswer) return writeAnswer(request);
            const id = ruleId(request);
            rules = rules.map((entry) =>
              entry.id === id ? { ...entry, ...(request.body as Partial<RuleView>) } : entry,
            );
            return jsonResponse({ ok: true, rule: rules.find((entry) => entry.id === id) });
          },
        ],
        [
          `DELETE ${RULES_PATH}/${rule(n).id}`,
          (request: SeenRequest) => {
            if (writeAnswer) return writeAnswer(request);
            rules = rules.filter((entry) => entry.id !== ruleId(request));
            return jsonResponse({ ok: true });
          },
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
  options: { repositoryId?: string; user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {},
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

const rulesSection = () => screen.findByRole("region", { name: "Rules" });
/** The row of the rule showing `text`. */
const row = (text: string) => screen.getByText(text).closest("li") as HTMLElement;
const useSwitch = (text: string) =>
  within(row(text)).getByRole("switch", { name: "Use this rule" });
const ruleTexts = (section: HTMLElement) =>
  [...section.querySelectorAll(".or-repo-rules__text")].map((node) => node.textContent);
const rulesReads = () =>
  seen.filter((request) => request.method === "GET" && request.path === RULES_PATH);
const writes = (method: string) => seen.filter((request) => request.method === method);

/** Renders the Rules section with its rules loaded, then holds every read. */
async function renderLoaded(options: Parameters<typeof renderRepos>[0] = {}) {
  const rendered = renderRepos(options);
  const section = await rulesSection();
  await within(section).findByText("Rule number 1");
  holdReads = true;
  return { ...rendered, section };
}

describe("the Rules section", () => {
  it("shows each rule with its badge, text, source, creator, switch and actions", async () => {
    const { section } = await renderLoaded();
    expect(section.closest("section#rules")).toBeTruthy();
    expect(within(section).getByRole("heading", { level: 2, name: "Rules" })).toBeTruthy();
    expect(
      within(section).getByText("Om follows these rules when it reviews this repo."),
    ).toBeTruthy();
    // The rules serve a repo of any of the user's organizations: no page to come back to.
    expect(rulesReads()[0]!.query.get("next")).toBeNull();

    const written = row("Rule number 1");
    expect(within(written).getByText("Written")).toBeTruthy();
    expect(within(written).getByText("Written by Ada Admin")).toBeTruthy();
    expect(useSwitch("Rule number 1").getAttribute("aria-checked")).toBe("true");
    expect(within(written).getByRole("button", { name: "Edit rule" })).toBeTruthy();
    expect(within(written).getByRole("button", { name: "Delete rule" })).toBeTruthy();

    const learned = row("Learned rule 2");
    expect(within(learned).getByText("Learned")).toBeTruthy();
    const link = within(learned).getByRole("link", { name: "Null check on config" });
    expect(link.getAttribute("href")).toBe("/runs/r1?step=p&tab=findings#finding-f");
    expect(learned.textContent).toContain("Learned by Om from Null check on config");
    expect(within(section).getAllByRole("button", { name: "Add rule" })).toHaveLength(1);
  });

  it("names a learned rule's finding without a link when its review has no page, or when it's gone", async () => {
    rules = [
      rule(1),
      learnedRule(2, { sourceFinding: { href: null, title: "Old finding", path: "a.ts" } }),
      learnedRule(3, { sourceFinding: null }),
    ];
    const { section } = await renderLoaded();
    expect(within(row("Learned rule 2")).queryByRole("link")).toBeNull();
    expect(row("Learned rule 2").textContent).toContain("Old finding");
    expect(row("Learned rule 3").textContent).toContain("from a finding that was deleted");
    expect(ruleTexts(section)).toEqual(["Rule number 1", "Learned rule 2", "Learned rule 3"]);
  });

  it("adds a rule from the response without a refetch and toasts", async () => {
    const { section } = await renderLoaded();
    const readsBefore = seen.length;
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "Add rule" }));
    const text = within(section).getByLabelText("Rule");
    await user.type(text, "Flag TODOs.");
    expect(within(section).getByText("11 / 1,000 characters.")).toBeTruthy();
    await user.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ruleTexts(section)).toContain("Flag TODOs."));
    expect(writes("POST")).toHaveLength(1);
    expect(writes("POST")[0]!.body).toEqual({ text: "Flag TODOs." });
    expect(ui.toast).toHaveBeenCalledWith("Rule added");
    expect(within(section).queryByLabelText("Rule")).toBeNull();
    expect(within(row("Flag TODOs.")).getByText("Written")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.slice(readsBefore).filter((request) => request.method === "GET")).toEqual([]);
  });

  it("shows the API's field error inline on a refused add and keeps the text", async () => {
    writeAnswer = () =>
      jsonResponse({ error: "Too long.", fieldErrors: { text: "Too long." } }, 400);
    const { section } = await renderLoaded();
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "Add rule" }));
    await user.type(within(section).getByLabelText("Rule"), "Flag TODOs.");
    await user.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(section).getByText("Too long.")).toBeTruthy());
    expect((within(section).getByLabelText("Rule") as HTMLTextAreaElement).value).toBe(
      "Flag TODOs.",
    );
    expect(ui.toast).toHaveBeenCalledWith("Too long.", { variant: "danger" });
    expect(ruleTexts(section)).toEqual(["Rule number 1", "Learned rule 2"]);
  });

  it("checks an empty rule before sending it, and Cancel closes the form", async () => {
    const { section } = await renderLoaded();
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "Add rule" }));
    await user.click(within(section).getByRole("button", { name: "Save" }));
    expect(within(section).getByText("Enter the rule.")).toBeTruthy();
    expect(writes("POST")).toHaveLength(0);
    await user.click(within(section).getByRole("button", { name: "Cancel" }));
    expect(within(section).queryByLabelText("Rule")).toBeNull();
  });

  it("edits a rule in place and shows the new text from the response", async () => {
    const { section } = await renderLoaded();
    const readsBefore = seen.length;
    const user = userEvent.setup();
    await user.click(within(row("Rule number 1")).getByRole("button", { name: "Edit rule" }));
    const text = within(section).getByLabelText("Rule") as HTMLTextAreaElement;
    expect(text.value).toBe("Rule number 1");
    await user.clear(text);
    await user.type(text, "Flag TODOs without a link.");
    await user.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ruleTexts(section)[0]).toBe("Flag TODOs without a link."));
    expect(writes("PATCH")[0]!.path).toBe(`${RULES_PATH}/${rule(1).id}`);
    expect(writes("PATCH")[0]!.body).toEqual({ text: "Flag TODOs without a link." });
    expect(within(section).queryByLabelText("Rule")).toBeNull();
    expect(ui.toast).toHaveBeenCalledWith("Rule saved");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.slice(readsBefore).filter((request) => request.method === "GET")).toEqual([]);
  });

  it("cancels an edit back to the saved text", async () => {
    const { section } = await renderLoaded();
    const user = userEvent.setup();
    await user.click(within(row("Rule number 1")).getByRole("button", { name: "Edit rule" }));
    await user.type(within(section).getByLabelText("Rule"), " more");
    await user.click(within(section).getByRole("button", { name: "Cancel" }));
    expect(ruleTexts(section)).toEqual(["Rule number 1", "Learned rule 2"]);
    expect(writes("PATCH")).toHaveLength(0);
  });

  it("switches a rule off at once, holds it while the change is in flight, and keeps it", async () => {
    let release: () => void = () => {};
    writeAnswer = async (request) => {
      await new Promise<void>((resolve) => (release = resolve));
      return jsonResponse({
        ok: true,
        rule: rule(1, { enabled: (request.body as { enabled: boolean }).enabled }),
      });
    };
    await renderLoaded();
    await userEvent.setup().click(useSwitch("Rule number 1"));
    expect(useSwitch("Rule number 1").getAttribute("aria-checked")).toBe("false");
    expect(row("Rule number 1").dataset.enabled).toBe("false");
    await waitFor(() => expect(useSwitch("Rule number 1").hasAttribute("disabled")).toBe(true));
    expect(writes("PATCH")[0]!.body).toEqual({ enabled: false });

    release();
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Rule off"));
    await waitFor(() => expect(useSwitch("Rule number 1").hasAttribute("disabled")).toBe(false));
    expect(useSwitch("Rule number 1").getAttribute("aria-checked")).toBe("false");
    expect(rulesReads()).toHaveLength(1);
  });

  it("rolls a switch back with an error toast when the change fails", async () => {
    let release: () => void = () => {};
    writeAnswer = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return jsonResponse({ error: "That rule doesn't exist." }, 400);
    };
    await renderLoaded();
    await userEvent.setup().click(useSwitch("Rule number 1"));
    expect(useSwitch("Rule number 1").getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(writes("PATCH")).toHaveLength(1));
    release();
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("That rule doesn't exist.", { variant: "danger" }),
    );
    await waitFor(() =>
      expect(useSwitch("Rule number 1").getAttribute("aria-checked")).toBe("true"),
    );
    expect(rulesReads()).toHaveLength(1);
  });

  it("deletes a rule after confirming and removes the row at once", async () => {
    let release: () => void = () => {};
    writeAnswer = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return jsonResponse({ ok: true });
    };
    const { section } = await renderLoaded();
    const user = userEvent.setup();
    await user.click(within(row("Rule number 1")).getByRole("button", { name: "Delete rule" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this rule?" });
    expect(within(dialog).getByText("Om stops following it in new reviews.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(writes("DELETE")).toHaveLength(0);
    expect(ruleTexts(section)).toEqual(["Rule number 1", "Learned rule 2"]);

    await user.click(within(row("Rule number 1")).getByRole("button", { name: "Delete rule" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete rule" }),
    );
    // Gone before the server answers.
    await waitFor(() => expect(ruleTexts(section)).toEqual(["Learned rule 2"]));
    expect(writes("DELETE")[0]!.path).toBe(`${RULES_PATH}/${rule(1).id}`);
    release();
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Rule deleted"));
    expect(ruleTexts(section)).toEqual(["Learned rule 2"]);
    expect(rulesReads()).toHaveLength(1);
  });

  it("puts a deleted rule back when the deletion fails", async () => {
    writeAnswer = () => jsonResponse({ error: "That rule doesn't exist." }, 400);
    const { section } = await renderLoaded();
    const user = userEvent.setup();
    await user.click(within(row("Rule number 1")).getByRole("button", { name: "Delete rule" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete rule" }),
    );
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("That rule doesn't exist.", { variant: "danger" }),
    );
    expect(ruleTexts(section)).toEqual(["Rule number 1", "Learned rule 2"]);
  });

  it("shows a rule learned from a pull request when the repo's change event arrives", async () => {
    const live = fakeAbly();
    renderRepos({ live });
    const section = await rulesSection();
    await within(section).findByText("Rule number 1");
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const before = rulesReads().length;
    rules = [...rules, learnedRule(3)];
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "repository", ids: [REPO_PORTAL] }),
        ),
    );
    await waitFor(() => expect(ruleTexts(section)).toContain("Learned rule 3"));
    expect(rulesReads().length).toBeGreaterThan(before);
  });

  it("shows the empty state with the provider's wording and Add rule for admins", async () => {
    rules = [];
    renderRepos();
    const section = await rulesSection();
    await within(section).findByText("No rules yet");
    expect(
      within(section).getByText(
        "Om learns a rule when someone marks a finding as a false positive on a merge request.",
      ),
    ).toBeTruthy();
    const user = userEvent.setup();
    expect(within(section).getAllByRole("button", { name: "Add rule" })).toHaveLength(1);
    await user.click(within(section).getByRole("button", { name: "Add rule" }));
    expect(within(section).queryByText("No rules yet")).toBeNull();
    await user.type(within(section).getByLabelText("Rule"), "Flag TODOs.");
    holdReads = true;
    await user.click(within(section).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ruleTexts(section)).toEqual(["Flag TODOs."]));
  });

  it("words the empty state for pull requests on GitHub", async () => {
    renderRepos({ repositoryId: REPO_WEB });
    const section = await rulesSection();
    expect(
      await within(section).findByText(
        "Om learns a rule when someone marks a finding as a false positive on a pull request.",
      ),
    ).toBeTruthy();
  });

  it("shows members the rules read-only", async () => {
    details[REPO_PORTAL] = repoDetail(
      portalRow({ organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" } }),
    );
    const { section } = await renderLoaded({ user: member });
    expect(useSwitch("Rule number 1").hasAttribute("disabled")).toBe(true);
    expect(within(section).queryByRole("button", { name: "Add rule" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Edit rule" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Delete rule" })).toBeNull();
  });

  it("shows members no Add rule in the empty state", async () => {
    rules = [];
    details[REPO_PORTAL] = repoDetail(
      portalRow({ organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" } }),
    );
    renderRepos({ user: member });
    const section = await rulesSection();
    await within(section).findByText("No rules yet");
    expect(within(section).queryByRole("button", { name: "Add rule" })).toBeNull();
  });

  it("shows a failed load in place with a retry", async () => {
    let fail = true;
    seen.length = 0;
    vi.unstubAllGlobals();
    const base = { ...details };
    seen = mockFetch({
      "GET /api/ui/repositories": () => jsonResponse({ repositories: rows, truncated: false }),
      [`GET /api/ui/repositories/${REPO_PORTAL}`]: () => jsonResponse(base[REPO_PORTAL]),
      [`GET ${RULES_PATH}`]: () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse(rulesOf([rule(1)])),
      "GET /api/ui/settings-history": { latest: null, entries: [], next: null },
    });
    renderRepos();
    const section = await rulesSection();
    await waitFor(() => expect(within(section).getByText("Couldn't load the rules")).toBeTruthy(), {
      timeout: 5000,
    });
    fail = false;
    await userEvent.setup().click(within(section).getByRole("button", { name: "Retry" }));
    await within(section).findByText("Rule number 1");
  });
});
