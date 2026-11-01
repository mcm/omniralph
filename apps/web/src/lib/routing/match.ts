/**
 * Work item matches: a repository's own condition on the work items it builds. A match sets a
 * tracker and a team, and optionally a project (or "no project") and labels (any of them).
 * Team, project and labels compare ignoring case. When several repositories match a work
 * item, the most specific one wins (`specificity`); a tie asks.
 */
import type { WorkItemMatchFields } from "@omniralph/db";
import type { RoutingIssueFields } from "@omniralph/tracker/linear";

/** A work item's fields a match tests: the team's key, the project's name and label names. */
export type WorkItemValues = Pick<RoutingIssueFields, "team" | "project" | "labels">;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const normalized = (labels: readonly string[]) => new Set(labels.map((l) => l.toLowerCase()));

/** Whether `values` (a Linear work item's) satisfy `match`. */
export function matchesWorkItem(match: WorkItemMatchFields, values: WorkItemValues): boolean {
  if (match.tracker !== "linear") return false;
  if (!values.team || !same(match.team, values.team)) return false;
  if (match.withoutProject) {
    if (values.project) return false;
  } else if (match.project !== null) {
    if (!values.project || !same(match.project, values.project)) return false;
  }
  if (match.labels.length > 0) {
    const wanted = normalized(match.labels);
    if (!values.labels.some((label) => wanted.has(label.toLowerCase()))) return false;
  }
  return true;
}

/**
 * How specific a match is, beyond its tracker and team (0): a project or "no project" adds 1,
 * labels add 1.
 */
export function specificity(match: WorkItemMatchFields): number {
  return (
    (match.withoutProject || match.project !== null ? 1 : 0) + (match.labels.length > 0 ? 1 : 0)
  );
}

/** A match in words: `Team is SOC, label product:portal`. */
export function describeMatch(match: WorkItemMatchFields): string {
  const parts = [`Team is ${match.team}`];
  if (match.withoutProject) parts.push("no project");
  else if (match.project !== null) parts.push(`project ${match.project}`);
  if (match.labels.length === 1) parts.push(`label ${match.labels[0]}`);
  else if (match.labels.length > 1) parts.push(`any label of ${match.labels.join(", ")}`);
  return parts.join(", ");
}

const TRACKER_NAMES: Record<WorkItemMatchFields["tracker"], string> = { linear: "Linear" };

/**
 * A match as the Coding card's sentence reads it: `Linear team SOC, label product:portal`,
 * `Linear team MOD, no project`, `Linear team ENG, project Portal, label ui or web`.
 */
export function matchSentence(match: WorkItemMatchFields): string {
  const parts = [`${TRACKER_NAMES[match.tracker]} team ${match.team}`];
  if (match.withoutProject) parts.push("no project");
  else if (match.project !== null) parts.push(`project ${match.project}`);
  if (match.labels.length > 0) parts.push(`label ${match.labels.join(" or ")}`);
  return parts.join(", ");
}

/** `routed_by` of a route by a work item match: `work item match (Team is SOC, label product:portal)`. */
export function describeMatchRoute(match: WorkItemMatchFields): string {
  return `work item match (${describeMatch(match)})`;
}

/** `routed_by` of a tie between the matches of `fullPaths`, which asks. */
export function describeMatchTie(fullPaths: readonly string[]): string {
  return `work item matches of ${fullPaths.join(", ")} tie`;
}

/**
 * Whether two matches overlap so that a work item could match both at the same specificity:
 * the same tracker, team and project condition, and label sets that intersect (or are both
 * empty).
 */
export function matchesConflict(a: WorkItemMatchFields, b: WorkItemMatchFields): boolean {
  if (a.tracker !== b.tracker || !same(a.team, b.team)) return false;
  if (a.withoutProject !== b.withoutProject) return false;
  if (!a.withoutProject) {
    if ((a.project === null) !== (b.project === null)) return false;
    if (a.project !== null && b.project !== null && !same(a.project, b.project)) return false;
  }
  if (a.labels.length === 0 || b.labels.length === 0) {
    return a.labels.length === 0 && b.labels.length === 0;
  }
  const labels = normalized(a.labels);
  return b.labels.some((label) => labels.has(label.toLowerCase()));
}
