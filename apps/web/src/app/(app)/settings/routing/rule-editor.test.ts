import { describe, expect, it } from "vitest";
import type { RuleGroupType } from "react-querybuilder";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
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

  it("lists the changed rules", () => {
    const a = draft({ combinator: "and", rules: [] });
    const b = draft({ combinator: "and", rules: [{ field: "title", operator: "=", value: "x" }] });
    const repositories = [{ id: API, fullPath: "mcm/api", codingEnabled: true }];
    expect(ruleChanges([a, b], [a], fields, repositories)).toEqual([
      { key: "rule-1", label: "Rule 2", from: "Not set", to: "Title equals x → mcm/api" },
    ]);
    expect(ruleChanges([a], [a], fields, repositories)).toEqual([]);
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
