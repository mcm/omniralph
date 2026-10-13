import type * as React from "react";
import { notFound } from "next/navigation";
import {
  getRepositoryWithConnection,
  listPinnableHarnesses,
  listRepositoryPinnedHarnessIds,
  listReviewProfiles,
} from "@omniralph/db";
import { parseRalphSettings, ralphSettingsFormValues } from "@omniralph/shared";
import { z } from "zod";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
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
import { RepositorySettingsView, type RepositorySettingsTab } from "./settings/repository-settings-view";

/** A repository settings tab: Review settings, Coding Tasks or Harnesses. */
export async function renderRepositorySettings(
  params: Promise<{ id: string }>,
  tab: RepositorySettingsTab,
): Promise<React.ReactElement> {
  const user = await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await enterResourceOrganization(user, "repository", id, `/repositories/${id}/${tab}`);
  if (tab === "coding-tasks" && user.role !== "admin") notFound();
  const db = getDb();
  const found = await getRepositoryWithConnection(db, id, user.organization.id);
  if (!found || found.repository.disconnectedAt) notFound();
  const orgId = user.organization.id;
  const [
    profiles,
    agents,
    pinnedHarnessIds,
    reviewTasks,
    correlationTasks,
    storyTasks,
    requestTasks,
  ] = await Promise.all([
    listReviewProfiles(db, orgId),
    listPinnableHarnesses(db, orgId),
    listRepositoryPinnedHarnessIds(db, id),
    listTaskDefinitions(db, orgId, REVIEW_TASKS),
    listTaskChoices(db, orgId, CORRELATION_TASKS),
    listTaskChoices(db, orgId, STORY_TASKS),
    listTaskChoices(db, orgId, REQUEST_TASKS),
  ]);
  const { repository, connection } = found;

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
      agents={agents.map((a) => ({
        id: a.id,
        name: a.name,
        lastHeartbeatAt: a.lastHeartbeatAt?.toISOString() ?? null,
      }))}
      ralph={
        user.role === "admin"
          ? {
              ralphEnabled: repository.ralphEnabled,
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
      codingTasks={{ story: storyTasks, request: requestTasks }}
    />
  );
}
