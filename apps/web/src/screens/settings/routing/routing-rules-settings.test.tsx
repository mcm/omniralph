// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RoutingRulesSettingsPage from "@/app/(app)/settings/advanced/routing/page";
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
import { UnsavedChangesProvider } from "@/components/unsaved-changes";
import type { RoutingRuleRow, RoutingRules } from "@/lib/api/routing-rules";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import {
  DEFAULT_RULES,
  ROUTING_RULES_CONFLICT,
  ROUTING_RULES_DESCRIPTION,
} from "./routing-rules-settings";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/advanced/routing",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WEB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BETA_ID = "22222222-2222-4222-8222-222222222222";

const fields: RoutingRules["fields"] = LINEAR_ROUTING_FIELDS.map((field) => ({
  ...field,
  operators: [...field.operators],
  options:
    field.options && "values" in field.options
      ? { values: [...field.options.values] }
      : field.options,
}));

function row(
  id: string,
  position: number,
  repositoryId: string,
  query: RoutingRuleRow["query"],
): RoutingRuleRow {
  return { id, position, repositoryId, query, updatedAt: "2026-10-17T10:00:00.000Z" };
}

const labelsRule = row("r1", 0, API, {
  id: "g1",
  combinator: "and",
  rules: [{ id: "c1", field: "labels", operator: "containsAny", value: ["Backend"] }],
});
const teamRule = row("r2", 1, WEB, {
  id: "g2",
  combinator: "and",
  rules: [{ id: "c2", field: "team", operator: "=", value: "ENG" }],
});

const history: SettingsHistoryEntry = {
  id: "change-1",
  organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
  section: "routing_rules",
  subjectId: null,
  actor: { id: "user-2", name: "Grace" },
  changedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  changes: [{ field: "rule-1", label: "Rule 1", before: null, after: "Team is ENG → mcm/web" }],
  runsSince: 2,
};

function routing(rules: RoutingRuleRow[]): RoutingRules {
  return {
    rules,
    fields,
    linear: {
      status: "connected",
      options: {
        teams: [{ key: "ENG", name: "Engineering" }],
        labels: ["Backend", "Frontend"],
        projects: ["Web"],
        states: ["Todo"],
        projectMilestones: [],
        cycles: [],
        users: [],
      },
    },
    repositories: [
      { id: API, provider: "github", fullPath: "mcm/api", codingEnabled: true },
      { id: WEB, provider: "gitlab", fullPath: "mcm/web", codingEnabled: false },
    ],
    history,
  };
}

let rules: RoutingRuleRow[];
let seen: SeenRequest[];
/** While set, `GET /api/ui/routing-rules` never answers: the view shows the cache. */
let holdReads: boolean;
let putAnswer: ((request: SeenRequest) => Response) | null;

beforeEach(() => {
  ui.toast.mockReset();
  rules = [labelsRule, teamRule];
  holdReads = false;
  putAnswer = null;
  seen = mockFetch({
    "GET /api/ui/routing-rules": () =>
      holdReads ? new Promise<Response>(() => {}) : jsonResponse(routing(rules)),
    "PUT /api/ui/routing-rules": (request) => {
      if (putAnswer) return putAnswer(request);
      const body = request.body as { rules: { repositoryId: string; query: unknown }[] };
      rules = body.rules.map((rule, i) =>
        row(`saved-${i}`, i, rule.repositoryId, rule.query as RoutingRuleRow["query"]),
      );
      return jsonResponse({ ok: true, rules });
    },
    "GET /api/ui/settings-history": () =>
      jsonResponse({ latest: history, entries: [history], next: null }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

function renderRouting(options: { user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {}) {
  const client = createTestQueryClient();
  const page = <RoutingRulesSettingsPage />;
  render(
    <CurrentUserProvider user={options.user ?? testUser}>
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
    </CurrentUserProvider>,
  );
  return { client };
}

const card = () => screen.getByRole("region", { name: "Routing rules" });
const list = () => screen.getByRole("list", { name: "Routing rules" });
const ruleRow = (number: number) =>
  within(list()).getByRole("listitem", { name: `Rule ${number}` });
const ruleTexts = () =>
  within(list())
    .queryAllByRole("listitem")
    .map((item) => item.querySelector(".or-routing__description")!.textContent);
const saveBar = () => screen.queryByRole("region", { name: "Unsaved changes" });
const pendingLabels = () =>
  Array.from(saveBar()?.querySelectorAll(".or-pending__label") ?? [], (el) => el.textContent);
const puts = () =>
  seen
    .filter((request) => request.method === "PUT")
    .map((request) => request.body as { rules: { repositoryId: string; query: unknown }[] });
const reads = () => seen.filter((r) => r.method === "GET" && r.path === "/api/ui/routing-rules");
const dialog = () => screen.getByRole("dialog");

/** A saved rule's target and conditions, as `PUT` got them. */
function summary(body: { rules: { repositoryId: string; query: unknown }[] }) {
  return body.rules.map((rule) => [
    rule.repositoryId,
    (rule.query as { rules: { field: string; operator: string; value: unknown }[] }).rules.map(
      ({ field, operator, value }) => ({ field, operator, value }),
    ),
  ]);
}

async function loaded() {
  return screen.findByRole("list", { name: "Routing rules" });
}

describe("Advanced › Routing rules", () => {
  it("lists the rules in order with their description and target repo, then the built-in rules", async () => {
    rules = [teamRule, labelsRule];
    renderRouting();
    await loaded();
    expect(within(card()).getByText(ROUTING_RULES_DESCRIPTION)).toBeTruthy();
    // Saved in position order: the labels rule is first.
    expect(ruleTexts()).toEqual(["Labels contains any of Backend", "Team is ENG"]);
    expect(ruleRow(1).querySelector(".or-routing__number")!.textContent).toBe("1");
    expect(within(ruleRow(1)).getByText("mcm/api")).toBeTruthy();
    expect(within(ruleRow(2)).getByText("mcm/web")).toBeTruthy();
    expect(within(ruleRow(2)).getByRole("img", { name: "GitLab" })).toBeTruthy();

    const builtIn = screen.getByRole("list", { name: "After each repo's work item match" });
    expect(
      within(builtIn)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(DEFAULT_RULES.map((label) => `Default rule: ${label}`));
    expect(within(builtIn).queryAllByRole("button")).toEqual([]);
    // Admins get the icon buttons; the first can't go up, the last can't go down.
    expect(
      within(ruleRow(1)).getByRole<HTMLButtonElement>("button", { name: "Move rule 1 up" })
        .disabled,
    ).toBe(true);
    expect(
      within(ruleRow(2)).getByRole<HTMLButtonElement>("button", { name: "Move rule 2 down" })
        .disabled,
    ).toBe(true);
    expect(within(ruleRow(1)).getByRole("button", { name: "Edit rule 1" })).toBeTruthy();
    expect(within(ruleRow(1)).getByRole("button", { name: "Delete rule 1" })).toBeTruthy();
    expect(saveBar()).toBeNull();
  });

  it("says when a rule's repo has coding off", async () => {
    renderRouting();
    await loaded();
    expect(ruleRow(2).textContent).toContain(
      "Coding is off for mcm/web: matching work items are treated as manual.",
    );
    expect(ruleRow(1).textContent).not.toContain("Coding is off");
  });

  it("adds a rule in the sheet, stages it and saves the whole list in one PUT, shown before any refetch", async () => {
    renderRouting();
    await loaded();
    await userEvent.click(within(card()).getByRole("button", { name: "Add rule" }));
    const sheet = dialog();
    expect(within(sheet).getByRole("heading", { name: "Add a rule" })).toBeTruthy();
    expect(
      within(sheet).getByText("No conditions: this rule matches every work item."),
    ).toBeTruthy();
    await userEvent.selectOptions(within(sheet).getByRole("combobox", { name: "Repo" }), WEB);
    expect(within(sheet).getByText(/Coding is off for mcm\/web/)).toBeTruthy();
    await userEvent.click(within(sheet).getByRole("button", { name: "Condition" }));
    await userEvent.selectOptions(within(sheet).getByRole("combobox", { name: "Field" }), "title");
    await userEvent.selectOptions(
      within(sheet).getByRole("combobox", { name: "Operator" }),
      "contains",
    );
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Value" }), "docs");
    await userEvent.click(within(sheet).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ruleTexts()).toEqual([
      "Labels contains any of Backend",
      "Team is ENG",
      "Title contains docs",
    ]);
    expect(pendingLabels()).toEqual(["Rule 3: added"]);
    expect(saveBar()!.textContent).toContain("Work items it matches go to mcm/web.");
    expect(puts()).toEqual([]);

    holdReads = true;
    const before = reads().length;
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Saved the routing rules"));
    expect(puts()).toHaveLength(1);
    expect(summary(puts()[0]!)).toEqual([
      [API, [{ field: "labels", operator: "containsAny", value: ["Backend"] }]],
      [WEB, [{ field: "team", operator: "=", value: "ENG" }]],
      [WEB, [{ field: "title", operator: "contains", value: "docs" }]],
    ]);
    // The saved list, from the answer: no refetch answered, and nothing left to save.
    await waitFor(() => expect(saveBar()).toBeNull());
    expect(ruleTexts()).toEqual([
      "Labels contains any of Backend",
      "Team is ENG",
      "Title contains docs",
    ]);
    expect(reads().length).toBe(before);
  });

  it("reorders with Move up and Move down, lists the move and shows the saved order at once", async () => {
    const third = row("r3", 2, API, { id: "g3", combinator: "or", rules: [] });
    rules = [labelsRule, teamRule, third];
    renderRouting();
    await loaded();
    const up = within(ruleRow(2)).getByRole("button", { name: "Move rule 2 up" });
    await userEvent.click(up);
    expect(ruleTexts()).toEqual(["Team is ENG", "Labels contains any of Backend", "Every issue"]);
    expect(pendingLabels()).toEqual(["Rule 2: moved to 1"]);
    expect(screen.getByRole("status").textContent).toBe("Moved rule 2 to position 1.");
    // Focus follows the moved rule: at the top, onto its Move down.
    expect(document.activeElement).toBe(
      within(ruleRow(1)).getByRole("button", { name: "Move rule 1 down" }),
    );

    // Moving it back un-stages it.
    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Move rule 1 down" }));
    expect(saveBar()).toBeNull();

    await userEvent.click(within(ruleRow(3)).getByRole("button", { name: "Move rule 3 up" }));
    await userEvent.click(within(ruleRow(2)).getByRole("button", { name: "Move rule 2 up" }));
    expect(pendingLabels()).toEqual(["Rule 3: moved to 1"]);

    holdReads = true;
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveBar()).toBeNull());
    expect(summary(puts()[0]!)).toEqual([
      [API, []],
      [API, [{ field: "labels", operator: "containsAny", value: ["Backend"] }]],
      [WEB, [{ field: "team", operator: "=", value: "ENG" }]],
    ]);
    expect(ruleTexts()).toEqual(["Every issue", "Labels contains any of Backend", "Team is ENG"]);
  });

  it("edits a rule with a nested NOT and OR group, and removes a condition", async () => {
    renderRouting();
    await loaded();
    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Edit rule 1" }));
    const sheet = dialog();
    expect(within(sheet).getByRole("heading", { name: "Edit rule 1" })).toBeTruthy();
    await userEvent.click(within(sheet).getByRole("button", { name: "Group" }));
    // The new group: OR, negated, with one condition on the parent's team.
    await userEvent.selectOptions(
      within(sheet).getAllByRole("combobox", { name: "Match" })[1]!,
      "or",
    );
    const nots = within(sheet).getAllByRole("button", { name: "NOT" });
    await userEvent.click(nots[1]!);
    expect(
      within(sheet).getAllByRole("button", { name: "NOT" })[1]!.getAttribute("aria-pressed"),
    ).toBe("true");
    await userEvent.click(within(sheet).getAllByRole("button", { name: "Condition" })[1]!);
    await userEvent.selectOptions(
      within(sheet).getAllByRole("combobox", { name: "Field" })[1]!,
      "parent.team",
    );
    await userEvent.selectOptions(within(sheet).getByRole("combobox", { name: "Value" }), "ENG");
    // Remove the first condition (labels).
    await userEvent.click(within(sheet).getAllByRole("button", { name: "Remove condition" })[0]!);
    await userEvent.click(within(sheet).getByRole("button", { name: "Update rule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ruleTexts()[0]).toBe("(Parent › Team is ENG) is not true");
    expect(pendingLabels()).toEqual(["Rule 1: edited"]);
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.rules[0]!.query).toMatchObject({
      combinator: "and",
      rules: [
        {
          combinator: "or",
          not: true,
          rules: [{ field: "parent.team", operator: "=", value: "ENG" }],
        },
      ],
    });
  });

  it("edits a label set in a TokenInput, matching the workspace's names", async () => {
    renderRouting();
    await loaded();
    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Edit rule 1" }));
    // Suggests the workspace's labels: a text field with a list is a combobox.
    const values = within(dialog()).getByRole("combobox", { name: "Values" });
    await userEvent.type(values, "frontend{Enter}");
    await userEvent.click(within(dialog()).getByRole("button", { name: "Update rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ruleTexts()[0]).toBe("Labels contains any of Backend, Frontend");
  });

  it("closes the sheet on Cancel without staging anything", async () => {
    renderRouting();
    await loaded();
    await userEvent.click(within(ruleRow(2)).getByRole("button", { name: "Edit rule 2" }));
    await userEvent.selectOptions(within(dialog()).getByRole("combobox", { name: "Repo" }), API);
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(saveBar()).toBeNull();
    expect(within(ruleRow(2)).getByText("mcm/web")).toBeTruthy();
  });

  it("deletes a rule, and Discard brings it back", async () => {
    renderRouting();
    await loaded();
    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Delete rule 1" }));
    expect(ruleTexts()).toEqual(["Team is ENG"]);
    expect(pendingLabels()).toEqual(["Rule 1: deleted"]);
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Discard" }));
    expect(ruleTexts()).toEqual(["Labels contains any of Backend", "Team is ENG"]);

    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Delete rule 1" }));
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(summary(puts()[0]!)).toEqual([[WEB, [{ field: "team", operator: "=", value: "ENG" }]]]);
  });

  it("shows a value that isn't in the workspace any more with a warning, and still saves it", async () => {
    rules = [
      row("r1", 0, API, {
        id: "g1",
        combinator: "and",
        rules: [{ id: "c1", field: "labels", operator: "containsAny", value: ["Legacy"] }],
      }),
    ];
    renderRouting();
    await loaded();
    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Edit rule 1" }));
    expect(dialog().textContent).toContain("“Legacy” is not available.");
    expect(dialog().textContent).toContain("It's kept, and still saves.");
    await userEvent.selectOptions(within(dialog()).getByRole("combobox", { name: "Repo" }), WEB);
    await userEvent.click(within(dialog()).getByRole("button", { name: "Update rule" }));
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(summary(puts()[0]!)).toEqual([
      [WEB, [{ field: "labels", operator: "containsAny", value: ["Legacy"] }]],
    ]);
  });

  it("shows the server's field errors on the rule and condition they belong to", async () => {
    putAnswer = () =>
      jsonResponse(
        {
          error: "Check the highlighted fields.",
          fieldErrors: {
            "rules.0.repositoryId": "Pick one of your organization's repositories.",
            "rules.1.query.rules.0.value": "Pick a value.",
          },
        },
        400,
      );
    renderRouting();
    await loaded();
    // Something to save: retarget rule 2 at mcm/api.
    await userEvent.click(within(ruleRow(2)).getByRole("button", { name: "Edit rule 2" }));
    await userEvent.selectOptions(within(dialog()).getByRole("combobox", { name: "Repo" }), API);
    await userEvent.click(within(dialog()).getByRole("button", { name: "Update rule" }));
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(ruleRow(1)).getByRole("alert").textContent).toBe(
        "Pick one of your organization's repositories.",
      ),
    );
    expect(within(ruleRow(2)).getByRole("alert").textContent).toBe("Pick a value.");
    expect(ruleRow(1).getAttribute("data-invalid")).toBe("true");
    expect(within(card()).getByText("2 rules need attention.")).toBeTruthy();
    expect(within(saveBar()!).getByText("Check the highlighted fields.")).toBeTruthy();
    // The rule's sheet shows its condition's error where it belongs.
    await userEvent.click(within(ruleRow(2)).getByRole("button", { name: "Edit rule 2" }));
    expect(within(dialog()).getByRole("alert").textContent).toBe("Pick a value.");
  });

  it("checks a rule before staging it: one without a repo isn't added, and nothing is sent", async () => {
    rules = [];
    renderRouting();
    await loaded();
    await userEvent.click(within(card()).getByRole("button", { name: "Add rule" }));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Add rule" }));
    expect(within(dialog()).getByText("Pick a repository.")).toBeTruthy();
    await userEvent.selectOptions(within(dialog()).getByRole("combobox", { name: "Repo" }), API);
    expect(within(dialog()).queryByText("Pick a repository.")).toBeNull();
    await userEvent.click(within(dialog()).getByRole("button", { name: "Condition" }));
    await userEvent.selectOptions(
      within(dialog()).getByRole("combobox", { name: "Field" }),
      "team",
    );
    await userEvent.click(within(dialog()).getByRole("button", { name: "Add rule" }));
    expect(within(dialog()).getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(puts()).toEqual([]);
  });

  it("shows members the list without editing controls", async () => {
    renderRouting({ user: member });
    await loaded();
    expect(ruleTexts()).toEqual(["Labels contains any of Backend", "Team is ENG"]);
    expect(
      within(card())
        .queryAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["Change history"]);
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move rule|Edit rule|Delete rule/ })).toBeNull();
    expect(saveBar()).toBeNull();
    // Still shows what the rules do.
    expect(ruleRow(2).textContent).toContain("Coding is off for mcm/web");
    expect(screen.getAllByRole("listitem", { name: /^Default rule/ })).toHaveLength(3);
  });

  it("opens the routing rules' history from the card's ⓘ", async () => {
    renderRouting();
    await loaded();
    await userEvent.click(within(card()).getByRole("button", { name: "Change history" }));
    expect(await screen.findByText(/^Last changed by Grace, .*, 2 runs since$/)).toBeTruthy();
    const history = seen.find((r) => r.path === "/api/ui/settings-history");
    expect(history!.query.get("section")).toBe("routing_rules");
  });

  it("stacks each rule's actions under it at 768 px and narrower", () => {
    const css = readFileSync(path.resolve(__dirname, "routing.css"), "utf8");
    const phone = /@media \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(phone).toMatch(/\.or-routing__rule \{\s*grid-template-columns: 24px minmax\(0, 1fr\);/);
    expect(phone).toMatch(/\.or-routing__actions \{\s*grid-column: 2;/);
  });
});

describe("live updates", () => {
  const connected = (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${organizationId}:changes`));
  const deliver = (live: ReturnType<typeof fakeAbly>, organizationId: string) =>
    act(() =>
      live.current().deliver(
        `org:${organizationId}:changes`,
        changeEvent(organizationId, {
          resource: "settings",
          ids: [organizationId],
          section: "routing_rules",
        }),
      ),
    );
  /** Another admin saves: the team rule only, now first. */
  const theirSave = () => {
    rules = [row("theirs", 0, WEB, teamRule.query)];
  };

  it("shows another admin's save", async () => {
    const live = fakeAbly();
    renderRouting({ live });
    await loaded();
    await connected(live, TEST_ORGANIZATION_ID);
    theirSave();
    deliver(live, TEST_ORGANIZATION_ID);
    await waitFor(() => expect(ruleTexts()).toEqual(["Team is ENG"]));
    expect(saveBar()).toBeNull();
  });

  it("says when someone else changed the rules under staged changes, and keeps editing on request", async () => {
    const live = fakeAbly();
    renderRouting({ live });
    await loaded();
    await connected(live, TEST_ORGANIZATION_ID);
    await userEvent.click(within(ruleRow(2)).getByRole("button", { name: "Move rule 2 up" }));
    theirSave();
    deliver(live, TEST_ORGANIZATION_ID);
    await waitFor(() =>
      expect(within(saveBar()!).getByRole("alert").textContent).toBe(ROUTING_RULES_CONFLICT),
    );
    expect(within(saveBar()!).queryByRole("button", { name: "Save" })).toBeNull();
    // The user's draft stays until they choose.
    expect(ruleTexts()).toEqual(["Team is ENG", "Labels contains any of Backend"]);

    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Keep editing" }));
    expect(within(saveBar()!).queryByText(ROUTING_RULES_CONFLICT)).toBeNull();
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
  });

  it("takes the other admin's rules on Discard", async () => {
    const live = fakeAbly();
    renderRouting({ live });
    await loaded();
    await connected(live, TEST_ORGANIZATION_ID);
    await userEvent.click(within(ruleRow(2)).getByRole("button", { name: "Move rule 2 up" }));
    theirSave();
    deliver(live, TEST_ORGANIZATION_ID);
    await waitFor(() => expect(within(saveBar()!).getByText(ROUTING_RULES_CONFLICT)).toBeTruthy());
    await userEvent.click(within(saveBar()!).getByRole("button", { name: "Discard" }));
    expect(ruleTexts()).toEqual(["Team is ENG"]);
    expect(saveBar()).toBeNull();
    expect(puts()).toEqual([]);
  });

  it("ignores another organization's events", async () => {
    const live = fakeAbly();
    renderRouting({
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
    await loaded();
    await connected(live, BETA_ID);
    const before = reads().length;
    deliver(live, BETA_ID);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toHaveLength(before);
  });
});
