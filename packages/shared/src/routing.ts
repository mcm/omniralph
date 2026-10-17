/**
 * Routing rules: an organization's ordered list of conditions over an issue's fields, each
 * naming the repository a matching issue builds in (the first match wins). A rule's
 * condition is stored as react-querybuilder's `RuleGroupType` (`combinator`, `not`, nested
 * `rules` of `{ field, operator, value }`). The fields come from the issue tracker's catalog
 * (`routingQuerySchema(fields)`); the operators and values each field type takes are here.
 */
import { z } from "zod";

/** Most rules an organization can have. */
export const MAX_ROUTING_RULES = 100;
/** Most conditions (leaf rules, at any depth) in one rule. */
export const MAX_ROUTING_CONDITIONS = 50;
/** Deepest nesting of groups in one rule: the rule's own group is depth 1. */
export const MAX_ROUTING_DEPTH = 5;
/** Longest `matches regex` pattern. */
export const MAX_ROUTING_REGEX_LENGTH = 200;
/** Longest text value or list item. */
export const MAX_ROUTING_VALUE_LENGTH = 1000;
/** Most values in one list (`is any of`, `contains all of`, ...). */
export const MAX_ROUTING_LIST_VALUES = 200;

export const ROUTING_FIELD_TYPES = ["text", "one-of", "many-of", "number", "date"] as const;
export type RoutingFieldType = (typeof ROUTING_FIELD_TYPES)[number];

/** An operator and how it reads for the field type ("equals" for text, "is" for one-of). */
export interface RoutingOperator {
  /** react-querybuilder's operator name where it has one (`=`, `in`, `null`, ...). */
  name: string;
  label: string;
}

/** The value an operator takes. */
type ValueKind =
  | "none"
  | "text"
  | "regex"
  | "option"
  | "options"
  | "number"
  | "number-range"
  | "date"
  | "date-range";

const EMPTY = [
  { name: "null", label: "is empty" },
  { name: "notNull", label: "is not empty" },
] as const;

/** The operators of each field type, in the order the builder offers them. */
export const ROUTING_OPERATORS = {
  text: [
    { name: "=", label: "equals" },
    { name: "!=", label: "does not equal" },
    { name: "contains", label: "contains" },
    { name: "doesNotContain", label: "does not contain" },
    { name: "beginsWith", label: "begins with" },
    { name: "endsWith", label: "ends with" },
    { name: "matches", label: "matches regex" },
    ...EMPTY,
  ],
  "one-of": [
    { name: "=", label: "is" },
    { name: "!=", label: "is not" },
    { name: "in", label: "is any of" },
    { name: "notIn", label: "is none of" },
    ...EMPTY,
  ],
  "many-of": [
    { name: "containsAny", label: "contains any of" },
    { name: "containsAll", label: "contains all of" },
    { name: "containsNone", label: "contains none of" },
    ...EMPTY,
  ],
  number: [
    { name: "=", label: "=" },
    { name: "!=", label: "≠" },
    { name: "<", label: "<" },
    { name: "<=", label: "≤" },
    { name: ">", label: ">" },
    { name: ">=", label: "≥" },
    { name: "between", label: "between" },
    ...EMPTY,
  ],
  date: [
    { name: "=", label: "on" },
    { name: "<", label: "before" },
    { name: ">", label: "after" },
    { name: "between", label: "between" },
    ...EMPTY,
  ],
} as const satisfies Record<RoutingFieldType, readonly RoutingOperator[]>;

/** The operator names a field type takes. */
export type RoutingOperatorName<T extends RoutingFieldType = RoutingFieldType> =
  (typeof ROUTING_OPERATORS)[T][number]["name"];

function valueKind(type: RoutingFieldType, operator: string): ValueKind {
  if (operator === "null" || operator === "notNull") return "none";
  switch (type) {
    case "text":
      return operator === "matches" ? "regex" : "text";
    case "one-of":
      return operator === "in" || operator === "notIn" ? "options" : "option";
    case "many-of":
      return "options";
    case "number":
      return operator === "between" ? "number-range" : "number";
    case "date":
      return operator === "between" ? "date-range" : "date";
  }
}

/** What the schema needs to know of a catalog field. */
export interface RoutingFieldSpec {
  /** The field's name, e.g. `labels` or `parent.team`. */
  id: string;
  type: RoutingFieldType;
  /** For a field with a fixed set of values (e.g. `priority`): the only values it takes. */
  values?: readonly string[];
}

/** One condition: `{ field, operator, value }`. */
export interface RoutingCondition {
  id?: string;
  field: string;
  operator: string;
  /**
   * `null` for `is empty`/`is not empty`; a string (text, one value, a `YYYY-MM-DD` date);
   * a list of strings; a number; or a `[from, to]` range of numbers or dates.
   */
  value: RoutingValue;
}

export type RoutingValue = null | string | number | string[] | [number, number] | [string, string];

/** A group of conditions and groups, joined by `combinator`, negated with `not`. */
export interface RoutingGroup {
  id?: string;
  combinator: "and" | "or";
  not?: boolean;
  rules: Array<RoutingCondition | RoutingGroup>;
}

/** A stored rule's condition: its top-level group. */
export type RoutingQuery = RoutingGroup;

export function isRoutingGroup(rule: RoutingCondition | RoutingGroup): rule is RoutingGroup {
  return "rules" in rule;
}

type Path = Array<string | number>;
type Report = (message: string, path: Path) => void;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ROUTING_VALUE_LENGTH;
}

/** An `id` react-querybuilder gave a rule or group, kept so the builder keeps its keys. */
function optionalId(value: Record<string, unknown>, path: Path, report: Report) {
  if (value.id === undefined) return {};
  if (typeof value.id === "string" && value.id.length <= 100) return { id: value.id };
  report("Invalid ID.", [...path, "id"]);
  return {};
}

/** The condition's value for its field and operator, or undefined (reported) when invalid. */
function conditionValue(
  field: RoutingFieldSpec,
  operator: string,
  value: unknown,
  path: Path,
  report: Report,
): RoutingValue | undefined {
  const at = [...path, "value"];
  const fixed = field.values;
  const allowed = (v: string) => !fixed || fixed.includes(v);
  switch (valueKind(field.type, operator)) {
    case "none":
      if (value === undefined || value === null || value === "") return null;
      report("This operator takes no value.", at);
      return undefined;
    case "text":
      if (isText(value)) return value;
      report(`Enter text of at most ${MAX_ROUTING_VALUE_LENGTH} characters.`, at);
      return undefined;
    case "regex": {
      if (typeof value !== "string" || value === "") {
        report("Enter a regular expression.", at);
        return undefined;
      }
      if (value.length > MAX_ROUTING_REGEX_LENGTH) {
        report(`Regular expressions can be at most ${MAX_ROUTING_REGEX_LENGTH} characters.`, at);
        return undefined;
      }
      try {
        new RegExp(value);
      } catch {
        report("This isn't a valid regular expression.", at);
        return undefined;
      }
      return value;
    }
    case "option":
      if (isText(value) && value.trim() !== "" && allowed(value)) return value;
      report("Pick a value.", at);
      return undefined;
    case "options":
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MAX_ROUTING_LIST_VALUES &&
        value.every((v) => isText(v) && v.trim() !== "" && allowed(v))
      ) {
        return value as string[];
      }
      report("Pick at least one value.", at);
      return undefined;
    case "number":
      if (isNumber(value)) return value;
      report("Enter a number.", at);
      return undefined;
    case "number-range":
      if (Array.isArray(value) && value.length === 2 && value.every(isNumber)) {
        const [from, to] = value as [number, number];
        if (from <= to) return [from, to];
      }
      report("Enter two numbers, the smaller first.", at);
      return undefined;
    case "date":
      if (isDate(value)) return value;
      report("Enter a date (YYYY-MM-DD).", at);
      return undefined;
    case "date-range":
      if (Array.isArray(value) && value.length === 2 && value.every(isDate)) {
        const [from, to] = value as [string, string];
        if (from <= to) return [from, to];
      }
      report("Enter two dates (YYYY-MM-DD), the earlier first.", at);
      return undefined;
  }
}

function parseCondition(
  value: Record<string, unknown>,
  fields: ReadonlyMap<string, RoutingFieldSpec>,
  path: Path,
  report: Report,
): RoutingCondition | undefined {
  const field = typeof value.field === "string" ? fields.get(value.field) : undefined;
  if (!field) {
    report("Pick a field.", [...path, "field"]);
    return undefined;
  }
  if (value.valueSource !== undefined && value.valueSource !== "value") {
    report("Conditions compare with a value.", [...path, "valueSource"]);
    return undefined;
  }
  const operator = value.operator;
  const operators: readonly RoutingOperator[] = ROUTING_OPERATORS[field.type];
  if (typeof operator !== "string" || !operators.some((o) => o.name === operator)) {
    report("Pick an operator for this field.", [...path, "operator"]);
    return undefined;
  }
  const parsed = conditionValue(field, operator, value.value, path, report);
  if (parsed === undefined) return undefined;
  return { ...optionalId(value, path, report), field: field.id, operator, value: parsed };
}

interface Counter {
  conditions: number;
}

function parseGroup(
  value: unknown,
  fields: ReadonlyMap<string, RoutingFieldSpec>,
  path: Path,
  depth: number,
  counter: Counter,
  report: Report,
): RoutingGroup | undefined {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    report("Invalid condition group.", path);
    return undefined;
  }
  if (depth > MAX_ROUTING_DEPTH) {
    report(`Groups can be nested at most ${MAX_ROUTING_DEPTH} deep.`, path);
    return undefined;
  }
  let valid = true;
  if (value.combinator !== "and" && value.combinator !== "or") {
    report("Pick AND or OR.", [...path, "combinator"]);
    valid = false;
  }
  if (value.not !== undefined && typeof value.not !== "boolean") {
    report("Invalid NOT.", [...path, "not"]);
    valid = false;
  }
  // Only the rule's own group may be empty (it matches every issue).
  if (depth > 1 && value.rules.length === 0) {
    report("Add a condition to this group, or remove it.", [...path, "rules"]);
    valid = false;
  }
  const rules: RoutingGroup["rules"] = [];
  value.rules.forEach((rule: unknown, index) => {
    const at = [...path, "rules", index];
    let parsed: RoutingCondition | RoutingGroup | undefined;
    if (isRecord(rule) && "rules" in rule) {
      parsed = parseGroup(rule, fields, at, depth + 1, counter, report);
    } else if (isRecord(rule)) {
      counter.conditions += 1;
      parsed = parseCondition(rule, fields, at, report);
    } else {
      report("Invalid condition.", at);
    }
    if (parsed) rules.push(parsed);
    else valid = false;
  });
  if (!valid) return undefined;
  return {
    ...optionalId(value, path, report),
    combinator: value.combinator as "and" | "or",
    ...(value.not === true && { not: true }),
    rules,
  };
}

/**
 * Validates a stored rule's condition against `fields` (the tracker's catalog): known
 * fields, operators of the field's type, values the operator takes (a `matches regex`
 * pattern that compiles and is at most 200 characters), at most 50 conditions and groups
 * nested at most 5 deep. Errors are at the offending path (`rules.0.rules.2.value`).
 * Unknown keys are dropped.
 */
export function routingQuerySchema(fields: readonly RoutingFieldSpec[]) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return z.unknown().transform((value, ctx): RoutingQuery => {
    let issues = 0;
    const report: Report = (message, path) => {
      issues += 1;
      ctx.addIssue({ code: "custom", message, path });
    };
    const counter: Counter = { conditions: 0 };
    const query = parseGroup(value, byId, [], 1, counter, report);
    if (counter.conditions > MAX_ROUTING_CONDITIONS) {
      report(`A rule can have at most ${MAX_ROUTING_CONDITIONS} conditions.`, ["rules"]);
    }
    if (!query || issues > 0) return z.NEVER;
    return query;
  });
}

/** One rule as saved: its condition and the repository a matching issue routes to. */
export interface RoutingRuleInput {
  repositoryId: string;
  query: RoutingQuery;
}

/**
 * The organization's whole list of rules, in evaluation order (at most 100), as
 * `PUT /api/ui/routing-rules` takes it: `{ rules: [{ repositoryId, query }] }`.
 */
export function routingRulesSchema(fields: readonly RoutingFieldSpec[]) {
  return z.object({
    rules: z
      .array(
        z.object({
          repositoryId: z.uuid("Pick a repository."),
          query: routingQuerySchema(fields),
        }),
      )
      .max(MAX_ROUTING_RULES, `There can be at most ${MAX_ROUTING_RULES} rules.`),
  });
}
