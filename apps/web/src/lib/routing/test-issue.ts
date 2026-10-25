import "server-only";
import { InvalidInputLinearError } from "@linear/sdk";
import { listLatestIssueRuns, type Database, type RoutingRule } from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import type { RoutingPreviewItem, RoutingTestResult } from "@/lib/api/routing-rules";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import { fixtureLinearEnabled, fixtureLinearGateway } from "@/lib/linear/fixture-gateway";
import type { LinearGateway, RoutingIssue } from "@/lib/linear/gateway";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import { hitRateLimit } from "@/lib/rate-limit";
import { describeQuery } from "./describe";
import { createRouter, type RouteDeps } from "./resolve";

/** Most "Test an issue" and routing preview requests one user may make a minute (shared). */
export const ROUTING_TEST_LIMIT = 30;

export const unknownIssueMessage = (identifier: string) =>
  `There's no issue ${identifier} in your Linear workspace, or Omniralph can't read it.`;

type Rules = readonly Pick<RoutingRule, "repositoryId" | "query">[];

/** A work item's route (`routeIssues`), as the preview answers it. */
export type RoutedIssue = Exclude<RoutingPreviewItem, { outcome: "not_found" }>;

/**
 * Where each of `identifiers` routes under `rules` (the saved list, or Settings › Routing's
 * unsaved one, already validated), by the same router delegation, triage, story lanes and
 * follow-ups use, in the order sent. An issue Linear doesn't know is a `not_found` result.
 *
 * Linear is asked once per issue in the request: the issues sent are loaded first, and
 * every later lookup (a parent, a follow-up's source, an issue sent twice) reuses them.
 */
export async function routeIssues(
  deps: Omit<RouteDeps, "rules">,
  identifiers: readonly string[],
  rules: Rules,
): Promise<RoutingPreviewItem[]> {
  const linear = dedupedRoutingFields(deps.linear);
  const loaded = new Map(
    await Promise.all(
      [...new Set(identifiers)].map(
        async (identifier) => [identifier, await loadIssue(linear, identifier)] as const,
      ),
    ),
  );
  const router = await createRouter({ ...deps, linear, rules });
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
        return {
          ...base,
          outcome: "ask",
          repository: null,
          rule: { kind: "default", number: 3 },
          by: null,
        };
      }
      const manual = "manual" in route;
      const repository = manual ? route.manual : route.repository;
      const ruleQuery = route.rule === undefined ? undefined : rules[route.rule - 1]?.query;
      return {
        ...base,
        outcome: manual ? "manual" : "repository",
        repository: {
          id: repository.id,
          fullPath: repository.fullPath,
          codingEnabled: repository.effective.coding,
        },
        rule:
          route.rule !== undefined && ruleQuery
            ? {
                kind: "custom",
                number: route.rule,
                summary: describeQuery(ruleQuery, LINEAR_ROUTING_FIELDS),
              }
            : { kind: "default", number: route.defaultRule ?? 3 },
        by: route.by,
      };
    }),
  );
}

/**
 * Settings › Routing's "Test an issue": where `identifier` routes under `rules` (the unsaved
 * list, already validated), by `routeIssues`. An issue Linear doesn't know answers 404.
 */
export async function testRoutingRules(
  deps: Omit<RouteDeps, "rules">,
  identifier: string,
  rules: Rules,
): Promise<RoutingTestResult> {
  const [result] = await routeIssues(deps, [identifier], rules);
  if (!result || result.outcome === "not_found") {
    throw new ApiRouteError(404, unknownIssueMessage(identifier), "not_found");
  }
  const { issue, outcome, repository, rule, by } = result;
  return {
    issue,
    outcome,
    repository: repository && { id: repository.id, fullPath: repository.fullPath },
    rule,
    by,
  };
}

/** An issue's routing fields, or null when Linear doesn't know it. */
async function loadIssue(
  linear: RouteDeps["linear"],
  identifier: string,
): Promise<RoutingIssue | null> {
  try {
    return await linear.getRoutingFields(identifier);
  } catch (error) {
    if (error instanceof InvalidInputLinearError) return null;
    throw error;
  }
}

/** `getRoutingFields` asking Linear once per issue, by ID or identifier (failures are retried). */
function dedupedRoutingFields(linear: RouteDeps["linear"]): RouteDeps["linear"] {
  const cache = new Map<string, Promise<RoutingIssue>>();
  return {
    getRoutingFields(idOrIdentifier) {
      let pending = cache.get(idOrIdentifier);
      if (!pending) {
        pending = linear.getRoutingFields(idOrIdentifier);
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

/** Counts a "Test an issue" or preview request; 429 past `ROUTING_TEST_LIMIT` a minute per user. */
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
