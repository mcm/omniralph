/**
 * Repository › Settings: per-repository review config, which reviews read
 * when they're enqueued.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ReviewDepth } from "@omniralph/shared";
import type { Database } from "./client.js";
import type { RepositoryPlaybookBindings } from "./playbooks.js";
import { recordRepositorySettingsChange, type Repository } from "./repositories.js";
import { agentRepoPins, agents, repositories, type RepositoryTriggers } from "./schema.js";

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

/** Names of the agents a repository is pinned to, by name (its change history's display value). */
export async function listRepositoryPinnedAgentNames(
  db: Database,
  repositoryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ name: agents.name })
    .from(agentRepoPins)
    .innerJoin(agents, eq(agents.id, agentRepoPins.agentId))
    .where(eq(agentRepoPins.repositoryId, repositoryId))
    .orderBy(asc(agents.name), asc(agents.id));
  return rows.map((r) => r.name);
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

/**
 * Saves a connected repository's playbook bindings (checked by the caller) and records the
 * live change of its `repository.playbooks` section. Returns null if the organization has no
 * such connected repository.
 */
export async function updateRepositoryPlaybookBindings(
  db: Database,
  organizationId: string,
  id: string,
  bindings: Omit<RepositoryPlaybookBindings, "id" | "fullPath">,
): Promise<Repository | null> {
  const [row] = await db
    .update(repositories)
    .set({
      reviewPlaybookIds: bindings.reviewPlaybookIds,
      correlationPlaybookId: bindings.correlationPlaybookId,
      storyPlaybookId: bindings.storyPlaybookId,
      requestPlaybookId: bindings.requestPlaybookId,
    })
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.organizationId, organizationId),
        isNull(repositories.disconnectedAt),
      ),
    )
    .returning();
  if (row) recordRepositorySettingsChange(db, row, "repository.playbooks");
  return row ?? null;
}
