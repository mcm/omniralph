import { describe, expect, it } from "vitest";
import type { RuleGroupType } from "react-querybuilder";
import { LINEAR_ROUTING_FIELDS } from "@/lib/tracker/linear/routing-fields";
import {
  coerceValue,
  draftsOf,
  findOption,
  moveRule,
  normalizeQuery,
  placeErrors,
  ruleChanges,
  rulesDiffer,
  validateDrafts,
  valueOptions,
  type DraftRule,
  type RoutingFieldData,
  type RoutingLinear,
} from "./rule-editor";

const fields = LINEAR_ROUTING_FIELDS as unknown as RoutingFieldData[];
const byId = new Map(fields.map((field) => [field.id, field]));
const API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WEB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const connected: RoutingLinear = {
  status: "connected",
  options: {
    teams: [{ key: "ENG", name: "Engineering" }],
    labels: ["Backend"],
    projects: [],
    states: [],
    projectMilestones: [],
    cycles: [{ id: "c1", number: 4, name: null, teamKey: "ENG" }],
    users: [{ id: "u1", name: "Ada" }],
  },
};

function draft(query: RuleGroupType, repositoryId = API, key = "k"): DraftRule {
  return { key, repositoryId, query };
}

describe("moveRule", () => {
  it("moves one rule and keeps the rest in order", () => {
    expect(moveRule(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveRule(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveRule(["a", "b"], 1, 5)).toEqual(["a", "b"]);
  });
});

describe("rulesDiffer", () => {
  it("ignores the builder's IDs and value sources, but not order, targets or values", () => {
    const saved = draftsOf([
      {
        id: "r1",
        position: 0,
        repositoryId: API,
        query: { combinator: "and", rules: [{ field: "title", operator: "=", value: "x" }] },
        updatedAt: "2026-10-17T10:00:00.000Z",
      },
    ]);
    const same = [
      draft({
        id: "other",
        combinator: "and",
        rules: [{ id: "c", field: "title", operator: "=", value: "x", valueSource: "value" }],
      }),
    ];
    expect(rulesDiffer(same, saved)).toBe(false);
    expect(rulesDiffer([{ ...same[0]!, repositoryId: "other" }], saved)).toBe(true);
    expect(
      rulesDiffer([draft({ combinator: "and", not: true, rules: same[0]!.query.rules })], saved),
    ).toBe(true);
  });

  it("doesn't list anything without a difference", () => {
    const a = draft({ combinator: "and", rules: [] }, API, "a");
    expect(ruleChanges([a], [a], fields, repositories)).toEqual([]);
  });
});

const repositories = [
  { id: API, provider: "github" as const, fullPath: "mcm/api", codingEnabled: true },
  { id: WEB, provider: "gitlab" as const, fullPath: "mcm/web", codingEnabled: true },
];

describe("ruleChanges", () => {
  const title = (value: string, key: string, repositoryId = API) =>
    draft(
      { combinator: "and", rules: [{ field: "title", operator: "=", value }] },
      repositoryId,
      key,
    );
  const a = title("a", "a");
  const b = title("b", "b");
  const c = title("c", "c");
  const labels = (list: ReturnType<typeof ruleChanges>) => list.map((change) => change.label);

  it("lists an added rule by its new number, with what it does", () => {
    const added = title("docs", "new-1", WEB);
    expect(ruleChanges([a, b, added], [a, b], fields, repositories)).toEqual([
      {
        id: "add-new-1",
        label: "Rule 3: added",
        to: "Title equals docs → mcm/web",
        effect: "Work items it matches go to mcm/web.",
      },
    ]);
  });

  it("lists only the rule that moved, not the ones it shifted", () => {
    expect(labels(ruleChanges([b, a, c], [a, b, c], fields, repositories))).toEqual([
      "Rule 2: moved to 1",
    ]);
    expect(labels(ruleChanges([b, c, a], [a, b, c], fields, repositories))).toEqual([
      "Rule 1: moved to 3",
    ]);
    const [moved] = ruleChanges([b, a, c], [a, b, c], fields, repositories);
    expect(moved!.effect).toBe("It's checked before the rules it moved above.");
  });

  it("lists an edited rule from its old to its new summary, and a deleted one", () => {
    const edited = { ...b, repositoryId: WEB };
    expect(ruleChanges([edited, c], [a, b, c], fields, repositories)).toEqual([
      {
        id: "edit-b",
        label: "Rule 2: edited",
        from: "Title equals b → mcm/api",
        to: "Title equals b → mcm/web",
        effect: "Work items it matches go to mcm/web.",
      },
      {
        id: "delete-a",
        label: "Rule 1: deleted",
        from: "Title equals a → mcm/api",
        effect: "Work items it matched go on to the next rule.",
      },
    ]);
  });

  it("describes a rule without conditions or a repository", () => {
    const empty = draft({ combinator: "and", rules: [] }, "", "new-2");
    expect(ruleChanges([empty], [], fields, repositories)[0]!.to).toBe("Every issue → no repo");
  });
});

describe("coerceValue", () => {
  it("shapes the value for the operator, keeping what carries over", () => {
    expect(coerceValue("options", "Backend")).toEqual(["Backend"]);
    expect(coerceValue("option", ["Backend", "Api"])).toBe("Backend");
    expect(coerceValue("none", "x")).toBeNull();
    expect(coerceValue("number", "3")).toBe(3);
    expect(coerceValue("number", "")).toBeNull();
    expect(coerceValue("number-range", 2)).toEqual([2, null]);
    expect(coerceValue("date-range", "2026-01-01")).toEqual(["2026-01-01", ""]);
  });

  it("normalizes a query's conditions in place, nested groups too", () => {
    const query: RuleGroupType = {
      combinator: "and",
      rules: [
        { field: "labels", operator: "containsAny", value: "Backend" },
        {
          combinator: "or",
          rules: [{ field: "estimate", operator: "null", value: "" }],
        },
      ],
    };
    expect(normalizeQuery(query, byId)).toEqual({
      combinator: "and",
      rules: [
        { field: "labels", operator: "containsAny", value: ["Backend"] },
        { combinator: "or", rules: [{ field: "estimate", operator: "null", value: null }] },
      ],
    });
    const clean = normalizeQuery(query, byId);
    expect(normalizeQuery(clean, byId)).toBe(clean);
  });
});

describe("valueOptions", () => {
  it("offers fixed values, or the connected workspace's", () => {
    expect(valueOptions(byId.get("priority"), connected)?.[1]).toEqual({
      value: "1",
      label: "Urgent",
    });
    expect(valueOptions(byId.get("parent.team"), connected)).toEqual([
      { value: "ENG", label: "ENG · Engineering" },
    ]);
    expect(valueOptions(byId.get("cycle"), connected)).toEqual([
      { value: "c1", label: "ENG · Cycle 4" },
    ]);
    expect(valueOptions(byId.get("assignee"), connected)).toEqual([{ value: "u1", label: "Ada" }]);
  });

  it("has none for typed values, or without a connected workspace", () => {
    expect(valueOptions(byId.get("title"), connected)).toBeNull();
    expect(valueOptions(byId.get("parent"), connected)).toBeNull();
    expect(valueOptions(byId.get("labels"), { status: "disconnected" })).toBeNull();
    expect(valueOptions(byId.get("stateType"), { status: "unavailable" })).not.toBeNull();
  });

  it("finds names ignoring case", () => {
    expect(findOption([{ value: "Backend", label: "Backend" }], "backend")?.value).toBe("Backend");
    expect(findOption([{ value: "Backend", label: "Backend" }], "api")).toBeUndefined();
  });
});

describe("placeErrors", () => {
  it("puts each error on its rule and the condition's builder path", () => {
    const placed = placeErrors({
      "rules.0.repositoryId": "Pick a repository.",
      "rules.1.query.rules.2.value": "Pick a value.",
      "rules.1.query.rules.0.rules.1.operator": "Pick an operator for this field.",
      "rules.1.query.rules.0.rules": "Add a condition to this group, or remove it.",
      "rules.2.query.rules": "A rule can have at most 50 conditions.",
      rules: "There can be at most 100 rules.",
    });
    expect(placed.rules.get(0)).toEqual({ nodes: new Map(), repository: "Pick a repository." });
    expect(placed.rules.get(1)?.nodes).toEqual(
      new Map([
        ["2", "Pick a value."],
        ["0.1", "Pick an operator for this field."],
        ["0", "Add a condition to this group, or remove it."],
      ]),
    );
    expect(placed.rules.get(2)?.nodes).toEqual(
      new Map([["", "A rule can have at most 50 conditions."]]),
    );
    expect(placed.list).toEqual(["There can be at most 100 rules."]);
  });
});

describe("validateDrafts", () => {
  it("checks the draft against the catalog the way PUT does", () => {
    expect(
      validateDrafts(
        [draft({ combinator: "and", rules: [{ field: "title", operator: "=", value: "x" }] })],
        fields,
      ),
    ).toBeNull();
    const errors = validateDrafts(
      [
        draft(
          { combinator: "and", rules: [{ field: "title", operator: "matches", value: "(" }] },
          "",
        ),
      ],
      fields,
    );
    expect(errors?.rules.get(0)).toEqual({
      repository: "Pick a repository.",
      nodes: new Map([["0", "This isn't a valid regular expression."]]),
    });
  });
});
