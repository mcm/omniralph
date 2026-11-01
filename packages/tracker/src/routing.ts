import type { IssueWithBlockers } from "./types.js";

/**
 * An issue's values of the fields routing rules test: the team by key, the
 * cycle and people by ID, the parent by identifier, the rest by name. Null
 * where the issue has none, or its tracker has no such field (milestones,
 * cycles, estimates and due dates are not every tracker's).
 */
export interface RoutingIssueFields {
  id: string;
  identifier: string;
  title: string;
  description: string;
  team: string | null;
  project: string | null;
  projectMilestone: string | null;
  cycle: string | null;
  state: string | null;
  stateType: string | null;
  /** 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority: number;
  assignee: string | null;
  creator: string | null;
  /** The parent's identifier (`ENG-10`). */
  parent: string | null;
  /** The parent's ID. */
  parentId: string | null;
  labels: string[];
  estimate: number | null;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
  /** The team's, project's and milestone's IDs (not routing fields: a follow-up copies them). */
  teamId: string | null;
  projectId: string | null;
  projectMilestoneId: string | null;
}

/** An issue's routing fields and its parent's. */
export interface RoutingIssue {
  issue: RoutingIssueFields;
  parent: RoutingIssueFields | null;
}

/** A listed issue with its blockers and, when the tracker read them in the same query, its routing fields. */
export interface IssueWithRouting extends IssueWithBlockers {
  routing?: RoutingIssue;
}

/** The team key and number of an issue identifier (`ENG-12`), or null. */
export function parseIssueIdentifier(
  identifier: string,
): { teamKey: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*)-(\d{1,9})$/.exec(identifier.trim());
  return match ? { teamKey: match[1]!.toUpperCase(), number: Number(match[2]) } : null;
}
