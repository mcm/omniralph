/**
 * Which repository an issue routes to (`resolveRoute`): first the repository a member chose for
 * it in Omniralph ("Change repo…", `work_item_overrides`) while that repository is connected;
 * then the organization's routing rules in order (the first match wins), whenever it has any;
 * then the work item matches of its connected repositories (`match.ts`: the most specific one
 * wins, and a tie asks); then the default rules, which aren't stored:
 *
 *   1. follow-up   route it the same as the issue it was filed from (its source)
 *   2. sub-issue   route it the same as its parent
 *   3. ask         ask which repository to use (the repository question)
 *
 * A match or choice of a repository with coding off makes the issue manual: a person does it. An issue
 * is a follow-up only when Omniralph recorded its source (`recordFollowUpSource`); rules read
 * the source's fields as `source.*`.
 *
 * "Route the same as" another issue uses the repository Omniralph already uses for it (its
 * run's, including "your selection", else its story lane's), else resolves it the same way.
 * A cycle, or more than `MAX_ROUTE_HOPS` such hops, is no result. When the other issue would
 * ask, the default rule doesn't match and the next one is tried; when it is manual, so is
 * this issue.
 */
import {
  getFollowUpSource,
  getIssueRepository,
  getWorkItemOverride,
  listRoutingRepositories,
  listRoutingRules,
  listWorkItemMatches,
  type Database,
  type Repository,
  type RoutingRule,
  type WorkItemMatchFields,
} from "@omniralph/db";
import type { LinearGateway, RoutingIssueFields } from "@/lib/linear/gateway";
import {
  LINEAR_ROUTING_FIELDS,
  LINEAR_ROUTING_FIELD_TYPES,
  linearRoutingValues,
} from "@/lib/linear/routing-fields";
import { describeRule } from "./describe";
import { evaluateQuery } from "./evaluate";
import { describeMatchRoute, describeMatchTie, matchesWorkItem, specificity } from "./match";

/** `routed_by` of a repository a member chose for the issue ("Change repo…"). */
export const chosenBy = (fullPath: string) =>
  `your choice in Omniralph (${fullPath.split("/").filter(Boolean).pop() ?? fullPath})`;

/** Most "route the same as another issue" steps one resolution takes. */
export const MAX_ROUTE_HOPS = 5;

export type RouteOutcome<R = Repository> =
  /** The issue builds in `repository` (coding on). `by` is its `routed_by`. */
  | ({ repository: R } & RouteMatch)
  /** The issue routes to `manual`, whose coding is off: it's for a person. */
  | ({ manual: R } & RouteMatch)
  /**
   * Nothing routes it: ask which repository to use. `by` is set when the most specific work
   * item matches tie: it names their repositories.
   */
  | { ask: true; by?: string };

/** How an issue's own rules routed it. */
export interface RouteMatch {
  /** `routed_by`, the whole chain: `sub-issue of ENG-10 → rule 2 (Team is ENG)`. */
  by: string;
  /** The custom rule (1-based) the issue itself matched. */
  rule?: number;
  /** The default rule the issue itself matched: 1 follow-up, 2 sub-issue (3 asks). */
  defaultRule?: 1 | 2;
  /** The issue itself matched its repository's work item match. */
  workItemMatch?: true;
  /** A member chose the repository for the issue in Omniralph ("Change repo…"). */
  chosen?: true;
}

/** A route to a repository (coding on or off), with `rule` set for a direct custom-rule match. */
export type RoutedOutcome<R = Repository> = Exclude<RouteOutcome<R>, { ask: true }>;

/** The repository of a routed outcome, coding on or off. */
export function routedRepository<R>(outcome: RouteOutcome<R>): R | null {
  if ("repository" in outcome) return outcome.repository;
  if ("manual" in outcome) return outcome.manual;
  return null;
}

export interface RouteDeps {
  /** The database, or a transaction whose writes the routes should see. */
  db: Pick<Database, "select">;
  organizationId: string;
  linear: Pick<LinearGateway, "getRoutingFields">;
  /** Rules to route by instead of the saved ones, in order (Settings › Advanced › Routing rules' unsaved list). */
  rules?: readonly Pick<RoutingRule, "repositoryId" | "query">[];
  /** Work item matches to route by instead of the saved ones (an unsaved match applied). */
  matches?: readonly RouteWorkItemMatch[];
  /**
   * Saved repo choices ("Change repo…") read beforehand for a page of issues: Linear issue ID
   * to the chosen repository ID, null for an issue without one. An issue not in it is looked
   * up.
   */
  choices?: ReadonlyMap<string, string | null>;
}

/** A repository's work item match, as routing reads it. */
export type RouteWorkItemMatch = WorkItemMatchFields & { repositoryId: string };

export interface Router {
  /**
   * Whether the organization has routing rules or work item matches (without any, only the
   * default rules route).
   */
  readonly hasCustomRoutes: boolean;
  /** The route of an issue (by ID or identifier), memoized for the router's lifetime. */
  resolve(issueId: string): Promise<RouteOutcome>;
}

const ASK = { ask: true } as const;

/**
 * A router over the organization's rules and repositories as they are now. Use one per
 * decision, so every lookup in it sees the same rules.
 */
export async function createRouter(deps: RouteDeps): Promise<Router> {
  const [rules, savedMatches, repositories] = await Promise.all([
    deps.rules ?? listRoutingRules(deps.db, deps.organizationId),
    deps.matches ?? listWorkItemMatches(deps.db, deps.organizationId),
    listRoutingRepositories(deps.db, deps.organizationId),
  ]);
  const byId = new Map(repositories.map((r) => [r.id, r]));
  // A match whose repository is disconnected routes nothing.
  const matches = savedMatches.flatMap((match) => {
    const repository = byId.get(match.repositoryId);
    return repository ? [{ match, repository }] : [];
  });
  const memo = new Map<string, Promise<RouteOutcome>>();

  const outcome = (repository: Repository, by: string, rule?: number): RoutedOutcome =>
    repository.codingEnabled
      ? { repository, by, ...(rule !== undefined && { rule }) }
      : { manual: repository, by, ...(rule !== undefined && { rule }) };

  const matchRules = (values: ReturnType<typeof linearRoutingValues>): RouteOutcome | null => {
    for (const [index, rule] of rules.entries()) {
      // A rule whose repository is disconnected routes nothing.
      const repository = byId.get(rule.repositoryId);
      if (!repository) continue;
      if (evaluateQuery(rule.query, values, LINEAR_ROUTING_FIELD_TYPES)) {
        return outcome(repository, describe(index, rule), index + 1);
      }
    }
    return null;
  };

  /** The most specific work item match of `issue`; a tie asks, naming the tied repositories. */
  const matchWorkItem = (issue: RoutingIssueFields): RouteOutcome | null => {
    let best: typeof matches = [];
    let bestSpecificity = -1;
    for (const candidate of matches) {
      if (!matchesWorkItem(candidate.match, issue)) continue;
      const value = specificity(candidate.match);
      if (value > bestSpecificity) {
        best = [candidate];
        bestSpecificity = value;
      } else if (value === bestSpecificity) {
        best.push(candidate);
      }
    }
    const [winner, ...tied] = best;
    if (!winner) return null;
    if (tied.length > 0) {
      return { ask: true, by: describeMatchTie(best.map((c) => c.repository.fullPath)) };
    }
    const by = describeMatchRoute(winner.match);
    return winner.repository.codingEnabled
      ? { repository: winner.repository, by, workItemMatch: true }
      : { manual: winner.repository, by, workItemMatch: true };
  };

  /** The route of `issueId` itself: the rules, the work item matches, then the defaults. */
  const resolveIssue = async (
    issueId: string,
    seen: ReadonlySet<string>,
    hops: number,
  ): Promise<RouteOutcome> => {
    const routing = await deps.linear.getRoutingFields(issueId);
    const { issue } = routing;
    if (seen.has(issue.id) || seen.has(issue.identifier)) return ASK;
    const visited = new Set([...seen, issueId, issue.id, issue.identifier]);

    // A member's choice for this issue comes first, while its repository is connected.
    const chosen = await chosenRoute(issue.id);
    if (chosen) return chosen;

    const sourceId = await getFollowUpSource(deps.db, deps.organizationId, issue.id);
    const source = sourceId ? await sourceFields(issue.identifier, sourceId) : null;

    const matched = matchRules(linearRoutingValues(routing, source)) ?? matchWorkItem(issue);
    if (matched) return matched;

    // Default rule 1: a follow-up routes the same as its source.
    if (sourceId) {
      const routed = await routeAs(sourceId, visited, hops + 1);
      if (!("ask" in routed)) {
        const by = `follow-up of ${source?.identifier ?? sourceId} → ${routed.by}`;
        return "repository" in routed
          ? { repository: routed.repository, by, defaultRule: 1 }
          : { manual: routed.manual, by, defaultRule: 1 };
      }
    }
    // Default rule 2: a sub-issue routes the same as its parent.
    if (issue.parentId) {
      const parent = await routeAs(issue.parentId, visited, hops + 1);
      if (!("ask" in parent)) {
        const name = routing.parent?.identifier ?? issue.parent ?? issue.parentId;
        const by = `sub-issue of ${name} → ${parent.by}`;
        return "repository" in parent
          ? { repository: parent.repository, by, defaultRule: 2 }
          : { manual: parent.manual, by, defaultRule: 2 };
      }
    }
    // Default rule 3: ask.
    return ASK;
  };

  /** The route a member chose for `issueId` ("Change repo…"), or null without a usable choice. */
  const chosenRoute = async (issueId: string): Promise<RoutedOutcome | null> => {
    const repositoryId = deps.choices?.has(issueId)
      ? deps.choices.get(issueId)
      : (
          await getWorkItemOverride(deps.db, {
            organizationId: deps.organizationId,
            tracker: "linear",
            externalId: issueId,
          })
        )?.repositoryId;
    const repository = repositoryId ? byId.get(repositoryId) : undefined;
    if (!repository) return null;
    return { ...outcome(repository, chosenBy(repository.fullPath)), chosen: true };
  };

  /** A follow-up's source's fields; null (empty `source.*`) when it can't be read, e.g. deleted. */
  const sourceFields = async (identifier: string, sourceId: string) => {
    try {
      return (await deps.linear.getRoutingFields(sourceId)).issue;
    } catch (error) {
      console.warn(`${identifier}: could not read its follow-up source ${sourceId}`, error);
      return null;
    }
  };

  /** Route the same as `issueId`: the repository Omniralph uses for it, else its route. */
  const routeAs = async (
    issueId: string,
    seen: ReadonlySet<string>,
    hops: number,
  ): Promise<RouteOutcome> => {
    if (hops > MAX_ROUTE_HOPS || seen.has(issueId)) return ASK;
    const existing = await getIssueRepository(deps.db, deps.organizationId, issueId);
    const repository = existing && byId.get(existing.repositoryId);
    if (existing && repository) {
      const by =
        existing.routedBy ??
        (existing.via === "lane" && existing.runIdentifier
          ? `story of ${existing.runIdentifier}`
          : "its run");
      return outcome(repository, by);
    }
    return resolveIssue(issueId, seen, hops);
  };

  const describe = (index: number, rule: Pick<RoutingRule, "query">) =>
    describeRule(index + 1, rule.query, LINEAR_ROUTING_FIELDS);

  return {
    hasCustomRoutes: rules.length > 0 || matches.length > 0,
    resolve(issueId) {
      let route = memo.get(issueId);
      if (!route) {
        route = resolveIssue(issueId, new Set(), 0);
        memo.set(issueId, route);
        // A failed load isn't remembered.
        route.catch(() => memo.delete(issueId));
      }
      return route;
    },
  };
}

/** The route of one issue under the organization's rules (`createRouter` for several). */
export async function resolveRoute(deps: RouteDeps, issueId: string): Promise<RouteOutcome> {
  return (await createRouter(deps)).resolve(issueId);
}
