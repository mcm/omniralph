/**
 * Repository › Settings and Settings › Profiles: per-repository review config
 * and the organization's review profiles. Reviews read both when they're enqueued.
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

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The built-in review profiles seeded into every new organization (see `createOrganization`). */
export const BUILT_IN_REVIEW_PROFILES = [
  {
    id: "quick",
    name: "Quick",
    description: "Fast, diff-only review for small changes.",
    model: "claude-haiku-4-5",
    maxTokensPerReview: 60_000,
    maxFiles: 15,
    allowRepoExploration: false,
  },
  {
    id: "standard",
    name: "Standard",
    description: "Balanced review with repository exploration.",
    model: "claude-sonnet-5-5",
    maxTokensPerReview: 200_000,
    maxFiles: 40,
    allowRepoExploration: true,
  },
  {
    id: "deep",
    name: "Deep",
    description: "Thorough review for large or high-risk changes.",
    model: "claude-opus-5-5",
    maxTokensPerReview: 500_000,
    maxFiles: 100,
    allowRepoExploration: true,
  },
] as const;

/** Adds the built-in review profiles to an organization (existing ones are kept). */
export async function seedReviewProfiles(db: Queryable, organizationId: string): Promise<void> {
  await db
    .insert(reviewProfiles)
    .values(BUILT_IN_REVIEW_PROFILES.map((p) => ({ ...p, organizationId, builtIn: true })))
    .onConflictDoNothing();
}

/** An organization's review profiles by token cap (Quick, Standard, Deep), then by name. */
export async function listReviewProfiles(
  db: Database,
  organizationId: string,
): Promise<ReviewProfile[]> {
  return db
    .select()
    .from(reviewProfiles)
    .where(eq(reviewProfiles.organizationId, organizationId))
    .orderBy(asc(reviewProfiles.maxTokensPerReview), asc(reviewProfiles.name));
}

export interface ReviewProfileUpdate {
  model: string;
  maxTokensPerReview: number;
  maxFiles: number;
  allowRepoExploration: boolean;
}

/** Updates a profile's limits. Returns null if the organization has no such profile. */
export async function updateReviewProfile(
  db: Database,
  organizationId: string,
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
    .where(and(eq(reviewProfiles.organizationId, organizationId), eq(reviewProfiles.id, id)))
    .returning();
  return row ?? null;
}

/** The organization's agents that can be pinned (not revoked), by name. */
export async function listPinnableAgents(
  db: Database,
  organizationId: string,
): Promise<{ id: string; name: string; lastHeartbeatAt: Date | null }[]> {
  return db
    .select({ id: agents.id, name: agents.name, lastHeartbeatAt: agents.lastHeartbeatAt })
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), isNull(agents.revokedAt)))
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

/** Which of `agentIds` are existing, non-revoked agents of the organization. */
export async function filterActiveAgentIds(
  db: Database,
  organizationId: string,
  agentIds: string[],
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        inArray(agents.id, agentIds),
        isNull(agents.revokedAt),
      ),
    );
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
 * Saves a connected repository's review config. `profileId` must be a profile of
 * the repository's organization. Returns null if the organization has no such
 * connected repository.
 */
export async function updateRepositorySettings(
  db: Database,
  organizationId: string,
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
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.organizationId, organizationId),
        isNull(repositories.disconnectedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** An organization's review profile, or null. */
export async function getReviewProfile(
  db: Database,
  organizationId: string,
  id: string,
): Promise<ReviewProfile | null> {
  const [row] = await db
    .select()
    .from(reviewProfiles)
    .where(and(eq(reviewProfiles.organizationId, organizationId), eq(reviewProfiles.id, id)))
    .limit(1);
  return row ?? null;
}
