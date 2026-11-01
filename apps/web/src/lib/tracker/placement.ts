/**
 * Where an issue sits in its tracker, for filing another issue next to it
 * (a story's follow-ups copy their story's placement).
 */
import type {
  CreateIssueInput,
  IssuePriority,
  IssueSummary,
  TrackerGateway,
} from "@omniralph/tracker";
import { trackerExtras } from "./adapters";

export interface IssuePlacement {
  teamId?: string;
  /** The project: by ID when known (else by name). */
  projectId?: string;
  projectName?: string;
  priority: IssuePriority;
  /** The issue's label names. */
  labels: string[];
  /**
   * Provider-specific fields an issue filed next to it copies as they are
   * (e.g. a project milestone and cycle); empty for trackers without any.
   */
  extras: Record<string, string>;
}

/** The issue's placement, read from its tracker. */
export async function readIssuePlacement(
  gateway: TrackerGateway,
  issueId: string,
): Promise<IssuePlacement> {
  const extras = trackerExtras(gateway);
  if (extras) return extras.issuePlacement(issueId);
  const issue = await gateway.getIssue(issueId);
  return {
    teamId: issue.teamId,
    ...(issue.projectId && { projectId: issue.projectId }),
    ...(issue.projectName && { projectName: issue.projectName }),
    priority: issue.priority,
    labels: issue.labels,
    extras: {},
  };
}

/**
 * Creates an issue with a placement's `extras`. Returns the extras later
 * issues should be filed with: fewer when the tracker refused one (e.g. a
 * completed cycle).
 */
export async function createIssueWithExtras(
  gateway: TrackerGateway,
  input: CreateIssueInput,
  extras: Record<string, string>,
): Promise<{ issue: IssueSummary; extras: Record<string, string> }> {
  const provider = trackerExtras(gateway);
  if (provider) return provider.createIssueWithExtras(input, extras);
  return { issue: await gateway.createIssue(input), extras };
}
