/**
 * Rules in words: react-querybuilder's natural-language format, with the catalog's field
 * and operator labels ("Labels contains any of backend, api"). `routed_by` stores
 * `rule 3 (…)`.
 */
import { formatQuery } from "react-querybuilder/formatQuery";
import type { RoutingCondition, RoutingQuery } from "@omniralph/shared";
import type { RoutingField } from "@/lib/linear/routing-fields";

/** What an empty rule (it matches every issue) reads as. */
export const EVERY_ISSUE = "every issue";

function valueText(field: RoutingField | undefined, { operator, value }: RoutingCondition): string {
  const fixed = field?.options && "values" in field.options ? field.options.values : null;
  const label = (v: string | number) =>
    fixed?.find((option) => option.value === String(v))?.label ?? String(v);
  if (value === null) return "";
  if (operator === "between" && Array.isArray(value)) {
    return `${label(value[0] ?? "")} and ${label(value[1] ?? "")}`;
  }
  return Array.isArray(value) ? value.map(label).join(", ") : label(value);
}

function conditionText(condition: RoutingCondition, fields: readonly RoutingField[]): string {
  const field = fields.find((f) => f.id === condition.field);
  const operator =
    field?.operators.find((o) => o.name === condition.operator)?.label ?? condition.operator;
  const value = valueText(field, condition);
  return [field?.label ?? condition.field, operator, value].filter(Boolean).join(" ");
}

/** A rule's condition in words. */
export function describeQuery(query: RoutingQuery, fields: readonly RoutingField[]): string {
  if (query.rules.length === 0) return query.not ? `not ${EVERY_ISSUE}` : EVERY_ISSUE;
  return formatQuery(query, {
    format: "natural_language",
    ruleProcessor: (rule) => conditionText(rule as RoutingCondition, fields),
  });
}

/** `routed_by` of a match on custom rule `number` (1-based): `rule 3 (Labels contains any of backend)`. */
export function describeRule(
  number: number,
  query: RoutingQuery,
  fields: readonly RoutingField[],
): string {
  return `rule ${number} (${describeQuery(query, fields)})`;
}
