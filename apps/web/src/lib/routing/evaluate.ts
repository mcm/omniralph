/**
 * Evaluates a routing rule's condition against an issue's field values: pure and synchronous,
 * over a record of values by field name (`labels`, `parent.team`, ...) and the catalog's
 * field types. Text and names compare ignoring case (a `matches regex` pattern too). A field
 * the record lacks counts as empty. An empty group matches every issue.
 */
import {
  isRoutingGroup,
  type RoutingCondition,
  type RoutingFieldType,
  type RoutingGroup,
} from "@omniralph/shared";

/**
 * One field's value: a string (text, one name/key/ID, a `YYYY-MM-DD` date), a list of
 * names (many-of), a number, or null when the issue has none.
 */
export type RoutingIssueValue = string | number | readonly string[] | null;

/** An issue's values by field name. */
export type RoutingFieldValues = Readonly<Record<string, RoutingIssueValue | undefined>>;

/** The type of each field rules may test, by name. */
export type RoutingFieldTypes = ReadonlyMap<string, RoutingFieldType>;

const fold = (value: string) => value.trim().toLowerCase();

const isBlank = (value: RoutingIssueValue | undefined): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

/** The condition's value as a list of strings (a single value as a list of one). */
function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => fold(String(v)));
  return value === null || value === undefined ? [] : [fold(String(value))];
}

function text(operator: string, actual: string, expected: unknown): boolean {
  const have = actual.toLowerCase();
  const want = String(expected ?? "").toLowerCase();
  switch (operator) {
    case "=":
      return have.trim() === want.trim();
    case "!=":
      return have.trim() !== want.trim();
    case "contains":
      return have.includes(want);
    case "doesNotContain":
      return !have.includes(want);
    case "beginsWith":
      return have.startsWith(want);
    case "endsWith":
      return have.endsWith(want);
    case "matches":
      try {
        return new RegExp(String(expected ?? ""), "i").test(actual);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function oneOf(operator: string, actual: string | null, expected: unknown): boolean {
  const have = actual === null ? null : fold(actual);
  switch (operator) {
    case "=":
      return have !== null && have === fold(String(expected ?? ""));
    case "!=":
      return have === null || have !== fold(String(expected ?? ""));
    case "in":
      return have !== null && strings(expected).includes(have);
    case "notIn":
      return have === null || !strings(expected).includes(have);
    default:
      return false;
  }
}

function manyOf(operator: string, actual: readonly string[], expected: unknown): boolean {
  const have = new Set(actual.map(fold));
  const want = strings(expected);
  switch (operator) {
    case "containsAny":
      return want.some((v) => have.has(v));
    case "containsAll":
      return want.every((v) => have.has(v));
    case "containsNone":
      return !want.some((v) => have.has(v));
    default:
      return false;
  }
}

/** Ordered comparison of numbers, or of `YYYY-MM-DD` dates (which order as strings). */
function ordered<T extends number | string>(
  operator: string,
  actual: T | null,
  expected: unknown,
  coerce: (value: unknown) => T | null,
): boolean {
  if (operator === "between") {
    if (actual === null || !Array.isArray(expected) || expected.length !== 2) return false;
    const [from, to] = expected.map(coerce);
    if (from === null || from === undefined || to === null || to === undefined) return false;
    const [low, high] = from <= to ? [from, to] : [to, from];
    return actual >= low && actual <= high;
  }
  const want = coerce(expected);
  if (operator === "!=") return actual === null || want === null || actual !== want;
  if (actual === null || want === null) return false;
  switch (operator) {
    case "=":
      return actual === want;
    case "<":
      return actual < want;
    case "<=":
      return actual <= want;
    case ">":
      return actual > want;
    case ">=":
      return actual >= want;
    default:
      return false;
  }
}

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const toDate = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 10) : null;

const single = (value: RoutingIssueValue | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return String(value);
};

/** Whether one condition holds for the values. An unknown field or operator never holds. */
export function evaluateCondition(
  condition: RoutingCondition,
  values: RoutingFieldValues,
  types: RoutingFieldTypes,
): boolean {
  const type = types.get(condition.field);
  if (!type) return false;
  const actual = values[condition.field];
  if (condition.operator === "null") return isBlank(actual);
  if (condition.operator === "notNull") return !isBlank(actual);
  switch (type) {
    case "text":
      return text(condition.operator, single(actual) ?? "", condition.value);
    case "one-of":
      return oneOf(condition.operator, isBlank(actual) ? null : single(actual), condition.value);
    case "many-of":
      return manyOf(
        condition.operator,
        Array.isArray(actual)
          ? actual
          : actual === null || actual === undefined
            ? []
            : [String(actual)],
        condition.value,
      );
    case "number":
      return ordered(condition.operator, toNumber(single(actual)), condition.value, toNumber);
    case "date":
      return ordered(condition.operator, toDate(single(actual)), condition.value, toDate);
  }
}

/** Whether a group holds: its conditions and groups joined by its combinator, then `not`. */
export function evaluateQuery(
  group: RoutingGroup,
  values: RoutingFieldValues,
  types: RoutingFieldTypes,
): boolean {
  const results = group.rules.map((rule) =>
    isRoutingGroup(rule)
      ? evaluateQuery(rule, values, types)
      : evaluateCondition(rule, values, types),
  );
  const held =
    results.length === 0 ||
    (group.combinator === "or" ? results.some(Boolean) : results.every(Boolean));
  return group.not ? !held : held;
}
