import {
  ROUTING_OPERATORS,
  routingRulesSchema,
  type RoutingFieldType,
  type RoutingOperator,
} from "@omniralph/shared";
import type { RoutingFieldValues, RoutingIssueValue } from "@/lib/routing/evaluate";
import type { RoutingIssue, RoutingIssueFields } from "./gateway";

/**
 * The Linear issue fields routing rules test (Settings › Routing), under Linear's own names.
 * Each is offered for the issue itself, its parent (`parent.labels`, "Parent › Labels") and,
 * for a follow-up, the issue it was filed from (`source.team`, "Source › Team"). Names
 * (labels, projects, milestones, states) match ignoring case.
 */

/** A list of the connected workspace's `LinearSettingsOptions` the value picker offers. */
export type RoutingOptionSource =
  "teams" | "projects" | "projectMilestones" | "cycles" | "states" | "labels" | "users";

export interface RoutingFieldValue {
  value: string;
  label: string;
}

/** Where a field's values come from. */
export type RoutingFieldOptions =
  /** The workspace's list (teams by key, cycles and users by ID, the rest by name). */
  | { source: RoutingOptionSource }
  /** A fixed set: the only values the field takes. */
  | { values: readonly RoutingFieldValue[] }
  /** Typed in (text, numbers, dates, an issue identifier). */
  | null;

export interface RoutingField {
  /** Linear's name, with a `parent.` or `source.` prefix for those issues' fields. */
  id: string;
  label: string;
  type: RoutingFieldType;
  /** In the order the builder offers them. */
  operators: readonly RoutingOperator[];
  options: RoutingFieldOptions;
}

type BaseField = Omit<RoutingField, "operators">;

const STATE_TYPES: readonly RoutingFieldValue[] = [
  { value: "triage", label: "Triage" },
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Unstarted" },
  { value: "started", label: "Started" },
  { value: "completed", label: "Completed" },
  { value: "canceled", label: "Canceled" },
];

/** Linear's priorities, 0–4. */
const PRIORITIES: readonly RoutingFieldValue[] = [
  { value: "0", label: "No priority" },
  { value: "1", label: "Urgent" },
  { value: "2", label: "High" },
  { value: "3", label: "Medium" },
  { value: "4", label: "Low" },
];

const ISSUE_FIELDS: readonly BaseField[] = [
  { id: "identifier", label: "Identifier", type: "text", options: null },
  { id: "title", label: "Title", type: "text", options: null },
  { id: "description", label: "Description", type: "text", options: null },
  { id: "team", label: "Team", type: "one-of", options: { source: "teams" } },
  { id: "project", label: "Project", type: "one-of", options: { source: "projects" } },
  {
    id: "projectMilestone",
    label: "Milestone",
    type: "one-of",
    options: { source: "projectMilestones" },
  },
  { id: "cycle", label: "Cycle", type: "one-of", options: { source: "cycles" } },
  { id: "state", label: "State", type: "one-of", options: { source: "states" } },
  { id: "stateType", label: "State type", type: "one-of", options: { values: STATE_TYPES } },
  { id: "priority", label: "Priority", type: "one-of", options: { values: PRIORITIES } },
  { id: "assignee", label: "Assignee", type: "one-of", options: { source: "users" } },
  { id: "creator", label: "Creator", type: "one-of", options: { source: "users" } },
  /** The parent's identifier (`ENG-10`). */
  { id: "parent", label: "Parent", type: "one-of", options: null },
  { id: "labels", label: "Labels", type: "many-of", options: { source: "labels" } },
  { id: "estimate", label: "Estimate", type: "number", options: null },
  { id: "dueDate", label: "Due date", type: "date", options: null },
];

/** The issues besides the routed one whose fields rules test. */
const RELATED = [
  { prefix: "parent", label: "Parent" },
  { prefix: "source", label: "Source" },
] as const;

function withOperators(field: BaseField): RoutingField {
  return { ...field, operators: ROUTING_OPERATORS[field.type] };
}

/** Every field, the issue's own first, then its parent's, then its source's. */
export const LINEAR_ROUTING_FIELDS: readonly RoutingField[] = [
  ...ISSUE_FIELDS.map(withOperators),
  ...RELATED.flatMap(({ prefix, label }) =>
    ISSUE_FIELDS.map((field) =>
      withOperators({ ...field, id: `${prefix}.${field.id}`, label: `${label} › ${field.label}` }),
    ),
  ),
];

/** `PUT /api/ui/routing-rules`'s body, checked against the Linear catalog. */
export const linearRoutingRulesSchema = routingRulesSchema(
  LINEAR_ROUTING_FIELDS.map((field) => ({
    id: field.id,
    type: field.type,
    ...(field.options && "values" in field.options
      ? { values: field.options.values.map((v) => v.value) }
      : {}),
  })),
);

/** Each catalog field's type, by ID, for the evaluator. */
export const LINEAR_ROUTING_FIELD_TYPES: ReadonlyMap<string, RoutingFieldType> = new Map(
  LINEAR_ROUTING_FIELDS.map((field) => [field.id, field.type]),
);

/** One issue's fields as the evaluator reads them, under `prefix` (`parent.`) when given. */
function issueValues(
  fields: RoutingIssueFields | null,
  prefix = "",
): Record<string, RoutingIssueValue> {
  const values: Record<string, RoutingIssueValue> = {};
  for (const field of ISSUE_FIELDS) {
    const id = field.id as keyof RoutingIssueFields & string;
    const value = fields ? fields[id] : null;
    values[`${prefix}${field.id}`] =
      // `priority` is one of fixed values "0"–"4".
      typeof value === "number" && field.type === "one-of" ? String(value) : (value ?? null);
  }
  return values;
}

/**
 * The values rules test for an issue: its own fields, its parent's (`parent.*`) and, for a
 * follow-up, those of the issue it was filed from (`source.*`). Missing issues' fields are
 * empty.
 */
export function linearRoutingValues(
  routing: RoutingIssue,
  source: RoutingIssueFields | null = null,
): RoutingFieldValues {
  return {
    ...issueValues(routing.issue),
    ...issueValues(routing.parent, "parent."),
    ...issueValues(source, "source."),
  };
}
