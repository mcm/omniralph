import "server-only";
import {
  getRepositoryWithConnection,
  pinRepositoryToAgent,
  type Database,
  type PinRepositoryResult,
} from "@omniralph/db";
import { REPO_SYNC_JOB_TYPE, type RepoSyncPayload } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { jobRepository } from "@/lib/scm/adapters";
import { bumpAgentHeartbeat } from "./heartbeat-cache";

/**
 * Pins a repository to an agent and enqueues a `repo.sync` system RPC targeted
 * at that agent, so the agent pre-clones the repo before its first
 * review. The sync is deduped per agent and repository (also when the
 * repository was already pinned, so pinning again re-syncs).
 */
export async function pinRepository(
  db: Database,
  dispatcher: JobDispatcher,
  input: { agentId: string; repositoryId: string },
): Promise<{ result: PinRepositoryResult; syncJobId?: string }> {
  const result = await pinRepositoryToAgent(db, {
    agentId: input.agentId,
    repositoryId: input.repositoryId,
  });
  if (result !== "pinned" && result !== "already_pinned") return { result };
  if (result === "pinned") await bumpAgentHeartbeat(input.agentId);
  const found = await getRepositoryWithConnection(db, input.repositoryId);
  if (!found) return { result: "unknown_repository" };
  const payload: RepoSyncPayload = {
    repository: jobRepository(found.repository, found.connection),
  };
  const { job } = await dispatcher.createAndPublish({
    organizationId: found.repository.organizationId,
    // A system RPC: no session, no pool; only the targeted agent claims it.
    type: REPO_SYNC_JOB_TYPE,
    taskType: "system",
    payload,
    repositoryId: input.repositoryId,
    dedupeKey: `${REPO_SYNC_JOB_TYPE}:${input.agentId}:${input.repositoryId}`,
    targetAgentId: input.agentId,
  });
  return { result, syncJobId: job.id };
}
