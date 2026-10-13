import { notFound } from "next/navigation";
import {
  getAllowedTaskTypeDefaults,
  getRepositoryWithConnection,
  listHarnessOverview,
  listReportedModels,
  listRepositoryCodingHarnessIds,
  listRepositoryPinnedHarnessIds,
  listReviewProfiles,
  repositorySwitchOverrides,
} from "@omniralph/db";
import { parseRalphSettings, ralphSettingsFormValues } from "@omniralph/shared";
import { z } from "zod";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { getLinearSettingsOptions } from "@/lib/linear/settings-options";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { harnessRow } from "@/lib/harnesses/rows";
import { repositoryManualLabels } from "@/lib/ralph/epic-loader";
import {
  CORRELATION_TASKS,
  listTaskChoices,
  listTaskDefinitions,
  REQUEST_TASKS,
  REVIEW_TASKS,
  STORY_TASKS,
} from "@/lib/definitions";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import type { CodingChoices, CodingLinearChoices } from "./settings/ralph-settings-section";
import {
  RepositorySettingsView,
  type RepositorySettingsTab,
} from "./settings/repository-settings-view";

/**
 * The Coding tab's picker choices: the organization's Linear workspace, and the models of the
 * harnesses that may run the repository's coding jobs (its pinned ones, else every harness
 * accepting coding).
 */
async function loadCodingChoices(
  organizationId: string,
  repositoryId: string,
): Promise<CodingChoices> {
  const db = getDb();
  const [linear, { pinned, harnessIds }] = await Promise.all([
    getLinearSettingsOptions(organizationId).then(
      (options): CodingLinearChoices =>
        options ? { status: "connected", options } : { status: "disconnected" },
      (error: unknown): CodingLinearChoices => {
        console.error("Loading the Linear settings options failed", error);
        return { status: "unavailable" };
      },
    ),
    listRepositoryCodingHarnessIds(db, organizationId, repositoryId),
  ]);
  const models = await listReportedModels(db, organizationId, { harnessIds });
  return {
    linear,
    models,
    harnessCount: harnessIds.length,
    pinned,
  };
}

/** A repository settings tab: Review settings, Coding (admins only) or Harnesses. */
export async function renderRepositorySettings(
  params: Promise<{ id: string }>,
  tab: RepositorySettingsTab,
) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await enterResourceOrganization(user, "repository", id, `/repositories/${id}/${tab}`);
  if (tab === "coding" && user.role !== "admin") notFound();
  const db = getDb();
  const found = await getRepositoryWithConnection(db, id, user.organization.id);
  if (!found || found.repository.disconnectedAt) notFound();
  const orgId = user.organization.id;
  const [
    profiles,
    harnesses,
    organizationVersion,
    pinnedHarnessIds,
    reviewTasks,
    correlationTasks,
    storyTasks,
    requestTasks,
    allowedTaskTypes,
  ] = await Promise.all([
    listReviewProfiles(db, orgId),
    listHarnessOverview(db, orgId),
    organizationHarnessVersion(db, orgId),
    listRepositoryPinnedHarnessIds(db, id),
    listTaskDefinitions(db, orgId, REVIEW_TASKS),
    listTaskChoices(db, orgId, CORRELATION_TASKS),
    listTaskChoices(db, orgId, STORY_TASKS),
    listTaskChoices(db, orgId, REQUEST_TASKS),
    getAllowedTaskTypeDefaults(db, orgId),
  ]);
  const { repository, connection } = found;
  const now = new Date();
  const codingChoices = tab === "coding" ? await loadCodingChoices(orgId, id) : null;

  return (
    <RepositorySettingsView
      tab={tab}
      repository={{
        id: repository.id,
        provider: repository.provider,
        fullPath: repository.fullPath,
        webUrl: repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath),
      }}
      settings={{
        profileId: repository.profileId,
        triggers: repository.triggers,
        pathExcludes: repository.pathExcludes,
        customInstructions: repository.customInstructions ?? "",
        pinnedHarnessIds,
        reviewTaskIds: repository.reviewTaskIds,
        correlationTaskId: repository.correlationTaskId,
      }}
      reviewTasks={reviewTasks.map(({ definition, builtin }) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        builtin,
      }))}
      correlationTasks={correlationTasks}
      profiles={profiles.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        model: p.model,
        maxTokensPerReview: p.maxTokensPerReview,
        maxFiles: p.maxFiles,
        allowRepoExploration: p.allowRepoExploration,
      }))}
      harnesses={harnesses.map((harness) => {
        const row = harnessRow(harness, now, organizationVersion.version);
        return {
          id: row.id,
          name: row.name,
          online: row.online,
          revoked: row.revoked,
          updating: row.updateStatus === "updating",
          acceptedTaskTypes: row.acceptedTaskTypes,
        };
      })}
      ralph={
        user.role === "admin"
          ? {
              linearTeamKeys: repository.linearTeamKeys,
              linearProjectNames: repository.linearProjectNames,
              linearLabels: repository.linearLabels,
              codingPath: repository.codingPath,
              storyTaskId: repository.storyTaskId,
              requestTaskId: repository.requestTaskId,
              ...ralphSettingsFormValues(parseRalphSettings(repository.ralphSettings)),
              manualLabels: repositoryManualLabels(repository),
            }
          : null
      }
      codingChoices={codingChoices}
      codingTasks={{ story: storyTasks, request: requestTasks }}
      taskTypes={{
        overrides: repositorySwitchOverrides(repository),
        inherited: {
          query: allowedTaskTypes.includes("query"),
          review: allowedTaskTypes.includes("review"),
          coding: allowedTaskTypes.includes("coding"),
        },
      }}
    />
  );
}
