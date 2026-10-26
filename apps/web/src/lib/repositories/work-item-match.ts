import "server-only";
import {
  deleteWorkItemMatch,
  getIntegration,
  getRepositoryWithConnection,
  listOtherWorkItemMatches,
  saveWorkItemMatch,
  WorkItemMatchRequiredError,
  type Database,
  type WorkItemMatch,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import type {
  SavedWorkItemMatch,
  WorkItemMatchInput,
  WorkItemMatchRow,
  WorkItemMatchWarning,
} from "@/lib/api/work-item-matches";
import { describeMatch, matchesConflict } from "@/lib/routing/match";

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

/** The warning for `fullPath`'s overlapping match. */
export const conflictMessage = (fullPath: string, match: WorkItemMatch) =>
  `The work item match of ${fullPath} (${describeMatch(match)}) overlaps this one: a work item both match asks which repo to use.`;

/**
 * Saves (or, with `match` null, clears) the organization's connected repository's work item
 * match. Clearing needs its Coding off (409 otherwise). Saving needs its tracker connected; the answer warns about every other repository
 * whose match overlaps it (`matchesConflict`).
 */
export async function saveRepositoryWorkItemMatch(
  db: Database,
  input: {
    organizationId: string;
    repositoryId: string;
    userId: string;
    match: WorkItemMatchInput | null;
  },
): Promise<SavedWorkItemMatch> {
  const { organizationId, repositoryId, userId, match } = input;
  const found = await getRepositoryWithConnection(db, repositoryId, organizationId);
  if (!found || found.repository.disconnectedAt) throw ApiRouteError.notFound();

  if (match === null) {
    await refusingCodingWithoutMatch(() => deleteWorkItemMatch(db, organizationId, repositoryId));
    return { ok: true, workItemMatch: null, warnings: [] };
  }

  if (!(await getIntegration(db, organizationId, match.tracker))) {
    throw new ApiRouteError(409, TRACKER_NOT_CONNECTED, "tracker_not_connected");
  }
  const saved = await saveWorkItemMatch(db, { organizationId, repositoryId, userId, match });
  if (!saved) throw ApiRouteError.notFound();
  const others = await listOtherWorkItemMatches(db, organizationId, repositoryId);
  const warnings = others.flatMap((other): WorkItemMatchWarning[] =>
    matchesConflict(saved, other)
      ? [
          {
            repositoryId: other.repositoryId,
            fullPath: other.fullPath,
            message: conflictMessage(other.fullPath, other),
          },
        ]
      : [],
  );
  return { ok: true, workItemMatch: workItemMatchRow(saved), warnings };
}
