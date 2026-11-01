/**
 * The fields routing rules test, read from any tracker: an adapter with routing
 * extras returns them in one query; other trackers build them from the issue and its parent, without
 * the fields they don't have (milestones, cycles, estimates, due dates).
 */
import type {
  IssueSummary,
  RoutingIssue,
  RoutingIssueFields,
  TrackerGateway,
  TrackerProvider,
} from "@omniralph/tracker";
import { trackerExtras } from "./adapters";

/** Reads an issue's routing fields and its parent's in one go (e.g. a cache over a tracker). */
export interface RoutingRead {
  routingIssue(idOrIdentifier: string): Promise<RoutingIssue>;
}

/** What routing reads an issue's fields from: any tracker, or just a routing read. */
export type RoutingSource = TrackerGateway | RoutingRead;

/** A routing read, not a gateway (a gateway has its provider; a lazy one answers any method). */
function isRoutingRead(source: RoutingSource): source is RoutingRead {
  return typeof (source as Partial<TrackerGateway>).provider !== "string";
}

/** The source's tracker provider, or undefined for a routing read (which doesn't say). */
export function routingSourceProvider(source: RoutingSource): TrackerProvider | undefined {
  return isRoutingRead(source) ? undefined : source.provider;
}

/** An issue's routing field values and its parent's. */
export async function readRoutingIssue(
  gateway: RoutingSource,
  idOrIdentifier: string,
): Promise<RoutingIssue> {
  if (isRoutingRead(gateway)) return gateway.routingIssue(idOrIdentifier);
  const extras = trackerExtras(gateway);
  if (extras) return extras.routingIssue(idOrIdentifier);
  const issue = await gateway.getIssue(idOrIdentifier);
  const parent = issue.parentId ? await gateway.getIssue(issue.parentId) : null;
  const grandparent =
    parent?.parentId !== undefined ? { identifier: null, id: parent.parentId } : null;
  return {
    issue: routingFieldsOf(issue, parent && { identifier: parent.identifier, id: parent.id }),
    parent: parent && routingFieldsOf(parent, grandparent),
  };
}

/** The routing fields of an issue on a tracker without routing extras. */
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
