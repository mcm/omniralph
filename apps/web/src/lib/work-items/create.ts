import "server-only";
import {
  getOrganization,
  getRepository,
  getWorkItemMatch,
  recordWorkItemEvent,
  workItemUrlId,
  type Database,
  type Repository,
} from "@omniralph/db";
import type { WorkItemRow } from "@/lib/api/work-items";
import { dropBacklogCache } from "./backlog-cache";
import { getWorkItemTracker } from "./get-tracker";
import { groupFor } from "./group";
import {
  TrackerNotConnectedError,
  WorkItemProjectNotFoundError,
  type WorkItem,
  type WorkItemTracker,
} from "./tracker";

/**
 * The create work item service: adds a work item to the Backlog in the team, project and
 * labels of a repo's work item match, through the tracker interface, optionally asking Om to
 * triage it at once. The Backlog's + (`POST /api/ui/work-items`) and Ask's "Add to backlog"
 * both call it, each with its own actor, so it depends on no request, session or cookie.
 */

/** Longest title a work item may have. */
export const WORK_ITEM_TITLE_MAX = 255;

/** Who creates the item: a member, or whoever a chat surface acts for. */
export interface CreateWorkItemActor {
  userId: string | null;
  /** The name Activity shows ("Steve created it"). */
  name: string;
}

export interface CreateWorkItemInput {
  organizationId: string;
  /** The repo the item is for: its work item match says where it's created. */
  repositoryId: string;
  title: string;
  /** Markdown; may be empty. */
  description: string;
  /** Ask Om to triage the item once it's created. */
  triageNow: boolean;
  actor: CreateWorkItemActor;
  /** Where it was created: the Backlog's + or Ask. */
  origin: "backlog" | "ask";
}

export interface CreateWorkItemDeps {
  db: Database;
  /** The organization's tracker (default `getWorkItemTracker`). */
  getTracker?: (organizationId: string) => Promise<WorkItemTracker>;
}

/** The created item's Backlog row: the organization without the reader's role. */
export type CreatedWorkItemRow = Omit<WorkItemRow, "organization"> & {
  organization: { id: string; name: string };
};

export type CreateWorkItemErrorCode =
  | "invalid"
  | "repository_not_found"
  | "coding_off"
  | "no_work_item_match"
  | "tracker_not_connected"
  | "tracker_failed";

export type CreateWorkItemResult =
  | {
      ok: true;
      item: CreatedWorkItemRow;
      /**
       * Triage now: `started`, or `failed` (the item exists; `triageError` says why), or
       * null when it wasn't asked for.
       */
      triage: "started" | "failed" | null;
      triageError?: string;
    }
  | { ok: false; code: CreateWorkItemErrorCode; message: string };

export const TITLE_REQUIRED_MESSAGE = "Give the work item a title.";
export const TITLE_TOO_LONG_MESSAGE = `Keep the title to ${WORK_ITEM_TITLE_MAX} characters.`;
export const REPOSITORY_NOT_FOUND_MESSAGE = "That repo doesn't exist.";
export const TRACKER_NOT_CONNECTED_MESSAGE = "Connect Linear to add work items.";
export const CREATE_FAILED_MESSAGE = "Linear didn't answer. Try again in a moment.";
export const TRIAGE_FAILED_MESSAGE =
  "Om couldn't start triage because Linear didn't answer. Use Triage now to try again.";
export const noWorkItemMatchMessage = (repo: string) => `${repo} doesn't pick up work items yet.`;
export const codingOffMessage = (repo: string) => `Coding is off for ${repo}.`;
export const unknownTeamMessage = (team: string) => `Linear has no team ${team}.`;
export const unknownProjectMessage = (project: string) => `Linear has no project ${project}.`;

/** A repo by its name, the last segment of its path (`customer-portal`). */
const repoName = (repository: Pick<Repository, "fullPath">) =>
  repository.fullPath.split("/").pop() ?? repository.fullPath;

const failure = (code: CreateWorkItemErrorCode, message: string): CreateWorkItemResult => ({
  ok: false,
  code,
  message,
});

/**
 * Creates a work item for `repositoryId` (a connected repo of the organization with Coding on
 * and a work item match): in the match's team, project (none for a "no project" match) and
 * labels, never delegated. Records `created` with the origin and drops the organization's
 * Backlog cache. With `triageNow`, starts Om's triage of it; a triage that fails to start
 * still returns the created item, with `triage: "failed"`.
 */
export async function createWorkItem(
  deps: CreateWorkItemDeps,
  input: CreateWorkItemInput,
): Promise<CreateWorkItemResult> {
  const { db } = deps;
  const { organizationId } = input;
  const title = input.title.trim();
  if (!title) return failure("invalid", TITLE_REQUIRED_MESSAGE);
  if (title.length > WORK_ITEM_TITLE_MAX) return failure("invalid", TITLE_TOO_LONG_MESSAGE);

  const repository = await getRepository(db, input.repositoryId, organizationId);
  if (!repository || repository.disconnectedAt) {
    return failure("repository_not_found", REPOSITORY_NOT_FOUND_MESSAGE);
  }
  if (!repository.codingEnabled)
    return failure("coding_off", codingOffMessage(repoName(repository)));
  const match = await getWorkItemMatch(db, organizationId, repository.id);
  if (!match || match.tracker !== "linear") {
    return failure("no_work_item_match", noWorkItemMatchMessage(repoName(repository)));
  }

  const getTracker =
    deps.getTracker ?? ((orgId: string) => getWorkItemTracker({ db, organizationId: orgId }));
  let item: WorkItem;
  let tracker: WorkItemTracker;
  try {
    tracker = await getTracker(organizationId);
    const teamKey = match.team.toLowerCase();
    const team = (await tracker.listTeams()).find((t) => t.key.toLowerCase() === teamKey);
    if (!team) return failure("tracker_failed", unknownTeamMessage(match.team));
    item = await tracker.create({
      teamId: team.id,
      ...(!match.withoutProject && match.project !== null && { projectName: match.project }),
      ...(match.labels.length > 0 && { labels: [...match.labels] }),
      title,
      description: input.description,
    });
  } catch (error) {
    if (error instanceof TrackerNotConnectedError) {
      return failure("tracker_not_connected", TRACKER_NOT_CONNECTED_MESSAGE);
    }
    if (error instanceof WorkItemProjectNotFoundError) {
      return failure("tracker_failed", unknownProjectMessage(error.projectName));
    }
    console.error(`Creating a work item for repository ${repository.id} failed`, error);
    return failure("tracker_failed", CREATE_FAILED_MESSAGE);
  }

  const key = { organizationId, tracker: item.tracker, externalId: item.id };
  const actor = { actorUserId: input.actor.userId, actorName: input.actor.name };
  await recordWorkItemEvent(db, {
    ...key,
    ...actor,
    kind: "created",
    detail: { origin: input.origin, repositoryId: repository.id, repository: repository.fullPath },
  });

  let triage: "started" | "failed" | null = null;
  if (input.triageNow) {
    try {
      await tracker.startTriage(item.id);
      triage = "started";
      await recordWorkItemEvent(db, {
        ...key,
        ...actor,
        kind: "triage_requested",
        detail: { origin: input.origin },
      });
    } catch (error) {
      console.error(`Starting triage of ${item.identifier} failed`, error);
      triage = "failed";
    }
  }
  // The events drop the cache once committed; a caller outside a request collects none.
  await dropBacklogCache(organizationId);

  const organization = await getOrganization(db, organizationId);
  return {
    ok: true,
    item: {
      id: workItemUrlId(item.tracker, item.id),
      tracker: item.tracker,
      identifier: item.identifier,
      title: item.title,
      url: item.url,
      organization: { id: organizationId, name: organization?.name ?? "" },
      repository: {
        id: repository.id,
        provider: repository.provider,
        fullPath: repository.fullPath,
      },
      size: null,
      // A new item in a state of neither readiness (e.g. Triage) shows in Needs refining.
      group: groupFor(item) ?? "refine",
      blocked: item.blocked,
      blockers: item.blockedBy.map((blocker) => blocker.identifier),
      triageRunning: triage === "started",
      source: item.project
        ? { kind: "project", id: item.project.id ?? item.project.name, name: item.project.name }
        : { kind: "team", id: item.team.id, name: item.team.key },
    },
    triage,
    ...(triage === "failed" && { triageError: TRIAGE_FAILED_MESSAGE }),
  };
}
