import type { RoutingCondition, RoutingGroup } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { LINEAR_ROUTING_FIELD_TYPES } from "@/lib/tracker/linear/routing-fields";
import { evaluateCondition, evaluateQuery, type RoutingFieldValues } from "./evaluate";

const values: RoutingFieldValues = {
  identifier: "ENG-12",
  title: "Fix the Login page",
  description: "",
  team: "ENG",
  project: "Control Panel",
  projectMilestone: null,
  cycle: "cycle-1",
  state: "In Progress",
  stateType: "started",
  priority: "2",
  assignee: "user-1",
  creator: null,
  parent: "ENG-10",
  labels: ["Backend", "api"],
  estimate: 3,
  dueDate: "2026-11-15",
  "parent.labels": ["epic"],
  "parent.team": "OPS",
  "source.team": null,
  "source.labels": [],
};

const holds = (field: string, operator: string, value: RoutingCondition["value"] = null) =>
  evaluateCondition({ field, operator, value }, values, LINEAR_ROUTING_FIELD_TYPES);

describe("evaluateCondition", () => {
  it("text: equals, does not equal, contains, begins and ends with, ignoring case", () => {
    expect(holds("title", "=", "fix the login page")).toBe(true);
    expect(holds("title", "=", "Fix")).toBe(false);
    expect(holds("title", "!=", "Fix")).toBe(true);
    expect(holds("title", "!=", "FIX THE LOGIN PAGE")).toBe(false);
    expect(holds("title", "contains", "LOGIN")).toBe(true);
    expect(holds("title", "contains", "logout")).toBe(false);
    expect(holds("title", "doesNotContain", "logout")).toBe(true);
    expect(holds("title", "doesNotContain", "login")).toBe(false);
    expect(holds("title", "beginsWith", "fix")).toBe(true);
    expect(holds("title", "beginsWith", "login")).toBe(false);
    expect(holds("title", "endsWith", "PAGE")).toBe(true);
    expect(holds("title", "endsWith", "fix")).toBe(false);
  });

  it("text: matches regex (ignoring case), and an invalid pattern never matches", () => {
    expect(holds("identifier", "matches", "^eng-\\d+$")).toBe(true);
    expect(holds("identifier", "matches", "^OPS-")).toBe(false);
    expect(holds("title", "matches", "(")).toBe(false);
  });

  it("text: is empty and is not empty", () => {
    expect(holds("description", "null")).toBe(true);
    expect(holds("description", "notNull")).toBe(false);
    expect(holds("title", "null")).toBe(false);
    expect(holds("title", "notNull")).toBe(true);
    // A field the issue doesn't have reads as empty.
    expect(holds("source.title", "null")).toBe(true);
  });

  it("one-of: is, is not, is any of, is none of, ignoring case", () => {
    expect(holds("team", "=", "eng")).toBe(true);
    expect(holds("team", "=", "OPS")).toBe(false);
    expect(holds("team", "!=", "OPS")).toBe(true);
    expect(holds("team", "!=", "Eng")).toBe(false);
    expect(holds("project", "in", ["control panel", "Agent"])).toBe(true);
    expect(holds("project", "in", ["Agent"])).toBe(false);
    expect(holds("project", "notIn", ["Agent"])).toBe(true);
    expect(holds("project", "notIn", ["CONTROL PANEL"])).toBe(false);
    expect(holds("priority", "=", "2")).toBe(true);
    expect(holds("parent", "=", "eng-10")).toBe(true);
  });

  it("one-of: an empty value is never `is` and always `is not`", () => {
    expect(holds("creator", "=", "user-1")).toBe(false);
    expect(holds("creator", "!=", "user-1")).toBe(true);
    expect(holds("creator", "in", ["user-1"])).toBe(false);
    expect(holds("creator", "notIn", ["user-1"])).toBe(true);
    expect(holds("creator", "null")).toBe(true);
    expect(holds("creator", "notNull")).toBe(false);
    expect(holds("assignee", "notNull")).toBe(true);
  });

  it("many-of: contains any, all and none of, ignoring case", () => {
    expect(holds("labels", "containsAny", ["backend", "frontend"])).toBe(true);
    expect(holds("labels", "containsAny", ["frontend"])).toBe(false);
    expect(holds("labels", "containsAll", ["API", "backend"])).toBe(true);
    expect(holds("labels", "containsAll", ["api", "frontend"])).toBe(false);
    expect(holds("labels", "containsNone", ["frontend"])).toBe(true);
    expect(holds("labels", "containsNone", ["frontend", "Api"])).toBe(false);
  });

  it("many-of: is empty and is not empty", () => {
    expect(holds("labels", "null")).toBe(false);
    expect(holds("labels", "notNull")).toBe(true);
    expect(holds("source.labels", "null")).toBe(true);
    expect(holds("source.labels", "containsNone", ["x"])).toBe(true);
    expect(holds("source.labels", "containsAny", ["x"])).toBe(false);
  });

  it("number: =, ≠, <, ≤, >, ≥, between (inclusive)", () => {
    expect(holds("estimate", "=", 3)).toBe(true);
    expect(holds("estimate", "=", 2)).toBe(false);
    expect(holds("estimate", "!=", 2)).toBe(true);
    expect(holds("estimate", "!=", 3)).toBe(false);
    expect(holds("estimate", "<", 4)).toBe(true);
    expect(holds("estimate", "<", 3)).toBe(false);
    expect(holds("estimate", "<=", 3)).toBe(true);
    expect(holds("estimate", "<=", 2)).toBe(false);
    expect(holds("estimate", ">", 2)).toBe(true);
    expect(holds("estimate", ">", 3)).toBe(false);
    expect(holds("estimate", ">=", 3)).toBe(true);
    expect(holds("estimate", ">=", 4)).toBe(false);
    expect(holds("estimate", "between", [3, 5])).toBe(true);
    expect(holds("estimate", "between", [1, 3])).toBe(true);
    expect(holds("estimate", "between", [4, 8])).toBe(false);
  });

  it("number: an empty estimate only matches is empty and ≠", () => {
    expect(holds("parent.estimate", "null")).toBe(true);
    expect(holds("parent.estimate", "notNull")).toBe(false);
    expect(holds("parent.estimate", "=", 0)).toBe(false);
    expect(holds("parent.estimate", "<", 10)).toBe(false);
    expect(holds("parent.estimate", "between", [0, 10])).toBe(false);
    expect(holds("parent.estimate", "!=", 1)).toBe(true);
    expect(holds("estimate", "notNull")).toBe(true);
  });

  it("date: on, before, after, between (inclusive), is empty", () => {
    expect(holds("dueDate", "=", "2026-11-15")).toBe(true);
    expect(holds("dueDate", "=", "2026-11-16")).toBe(false);
    expect(holds("dueDate", "<", "2026-12-01")).toBe(true);
    expect(holds("dueDate", "<", "2026-11-15")).toBe(false);
    expect(holds("dueDate", ">", "2026-11-01")).toBe(true);
    expect(holds("dueDate", ">", "2026-11-15")).toBe(false);
    expect(holds("dueDate", "between", ["2026-11-15", "2026-11-30"])).toBe(true);
    expect(holds("dueDate", "between", ["2026-10-01", "2026-11-14"])).toBe(false);
    expect(holds("dueDate", "null")).toBe(false);
    expect(holds("dueDate", "notNull")).toBe(true);
    expect(holds("parent.dueDate", "null")).toBe(true);
    expect(holds("parent.dueDate", "<", "2030-01-01")).toBe(false);
  });

  it("tests the parent's and the source's fields", () => {
    expect(holds("parent.labels", "containsAny", ["Epic"])).toBe(true);
    expect(holds("parent.team", "=", "ops")).toBe(true);
    expect(holds("source.team", "null")).toBe(true);
  });

  it("an unknown field or operator never holds", () => {
    expect(holds("nope", "=", "x")).toBe(false);
    expect(holds("nope", "null")).toBe(false);
    expect(holds("team", "contains", "E")).toBe(false);
  });
});

const condition = (field: string, operator: string, value: RoutingCondition["value"]) => ({
  field,
  operator,
  value,
});
const TRUE = condition("team", "=", "ENG");
const FALSE = condition("team", "=", "OPS");
const query = (group: RoutingGroup) => evaluateQuery(group, values, LINEAR_ROUTING_FIELD_TYPES);

describe("evaluateQuery", () => {
  it("AND needs every rule, OR any", () => {
    expect(query({ combinator: "and", rules: [TRUE, TRUE] })).toBe(true);
    expect(query({ combinator: "and", rules: [TRUE, FALSE] })).toBe(false);
    expect(query({ combinator: "or", rules: [FALSE, TRUE] })).toBe(true);
    expect(query({ combinator: "or", rules: [FALSE, FALSE] })).toBe(false);
  });

  it("NOT negates a group", () => {
    expect(query({ combinator: "and", not: true, rules: [TRUE] })).toBe(false);
    expect(query({ combinator: "or", not: true, rules: [FALSE] })).toBe(true);
  });

  it("evaluates nested groups", () => {
    // labels has backend AND (team is OPS OR NOT (estimate > 5))
    const nested: RoutingGroup = {
      combinator: "and",
      rules: [
        condition("labels", "containsAny", ["backend"]),
        {
          combinator: "or",
          rules: [FALSE, { combinator: "and", not: true, rules: [condition("estimate", ">", 5)] }],
        },
      ],
    };
    expect(query(nested)).toBe(true);
    expect(query({ ...nested, not: true })).toBe(false);
    const deeper: RoutingGroup = {
      combinator: "and",
      rules: [{ combinator: "or", rules: [{ combinator: "and", rules: [FALSE] }] }],
    };
    expect(query(deeper)).toBe(false);
  });

  it("an empty group matches every issue", () => {
    expect(query({ combinator: "and", rules: [] })).toBe(true);
    expect(query({ combinator: "or", rules: [] })).toBe(true);
  });
});
