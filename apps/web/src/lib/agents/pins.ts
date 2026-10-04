import "server-only";
import {
  getRepositoryWithConnection,
  pinRepositoryToAgent,
  type Database,
  type PinRepositoryResult,
} from "@omniralph/db";
import { REPO_SYNC_JOB_TYPE, SYSTEM_CAPABILITY, type RepoSyncPayload } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { jobRepository } from "@/lib/scm/adapters";

/**
 * Pins a repository to an agent and enqueues a `repo.sync` job on that
 * agent's `system` topic, so the agent pre-clones the repo before its first
 * review. The sync is deduped per agent and repository (also when the
 * repository was already pinned, so pinning again re-syncs).
 */
export async function pinRepository(
  db: Database,
  dispatcher: JobDispatcher,
  input: { agentId: string; repositoryId: string },
): Promise<{ result: PinRepositoryResult; syncJobId?: string }> {
  const result = await pinRepositoryToAgent(db, input);
  if (result !== "pinned" && result !== "already_pinned") return { result };
  const found = await getRepositoryWithConnection(db, input.repositoryId);
  if (!found) return { result: "unknown_repository" };
  const payload: RepoSyncPayload = {
    repository: jobRepository(found.repository, found.connection),
  };
  const { job } = await dispatcher.createAndPublish({
    capability: SYSTEM_CAPABILITY,
    type: REPO_SYNC_JOB_TYPE,
    payload,
    repositoryId: input.repositoryId,
    dedupeKey: `${REPO_SYNC_JOB_TYPE}:${input.agentId}:${input.repositoryId}`,
    targetAgentId: input.agentId,
  });
  return { result, syncJobId: job.id };
}
