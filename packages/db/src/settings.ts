/**
 * Repository › Settings and Settings › Profiles: per-repository review config
 * and the built-in review profiles. Reviews read both when they're enqueued.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import type { Repository } from "./repositories.js";
import type { ReviewProfile } from "./reviews.js";
import {
  agentRepoPins,
  agents,
  repositories,
  reviewProfiles,
  type RepositoryTriggers,
} from "./schema.js";

/** Review profiles by token cap (Quick, Standard, Deep), then by name. */
export async function listReviewProfiles(db: Database): Promise<ReviewProfile[]> {
  return db
    .select()
    .from(reviewProfiles)
    .orderBy(asc(reviewProfiles.maxTokensPerReview), asc(reviewProfiles.name));
}

export interface ReviewProfileUpdate {
  model: string;
  maxTokensPerReview: number;
  maxFiles: number;
  allowRepoExploration: boolean;
}

/** Updates a profile's limits. Returns null if it doesn't exist. */
export async function updateReviewProfile(
  db: Database,
  id: string,
  input: ReviewProfileUpdate,
): Promise<ReviewProfile | null> {
  const [row] = await db
    .update(reviewProfiles)
    .set({
      model: input.model,
      maxTokensPerReview: input.maxTokensPerReview,
      maxFiles: input.maxFiles,
      allowRepoExploration: input.allowRepoExploration,
    })
    .where(eq(reviewProfiles.id, id))
    .returning();
  return row ?? null;
}

/** Agents that can be pinned (not revoked), by name. */
export async function listPinnableAgents(
  db: Database,
): Promise<{ id: string; name: string; lastHeartbeatAt: Date | null }[]> {
  return db
    .select({ id: agents.id, name: agents.name, lastHeartbeatAt: agents.lastHeartbeatAt })
    .from(agents)
    .where(isNull(agents.revokedAt))
    .orderBy(asc(agents.name), asc(agents.createdAt));
}

/** IDs of the agents a repository is pinned to. */
export async function listRepositoryPinnedAgentIds(
  db: Database,
  repositoryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ agentId: agentRepoPins.agentId })
    .from(agentRepoPins)
    .where(eq(agentRepoPins.repositoryId, repositoryId))
    .orderBy(asc(agentRepoPins.createdAt));
  return rows.map((r) => r.agentId);
}

/** Which of `agentIds` are existing, non-revoked agents. */
export async function filterActiveAgentIds(db: Database, agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, agentIds), isNull(agents.revokedAt)));
  return new Set(rows.map((r) => r.id));
}

export interface RepositorySettingsUpdate {
  profileId: string;
  triggers: RepositoryTriggers;
  pathExcludes: string[];
  /** Empty or null clears them. */
  customInstructions: string | null;
}

/**
 * Saves a connected repository's review config. Returns null if the repository
 * is unknown or disconnected.
 */
export async function updateRepositorySettings(
  db: Database,
  id: string,
  input: RepositorySettingsUpdate,
): Promise<Repository | null> {
  const [row] = await db
    .update(repositories)
    .set({
      profileId: input.profileId,
      triggers: input.triggers,
      pathExcludes: input.pathExcludes,
      customInstructions: input.customInstructions?.trim() || null,
    })
    .where(and(eq(repositories.id, id), isNull(repositories.disconnectedAt)))
    .returning();
  return row ?? null;
}

export async function getReviewProfile(db: Database, id: string): Promise<ReviewProfile | null> {
  const [row] = await db.select().from(reviewProfiles).where(eq(reviewProfiles.id, id)).limit(1);
  return row ?? null;
}
