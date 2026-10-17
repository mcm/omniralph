/** Routing rules for tests: conditions and a helper that saves an organization's list. */
import { replaceRoutingRules, type Database } from "@omniralph/db";
import type { RoutingQuery } from "@omniralph/shared";

/** Team is `key`. */
export const teamIs = (key: string): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "team", operator: "=", value: key }],
});

/** Project is `name`. */
export const projectIs = (name: string): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "project", operator: "=", value: name }],
});

/** Labels contain any of `names`. */
export const labelsInclude = (...names: string[]): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "labels", operator: "containsAny", value: names }],
});

/** Replaces the organization's routing rules with `rules`, in order. */
export async function setRoutingRules(
  db: Database,
  organizationId: string,
  ...rules: Array<[repositoryId: string, query: RoutingQuery]>
): Promise<void> {
  const saved = await replaceRoutingRules(
    db,
    organizationId,
    rules.map(([repositoryId, query]) => ({ repositoryId, query })),
  );
  if (!saved.ok) throw new Error("Saving the routing rules failed");
}
