import "server-only";
import {
  filterActiveHarnessIds,
  getRepository,
  listRepositoryPinnedHarnessIds,
  listReviewProfiles,
  unpinRepositoryFromHarness,
  updateRepositorySettings,
  type Database,
} from "@omniralph/db";
import type { FieldErrors, RalphSettingsInput, RepositorySettingsInput } from "@omniralph/shared";
import {
  CORRELATION_TASKS,
  getTaskChoice,
  REQUEST_TASKS,
  REVIEW_TASKS,
  STORY_TASKS,
} from "@/lib/definitions";
import { pinRepository } from "@/lib/harnesses/pins";
import type { JobDispatcher } from "@/lib/dispatch";

export type SaveRepositorySettingsResult =
  | {
      status: "saved";
      pinnedHarnessIds: string[];
      unpinnedHarnessIds: string[];
      /** `repo.sync` jobs enqueued for the newly pinned harnesses. */
      syncJobIds: string[];
    }
  | { status: "unknown_repository" }
  | { status: "unknown_profile" }
  | { status: "unknown_agents"; harnessIds: string[] }
  | { status: "unknown_review_tasks"; taskIds: string[] }
  | { status: "unknown_correlation_task" };

/**
 * Saves a repository's review settings (a repository of the organization; its profile
 * must be one of the organization's too, its review tasks tasks of the organization
 * (built-in or its own) passing `REVIEW_TASKS`, and its correlation task one passing
 * `CORRELATION_TASKS`) (validated with `RepositorySettingsInput`) and reconciles its agent pins: newly pinned agents go through the Agents
 * page's `pinRepository`, which enqueues a `repo.sync` job for that agent.
 * The next review job enqueued for the repository picks the settings up.
 */
export async function saveRepositorySettings(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  repositoryId: string,
  input: RepositorySettingsInput,
): Promise<SaveRepositorySettingsResult> {
  // Only the organization's repositories, with one of its own profiles.
  if (!(await getRepository(db, repositoryId, organizationId))) {
    return { status: "unknown_repository" };
  }
  const profiles = await listReviewProfiles(db, organizationId);
  if (!profiles.some((p) => p.id === input.profileId)) return { status: "unknown_profile" };
  const reviewTasks = await Promise.all(
    input.reviewTaskIds.map((id) => getTaskChoice(db, organizationId, id, REVIEW_TASKS)),
  );
  const unknownTasks = input.reviewTaskIds.filter((_, i) => !reviewTasks[i]);
  if (unknownTasks.length > 0) return { status: "unknown_review_tasks", taskIds: unknownTasks };
  if (!(await getTaskChoice(db, organizationId, input.correlationTaskId, CORRELATION_TASKS))) {
    return { status: "unknown_correlation_task" };
  }

  const wanted = [...new Set(input.pinnedHarnessIds)];
  const current = await listRepositoryPinnedHarnessIds(db, repositoryId);
  const added = wanted.filter((id) => !current.includes(id));
  const active = await filterActiveHarnessIds(db, organizationId, added);
  const unknown = added.filter((id) => !active.has(id));
  if (unknown.length > 0) return { status: "unknown_agents", harnessIds: unknown };

  const saved = await updateRepositorySettings(db, organizationId, repositoryId, {
    profileId: input.profileId,
    triggers: input.triggers,
    pathExcludes: input.pathExcludes,
    customInstructions: input.customInstructions,
    reviewTaskIds: input.reviewTaskIds,
    correlationTaskId: input.correlationTaskId,
  });
  if (!saved) return { status: "unknown_repository" };

  const syncJobIds: string[] = [];
  for (const harnessId of added) {
    const { result, syncJobId } = await pinRepository(db, dispatcher, { harnessId, repositoryId });
    if (result === "unknown_agent") return { status: "unknown_agents", harnessIds: [harnessId] };
    if (result === "unknown_repository") return { status: "unknown_repository" };
    if (syncJobId) syncJobIds.push(syncJobId);
  }
  const removed = current.filter((id) => !wanted.includes(id));
  for (const harnessId of removed) {
    await unpinRepositoryFromHarness(db, { harnessId, repositoryId });
  }
  return { status: "saved", pinnedHarnessIds: added, unpinnedHarnessIds: removed, syncJobIds };
}

/**
 * Field errors of a Ralph form's story and request tasks: each must be a task
 * of the organization (built-in or its own) passing `STORY_TASKS` / `REQUEST_TASKS`.
 */
export async function ralphTaskErrors(
  db: Database,
  organizationId: string,
  input: Pick<RalphSettingsInput, "storyTaskId" | "requestTaskId">,
): Promise<FieldErrors> {
  const [story, request] = await Promise.all([
    getTaskChoice(db, organizationId, input.storyTaskId, STORY_TASKS),
    getTaskChoice(db, organizationId, input.requestTaskId, REQUEST_TASKS),
  ]);
  return {
    ...(!story && {
      storyTaskId: "Choose a coding task of this organization that accepts linear.delegated.",
    }),
    ...(!request && {
      requestTaskId:
        "Choose a coding task of this organization that accepts every request trigger.",
    }),
  };
}
