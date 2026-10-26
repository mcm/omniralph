/**
 * Repository rules: `custom` rules written by admins and `learned` rules
 * generated from false-positive dismissals. Enabled rules are part of the
 * review config resolved at enqueue time (`getRepositoryReviewSettings`).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { currentChangeCollector, recordChange } from "./changes.js";
import type { Database } from "./client.js";
import type { Rule } from "./reviews.js";
import type { ruleKind } from "./schema.js";
import { feedback, findings, repositories, reviews, rules, users } from "./schema.js";

export type RuleKind = (typeof ruleKind.enumValues)[number];

/** Records a live `repository` change for a change to the repository's rules. */
async function recordRulesChange(db: Database, repositoryId: string): Promise<void> {
  if (!currentChangeCollector()) return;
  const [repository] = await db
    .select({ organizationId: repositories.organizationId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repository) return;
  recordChange(db, {
    resource: "repository",
    ids: [repositoryId],
    organizationId: repository.organizationId,
  });
}

export interface RuleEntry {
  id: string;
  repositoryId: string;
  kind: RuleKind;
  text: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Null for learned rules (and creators whose account was deleted). */
  createdBy: { id: string; name: string | null; email: string | null } | null;
  /** The dismissed finding a learned rule came from, while it exists. */
  sourceFinding: {
    id: string;
    reviewId: string;
    /** The review run of the finding's review; null for reviews from before review runs. */
    reviewRunId: string | null;
    title: string;
    path: string;
  } | null;
}

/** A repository's rules, oldest first, with their creators and source findings. */
export async function listRepositoryRules(
  db: Database,
  repositoryId: string,
): Promise<RuleEntry[]> {
  const rows = await db
    .select({
      rule: rules,
      creator: { id: users.id, name: users.name, email: users.email },
      finding: {
        id: findings.id,
        reviewId: findings.reviewId,
        title: findings.title,
        path: findings.path,
      },
      reviewRunId: reviews.reviewRunId,
    })
    .from(rules)
    .leftJoin(users, eq(users.id, rules.createdBy))
    .leftJoin(findings, eq(findings.id, rules.sourceFindingId))
    .leftJoin(reviews, eq(reviews.id, findings.reviewId))
    .where(eq(rules.repositoryId, repositoryId))
    .orderBy(asc(rules.createdAt), asc(rules.id));
  return rows.map(({ rule, creator, finding, reviewRunId }) => ({
    id: rule.id,
    repositoryId: rule.repositoryId,
    kind: rule.kind,
    text: rule.text,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    createdBy: creator,
    sourceFinding: finding && { ...finding, reviewRunId },
  }));
}

/** Adds an admin-written rule (enabled). */
export async function createCustomRule(
  db: Database,
  input: { repositoryId: string; text: string; createdBy: string | null },
): Promise<Rule> {
  const [row] = await db
    .insert(rules)
    .values({
      repositoryId: input.repositoryId,
      kind: "custom",
      text: input.text,
      createdBy: input.createdBy,
    })
    .returning();
  await recordRulesChange(db, input.repositoryId);
  return row!;
}

/** Edits a rule's text and/or enabled flag; null when the repository has no such rule. */
export async function updateRule(
  db: Database,
  input: { repositoryId: string; ruleId: string; text?: string; enabled?: boolean },
): Promise<Rule | null> {
  const changes = {
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
  if (Object.keys(changes).length === 0) {
    const [row] = await db
      .select()
      .from(rules)
      .where(and(eq(rules.id, input.ruleId), eq(rules.repositoryId, input.repositoryId)));
    return row ?? null;
  }
  const [row] = await db
    .update(rules)
    .set(changes)
    .where(and(eq(rules.id, input.ruleId), eq(rules.repositoryId, input.repositoryId)))
    .returning();
  if (row) await recordRulesChange(db, input.repositoryId);
  return row ?? null;
}

/** Deletes a rule; false when the repository has no such rule. */
export async function deleteRule(
  db: Database,
  input: { repositoryId: string; ruleId: string },
): Promise<boolean> {
  const deleted = await db
    .delete(rules)
    .where(and(eq(rules.id, input.ruleId), eq(rules.repositoryId, input.repositoryId)))
    .returning({ id: rules.id });
  if (deleted.length > 0) await recordRulesChange(db, input.repositoryId);
  return deleted.length > 0;
}

export type InsertLearnedRuleResult =
  | { status: "inserted"; rule: Rule }
  /** A near-duplicate of `rule` (any kind, enabled or not) already exists. */
  | { status: "duplicate"; rule: Rule };

/**
 * Stores a learned rule (enabled) unless `findDuplicate` matches one of the
 * repository's existing rules. Runs under a per-repository advisory lock, so
 * two generations finishing at once can't both insert the same rule.
 */
export async function insertLearnedRule(
  db: Database,
  input: {
    repositoryId: string;
    text: string;
    sourceFindingId: string;
    findDuplicate: (text: string, existing: readonly Rule[]) => Rule | undefined;
  },
): Promise<InsertLearnedRuleResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`rules:${input.repositoryId}`}, 0))`,
    );
    const existing = await tx
      .select()
      .from(rules)
      .where(eq(rules.repositoryId, input.repositoryId));
    const duplicate = input.findDuplicate(input.text, existing);
    if (duplicate) return { status: "duplicate", rule: duplicate };
    const [row] = await tx
      .insert(rules)
      .values({
        repositoryId: input.repositoryId,
        kind: "learned",
        text: input.text,
        enabled: true,
        sourceFindingId: input.sourceFindingId,
        createdBy: null,
      })
      .returning();
    await recordRulesChange(tx as unknown as Database, input.repositoryId);
    return { status: "inserted", rule: row! };
  });
}

/** A feedback row with its finding and the finding's review (for rule generation). */
export async function getFeedbackWithFinding(db: Database, feedbackId: string) {
  const [row] = await db
    .select({ feedback, finding: findings, review: reviews })
    .from(feedback)
    .innerJoin(findings, eq(findings.id, feedback.findingId))
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .where(eq(feedback.id, feedbackId))
    .limit(1);
  return row ?? null;
}
