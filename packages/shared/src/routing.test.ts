import { describe, expect, it } from "vitest";
import {
  MAX_ROUTING_CONDITIONS,
  MAX_ROUTING_RULES,
  ROUTING_OPERATORS,
  routingQuerySchema,
  routingRulesSchema,
  type RoutingFieldSpec,
} from "./routing.js";
import { fieldErrors } from "./settings.js";

const FIELDS: RoutingFieldSpec[] = [
  { id: "title", type: "text" },
  { id: "team", type: "one-of" },
  { id: "priority", type: "one-of", values: ["0", "1", "2", "3", "4"] },
  { id: "labels", type: "many-of" },
  { id: "estimate", type: "number" },
  { id: "dueDate", type: "date" },
  { id: "parent.labels", type: "many-of" },
];

const schema = routingQuerySchema(FIELDS);

const group = (...rules: unknown[]) => ({ combinator: "and", rules });
const condition = (field: string, operator: string, value?: unknown) => ({
  field,
  operator,
  value,
});

/** The field errors of parsing `query`, or `{}` when it parses. */
function errors(query: unknown): Record<string, string> {
  const result = schema.safeParse(query);
  return result.success ? {} : fieldErrors(result.error);
}

/** A group nested `depth` deep (the outer group is depth 1), with one condition inside. */
function nested(depth: number): unknown {
  let query: unknown = group(condition("title", "=", "x"));
  for (let i = 1; i < depth; i += 1) query = group(query);
  return query;
}

describe("routingQuerySchema", () => {
  it("accepts every operator of every type with a value it takes", () => {
    const values: Record<string, unknown> = {
      text: "backend",
      "one-of": "ENG",
      "many-of": ["backend"],
      number: 3,
      date: "2026-10-17",
    };
    const fieldOf = {
      text: "title",
      "one-of": "team",
      "many-of": "labels",
      number: "estimate",
      date: "dueDate",
    };
    for (const [type, operators] of Object.entries(ROUTING_OPERATORS)) {
      for (const { name } of operators) {
        let value = values[type];
        if (name === "null" || name === "notNull") value = null;
        else if (name === "in" || name === "notIn") value = ["ENG", "DES"];
        else if (name === "between")
          value = type === "number" ? [1, 5] : ["2026-01-01", "2026-12-31"];
        else if (name === "matches") value = "^back(end)?$";
        const field = fieldOf[type as keyof typeof fieldOf];
        expect(errors(group(condition(field, name, value))), `${type} ${name}`).toEqual({});
      }
    }
  });

  it("keeps nesting, NOT and the builder's IDs, and drops unknown keys", () => {
    expect(
      schema.parse({
        id: "g1",
        combinator: "or",
        not: false,
        extra: 1,
        rules: [
          { id: "r1", ...condition("labels", "containsAny", ["backend"]), valueSource: "value" },
          { combinator: "and", not: true, rules: [condition("team", "null", "")] },
        ],
      }),
    ).toEqual({
      id: "g1",
      combinator: "or",
      rules: [
        { id: "r1", field: "labels", operator: "containsAny", value: ["backend"] },
        { combinator: "and", not: true, rules: [{ field: "team", operator: "null", value: null }] },
      ],
    });
  });

  it("accepts an empty rule (it matches every issue)", () => {
    expect(errors(group())).toEqual({});
  });

  it("rejects a field outside the catalog", () => {
    expect(errors(group(condition("milestone", "=", "x")))).toEqual({
      "rules.0.field": "Pick a field.",
    });
  });

  it("rejects an operator the field's type doesn't take", () => {
    expect(errors(group(condition("labels", "=", "backend")))).toEqual({
      "rules.0.operator": "Pick an operator for this field.",
    });
    expect(errors(group(condition("title", "containsAny", ["x"])))).toEqual({
      "rules.0.operator": "Pick an operator for this field.",
    });
  });

  it("rejects a value the operator doesn't take", () => {
    const cases: Array<[unknown, string]> = [
      [condition("title", "=", 3), "Enter text of at most 1000 characters."],
      [condition("title", "contains", "x".repeat(1001)), "Enter text of at most 1000 characters."],
      [condition("team", "=", ""), "Pick a value."],
      [condition("team", "=", ["ENG"]), "Pick a value."],
      [condition("priority", "=", "7"), "Pick a value."],
      [condition("priority", "in", ["1", "9"]), "Pick at least one value."],
      [condition("team", "in", []), "Pick at least one value."],
      [condition("labels", "containsAll", "backend"), "Pick at least one value."],
      [condition("estimate", "<", "3"), "Enter a number."],
      [condition("estimate", "between", [5, 1]), "Enter two numbers, the smaller first."],
      [condition("estimate", "between", [1]), "Enter two numbers, the smaller first."],
      [condition("dueDate", "=", "2026-02-30"), "Enter a date (YYYY-MM-DD)."],
      [condition("dueDate", ">", "tomorrow"), "Enter a date (YYYY-MM-DD)."],
      [
        condition("dueDate", "between", ["2026-12-31", "2026-01-01"]),
        "Enter two dates (YYYY-MM-DD), the earlier first.",
      ],
      [condition("labels", "null", ["x"]), "This operator takes no value."],
    ];
    for (const [rule, message] of cases) {
      expect(errors(group(rule)), JSON.stringify(rule)).toEqual({ "rules.0.value": message });
    }
  });

  it("rejects a regex that doesn't compile or is longer than 200 characters", () => {
    expect(errors(group(condition("title", "matches", "(unclosed")))).toEqual({
      "rules.0.value": "This isn't a valid regular expression.",
    });
    expect(errors(group(condition("title", "matches", "a".repeat(201))))).toEqual({
      "rules.0.value": "Regular expressions can be at most 200 characters.",
    });
    expect(errors(group(condition("title", "matches", "a".repeat(200))))).toEqual({});
    expect(errors(group(condition("title", "matches", "")))).toEqual({
      "rules.0.value": "Enter a regular expression.",
    });
  });

  it("rejects more than 50 conditions, counted at every depth", () => {
    const many = (n: number) => Array.from({ length: n }, () => condition("title", "=", "x"));
    expect(
      errors(group(...many(MAX_ROUTING_CONDITIONS - 1), group(condition("title", "=", "y")))),
    ).toEqual({});
    expect(
      errors(group(...many(MAX_ROUTING_CONDITIONS), group(condition("title", "=", "y")))),
    ).toEqual({
      rules: "A rule can have at most 50 conditions.",
    });
  });

  it("rejects groups nested more than 5 deep", () => {
    expect(errors(nested(5))).toEqual({});
    expect(errors(nested(6))).toEqual({
      "rules.0.rules.0.rules.0.rules.0.rules.0": "Groups can be nested at most 5 deep.",
    });
  });

  it("rejects malformed groups and conditions at their path", () => {
    expect(errors({ combinator: "xor", rules: [group()] })).toEqual({
      combinator: "Pick AND or OR.",
      "rules.0.rules": "Add a condition to this group, or remove it.",
    });
    expect(errors({ combinator: "and", not: "yes", rules: ["title"] })).toEqual({
      not: "Invalid NOT.",
      "rules.0": "Invalid condition.",
    });
    expect(errors({ combinator: "and" })).toEqual({ form: "Invalid condition group." });
    expect(errors(group({ ...condition("title", "=", "x"), valueSource: "field" }))).toEqual({
      "rules.0.valueSource": "Conditions compare with a value.",
    });
  });
});

describe("routingRulesSchema", () => {
  const rules = routingRulesSchema(FIELDS);
  const rule = { repositoryId: "00000000-0000-4000-8000-000000000001", query: group() };

  it("takes up to 100 rules", () => {
    expect(rules.safeParse({ rules: Array(MAX_ROUTING_RULES).fill(rule) }).success).toBe(true);
    const result = rules.safeParse({ rules: Array(MAX_ROUTING_RULES + 1).fill(rule) });
    expect(result.success ? {} : fieldErrors(result.error)).toEqual({
      rules: "There can be at most 100 rules.",
    });
  });

  it("puts errors under the rule's index", () => {
    const result = rules.safeParse({
      rules: [rule, { repositoryId: "nope", query: group(condition("labels", "=", "x")) }],
    });
    expect(result.success ? {} : fieldErrors(result.error)).toEqual({
      "rules.1.repositoryId": "Pick a repository.",
      "rules.1.query.rules.0.operator": "Pick an operator for this field.",
    });
  });
});
