/**
 * Runs' hidden refs on the code host (`refs/omniralph/runs/<run>`): recorded
 * from story outcomes, deleted on `origin` by a `worktree.cleanup` RPC once
 * the run is over, or by the age sweep.
 */
import { and, asc, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import type { Database } from "./client.js";
import type { RalphRun, RalphRunStatus, RalphTransaction } from "./ralph.js";
import { hiddenRefs, ralphRuns } from "./schema.js";

export type HiddenRef = typeof hiddenRefs.$inferSelect;

type Executor = Database | RalphTransaction;

/** Run statuses whose hidden refs are deleted at once: the run is over for good. */
const ENDED_RUN_STATUSES: RalphRunStatus[] = ["completed", "failed"];

/**
 * Records a hidden ref a story pushed (its latest SHA). One deleted before is
 * live again (a resumed run pushed it anew). `created_at` is the latest push,
 * so the age sweep counts from it.
 */
export async function recordHiddenRef(
  db: Executor,
  input: { repositoryId: string; runId: string; ref: string; sha: string },
): Promise<HiddenRef> {
  const [row] = await db
    .insert(hiddenRefs)
    .values(input)
    .onConflictDoUpdate({
      target: [hiddenRefs.repositoryId, hiddenRefs.ref],
      set: { runId: input.runId, sha: input.sha, createdAt: new Date(), deletedAt: null },
    })
    .returning();
  return row!;
}

/** A run's hidden refs not deleted yet, oldest first. */
export function listRunHiddenRefs(db: Executor, runId: string): Promise<HiddenRef[]> {
  return db
    .select()
    .from(hiddenRefs)
    .where(and(eq(hiddenRefs.runId, runId), isNull(hiddenRefs.deletedAt)))
    .orderBy(asc(hiddenRefs.createdAt), asc(hiddenRefs.id));
}

/**
 * Hidden refs the sweep deletes: not deleted yet, and either their run is
 * over (completed or failed) or they were last pushed before `olderThan` and
 * their run isn't running. A stopped run's ref is kept until then (the run
 * may resume from it). Oldest first, with the run.
 */
export async function listHiddenRefsToDelete(
  db: Executor,
  olderThan: Date,
  limit = 500,
): Promise<Array<{ hiddenRef: HiddenRef; run: RalphRun }>> {
  return db
    .select({ hiddenRef: hiddenRefs, run: ralphRuns })
    .from(hiddenRefs)
    .innerJoin(ralphRuns, eq(ralphRuns.id, hiddenRefs.runId))
    .where(
      and(
        isNull(hiddenRefs.deletedAt),
        or(
          inArray(ralphRuns.status, ENDED_RUN_STATUSES),
          and(lt(hiddenRefs.createdAt, olderThan), ne(ralphRuns.status, "running")),
        ),
      ),
    )
    .orderBy(asc(hiddenRefs.createdAt), asc(hiddenRefs.id))
    .limit(limit);
}

/** Marks a repository's hidden refs deleted (those not marked yet); returns how many. */
export async function markHiddenRefsDeleted(
  db: Executor,
  repositoryId: string,
  refs: readonly string[],
  at = new Date(),
): Promise<number> {
  if (refs.length === 0) return 0;
  const rows = await db
    .update(hiddenRefs)
    .set({ deletedAt: at })
    .where(
      and(
        eq(hiddenRefs.repositoryId, repositoryId),
        inArray(hiddenRefs.ref, [...refs]),
        isNull(hiddenRefs.deletedAt),
      ),
    )
    .returning({ id: hiddenRefs.id });
  return rows.length;
}
