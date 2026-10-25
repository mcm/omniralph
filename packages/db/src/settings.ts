/**
 * Repository › Settings: per-repository review config, which reviews read
 * when they're enqueued.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ReviewDepth } from "@omniralph/shared";
import type { Database } from "./client.js";
import { recordRepositorySettingsChange, type Repository } from "./repositories.js";
import { harnessRepoPins, harnesses, repositories, type RepositoryTriggers } from "./schema.js";

/** The organization's agents that can be pinned (not revoked), by name. */
export async function listPinnableHarnesses(
  db: Database,
  organizationId: string,
): Promise<{ id: string; name: string; lastHeartbeatAt: Date | null }[]> {
  return db
    .select({ id: harnesses.id, name: harnesses.name, lastHeartbeatAt: harnesses.lastHeartbeatAt })
    .from(harnesses)
    .where(and(eq(harnesses.organizationId, organizationId), isNull(harnesses.revokedAt)))
    .orderBy(asc(harnesses.name), asc(harnesses.createdAt));
}

/** IDs of the agents a repository is pinned to. */
export async function listRepositoryPinnedHarnessIds(
  db: Database,
  repositoryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ harnessId: harnessRepoPins.harnessId })
    .from(harnessRepoPins)
    .where(eq(harnessRepoPins.repositoryId, repositoryId))
    .orderBy(asc(harnessRepoPins.createdAt));
  return rows.map((r) => r.harnessId);
}

/** Names of the agents a repository is pinned to, by name (its change history's display value). */
export async function listRepositoryPinnedHarnessNames(
  db: Database,
  repositoryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ name: harnesses.name })
    .from(harnessRepoPins)
    .innerJoin(harnesses, eq(harnesses.id, harnessRepoPins.harnessId))
    .where(eq(harnessRepoPins.repositoryId, repositoryId))
    .orderBy(asc(harnesses.name), asc(harnesses.id));
  return rows.map((r) => r.name);
}

/** Which of `harnessIds` are existing, non-revoked agents of the organization. */
export async function filterActiveHarnessIds(
  db: Database,
  organizationId: string,
  harnessIds: string[],
): Promise<Set<string>> {
  if (harnessIds.length === 0) return new Set();
  const rows = await db
    .select({ id: harnesses.id })
    .from(harnesses)
    .where(
      and(
        eq(harnesses.organizationId, organizationId),
        inArray(harnesses.id, harnessIds),
        isNull(harnesses.revokedAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export interface RepositorySettingsUpdate {
  /** The depth its reviews run at. */
  depth: ReviewDepth;
  triggers: RepositoryTriggers;
  pathExcludes: string[];
  /** Empty or null clears them. */
  customInstructions: string | null;
  /** Review tasks of the repository's review runs; unchanged when left out. */
  reviewPlaybookIds?: string[];
  /** Correlation task of the repository's review runs; unchanged when left out. */
  correlationPlaybookId?: string;
  /** Story playbook of its story runs; unchanged when left out. */
  storyPlaybookId?: string;
  /** Request playbook of its request runs; unchanged when left out. */
  requestPlaybookId?: string;
}

/**
 * Saves a connected repository's review config and (when given) its playbook bindings.
 * Returns null if the organization has no such connected repository.
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
      reviewDepth: input.depth,
      triggers: input.triggers,
      pathExcludes: input.pathExcludes,
      customInstructions: input.customInstructions?.trim() || null,
      ...(input.reviewPlaybookIds ? { reviewPlaybookIds: input.reviewPlaybookIds } : {}),
      ...(input.correlationPlaybookId
        ? { correlationPlaybookId: input.correlationPlaybookId }
        : {}),
      ...(input.storyPlaybookId ? { storyPlaybookId: input.storyPlaybookId } : {}),
      ...(input.requestPlaybookId ? { requestPlaybookId: input.requestPlaybookId } : {}),
    })
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.organizationId, organizationId),
        isNull(repositories.disconnectedAt),
      ),
    )
    .returning();
  if (row) {
    recordRepositorySettingsChange(db, row, "repository.reviews");
    // The story and request playbooks are coding settings.
    if (input.storyPlaybookId || input.requestPlaybookId) {
      recordRepositorySettingsChange(db, row, "repository.coding");
    }
  }
  return row ?? null;
}
