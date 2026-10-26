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
import { bumpHarnessHeartbeat } from "./heartbeat-cache";

/**
 * Pins a repository to a harness and enqueues a `repo.sync` system RPC targeted
 * at that harness, so the harness pre-clones the repo before its first
 * review. The sync is deduped per harness and repository (also when the
 * repository was already pinned, so pinning again re-syncs).
 */
export async function pinRepository(
  db: Database,
  dispatcher: JobDispatcher,
  input: { harnessId: string; repositoryId: string },
): Promise<{ result: PinRepositoryResult; syncJobId?: string }> {
  const result = await pinRepositoryToAgent(db, {
    agentId: input.harnessId,
    repositoryId: input.repositoryId,
  });
  if (result !== "pinned" && result !== "already_pinned") return { result };
  if (result === "pinned") await bumpHarnessHeartbeat(input.harnessId);
  const found = await getRepositoryWithConnection(db, input.repositoryId);
  if (!found) return { result: "unknown_repository" };
  const payload: RepoSyncPayload = {
    repository: jobRepository(found.repository, found.connection),
  };
  const { job } = await dispatcher.createAndPublish({
    organizationId: found.repository.organizationId,
    // A system RPC: no session, no pool; only the targeted harness claims it.
    type: REPO_SYNC_JOB_TYPE,
    taskType: "system",
    payload,
    repositoryId: input.repositoryId,
    dedupeKey: `${REPO_SYNC_JOB_TYPE}:${input.harnessId}:${input.repositoryId}`,
    targetHarnessId: input.harnessId,
  });
  return { result, syncJobId: job.id };
}
