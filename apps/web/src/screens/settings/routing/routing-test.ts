import { ROUTING_PREVIEW_MAX, type RoutingTestResult } from "@/lib/api/routing-rules";

/**
 * "Test where an issue would go": the identifiers it takes, what decided each result and the
 * route's chain (`routed_by`) in words. Pure, so the card and its tests share them.
 */

/** Most work items one test with unsaved rules routes: one request each. */
export const ROUTING_TEST_STAGED_MAX = 10;

/** Most work items one test routes (the preview's limit). */
export const ROUTING_TEST_MAX = ROUTING_PREVIEW_MAX;

export const STAGED_LIMIT_MESSAGE = `Save your changes to test more than ${ROUTING_TEST_STAGED_MAX} work items at once.`;

export const TOO_MANY_MESSAGE = `Test at most ${ROUTING_TEST_MAX} work items at once.`;

/** A Linear work item identifier: a team key, a dash and a number (`ENG-123`). */
const IDENTIFIER = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

/** A typed identifier as it's sent: trimmed and upper-cased (team keys are). */
export function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase();
}

/** Why `value` can't be tested, or null. */
export function identifierError(value: string): string | null {
  return IDENTIFIER.test(normalizeIdentifier(value))
    ? null
    : `${value.trim()} isn't a work item identifier like ENG-123.`;
}

/** One tested work item: where it goes, or null when the tracker doesn't know it. */
export interface RoutingTestRow {
  identifier: string;
  result: RoutingTestResult | null;
}

const DEFAULT_RULE_LABELS = {
  1: "Default: follow-up of a work item",
  2: "Default: sub-issue of an epic",
  3: "Default: asks which repo",
} as const;

/** What decided a result: "Rule 2", "Work item match" or a default rule. */
export function decidedByLabel(result: Pick<RoutingTestResult, "matched" | "rule">): string {
  if (result.rule?.kind === "custom") return `Rule ${result.rule.number}`;
  if (result.rule?.kind === "default") return DEFAULT_RULE_LABELS[result.rule.number];
  return "Work item match";
}

/** One link of a `routed_by` chain as a verb phrase ("is a sub-issue of ENG-10"). */
function clause(part: string): string {
  const hop = /^(sub-issue|follow-up|story) of (.+)$/.exec(part);
  if (hop) return `is a ${hop[1]} of ${hop[2]}`;
  if (/^rule \d+/.test(part)) return `matched ${part}`;
  if (part.startsWith("work item match (")) return `matched the ${part}`;
  const tie = /^work item matches of (.+) tie$/.exec(part);
  if (tie) return `matched the work item matches of ${tie[1]} equally`;
  if (part === "your selection") return "went where someone picked";
  if (part === "its run") return "goes where its run builds";
  return `was routed by ${part}`;
}

/**
 * The route's chain (`sub-issue of ENG-10 → rule 2 (Team is ENG)`) as one sentence: "It is a
 * sub-issue of ENG-10, which matched rule 2 (Team is ENG)." Null (nothing decided it): no
 * rule, work item match or parent picks a repo.
 */
export function routedBySentence(by: string | null): string {
  if (!by) return "No rule, work item match or parent picks a repo for it.";
  const [first, ...rest] = by.split(" → ").map(clause);
  return `It ${first}${rest.map((part) => `, which ${part}`).join("")}.`;
}
