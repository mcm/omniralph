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
import type { RepositorySettingsInput } from "@omniralph/shared";
import { BUILTIN_TASKS, getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
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
  | { status: "unknown_review_tasks"; taskIds: string[] };

/** The review tasks a repository can choose to run on its PRs/MRs: the built-in ones. */
export function reviewTaskChoices(): TaskDefinition[] {
  return BUILTIN_TASKS.filter((task) => task.taskType === "review");
}

/**
 * Saves a repository's review settings (a repository of the organization; its profile
 * must be one of the organization's too, and its review tasks built-in tasks of the
 * `review` type) (validated with `RepositorySettingsInput`) and reconciles its agent pins: newly pinned agents go through the Agents
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
  const unknownTasks = input.reviewTaskIds.filter(
    (id) => getBuiltinTask(id)?.taskType !== "review",
  );
  if (unknownTasks.length > 0) return { status: "unknown_review_tasks", taskIds: unknownTasks };

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
