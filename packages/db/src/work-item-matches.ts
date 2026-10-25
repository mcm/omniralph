/**
 * Work item matches: each repository's own condition on which work items it builds (tracker,
 * team, and optionally a project or "no project" and labels). Routing evaluates them in
 * `apps/web/src/lib/routing`; this module only stores them.
 */
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "./client.js";
import { repositories, workItemMatches } from "./schema.js";

export type WorkItemMatch = typeof workItemMatches.$inferSelect;
export type WorkItemTracker = WorkItemMatch["tracker"];

/** A match's conditions, as saved and as routing reads them. */
export type WorkItemMatchFields = Pick<
  WorkItemMatch,
  "tracker" | "team" | "project" | "withoutProject" | "labels"
>;

/** The organization's matches on connected repositories (a disconnected one's routes nothing). */
export async function listWorkItemMatches(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<WorkItemMatch[]> {
  const rows = await db
    .select({ match: workItemMatches })
    .from(workItemMatches)
    .innerJoin(repositories, eq(repositories.id, workItemMatches.repositoryId))
    .where(
      and(eq(workItemMatches.organizationId, organizationId), isNull(repositories.disconnectedAt)),
    )
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
  return rows.map((r) => r.match);
}

/** The repository's match, or null when it has none. */
export async function getWorkItemMatch(
  db: Pick<Database, "select">,
  organizationId: string,
  repositoryId: string,
): Promise<WorkItemMatch | null> {
  const [row] = await db
    .select()
    .from(workItemMatches)
    .where(
      and(
        eq(workItemMatches.organizationId, organizationId),
        eq(workItemMatches.repositoryId, repositoryId),
      ),
    );
  return row ?? null;
}

/** The other connected repositories' matches with their full paths, e.g. to warn about overlaps. */
export async function listOtherWorkItemMatches(
  db: Pick<Database, "select">,
  organizationId: string,
  repositoryId: string,
): Promise<Array<WorkItemMatch & { fullPath: string }>> {
  const rows = await db
    .select({ match: workItemMatches, fullPath: repositories.fullPath })
    .from(workItemMatches)
    .innerJoin(repositories, eq(repositories.id, workItemMatches.repositoryId))
    .where(
      and(
        eq(workItemMatches.organizationId, organizationId),
        ne(workItemMatches.repositoryId, repositoryId),
        isNull(repositories.disconnectedAt),
      ),
    )
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
  return rows.map((r) => ({ ...r.match, fullPath: r.fullPath }));
}

export interface SaveWorkItemMatchInput {
  organizationId: string;
  repositoryId: string;
  /** The user saving it (`created_by` the first time, `updated_by` every time). */
  userId: string | null;
  match: WorkItemMatchFields;
}

/**
 * Saves (creates or replaces) the repository's match. Null when the repository isn't one of
 * the organization's connected repositories: nothing is saved.
 */
export async function saveWorkItemMatch(
  db: Database,
  input: SaveWorkItemMatchInput,
): Promise<WorkItemMatch | null> {
  const { organizationId, repositoryId, userId, match } = input;
  const [repository] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.id, repositoryId),
        eq(repositories.organizationId, organizationId),
        isNull(repositories.disconnectedAt),
      ),
    );
  if (!repository) return null;
  const values = {
    tracker: match.tracker,
    team: match.team,
    project: match.withoutProject ? null : match.project,
    withoutProject: match.withoutProject,
    labels: [...match.labels],
    updatedBy: userId,
  };
  const [saved] = await db
    .insert(workItemMatches)
    .values({ organizationId, repositoryId, createdBy: userId, ...values })
    .onConflictDoUpdate({
      target: workItemMatches.repositoryId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return saved!;
}

/** Clears the repository's match; whether it had one. */
export async function deleteWorkItemMatch(
  db: Pick<Database, "delete">,
  organizationId: string,
  repositoryId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(workItemMatches)
    .where(
      and(
        eq(workItemMatches.organizationId, organizationId),
        eq(workItemMatches.repositoryId, repositoryId),
      ),
    )
    .returning({ repositoryId: workItemMatches.repositoryId });
  return deleted.length > 0;
}
