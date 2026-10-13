import "server-only";
import {
  filterActiveHarnessIds,
  getRepository,
  listRepositoryPinnedHarnessIds,
  listReviewProfiles,
  unpinRepositoryFromHarness,
  updateRepositorySettings,
  type Database,
  type Repository,
} from "@omniralph/db";
import {
  parseRalphSettings,
  type FieldErrors,
  type RalphSettingsInput,
  type RepositorySettingsInput,
} from "@omniralph/shared";
import {
  CORRELATION_TASKS,
  getTaskChoice,
  REQUEST_TASKS,
  REVIEW_TASKS,
  STORY_TASKS,
} from "@/lib/definitions";
import { pinRepository } from "@/lib/harnesses/pins";
import { getLinearSettingsOptions } from "@/lib/linear/settings-options";
import { unknownLinearValues } from "@/lib/linear/settings-values";
import { repositoryManualLabels } from "@/lib/ralph/epic-loader";
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

/** The Linear routing values a repository has saved, as the Coding tab shows them. */
type SavedLinearValues = Pick<
  Repository,
  "linearTeamKeys" | "linearProjectNames" | "linearLabels" | "ralphSettings"
>;

/** `values` not in `saved`, ignoring case. */
function newValues(values: readonly string[], saved: readonly string[]): string[] {
  const have = new Set(saved.map((v) => v.toLowerCase()));
  return values.filter((v) => !have.has(v.toLowerCase()));
}

function notInWorkspace(values: readonly string[], what: string): string {
  const list = values.map((v) => `“${v}”`).join(", ");
  return values.length === 1
    ? `${list} isn't a ${what} in your Linear workspace.`
    : `${list} aren't ${what}s in your Linear workspace.`;
}

/**
 * Field errors of a Coding form's Linear values: each label, project, team key, manual label
 * and the epic completed state must exist in the organization's connected Linear workspace.
 * Values the repository already has saved are kept even when they went stale (a renamed label
 * stays until a person removes it); only new ones are checked. Without a connected workspace
 * nothing is checked. `"unavailable"` when the workspace couldn't be read.
 */
export async function ralphLinearErrors(
  organizationId: string,
  saved: SavedLinearValues,
  input: Pick<
    RalphSettingsInput,
    "linearTeamKeys" | "linearProjectNames" | "linearLabels" | "manualLabels" | "epicCompletedState"
  >,
): Promise<FieldErrors | "unavailable"> {
  const savedEpicState = parseRalphSettings(saved.ralphSettings).epicCompletedState ?? "";
  const epicState = input.epicCompletedState.trim();
  const added = {
    labels: newValues(input.linearLabels, saved.linearLabels),
    projects: newValues(input.linearProjectNames, saved.linearProjectNames),
    teamKeys: newValues(input.linearTeamKeys, saved.linearTeamKeys),
    manualLabels: newValues(input.manualLabels, repositoryManualLabels(saved)),
    epicCompletedState:
      epicState.toLowerCase() === savedEpicState.trim().toLowerCase() ? null : epicState,
  };
  const anyAdded =
    added.labels.length + added.projects.length + added.teamKeys.length > 0 ||
    added.manualLabels.length > 0 ||
    Boolean(added.epicCompletedState);
  if (!anyAdded) return {};
  let options;
  try {
    options = await getLinearSettingsOptions(organizationId);
  } catch {
    return "unavailable";
  }
  if (!options) return {};
  const unknown = unknownLinearValues(options, added);
  return {
    ...(unknown.labels.length > 0 && { linearLabels: notInWorkspace(unknown.labels, "label") }),
    ...(unknown.projects.length > 0 && {
      linearProjectNames: notInWorkspace(unknown.projects, "project"),
    }),
    ...(unknown.teamKeys.length > 0 && {
      linearTeamKeys: notInWorkspace(unknown.teamKeys, "team key"),
    }),
    ...(unknown.manualLabels.length > 0 && {
      manualLabels: notInWorkspace(unknown.manualLabels, "label"),
    }),
    ...(unknown.epicCompletedState && {
      epicCompletedState: `“${unknown.epicCompletedState}” isn't a workflow state in your Linear workspace.`,
    }),
  };
}
