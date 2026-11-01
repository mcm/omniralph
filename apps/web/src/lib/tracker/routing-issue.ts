/**
 * The fields routing rules test, read from any tracker: Linear returns them in
 * one query; other trackers build them from the issue and its parent, without
 * the fields they don't have (milestones, cycles, estimates, due dates).
 */
import type { IssueSummary, TrackerGateway } from "@omniralph/tracker";
import type { LinearGateway, RoutingIssue, RoutingIssueFields } from "@omniralph/tracker/linear";

/** What routing reads an issue's fields from: any tracker, or just Linear's routing read. */
export type RoutingSource = TrackerGateway | Pick<LinearGateway, "getRoutingFields">;

function hasRoutingRead(source: RoutingSource): source is Pick<LinearGateway, "getRoutingFields"> {
  return typeof (source as Partial<LinearGateway>).getRoutingFields === "function";
}

/** An issue's routing field values and its parent's. */
export async function readRoutingIssue(
  gateway: RoutingSource,
  idOrIdentifier: string,
): Promise<RoutingIssue> {
  if (hasRoutingRead(gateway)) return gateway.getRoutingFields(idOrIdentifier);
  const issue = await gateway.getIssue(idOrIdentifier);
  const parent = issue.parentId ? await gateway.getIssue(issue.parentId) : null;
  const grandparent =
    parent?.parentId !== undefined ? { identifier: null, id: parent.parentId } : null;
  return {
    issue: routingFieldsOf(issue, parent && { identifier: parent.identifier, id: parent.id }),
    parent: parent && routingFieldsOf(parent, grandparent),
  };
}

/** The routing fields of an issue on a tracker without Linear's extras. */
export function routingFieldsOf(
  issue: IssueSummary,
  parent: { identifier: string | null; id: string } | null,
): RoutingIssueFields {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    team: issue.teamKey || null,
    project: issue.projectName ?? null,
    projectMilestone: null,
    cycle: null,
    state: issue.stateName || null,
    stateType: issue.stateType,
    priority: issue.priority,
    assignee: issue.assigneeId ?? null,
    creator: issue.creator?.id ?? null,
    parent: parent?.identifier ?? null,
    parentId: parent?.id ?? null,
    labels: issue.labels,
    estimate: null,
    dueDate: null,
    teamId: issue.teamId,
    projectId: issue.projectId ?? null,
    projectMilestoneId: null,
  };
}
