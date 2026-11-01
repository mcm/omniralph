/**
 * Advanced › Routing rules' draft: the rules being edited, their changes as the save bar
 * lists them, how a condition's value is shaped for its operator, the value suggestions and
 * where `PUT` errors belong. Pure, so it's tested without the page.
 */
import type { StagedChange } from "@omniralph/ui";
import {
  fieldErrors,
  routingRulesSchema,
  routingValueKind,
  type FieldErrors,
  type RoutingQuery,
  type RoutingValueKind,
} from "@omniralph/shared";
import { prepareRuleGroup, type RuleGroupType } from "react-querybuilder";
import type { RoutingRules } from "@/lib/api/routing-rules";
import { describeQuery } from "@/lib/routing/describe";

export type RoutingFieldData = RoutingRules["fields"][number];
export type RoutingRepository = RoutingRules["repositories"][number];
export type RoutingTracker = RoutingRules["tracker"];

/** One rule being edited. `key` identifies its row while it moves. */
export interface DraftRule {
  key: string;
  /** Empty until a repository is picked. */
  repositoryId: string;
  query: RuleGroupType;
}

let nextKey = 0;

/** A new rule's row key (saved rules use their ID). */
export function newRuleKey(): string {
  nextKey += 1;
  return `new-${nextKey}`;
}

/** The saved rules as drafts, in evaluation order, with the IDs the builder needs. */
export function draftsOf(rules: RoutingRules["rules"]): DraftRule[] {
  return [...rules]
    .sort((a, b) => a.position - b.position)
    .map((rule) => ({
      key: rule.id,
      repositoryId: rule.repositoryId,
      query: prepareRuleGroup(rule.query as RuleGroupType),
    }));
}

/** A rule appended by "Add rule": no conditions yet, no repository. */
export function newRule(): DraftRule {
  return {
    key: newRuleKey(),
    repositoryId: "",
    query: prepareRuleGroup({ combinator: "and", rules: [] }),
  };
}

/** The rules with the one at `from` moved to `to`. */
export function moveRule<T>(rules: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= rules.length || to >= rules.length) {
    return [...rules];
  }
  const next = [...rules];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

type QueryNode = RuleGroupType["rules"][number];

function isGroup(node: QueryNode): node is RuleGroupType {
  return typeof node === "object" && "rules" in node;
}

/** What a condition's value means, without the builder's own keys (IDs, `valueSource`). */
function canonicalNode(node: QueryNode): unknown {
  if (typeof node === "string") return node;
  if (isGroup(node)) {
    return {
      combinator: node.combinator,
      not: node.not === true,
      rules: node.rules.map(canonicalNode),
    };
  }
  return { field: node.field, operator: node.operator, value: node.value ?? null };
}

function canonical(rules: readonly DraftRule[]): string {
  return JSON.stringify(
    rules.map((rule) => ({ repositoryId: rule.repositoryId, query: canonicalNode(rule.query) })),
  );
}

/** Whether `draft` differs from `saved` in anything that's saved (order, targets, conditions). */
export function rulesDiffer(draft: readonly DraftRule[], saved: readonly DraftRule[]): boolean {
  return canonical(draft) !== canonical(saved);
}

/** The draft as `PUT /api/ui/routing-rules` takes it. */
export function toRuleInputs(rules: readonly DraftRule[]): unknown[] {
  return rules.map((rule) => ({ repositoryId: rule.repositoryId, query: rule.query }));
}

/** A rule's condition in words, as a sentence ("Team is ENG and Labels contains any of api"). */
export function ruleDescription(query: RuleGroupType, fields: readonly RoutingFieldData[]): string {
  let condition: string;
  try {
    condition = describeQuery(query as RoutingQuery, fields);
  } catch {
    condition = "an incomplete condition";
  }
  return condition.charAt(0).toUpperCase() + condition.slice(1);
}

/** The repository a rule targets, by path, or what stands in for it. */
export function targetName(
  repositoryId: string,
  repositories: readonly RoutingRepository[],
): string {
  if (!repositoryId) return "no repo";
  return repositories.find((repo) => repo.id === repositoryId)?.fullPath ?? "an unknown repo";
}

/** A rule in words: its condition and target ("Labels contains any of api → `mcm/api`"). */
export function ruleSummary(
  rule: { repositoryId: string; query: RuleGroupType },
  fields: readonly RoutingFieldData[],
  repositories: readonly RoutingRepository[],
): string {
  return `${ruleDescription(rule.query, fields)} → ${targetName(rule.repositoryId, repositories)}`;
}

/**
 * The saved positions (`order`, in draft order) that keep their relative order: the longest
 * increasing run, preferring the earliest positions, so a swap of rules 1 and 2 reads as
 * rule 2 moving up.
 */
function unmoved(order: readonly number[]): Set<number> {
  // Patience sorting: `tails[k]` ends the best run of length k + 1 found so far.
  const tails: number[] = [];
  const previous = new Map<number, number | undefined>();
  for (const value of order) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid]! < value) low = mid + 1;
      else high = mid;
    }
    previous.set(value, low > 0 ? tails[low - 1] : undefined);
    tails[low] = value;
  }
  const kept = new Set<number>();
  for (let value = tails.at(-1); value !== undefined; value = previous.get(value)) {
    kept.add(value);
  }
  return kept;
}

/**
 * The list's unsaved changes for the save bar, rule by rule, each with its effect: "Rule 3:
 * added", "Rule 2: moved to 1", "Rule 1: edited" (old → new) and "Rule 4: deleted". Numbers
 * are the saved positions, an added rule's its new one. Rules that only shift because
 * another moved, came or went aren't listed.
 */
export function ruleChanges(
  draft: readonly DraftRule[],
  saved: readonly DraftRule[],
  fields: readonly RoutingFieldData[],
  repositories: readonly RoutingRepository[],
): StagedChange[] {
  if (!rulesDiffer(draft, saved)) return [];
  const savedIndex = new Map(saved.map((rule, index) => [rule.key, index]));
  const draftKeys = new Set(draft.map((rule) => rule.key));
  const stay = unmoved(
    draft.flatMap((rule) => {
      const index = savedIndex.get(rule.key);
      return index === undefined ? [] : [index];
    }),
  );
  const summary = (rule: DraftRule) => ruleSummary(rule, fields, repositories);
  const goesTo = (rule: DraftRule) =>
    `Work items it matches go to ${targetName(rule.repositoryId, repositories)}.`;
  const changes: StagedChange[] = [];
  draft.forEach((rule, to) => {
    const from = savedIndex.get(rule.key);
    if (from === undefined) {
      changes.push({
        id: `add-${rule.key}`,
        label: `Rule ${to + 1}: added`,
        to: summary(rule),
        effect: goesTo(rule),
      });
      return;
    }
    if (!stay.has(from)) {
      changes.push({
        id: `move-${rule.key}`,
        label: `Rule ${from + 1}: moved to ${to + 1}`,
        effect:
          to < from
            ? "It's checked before the rules it moved above."
            : "It's checked after the rules it moved below.",
      });
    }
    const before = saved[from]!;
    if (rulesDiffer([rule], [before])) {
      changes.push({
        id: `edit-${rule.key}`,
        label: `Rule ${from + 1}: edited`,
        from: summary(before),
        to: summary(rule),
        effect: goesTo(rule),
      });
    }
  });
  saved.forEach((rule, from) => {
    if (draftKeys.has(rule.key)) return;
    changes.push({
      id: `delete-${rule.key}`,
      label: `Rule ${from + 1}: deleted`,
      from: summary(rule),
      effect: "Work items it matched go on to the next rule.",
    });
  });
  return changes;
}

// ── Values ────────────────────────────────────────────────────────────────────

/** The value kind of a condition on `field` with `operator`, or null for an unknown field. */
export function valueKindOf(
  field: RoutingFieldData | undefined,
  operator: string,
): RoutingValueKind | null {
  return field ? routingValueKind(field.type, operator) : null;
}

/** The value a condition starts with for its kind (empty, so the schema asks for one). */
export function defaultValue(kind: RoutingValueKind | null): unknown {
  switch (kind) {
    case "options":
      return [];
    case "number-range":
      return [null, null];
    case "date-range":
      return ["", ""];
    case "number":
    case "none":
      return null;
    default:
      return "";
  }
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return typeof value === "string" ? value.split(",").map((v) => v.trim()) : [value];
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

/**
 * `value` in the shape `kind` takes, keeping what carries over (an operator change from "is"
 * to "is any of" keeps the value as the list's only item).
 */
export function coerceValue(kind: RoutingValueKind | null, value: unknown): unknown {
  switch (kind) {
    case null:
      return value;
    case "none":
      return null;
    case "text":
    case "regex":
    case "date":
    case "option":
      if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
      return typeof value === "string" ? value : value == null ? "" : String(value);
    case "options":
      return asList(value).filter((v): v is string => typeof v === "string" && v !== "");
    case "number":
      return asNumber(Array.isArray(value) ? value[0] : value);
    case "number-range": {
      const [from, to] = asList(value);
      return [asNumber(from), asNumber(to)];
    }
    case "date-range": {
      const [from, to] = asList(value);
      return [typeof from === "string" ? from : "", typeof to === "string" ? to : ""];
    }
  }
}

/** The query with every condition's value in the shape its field and operator take. */
export function normalizeQuery(
  query: RuleGroupType,
  fields: ReadonlyMap<string, RoutingFieldData>,
): RuleGroupType {
  const rules = query.rules.map((node): QueryNode => {
    if (typeof node === "string") return node;
    if (isGroup(node)) return normalizeQuery(node, fields);
    const value = coerceValue(valueKindOf(fields.get(node.field), node.operator), node.value);
    return JSON.stringify(value) === JSON.stringify(node.value) ? node : { ...node, value };
  });
  return rules.every((rule, i) => rule === query.rules[i]) ? query : { ...query, rules };
}

/** A picker's option: what's saved and what's shown. */
export interface ValueOption {
  value: string;
  label: string;
}

/**
 * The values a field's picker offers: its fixed set, or the connected workspace's list (teams
 * by key, cycles and users by ID, the rest by name). Null when the value is typed in: a
 * field without options (text, numbers, dates, the parent's identifier), or a workspace
 * field while the tracker isn't connected.
 */
export function valueOptions(
  field: RoutingFieldData | undefined,
  tracker: RoutingTracker,
): ValueOption[] | null {
  const options = field?.options;
  if (!options) return null;
  if ("values" in options) return options.values;
  if (tracker.status !== "connected") return null;
  const workspace = tracker.options;
  const names = (list: readonly string[]) => list.map((name) => ({ value: name, label: name }));
  switch (options.source) {
    case "teams":
      return workspace.teams.map((t) => ({ value: t.key, label: `${t.key} · ${t.name}` }));
    case "projects":
      return names(workspace.projects);
    case "projectMilestones":
      return names(workspace.projectMilestones);
    case "states":
      return names(workspace.states);
    case "labels":
      return names(workspace.labels);
    case "cycles":
      return workspace.cycles.map((c) => ({
        value: c.id,
        label: `${c.teamKey} · ${c.name ?? `Cycle ${c.number}`}`,
      }));
    case "users":
      return workspace.users.map((u) => ({ value: u.id, label: u.name }));
  }
}

/** The option `value` names, ignoring case as routing does; undefined when there's none. */
export function findOption(
  options: readonly ValueOption[],
  value: string,
): ValueOption | undefined {
  const lower = value.toLowerCase();
  return (
    options.find((o) => o.value === value) ?? options.find((o) => o.value.toLowerCase() === lower)
  );
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** A rule's errors: on its repository, on its conditions and groups (by builder path) and on the rule itself. */
export interface RuleErrors {
  repository?: string;
  /** By the builder's path of the condition or group (`"1.0"`), "" for the rule's own group. */
  nodes: ReadonlyMap<string, string>;
}

/** The errors of each rule (by index), and those of the whole list. */
export interface DraftErrors {
  rules: ReadonlyMap<number, RuleErrors>;
  list: string[];
}

export const NO_ERRORS: DraftErrors = { rules: new Map(), list: [] };

const RULE_KEY = /^rules\.(\d+)\.(repositoryId|query)(?:\.(.*))?$/;

/** The builder path (`"1.0"`) of a query error's path (`rules.1.rules.0.value`). */
function nodePath(rest: string | undefined): string {
  const parts = rest ? rest.split(".") : [];
  const path: string[] = [];
  for (let i = 0; i + 1 < parts.length && parts[i] === "rules"; i += 2) {
    if (!/^\d+$/.test(parts[i + 1]!)) break;
    path.push(parts[i + 1]!);
  }
  return path.join(".");
}

/**
 * `PUT`'s field errors (`rules.1.query.rules.0.value`, `rules.2.repositoryId`) placed on
 * their rule and condition; the rest (`rules`, `form`) are the list's.
 */
export function placeErrors(errors: FieldErrors | undefined): DraftErrors {
  if (!errors) return NO_ERRORS;
  const rules = new Map<number, { repository?: string; nodes: Map<string, string> }>();
  const list: string[] = [];
  for (const [key, message] of Object.entries(errors)) {
    const match = RULE_KEY.exec(key);
    if (!match) {
      list.push(message);
      continue;
    }
    const index = Number(match[1]);
    const rule = rules.get(index) ?? { nodes: new Map<string, string>() };
    rules.set(index, rule);
    if (match[2] === "repositoryId") rule.repository ??= message;
    else {
      const path = nodePath(match[3]);
      if (!rule.nodes.has(path)) rule.nodes.set(path, message);
    }
  }
  return { rules, list };
}

/** How many rules have errors, and the list's own. */
export function errorCount(errors: DraftErrors): number {
  return errors.rules.size + errors.list.length;
}

/** Checks the draft the way `PUT` will: null when it's valid, else its errors. */
export function validateDrafts(
  rules: readonly DraftRule[],
  fields: readonly RoutingFieldData[],
): DraftErrors | null {
  const schema = routingRulesSchema(
    fields.map((field) => ({
      id: field.id,
      type: field.type,
      ...(field.options && "values" in field.options
        ? { values: field.options.values.map((v) => v.value) }
        : {}),
    })),
  );
  const result = schema.safeParse({ rules: toRuleInputs(rules) });
  return result.success ? null : placeErrors(fieldErrors(result.error));
}
