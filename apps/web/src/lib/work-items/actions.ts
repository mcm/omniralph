import "server-only";
import {
  clearWorkItemRepository,
  getActiveTriageRun,
  getRepository,
  getRunByIssue,
  recordWorkItemEvent,
  setWorkItemRepository,
  type Database,
  type WorkItemEventKind,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import { featureStartReason } from "@/lib/ralph/feature";
import { relationsStartReason } from "@/lib/ralph/relations";
import { trackerName } from "@/lib/tracker/adapters";
import { latestWorkItemRun, isActiveRunStatus } from "./detail";
import { groupFor } from "./group";
import { trackerCall, type ResolvedWorkItem } from "./item";
import { WorkItemConflictError, type TrackerKind } from "./tracker";

/**
 * The work item actions of the detail's toolbar and ⋯ menu. Each goes through the tracker
 * interface, records its `work_item_events` row (which records a live `work_item` change with
 * the item's ID, and so drops the organization's Backlog cache once committed), and answers
 * a conflict (409) or a refusal (400) without changing anything.
 */

/** Who acted: the member, by the name Activity shows. */
export interface WorkItemActor {
  userId: string | null;
  name: string;
}

export const alreadyTriagingMessage = (identifier: string) =>
  `Om is already triaging ${identifier}.`;
export const prdConflictMessage = (identifier: string, tracker: TrackerKind) =>
  `${identifier} changed in ${trackerName(tracker)} since you opened it.`;
export const runWorkingMessage = (identifier: string) =>
  `Om is working on ${identifier}. Edit the PRD when the run stops.`;
export const hasRunMessage = (identifier: string) => `Om already has a run for ${identifier}.`;
export const NOT_READY_MESSAGE = "Only a work item that's Ready to start can be started.";
export const REPOSITORY_INVALID_MESSAGE = "Choose a repo of this organization with Coding on.";

function record(
  db: Database,
  resolved: ResolvedWorkItem,
  actor: WorkItemActor,
  kind: WorkItemEventKind,
  detail: Record<string, unknown> = {},
) {
  return recordWorkItemEvent(db, {
    ...resolved.key,
    kind,
    actorUserId: actor.userId,
    actorName: actor.name,
    detail,
  });
}

/**
 * Start epic: delegates the item to Om, whose agent session webhook starts the run as a
 * delegation made in the tracker does (a blocked item's run waits for its blockers). Only a Ready
 * to start item without a run (409 with one, 400 otherwise), and never a feature: a work item
 * holding epics, or a task directly under one (400, `feature`), nor work whose blocks relations
 * break the dependency rules (400, `relations`).
 */
export async function startWorkItem(
  db: Database,
  resolved: ResolvedWorkItem,
  actor: WorkItemActor,
): Promise<void> {
  const { item, tracker, organization } = resolved;
  if (await getRunByIssue(db, organization.id, item.id)) {
    throw new ApiRouteError(409, hasRunMessage(item.identifier), "run_exists");
  }
  if (groupFor(item) !== "ready") throw new ApiRouteError(400, NOT_READY_MESSAGE, "not_ready");
  const feature = await trackerCall(tracker, `Reading ${item.identifier}'s sub-issues`, () =>
    tracker.feature(item.id),
  );
  if (feature) throw new ApiRouteError(400, featureStartReason(feature), "feature");
  const violations = await trackerCall(tracker, `Reading ${item.identifier}'s relations`, () =>
    tracker.relationViolations(item.id),
  );
  if (violations.length > 0) {
    throw new ApiRouteError(400, relationsStartReason(violations), "relations");
  }
  await trackerCall(tracker, `Delegating ${item.identifier}`, () =>
    tracker.delegateToOmniralph(item.id),
  );
  await record(db, resolved, actor, "started");
}

/** Triage now: starts Om's triage of the item; 409 while a triage is queued or running. */
export async function triageWorkItem(
  db: Database,
  resolved: ResolvedWorkItem,
  actor: WorkItemActor,
): Promise<void> {
  const { item, tracker, organization } = resolved;
  if (await getActiveTriageRun(db, organization.id, item.id)) {
    throw new ApiRouteError(409, alreadyTriagingMessage(item.identifier), "triage_running");
  }
  await trackerCall(tracker, `Starting triage of ${item.identifier}`, () =>
    tracker.startTriage(item.id),
  );
  await record(db, resolved, actor, "triage_requested");
}

/**
 * Edit PRD: writes the description unless the item changed in the tracker since
 * `baseUpdatedAt` (409, nothing written) or Om is working on it (409). Returns the item's
 * new `updatedAt`.
 */
export async function saveWorkItemPrd(
  db: Database,
  resolved: ResolvedWorkItem,
  actor: WorkItemActor,
  input: { markdown: string; baseUpdatedAt: string },
): Promise<{ updatedAt: string }> {
  const { item, tracker, organization } = resolved;
  const run = await latestWorkItemRun(db, organization.id, item.id);
  if (run && isActiveRunStatus(run.status)) {
    throw new ApiRouteError(409, runWorkingMessage(item.identifier), "run_active");
  }
  try {
    await tracker.update(
      item.id,
      { description: input.markdown },
      { ifUpdatedAt: input.baseUpdatedAt },
    );
  } catch (error) {
    if (error instanceof WorkItemConflictError) {
      throw new ApiRouteError(409, prdConflictMessage(item.identifier, tracker.kind), "conflict");
    }
    return trackerCall(tracker, `Saving the PRD of ${item.identifier}`, () =>
      Promise.reject(error),
    );
  }
  await record(db, resolved, actor, "prd_edited");
  const saved = await trackerCall(tracker, `Reading ${item.identifier}`, () =>
    tracker.get(item.id),
  );
  return { updatedAt: saved.updatedAt };
}

/**
 * Change repo…: saves the member's repo for the item (one of its organization's connected
 * repos with Coding on, else 400), or clears it (`null`) so the routing rules route it again.
 */
export async function setWorkItemRepositoryChoice(
  db: Database,
  resolved: ResolvedWorkItem,
  actor: WorkItemActor,
  repositoryId: string | null,
): Promise<{
  repository: { id: string; provider: "github" | "gitlab"; fullPath: string } | null;
}> {
  const { organization, key } = resolved;
  if (repositoryId === null) {
    if (await clearWorkItemRepository(db, key)) await record(db, resolved, actor, "repo_reset");
    return { repository: null };
  }
  const repository = await getRepository(db, repositoryId, organization.id);
  if (!repository || repository.disconnectedAt || !repository.codingEnabled) {
    throw new ApiRouteError(400, REPOSITORY_INVALID_MESSAGE, "invalid_repository");
  }
  const saved = await setWorkItemRepository(db, { ...key, repositoryId, userId: actor.userId });
  if (!saved) throw new ApiRouteError(400, REPOSITORY_INVALID_MESSAGE, "invalid_repository");
  await record(db, resolved, actor, "repo_changed", {
    repositoryId: repository.id,
    repository: repository.fullPath,
  });
  return {
    repository: {
      id: repository.id,
      provider: repository.provider,
      fullPath: repository.fullPath,
    },
  };
}

/** Move to Needs refining: the integration's mapped Needs-refining state. */
export async function moveWorkItemToNeedsRefining(
  db: Database,
  resolved: ResolvedWorkItem,
  actor: WorkItemActor,
): Promise<void> {
  const { item, tracker } = resolved;
  await trackerCall(tracker, `Moving ${item.identifier} to Needs refining`, () =>
    tracker.setState(item.id, { readiness: "needs_refining" }),
  );
  await record(db, resolved, actor, "moved_to_needs_refining");
}

/** Remove from backlog…: cancels the item in its tracker. */
export async function cancelWorkItem(
  db: Database,
  resolved: ResolvedWorkItem,
  actor: WorkItemActor,
): Promise<void> {
  const { item, tracker } = resolved;
  await trackerCall(tracker, `Canceling ${item.identifier}`, () => tracker.cancel(item.id));
  await record(db, resolved, actor, "canceled");
}
