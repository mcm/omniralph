import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getRepositoryWithConnection,
  listPinnableAgents,
  listRepositoryPinnedAgentIds,
  listReviewProfiles,
} from "@omniralph/db";
import { parseRalphSettings, ralphSettingsFormValues } from "@omniralph/shared";
import { z } from "zod";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { repositoryManualLabels } from "@/lib/ralph/epic-loader";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { RepositorySettingsView } from "./repository-settings-view";

export const metadata: Metadata = { title: "Repository settings · Omniralph" };

export default async function RepositorySettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const found = await getRepositoryWithConnection(db, id, user.organization.id);
  if (!found || found.repository.disconnectedAt) notFound();
  const [profiles, agents, pinnedAgentIds] = await Promise.all([
    listReviewProfiles(db, user.organization.id),
    listPinnableAgents(db),
    listRepositoryPinnedAgentIds(db, id),
  ]);
  const { repository, connection } = found;

  return (
    <RepositorySettingsView
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
        pinnedAgentIds,
      }}
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
              ...ralphSettingsFormValues(parseRalphSettings(repository.ralphSettings)),
              manualLabels: repositoryManualLabels(repository),
            }
          : null
      }
    />
  );
}
