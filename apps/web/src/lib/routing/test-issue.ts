import "server-only";
import {
  listLatestIssueRuns,
  listRoutingRules,
  listWorkItemMatches,
  type Database,
  type RoutingRule,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import type { RoutingPreviewItem, RoutingTestResult } from "@/lib/api/routing-rules";
import type { WorkItemMatchInput } from "@/lib/api/work-item-matches";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/tracker/linear/client";
import { fixtureLinearEnabled, fixtureLinearGateway } from "@omniralph/tracker/linear/testing";
import { TrackerNotFoundError } from "@omniralph/tracker";
import type { LinearGateway, RoutingIssue } from "@omniralph/tracker/linear";
import { LINEAR_ROUTING_FIELDS } from "@/lib/tracker/linear/routing-fields";
import { readRoutingIssue } from "@/lib/tracker/routing-issue";
import { hitRateLimit } from "@/lib/rate-limit";
import { describeQuery } from "./describe";
import { createRouter, type RouteDeps, type RouteWorkItemMatch } from "./resolve";

/**
 * Most "Test where an issue would go" and routing preview requests one user may make a minute
 * (shared).
 */
export const ROUTING_TEST_LIMIT = 30;

export const unknownIssueMessage = (identifier: string) =>
  `There's no issue ${identifier} in your Linear workspace, or Omniralph can't read it.`;

type Rules = readonly Pick<RoutingRule, "repositoryId" | "query">[];

/** A work item's route (`routeIssues`), as the preview answers it. */
export type RoutedIssue = Exclude<RoutingPreviewItem, { outcome: "not_found" }>;

/** A repository's unsaved work item match (null: cleared) to test with. */
export interface UnsavedWorkItemMatch {
  repositoryId: string;
  match: WorkItemMatchInput | null;
}

/** The saved work item matches with `unsaved` applied: its repository's replaced or cleared. */
async function matchesWith(
  deps: Pick<RouteDeps, "db" | "organizationId">,
  unsaved: UnsavedWorkItemMatch,
): Promise<RouteWorkItemMatch[]> {
  const saved = await listWorkItemMatches(deps.db, deps.organizationId);
  const others = saved.filter((m) => m.repositoryId !== unsaved.repositoryId);
  return unsaved.match
    ? [...others, { ...unsaved.match, repositoryId: unsaved.repositoryId }]
    : others;
}

/**
 * Where each of `identifiers` routes under `rules` (the saved list, or Settings › Advanced ›
 * Routing rules' unsaved one, already validated) and the work item matches, with `unsaved`
 * applied when given, by the same router delegation, triage, story lanes and follow-ups use, in
 * the order sent. An issue Linear doesn't know is a `not_found` result.
 *
 * Linear is asked once per issue in the request: the issues sent are loaded first, and
 * every later lookup (a parent, a follow-up's source, an issue sent twice) reuses them.
 */
export async function routeIssues(
  deps: Omit<RouteDeps, "rules" | "matches">,
  identifiers: readonly string[],
  rules: Rules,
  unsaved?: UnsavedWorkItemMatch,
): Promise<RoutingPreviewItem[]> {
  const linear = dedupedRoutingFields(deps.linear);
  const loaded = new Map(
    await Promise.all(
      [...new Set(identifiers)].map(
        async (identifier) => [identifier, await loadIssue(linear, identifier)] as const,
      ),
    ),
  );
  const matches = unsaved ? await matchesWith(deps, unsaved) : undefined;
  const router = await createRouter({ ...deps, linear, rules, ...(matches && { matches }) });
  const issueIds = [...loaded.values()].flatMap((l) => (l ? [l.issue.id] : []));
  const runs = await listLatestIssueRuns(deps.db, deps.organizationId, issueIds);

  return Promise.all(
    identifiers.map(async (identifier): Promise<RoutingPreviewItem> => {
      const found = loaded.get(identifier);
      if (!found) {
        return { identifier, outcome: "not_found", message: unknownIssueMessage(identifier) };
      }
      const { issue } = found;
      const route = await router.resolve(issue.id);
      const base = {
        identifier,
        issue: { identifier: issue.identifier, title: issue.title },
        run: runs.get(issue.id) ?? null,
      };
      if ("ask" in route) {
        // `by` is set only when work item matches tie.
        return route.by
          ? {
              ...base,
              outcome: "ask",
              repository: null,
              matched: "match",
              rule: null,
              by: route.by,
            }
          : {
              ...base,
              outcome: "ask",
              repository: null,
              matched: "default",
              rule: { kind: "default", number: 3 },
              by: null,
            };
      }
      const manual = "manual" in route;
      const repository = manual ? route.manual : route.repository;
      const ruleQuery = route.rule === undefined ? undefined : rules[route.rule - 1]?.query;
      const routed = {
        ...base,
        outcome: manual ? ("manual" as const) : ("repository" as const),
        repository: {
          id: repository.id,
          fullPath: repository.fullPath,
          provider: repository.provider,
          codingEnabled: repository.codingEnabled,
        },
        by: route.by,
      };
      if (route.rule !== undefined && ruleQuery) {
        return {
          ...routed,
          matched: "rule",
          rule: {
            kind: "custom",
            number: route.rule,
            summary: describeQuery(ruleQuery, LINEAR_ROUTING_FIELDS),
          },
        };
      }
      if (route.workItemMatch) return { ...routed, matched: "match", rule: null };
      return {
        ...routed,
        matched: "default",
        rule: { kind: "default", number: route.defaultRule ?? 3 },
      };
    }),
  );
}

/**
 * Settings › Advanced › Routing rules' "Test where an issue would go": where `identifier` routes
 * under `rules` (the unsaved list, already validated; undefined: the saved rules) and the work
 * item matches, with `unsaved` applied when given, by `routeIssues`. An issue Linear doesn't know answers 404.
 */
export async function testRoutingRules(
  deps: Omit<RouteDeps, "rules" | "matches">,
  identifier: string,
  rules: Rules | undefined,
  unsaved?: UnsavedWorkItemMatch,
): Promise<RoutingTestResult> {
  const [result] = await routeIssues(
    deps,
    [identifier],
    rules ?? (await listRoutingRules(deps.db, deps.organizationId)),
    unsaved,
  );
  if (!result || result.outcome === "not_found") {
    throw new ApiRouteError(404, unknownIssueMessage(identifier), "not_found");
  }
  const { issue, outcome, repository, matched, rule, by, run } = result;
  return {
    issue,
    outcome,
    repository: repository && {
      id: repository.id,
      fullPath: repository.fullPath,
      provider: repository.provider,
    },
    matched,
    rule,
    by,
    run,
  };
}

/** An issue's routing fields, or null when Linear doesn't know it. */
async function loadIssue(
  linear: RouteDeps["linear"],
  identifier: string,
): Promise<RoutingIssue | null> {
  try {
    return await readRoutingIssue(linear, identifier);
  } catch (error) {
    if (error instanceof TrackerNotFoundError) return null;
    throw error;
  }
}

/** `getRoutingFields` asking Linear once per issue, by ID or identifier (failures are retried). */
function dedupedRoutingFields(
  linear: RouteDeps["linear"],
): Pick<LinearGateway, "getRoutingFields"> {
  const cache = new Map<string, Promise<RoutingIssue>>();
  return {
    getRoutingFields(idOrIdentifier) {
      let pending = cache.get(idOrIdentifier);
      if (!pending) {
        pending = readRoutingIssue(linear, idOrIdentifier);
        cache.set(idOrIdentifier, pending);
        pending.then(
          (loaded) => {
            cache.set(loaded.issue.id, pending!);
            cache.set(loaded.issue.identifier, pending!);
          },
          () => cache.delete(idOrIdentifier),
        );
      }
      return pending;
    },
  };
}

/**
 * Counts a "Test where an issue would go" or preview request; 429 past `ROUTING_TEST_LIMIT` a
 * minute per user.
 */
export async function hitRoutingTestLimit(db: Database, userId: string): Promise<void> {
  const limit = await hitRateLimit(db, {
    key: `routing_test:user:${userId}`,
    limit: ROUTING_TEST_LIMIT,
    windowSeconds: 60,
  });
  if (limit.limited) {
    throw new ApiRouteError(
      429,
      `That's a lot of tests in a minute. Try again in ${limit.retryAfterSeconds} seconds.`,
      "rate_limited",
    );
  }
}

/** The organization's Linear workspace to route by; 409 with `message` when none is connected. */
export async function routingLinearGateway(
  db: Database,
  organizationId: string,
  message: string,
): Promise<LinearGateway> {
  try {
    return await getLinearGateway({
      db,
      organizationId,
      ...(fixtureLinearEnabled() && { createGateway: fixtureLinearGateway }),
    });
  } catch (error) {
    if (error instanceof LinearNotConnectedError) {
      throw new ApiRouteError(409, message, "linear_not_connected");
    }
    throw error;
  }
}
