/**
 * Documentation requests: a documentation check's confirmed updates handed
 * off to be committed to the PR/MR, recorded per (repo, PR/MR number, head
 * SHA) so a head is asked about once and a PR/MR's requests can be counted.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { documentationRequests } from "./schema.js";

export type DocumentationRequest = typeof documentationRequests.$inferSelect;

type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A PR/MR's documentation requests, oldest first. */
export function listDocumentationRequests(
  db: Executor,
  repositoryId: string,
  prNumber: number,
): Promise<DocumentationRequest[]> {
  return db
    .select()
    .from(documentationRequests)
    .where(
      and(
        eq(documentationRequests.repositoryId, repositoryId),
        eq(documentationRequests.prNumber, prNumber),
      ),
    )
    .orderBy(asc(documentationRequests.createdAt), asc(documentationRequests.id));
}

export interface NewDocumentationRequestInput {
  repositoryId: string;
  prNumber: number;
  headSha: string;
  reviewId: string | null;
  ralphRunId: string | null;
  paths: string[];
}

/** Records a documentation request; null when the head already has one. */
export async function insertDocumentationRequest(
  db: Executor,
  input: NewDocumentationRequestInput,
): Promise<DocumentationRequest | null> {
  const [row] = await db
    .insert(documentationRequests)
    .values(input)
    .onConflictDoNothing({
      target: [
        documentationRequests.repositoryId,
        documentationRequests.prNumber,
        documentationRequests.headSha,
      ],
    })
    .returning();
  return row ?? null;
}

/** The documentation request a coding run was started for (a pull-request run's), or null. */
export async function getDocumentationRequestByRun(
  db: Executor,
  ralphRunId: string,
): Promise<DocumentationRequest | null> {
  const [row] = await db
    .select()
    .from(documentationRequests)
    .where(eq(documentationRequests.ralphRunId, ralphRunId))
    .orderBy(asc(documentationRequests.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Serializes the documentation requests of one PR/MR until the transaction
 * ends (an advisory lock), so its per-PR/MR limit holds whichever coding run
 * (Om's lane, or a new pull-request run) a request goes to.
 */
export async function lockDocumentationRequests(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  repositoryId: string,
  prNumber: number,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`documentation-requests:${repositoryId}:${prNumber}`}, 0))`,
  );
}
