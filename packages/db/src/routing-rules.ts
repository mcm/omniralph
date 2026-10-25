/**
 * Routing rules: an organization's ordered list of conditions, each naming the repository a
 * matching issue routes to. The list is read in order and saved whole. Queries are validated
 * by the caller (`routingRulesSchema` in `@omniralph/shared`, against the tracker's catalog).
 */
import type { RoutingRuleInput } from "@omniralph/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getAllowedTaskTypeDefaults } from "./app-settings.js";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { effectiveRepositorySwitches, type RepositoryWithSwitches } from "./repositories.js";
import {
  followUpSources,
  organizations,
  ralphLanes,
  ralphRuns,
  ralphStories,
  repositories,
  routingRules,
} from "./schema.js";

export type RoutingRule = typeof routingRules.$inferSelect;

/** The organization's rules in evaluation order. */
export async function listRoutingRules(
  db: Pick<Database, "select">,
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
    recordChange(tx, {
      resource: "settings",
      section: "routing_rules",
      ids: [organizationId],
      organizationId,
    });
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

/**
 * The repositories rules can route to: the organization's connected ones, coding on or off,
 * with their effective switches, by full path.
 */
export async function listRoutingRepositories(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<RepositoryWithSwitches[]> {
  const allowed = await getAllowedTaskTypeDefaults(db, organizationId);
  const rows = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.organizationId, organizationId), isNull(repositories.disconnectedAt)),
    )
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
  return rows.map((row) => ({ ...row, effective: effectiveRepositorySwitches(row, allowed) }));
}

/** The repository Omniralph already uses for an issue, and how it was chosen. */
export interface IssueRepository {
  repositoryId: string;
  /** The run's `routed_by` (null when it has none, or for a story lane). */
  routedBy: string | null;
  /** `lane`: the issue is a story of another issue's run, in this lane's repository. */
  via: "run" | "lane";
  /** For `lane`: the identifier of the run's issue. */
  runIdentifier?: string;
}

/**
 * The repository of an issue's latest run that has one, else of the latest story (of any
 * run) for that issue that has a lane. Null when Omniralph has neither.
 */
export async function getIssueRepository(
  db: Pick<Database, "select">,
  organizationId: string,
  linearIssueId: string,
): Promise<IssueRepository | null> {
  const [run] = await db
    .select({ repositoryId: ralphRuns.repositoryId, routedBy: ralphRuns.routedBy })
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        eq(ralphRuns.linearIssueId, linearIssueId),
        isNotNull(ralphRuns.repositoryId),
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id))
    .limit(1);
  if (run?.repositoryId) {
    return { repositoryId: run.repositoryId, routedBy: run.routedBy, via: "run" };
  }
  const [story] = await db
    .select({
      repositoryId: ralphLanes.repositoryId,
      runRepositoryId: ralphRuns.repositoryId,
      routedBy: ralphRuns.routedBy,
      runIdentifier: ralphRuns.linearIdentifier,
    })
    .from(ralphStories)
    .innerJoin(ralphLanes, eq(ralphLanes.id, ralphStories.laneId))
    .innerJoin(ralphRuns, eq(ralphRuns.id, ralphStories.runId))
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        eq(ralphStories.linearIssueId, linearIssueId),
      ),
    )
    .orderBy(desc(ralphStories.createdAt), desc(ralphStories.id))
    .limit(1);
  if (!story) return null;
  return {
    repositoryId: story.repositoryId,
    // A story in its run's own repository is routed the way the run is.
    routedBy: story.repositoryId === story.runRepositoryId ? story.routedBy : null,
    via: "lane",
    ...(story.runIdentifier && { runIdentifier: story.runIdentifier }),
  };
}

/** An issue's latest run (`listLatestIssueRuns`). */
export interface IssueRun {
  id: string;
  /** How the run was routed; null when it has none (e.g. the repository was selected). */
  routedBy: string | null;
}

/** The latest run (by creation) of each of `linearIssueIds` that has one, by issue ID. */
export async function listLatestIssueRuns(
  db: Pick<Database, "select">,
  organizationId: string,
  linearIssueIds: readonly string[],
): Promise<Map<string, IssueRun>> {
  if (linearIssueIds.length === 0) return new Map();
  const rows = await db
    .select({ issueId: ralphRuns.linearIssueId, id: ralphRuns.id, routedBy: ralphRuns.routedBy })
    .from(ralphRuns)
    .where(
      and(
        eq(ralphRuns.organizationId, organizationId),
        inArray(ralphRuns.linearIssueId, [...linearIssueIds]),
      ),
    )
    .orderBy(desc(ralphRuns.createdAt), desc(ralphRuns.id));
  const latest = new Map<string, IssueRun>();
  for (const { issueId, id, routedBy } of rows) {
    if (issueId && !latest.has(issueId)) latest.set(issueId, { id, routedBy });
  }
  return latest;
}

/**
 * Records that the follow-up `issueId` was filed from `sourceIssueId` (Linear issue IDs).
 * An issue already recorded keeps its first source.
 */
export async function recordFollowUpSource(
  db: Pick<Database, "insert">,
  organizationId: string,
  issueId: string,
  sourceIssueId: string,
): Promise<void> {
  await db
    .insert(followUpSources)
    .values({ organizationId, issueId, sourceIssueId })
    .onConflictDoNothing();
}

/** The Linear issue ID a follow-up was filed from; null when `issueId` isn't a follow-up. */
export async function getFollowUpSource(
  db: Pick<Database, "select">,
  organizationId: string,
  issueId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ sourceIssueId: followUpSources.sourceIssueId })
    .from(followUpSources)
    .where(
      and(eq(followUpSources.organizationId, organizationId), eq(followUpSources.issueId, issueId)),
    );
  return row?.sourceIssueId ?? null;
}

/** Which of `issueIds` are follow-ups (have a recorded source). */
export async function listFollowUps(
  db: Pick<Database, "select">,
  organizationId: string,
  issueIds: readonly string[],
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = await db
    .select({ issueId: followUpSources.issueId })
    .from(followUpSources)
    .where(
      and(
        eq(followUpSources.organizationId, organizationId),
        inArray(followUpSources.issueId, [...issueIds]),
      ),
    );
  return new Set(rows.map((r) => r.issueId));
}
