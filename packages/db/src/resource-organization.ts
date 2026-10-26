import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  chatThreadRuns,
  agents,
  ralphRuns,
  repositories,
  reviewRuns,
  reviews,
  scmConnections,
  triageRuns,
} from "./schema.js";

/** Resources with their own URL in the control panel. */
export type OrganizationResource =
  | "ask_run"
  | "agent"
  | "ralph_run"
  | "repository"
  | "review"
  | "review_run"
  | "scm_connection"
  | "triage_run";

/**
 * The organization a resource belongs to, whichever organization the caller is
 * working in, or `null` when there is no such resource. Detail pages use it to
 * switch to the resource's organization (for a member of it) before loading it.
 */
export async function getResourceOrganizationId(
  db: Database,
  resource: OrganizationResource,
  id: string,
): Promise<string | null> {
  const query = () => {
    switch (resource) {
      case "ask_run":
        return db
          .select({ organizationId: chatThreadRuns.organizationId })
          .from(chatThreadRuns)
          .where(and(eq(chatThreadRuns.id, id), eq(chatThreadRuns.kind, "query")));
      case "agent":
        return db
          .select({ organizationId: agents.organizationId })
          .from(agents)
          .where(and(eq(agents.id, id), isNull(agents.deletedAt)));
      case "ralph_run":
        return db
          .select({ organizationId: ralphRuns.organizationId })
          .from(ralphRuns)
          .where(eq(ralphRuns.id, id));
      case "repository":
        return db
          .select({ organizationId: repositories.organizationId })
          .from(repositories)
          .where(eq(repositories.id, id));
      case "review":
        return db
          .select({ organizationId: repositories.organizationId })
          .from(reviews)
          .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
          .where(eq(reviews.id, id));
      case "review_run":
        return db
          .select({ organizationId: reviewRuns.organizationId })
          .from(reviewRuns)
          .where(eq(reviewRuns.id, id));
      case "scm_connection":
        return db
          .select({ organizationId: scmConnections.organizationId })
          .from(scmConnections)
          .where(eq(scmConnections.id, id));
      case "triage_run":
        return db
          .select({ organizationId: triageRuns.organizationId })
          .from(triageRuns)
          .where(eq(triageRuns.id, id));
    }
  };
  const [row] = await query().limit(1);
  return row?.organizationId ?? null;
}
