import { workItemRole } from "@omniralph/planning";
import type { IssueSummary, TrackerGateway } from "@omniralph/tracker";
import { joinNames } from "@/lib/work-items/join-names";

/** The tracker reads the feature check needs. */
export type FeatureReader = Pick<TrackerGateway, "getIssue" | "getChildren">;

/** A feature a run would build: the work item and its epics (sub-issues with sub-issues). */
export interface FeatureFound {
  feature: Pick<IssueSummary, "id" | "identifier">;
  /** The identifiers of its epics, in the tracker's order. */
  epics: string[];
  /** The work item asked for, when it isn't the feature itself (a task directly under it). */
  via?: Pick<IssueSummary, "id" | "identifier">;
}

const open = (issue: IssueSummary) => issue.stateType !== "canceled";

/** `issue` as a feature (with its epics), or null when its role is task or epic. */
async function asFeature(
  reader: FeatureReader,
  issue: IssueSummary,
  children?: IssueSummary[],
): Promise<FeatureFound | null> {
  const subIssues = (children ?? (await reader.getChildren(issue.id))).filter(open);
  if (subIssues.length === 0) return null;
  const grandchildren = await Promise.all(
    subIssues.map(async (child) => (await reader.getChildren(child.id)).filter(open)),
  );
  const role = workItemRole(issue, subIssues, grandchildren.flat());
  if (role.role !== "feature") return null;
  const epics = subIssues.filter((_, index) => grandchildren[index]!.length > 0);
  return { feature: issue, epics: epics.map((epic) => epic.identifier) };
}

/**
 * The feature a run of `issueId` would build, or null. A run builds the work item
 * itself when it has (open) sub-issues, else its parent (a task delegated on its
 * own is a story of its parent's epic), as `loadEpic` does; that work item is a
 * feature when one of its sub-issues has sub-issues of its own. Throws when the
 * tracker can't be read.
 */
export async function featureToRun(
  reader: FeatureReader,
  issueId: string,
): Promise<FeatureFound | null> {
  const issue = await reader.getIssue(issueId);
  const children = await reader.getChildren(issue.id);
  if (children.some(open)) return asFeature(reader, issue, children);
  if (!issue.parentId) return null;
  const found = await asFeature(reader, await reader.getIssue(issue.parentId));
  return found ? { ...found, via: issue } : null;
}

const epicList = (found: FeatureFound, bold: boolean) =>
  found.epics.length > 0
    ? ` (${joinNames(found.epics.map((epic) => (bold ? `**${epic}**` : epic)))})`
    : "";

/** What the feature is and what to do instead, in Markdown (`bold`) or plain text. */
function featureReason(found: FeatureFound, bold: boolean, then: string): string {
  const name = (identifier: string) => (bold ? `**${identifier}**` : identifier);
  const feature = name(found.feature.identifier);
  if (found.via) {
    return (
      `${name(found.via.identifier)} is a task directly under ${feature}, which is a feature: ` +
      `it holds epics${epicList(found, bold)}. Each epic is started on its own: ` +
      `move ${name(found.via.identifier)} into one of them, or ${then}.`
    );
  }
  return (
    `${feature} is a feature: it holds epics${epicList(found, bold)}. ` +
    `Each epic is started on its own: ${then}.`
  );
}

/** The response refusing to build a feature (in the tracker session). */
export function featureMessage(found: FeatureFound): string {
  return `I won't build this. ${featureReason(found, true, "delegate each epic to me instead")}`;
}

/** Why Start is refused (and disabled) for a feature on the work item page. */
export function featureStartReason(found: FeatureFound): string {
  return featureReason(found, false, "start each epic instead");
}
