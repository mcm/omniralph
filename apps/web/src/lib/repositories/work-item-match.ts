import "server-only";
import {
  listOtherWorkItemMatches,
  WorkItemMatchRequiredError,
  type Database,
  type WorkItemMatch,
  type WorkItemMatchFields,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import type { CodingMatchWarning } from "@/lib/api/repositories";
import type { WorkItemMatchRow } from "@/lib/api/work-item-matches";
import { matchesConflict } from "@/lib/routing/match";

/** Answered (409) when Coding is turned on for a repository without a work item match. */
export const ADD_WORK_ITEM_MATCH_FIRST = "Add a work item match before turning on Coding.";
/** Answered (409) when the match of a repository whose Coding is on is cleared. */
export const TURN_OFF_CODING_FIRST = "Turn off Coding before removing the work item match.";

/**
 * Runs `save`, answering 409 when it would leave the repository with Coding on and no work item
 * match (`WorkItemMatchRequiredError`): nothing is saved.
 */
export async function refusingCodingWithoutMatch<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if (!(error instanceof WorkItemMatchRequiredError)) throw error;
    throw error.action === "turn_on_coding"
      ? new ApiRouteError(409, ADD_WORK_ITEM_MATCH_FIRST, "work_item_match_required")
      : new ApiRouteError(409, TURN_OFF_CODING_FIRST, "coding_enabled");
  }
}

/** Answered when the match's tracker isn't connected. */
export const TRACKER_NOT_CONNECTED = "Connect Linear in Integrations to match work items.";

/** A saved match on the wire. */
export function workItemMatchRow(match: WorkItemMatch): WorkItemMatchRow {
  return {
    tracker: match.tracker,
    team: match.team,
    project: match.project,
    withoutProject: match.withoutProject,
    labels: match.labels,
    updatedAt: match.updatedAt.toISOString(),
  };
}

/** The warning about `fullPath`'s match, which conflicts with this repo's. */
export const conflictMessage = (fullPath: string) =>
  `${fullPath} matches the same work items, so Om will ask which repo to use.`;

/**
 * The organization's other connected repositories whose matches conflict with `match` for
 * `repositoryId` (`matchesConflict`): a work item both match asks which repo to use.
 */
export async function matchConflicts(
  db: Database,
  organizationId: string,
  repositoryId: string,
  match: WorkItemMatchFields,
): Promise<CodingMatchWarning[]> {
  const others = await listOtherWorkItemMatches(db, organizationId, repositoryId);
  return others.flatMap((other): CodingMatchWarning[] =>
    matchesConflict(match, other)
      ? [
          {
            id: other.repositoryId,
            fullPath: other.fullPath,
            provider: other.provider,
            message: conflictMessage(other.fullPath),
          },
        ]
      : [],
  );
}
