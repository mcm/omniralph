import "server-only";
import {
  filterActiveAgentIds,
  getRepository,
  listRepositoryPinnedAgentIds,
  listReviewProfiles,
  unpinRepositoryFromAgent,
  updateRepositorySettings,
  type Database,
} from "@omniralph/db";
import type { RepositorySettingsInput } from "@omniralph/shared";
import { pinRepository } from "@/lib/agents/pins";
import type { JobDispatcher } from "@/lib/dispatch";

export type SaveRepositorySettingsResult =
  | {
      status: "saved";
      pinnedAgentIds: string[];
      unpinnedAgentIds: string[];
      /** `repo.sync` jobs enqueued for the newly pinned agents. */
      syncJobIds: string[];
    }
  | { status: "unknown_repository" }
  | { status: "unknown_profile" }
  | { status: "unknown_agents"; agentIds: string[] };

/**
 * Saves a repository's review settings (a repository of the organization; its profile
 * must be one of the organization's too) (validated with `RepositorySettingsInput`)
 * and reconciles its agent pins: newly pinned agents go through the Agents
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

  const wanted = [...new Set(input.pinnedAgentIds)];
  const current = await listRepositoryPinnedAgentIds(db, repositoryId);
  const added = wanted.filter((id) => !current.includes(id));
  const active = await filterActiveAgentIds(db, organizationId, added);
  const unknown = added.filter((id) => !active.has(id));
  if (unknown.length > 0) return { status: "unknown_agents", agentIds: unknown };

  const saved = await updateRepositorySettings(db, organizationId, repositoryId, {
    profileId: input.profileId,
    triggers: input.triggers,
    pathExcludes: input.pathExcludes,
    customInstructions: input.customInstructions,
  });
  if (!saved) return { status: "unknown_repository" };

  const syncJobIds: string[] = [];
  for (const agentId of added) {
    const { result, syncJobId } = await pinRepository(db, dispatcher, { agentId, repositoryId });
    if (result === "unknown_agent") return { status: "unknown_agents", agentIds: [agentId] };
    if (result === "unknown_repository") return { status: "unknown_repository" };
    if (syncJobId) syncJobIds.push(syncJobId);
  }
  const removed = current.filter((id) => !wanted.includes(id));
  for (const agentId of removed) {
    await unpinRepositoryFromAgent(db, { agentId, repositoryId });
  }
  return { status: "saved", pinnedAgentIds: added, unpinnedAgentIds: removed, syncJobIds };
}
