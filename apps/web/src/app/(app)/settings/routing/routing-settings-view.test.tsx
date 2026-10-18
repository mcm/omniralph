// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as UI from "@iamthemcmaster/ui";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { RoutingRuleRow, RoutingRules } from "@/lib/api/routing-rules";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import { DEFAULT_RULES, RoutingSettingsView } from "./routing-settings-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toast = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@iamthemcmaster/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof UI>()),
  notify: toast.notify,
}));

const API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WEB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
      { id: API, fullPath: "mcm/api", codingEnabled: true },
      { id: WEB, fullPath: "mcm/web", codingEnabled: false },
    ],
  };
}

/** Serves `rules` on GET; PUT saves them (or answers `putAnswer`). */
function serve(
  initial: RoutingRuleRow[],
  putAnswer?: (request: SeenRequest) => Response,
): SeenRequest[] {
  let rules = initial;
  return mockFetch({
    "GET /api/ui/routing-rules": () => jsonResponse(routing(rules)),
    "PUT /api/ui/routing-rules": (request) => {
      if (putAnswer) return putAnswer(request);
      const body = request.body as { rules: { repositoryId: string; query: unknown }[] };
      rules = body.rules.map((rule, i) =>
        row(`saved-${i}`, i, rule.repositoryId, rule.query as RoutingRuleRow["query"]),
      );
      return jsonResponse({ ok: true, rules });
    },
  });
}

function renderView(user = testUser) {
  return render(<RoutingSettingsView />, {
    wrapper: queryWrapper(createTestQueryClient(), user),
  });
}

const list = () => screen.getByRole("list", { name: "Routing rules" });
const rows = () => within(list()).getAllByRole("listitem", { name: /rule/i });
const ruleRow = (number: number) => screen.getByRole("listitem", { name: `Rule ${number}` });
const putBodies = (seen: SeenRequest[]) =>
  seen.filter((r) => r.method === "PUT").map((r) => r.body as { rules: unknown[] });

/** A saved rule's target and conditions, as `PUT` got them. */
function summary(body: { rules: unknown[] }) {
  return (
    body.rules as {
      repositoryId: string;
      query: { rules: { field: string; operator: string; value: unknown }[] };
    }[]
  ).map((rule) => [
    rule.repositoryId,
    rule.query.rules.map(({ field, operator, value }) => ({ field, operator, value })),
  ]);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  toast.notify.mockReset();
});

describe("RoutingSettingsView", () => {
  it("lists the rules in order, then the three default rules, read-only", async () => {
    serve([teamRule, labelsRule]);
    renderView();
    await screen.findByRole("listitem", { name: "Rule 1" });
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Rule 1",
      "Rule 2",
      ...DEFAULT_RULES.map((label) => `Default rule: ${label}`),
    ]);
    expect(DEFAULT_RULES).toEqual([
      "Follow-up → route as source issue",
      "Sub-issue → route as parent",
      "Ask which repository to use",
    ]);
    // Saved in position order: the labels rule is first.
    expect(
      (within(ruleRow(1)).getByRole("combobox", { name: "Rule 1 repository" }) as HTMLSelectElement)
        .value,
    ).toBe(API);
    expect(within(ruleRow(1)).getByText("Backend")).toBeTruthy();
    for (const label of DEFAULT_RULES) {
      const fixed = screen.getByRole("listitem", { name: `Default rule: ${label}` });
      expect(within(fixed).queryAllByRole("button")).toEqual([]);
      expect(within(fixed).queryAllByRole("combobox")).toEqual([]);
      expect(within(fixed).getByText(label)).toBeTruthy();
    }
  });

  it("shows the coding-off badge on a rule targeting a repository with coding off", async () => {
    serve([labelsRule, teamRule]);
    renderView();
    await screen.findByRole("listitem", { name: "Rule 2" });
    expect(ruleRow(2).textContent).toContain(
      "Coding is off for mcm/web: matching issues are treated as manual.",
    );
    expect(ruleRow(1).textContent).not.toContain("Coding is off");

    // Retargeting rule 1 at mcm/web shows it there too.
    await userEvent.selectOptions(
      within(ruleRow(1)).getByRole("combobox", { name: "Rule 1 repository" }),
      WEB,
    );
    expect(ruleRow(1).textContent).toContain("Coding is off for mcm/web");
  });

  it("adds a rule above the default rules and saves the whole list", async () => {
    const seen = serve([labelsRule]);
    renderView();
    await screen.findByRole("listitem", { name: "Rule 1" });
    const save = screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(
      rows()
        .map((r) => r.getAttribute("aria-label"))
        .slice(0, 3),
    ).toEqual(["Rule 1", "Rule 2", `Default rule: ${DEFAULT_RULES[0]}`]);
    const added = ruleRow(2);
    expect(added.textContent).toContain("No conditions: this rule matches every issue.");
    await userEvent.selectOptions(
      within(added).getByRole("combobox", { name: "Rule 2 repository" }),
      WEB,
    );
    await userEvent.click(within(added).getByRole("button", { name: "Condition" }));
    await userEvent.selectOptions(
      within(ruleRow(2)).getByRole("combobox", { name: "Field" }),
      "title",
    );
    await userEvent.selectOptions(
      within(ruleRow(2)).getByRole("combobox", { name: "Operator" }),
      "contains",
    );
    await userEvent.type(within(ruleRow(2)).getByRole("textbox", { name: "Value" }), "docs");

    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(toast.notify).toHaveBeenCalledWith("Saved the routing rules"));
    const [body] = putBodies(seen);
    expect(summary(body!)).toEqual([
      [API, [{ field: "labels", operator: "containsAny", value: ["Backend"] }]],
      [WEB, [{ field: "title", operator: "contains", value: "docs" }]],
    ]);
    // Saved: clean again.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });

  it("reorders rules by dragging and by keyboard, never below the default rules", async () => {
    const third = row("r3", 2, API, { id: "g3", combinator: "or", rules: [] });
    const seen = serve([labelsRule, teamRule, third]);
    renderView();
    await screen.findByRole("listitem", { name: "Rule 3" });

    // Drag rule 2 (team) onto rule 1.
    const handle = within(ruleRow(2)).getByRole("button", { name: "Move rule 2" });
    fireEvent.dragStart(handle);
    fireEvent.dragOver(ruleRow(1));
    fireEvent.drop(ruleRow(1));
    expect(within(ruleRow(1)).getByRole("combobox", { name: "Rule 1 repository" })).toHaveProperty(
      "value",
      WEB,
    );

    // The default rows aren't drop targets: dropping there moves nothing.
    fireEvent.dragStart(within(ruleRow(1)).getByRole("button", { name: "Move rule 1" }));
    fireEvent.drop(screen.getByRole("listitem", { name: `Default rule: ${DEFAULT_RULES[2]}` }));
    fireEvent.dragEnd(within(ruleRow(1)).getByRole("button", { name: "Move rule 1" }));
    expect(within(ruleRow(1)).getByRole("combobox", { name: "Rule 1 repository" })).toHaveProperty(
      "value",
      WEB,
    );

    // Arrow keys: rule 3 (empty) up to position 2, and the last rule can't go further down.
    const moveThird = within(ruleRow(3)).getByRole("button", { name: "Move rule 3" });
    moveThird.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(ruleRow(2).textContent).toContain("No conditions");
    expect(screen.getByText("Moved rule 3 to position 2.")).toBeTruthy();
    const moveLast = within(ruleRow(3)).getByRole("button", { name: "Move rule 3" });
    moveLast.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(rows()[3]!.getAttribute("aria-label")).toBe(`Default rule: ${DEFAULT_RULES[0]}`);

    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(putBodies(seen)).toHaveLength(1));
    expect(summary(putBodies(seen)[0]!)).toEqual([
      [WEB, [{ field: "team", operator: "=", value: "ENG" }]],
      [API, []],
      [API, [{ field: "labels", operator: "containsAny", value: ["Backend"] }]],
    ]);
  });

  it("builds nested groups with NOT and OR, and removes conditions", async () => {
    const seen = serve([labelsRule]);
    renderView();
    await screen.findByRole("listitem", { name: "Rule 1" });
    const rule = () => ruleRow(1);
    await userEvent.click(within(rule()).getAllByRole("button", { name: "Group" })[0]!);
    // The new group: OR, negated, with one condition on the parent's team.
    const matches = within(rule()).getAllByRole("combobox", { name: "Match" });
    await userEvent.selectOptions(matches[1]!, "or");
    await userEvent.click(within(rule()).getAllByRole("button", { name: "NOT" })[1]!);
    await userEvent.click(within(rule()).getAllByRole("button", { name: "Condition" })[1]!);
    const fieldSelects = within(rule()).getAllByRole("combobox", { name: "Field" });
    await userEvent.selectOptions(fieldSelects[1]!, "parent.team");
    await userEvent.selectOptions(
      within(rule()).getAllByRole("combobox", { name: "Value" })[0]!,
      "ENG",
    );
    // Remove the first condition (labels).
    await userEvent.click(within(rule()).getAllByRole("button", { name: "Remove condition" })[0]!);

    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(putBodies(seen)).toHaveLength(1));
    const [saved] = putBodies(seen)[0]!.rules as { query: unknown }[];
    expect(saved!.query).toMatchObject({
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

  it("deletes a rule, and Discard brings it back", async () => {
    const seen = serve([labelsRule, teamRule]);
    renderView();
    await screen.findByRole("listitem", { name: "Rule 2" });

    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Delete rule 1" }));
    expect(screen.queryByRole("listitem", { name: "Rule 2" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("listitem", { name: "Rule 2" })).toBeTruthy();

    await userEvent.click(within(ruleRow(1)).getByRole("button", { name: "Delete rule 1" }));
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(putBodies(seen)).toHaveLength(1));
    expect(summary(putBodies(seen)[0]!)).toEqual([
      [WEB, [{ field: "team", operator: "=", value: "ENG" }]],
    ]);
  });

  it("shows a value that isn't in the workspace any more with a warning, and still saves it", async () => {
    const gone = row("r1", 0, API, {
      id: "g1",
      combinator: "and",
      rules: [{ id: "c1", field: "labels", operator: "containsAny", value: ["Legacy"] }],
    });
    const seen = serve([gone]);
    renderView();
    await screen.findByRole("listitem", { name: "Rule 1" });
    expect(ruleRow(1).textContent).toContain("“Legacy” is not available.");
    expect(ruleRow(1).textContent).toContain("It's kept, and still saves.");

    await userEvent.selectOptions(
      within(ruleRow(1)).getByRole("combobox", { name: "Rule 1 repository" }),
      WEB,
    );
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(putBodies(seen)).toHaveLength(1));
    expect(summary(putBodies(seen)[0]!)).toEqual([
      [WEB, [{ field: "labels", operator: "containsAny", value: ["Legacy"] }]],
    ]);
  });

  it("shows the server's field errors on the rule and condition they belong to", async () => {
    serve([labelsRule, teamRule], () =>
      jsonResponse(
        {
          error: "Check the highlighted fields.",
          fieldErrors: {
            "rules.0.repositoryId": "Pick one of your organization's repositories.",
            "rules.1.query.rules.0.value": "Pick a value.",
          },
        },
        400,
      ),
    );
    renderView();
    await screen.findByRole("listitem", { name: "Rule 2" });
    await userEvent.selectOptions(
      within(ruleRow(2)).getByRole("combobox", { name: "Rule 2 repository" }),
      API,
    );
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() =>
      expect(within(ruleRow(1)).getByRole("alert").textContent).toBe(
        "Pick one of your organization's repositories.",
      ),
    );
    expect(within(ruleRow(2)).getByRole("alert").textContent).toBe("Pick a value.");
    expect(ruleRow(1).getAttribute("data-invalid")).toBe("true");
    expect(screen.getByText(/2 rules need attention/)).toBeTruthy();
    expect(toast.notify).toHaveBeenCalledWith("Check the highlighted fields.", {
      variant: "danger",
    });
  });

  it("checks the rules before saving: a rule without a repository isn't sent", async () => {
    const seen = serve([]);
    renderView();
    await screen.findByRole("list", { name: "Routing rules" });
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(within(ruleRow(1)).getByRole("alert").textContent).toBe("Pick a repository.");
    expect(putBodies(seen)).toEqual([]);
  });

  it("is read-only for members who aren't admins", async () => {
    serve([labelsRule, teamRule]);
    renderView({ ...testUser, role: "member" });
    await screen.findByRole("listitem", { name: "Rule 2" });
    expect(screen.getByText(/Only admins can change the rules/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move rule/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete rule/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Condition" })).toBeNull();
    for (const select of within(ruleRow(2)).getAllByRole("combobox")) {
      expect((select as HTMLSelectElement).disabled).toBe(true);
    }
    // Still shows what the rules do.
    expect(ruleRow(2).textContent).toContain("Coding is off for mcm/web");
    expect(rows()).toHaveLength(5);
  });
});
