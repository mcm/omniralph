/**
 * Routing rules: an organization's ordered list of conditions, each naming the repository a
 * matching issue routes to. The list is read in order and saved whole. Queries are validated
 * by the caller (`routingRulesSchema` in `@omniralph/shared`, against the tracker's catalog).
 */
import type { RoutingRuleInput } from "@omniralph/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "./client.js";
import { organizations, repositories, routingRules } from "./schema.js";

export type RoutingRule = typeof routingRules.$inferSelect;

/** The organization's rules in evaluation order. */
export async function listRoutingRules(
  db: Database,
  organizationId: string,
): Promise<RoutingRule[]> {
  return db
    .select()
    .from(routingRules)
    .where(eq(routingRules.organizationId, organizationId))
    .orderBy(asc(routingRules.position));
}

export type ReplaceRoutingRulesResult =
  | { ok: true; rules: RoutingRule[] }
  /** `indexes`: the rules whose repository isn't one of the organization's. */
  | { ok: false; error: "unknown_repository"; indexes: number[] };

/**
 * Replaces the organization's whole list with `rules`, in that order, in one transaction:
 * nothing changes when a rule's repository isn't the organization's (disconnected ones
 * count, since they are still its rows). Concurrent saves of one organization run one after
 * the other; the last one wins.
 */
export async function replaceRoutingRules(
  db: Database,
  organizationId: string,
  rules: readonly RoutingRuleInput[],
): Promise<ReplaceRoutingRulesResult> {
  return db.transaction(async (tx) => {
    // Serializes saves of the organization, so positions never collide.
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update");

    const ids = [...new Set(rules.map((r) => r.repositoryId))];
    const owned =
      ids.length === 0
        ? []
        : await tx
            .select({ id: repositories.id })
            .from(repositories)
            .where(
              and(eq(repositories.organizationId, organizationId), inArray(repositories.id, ids)),
            );
    const known = new Set(owned.map((r) => r.id));
    const indexes = rules.flatMap((r, i) => (known.has(r.repositoryId) ? [] : [i]));
    if (indexes.length > 0) return { ok: false, error: "unknown_repository", indexes };

    await tx.delete(routingRules).where(eq(routingRules.organizationId, organizationId));
    if (rules.length === 0) return { ok: true, rules: [] };
    const saved = await tx
      .insert(routingRules)
      .values(
        rules.map((r, position) => ({
          organizationId,
          position,
          repositoryId: r.repositoryId,
          query: r.query,
        })),
      )
      .returning();
    return { ok: true, rules: saved.sort((a, b) => a.position - b.position) };
  });
}
