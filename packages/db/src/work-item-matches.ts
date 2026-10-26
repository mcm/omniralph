/**
 * Work item matches: each repository's own condition on which work items it builds (tracker,
 * team, and optionally a project or "no project" and labels). Routing evaluates them in
 * `apps/web/src/lib/routing`; this module only stores them.
 */
import { and, asc, eq, isNull, ne, notExists, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { recordRepositorySettingsChange, WorkItemMatchRequiredError } from "./repositories.js";
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
 * Saves (creates or replaces) the repository's match, publishing the repository's
 * `repository.coding` change (the match is part of its coding policy). Null when the
 * repository isn't one of the organization's connected repositories: nothing is saved.
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
  recordRepositorySettingsChange(db, { id: repositoryId, organizationId }, "repository.coding");
  return saved!;
}

/**
 * Clears the repository's match (publishing its `repository.coding` change); whether it had one.
 * A repository whose Coding is on keeps its match: that throws `WorkItemMatchRequiredError`.
 */
export async function deleteWorkItemMatch(
  db: Pick<Database, "delete" | "select">,
  organizationId: string,
  repositoryId: string,
): Promise<boolean> {
  const ofRepository = and(
    eq(workItemMatches.organizationId, organizationId),
    eq(workItemMatches.repositoryId, repositoryId),
  );
  const deleted = await db
    .delete(workItemMatches)
    .where(
      and(
        ofRepository,
        notExists(
          db
            .select({ one: sql`1` })
            .from(repositories)
            .where(and(eq(repositories.id, repositoryId), eq(repositories.codingEnabled, true))),
        ),
      ),
    )
    .returning({ repositoryId: workItemMatches.repositoryId });
  if (deleted.length === 0) {
    const [kept] = await db
      .select({ repositoryId: workItemMatches.repositoryId })
      .from(workItemMatches)
      .where(ofRepository);
    if (kept) throw new WorkItemMatchRequiredError("remove_match", repositoryId);
    return false;
  }
  recordRepositorySettingsChange(db, { id: repositoryId, organizationId }, "repository.coding");
  return true;
}
