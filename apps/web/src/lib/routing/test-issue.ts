import "server-only";
import { InvalidInputLinearError } from "@linear/sdk";
import type { RoutingRuleInput } from "@omniralph/shared";
import { ApiRouteError } from "@/lib/api/handler";
import type { RoutingTestResult } from "@/lib/api/routing-rules";
import type { RoutingIssue } from "@/lib/linear/gateway";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import { describeQuery } from "./describe";
import { resolveRoute, type RouteDeps } from "./resolve";

/** Most "Test an issue" requests one user may make a minute. */
export const ROUTING_TEST_LIMIT = 30;

export const unknownIssueMessage = (identifier: string) =>
  `There's no issue ${identifier} in your Linear workspace, or Omniralph can't read it.`;

/**
 * Settings › Routing's "Test an issue": where `identifier` routes under `rules` (the unsaved
 * list, already validated), by the same `resolveRoute` delegation, triage, story lanes and
 * follow-ups use. An issue Linear doesn't know answers 404.
 */
export async function testRoutingRules(
  deps: Omit<RouteDeps, "rules">,
  identifier: string,
  rules: readonly RoutingRuleInput[],
): Promise<RoutingTestResult> {
  let loaded: RoutingIssue;
  try {
    loaded = await deps.linear.getRoutingFields(identifier);
  } catch (error) {
    if (error instanceof InvalidInputLinearError) {
      throw new ApiRouteError(404, unknownIssueMessage(identifier), "not_found");
    }
    throw error;
  }
  const { issue } = loaded;
  // The issue was just loaded: the resolver reuses it rather than asking Linear again.
  const linear: RouteDeps["linear"] = {
    getRoutingFields: (id) =>
      id === identifier || id === issue.id || id === issue.identifier
        ? Promise.resolve(loaded)
        : deps.linear.getRoutingFields(id),
  };
  const route = await resolveRoute({ ...deps, linear, rules }, issue.id);
  const summary = { identifier: issue.identifier, title: issue.title };
  if ("ask" in route) {
    return {
      issue: summary,
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
    issue: summary,
    outcome: manual ? "manual" : "repository",
    repository: { id: repository.id, fullPath: repository.fullPath },
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
}
