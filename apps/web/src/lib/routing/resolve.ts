/**
 * Which repository an issue routes to (`resolveRoute`): the organization's routing rules in
 * order (the first match wins), then the default rules, which aren't stored:
 *
 *   1. sub-issue   route it the same as its parent
 *   2. ask         ask which repository to use (the repository question)
 *
 * A match on a repository with coding off makes the issue manual: a person does it.
 *
 * "Route the same as" another issue uses the repository Omniralph already uses for it (its
 * run's, including "your selection", else its story lane's), else resolves it the same way.
 * A cycle, or more than `MAX_ROUTE_HOPS` such hops, is no result. When the other issue would
 * ask, the default rule doesn't match and the next one is tried; when it is manual, so is
 * this issue.
 */
import {
  getIssueRepository,
  listRoutingRepositories,
  listRoutingRules,
  type Database,
  type RepositoryWithSwitches,
  type RoutingRule,
} from "@omniralph/db";
import type { LinearGateway } from "@/lib/linear/gateway";
import {
  LINEAR_ROUTING_FIELDS,
  LINEAR_ROUTING_FIELD_TYPES,
  linearRoutingValues,
} from "@/lib/linear/routing-fields";
import { describeRule } from "./describe";
import { evaluateQuery } from "./evaluate";

/** Most "route the same as another issue" steps one resolution takes. */
export const MAX_ROUTE_HOPS = 5;

export type RouteOutcome<R = RepositoryWithSwitches> =
  /** The issue builds in `repository` (coding on). `by` is its `routed_by`. */
  | { repository: R; by: string; rule?: number }
  /** The issue routes to `manual`, whose coding is off: it's for a person. */
  | { manual: R; by: string; rule?: number }
  /** Nothing routes it: ask which repository to use. */
  | { ask: true };

/** A route to a repository (coding on or off), with `rule` set for a direct custom-rule match. */
export type RoutedOutcome<R = RepositoryWithSwitches> = Exclude<RouteOutcome<R>, { ask: true }>;

/** The repository of a routed outcome, coding on or off. */
export function routedRepository<R>(outcome: RouteOutcome<R>): R | null {
  if ("repository" in outcome) return outcome.repository;
  if ("manual" in outcome) return outcome.manual;
  return null;
}

export interface RouteDeps {
  db: Database;
  organizationId: string;
  linear: Pick<LinearGateway, "getRoutingFields">;
}

export interface Router {
  /** The route of an issue (by ID or identifier), memoized for the router's lifetime. */
  resolve(issueId: string): Promise<RouteOutcome>;
}

const ASK = { ask: true } as const;

/**
 * A router over the organization's rules and repositories as they are now. Use one per
 * decision, so every lookup in it sees the same rules.
 */
export async function createRouter(deps: RouteDeps): Promise<Router> {
  const [rules, repositories] = await Promise.all([
    listRoutingRules(deps.db, deps.organizationId),
    listRoutingRepositories(deps.db, deps.organizationId),
  ]);
  const byId = new Map(repositories.map((r) => [r.id, r]));
  const memo = new Map<string, Promise<RouteOutcome>>();

  const outcome = (repository: RepositoryWithSwitches, by: string, rule?: number): RoutedOutcome =>
    repository.effective.coding
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

  /** The route of `issueId` itself: the rules, then the defaults. */
  const resolveIssue = async (
    issueId: string,
    seen: ReadonlySet<string>,
    hops: number,
  ): Promise<RouteOutcome> => {
    const routing = await deps.linear.getRoutingFields(issueId);
    const { issue } = routing;
    if (seen.has(issue.id) || seen.has(issue.identifier)) return ASK;
    const visited = new Set([...seen, issueId, issue.id, issue.identifier]);

    const matched = matchRules(linearRoutingValues(routing));
    if (matched) return matched;

    // Default rule 1: a sub-issue routes the same as its parent.
    if (issue.parentId) {
      const parent = await routeAs(issue.parentId, visited, hops + 1);
      if (!("ask" in parent)) {
        const name = routing.parent?.identifier ?? issue.parent ?? issue.parentId;
        const by = `sub-issue of ${name} → ${parent.by}`;
        return "repository" in parent
          ? { repository: parent.repository, by }
          : { manual: parent.manual, by };
      }
    }
    // Default rule 2: ask.
    return ASK;
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

  const describe = (index: number, rule: RoutingRule) =>
    describeRule(index + 1, rule.query, LINEAR_ROUTING_FIELDS);

  return {
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
