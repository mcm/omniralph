import "server-only";
import {
  listRepositoryOverview,
  listRoutingRules,
  replaceRoutingRules,
  withSettingsChanges,
  type Database,
  type RoutingRule,
  type SettingsActor,
} from "@omniralph/db";
import type { RoutingRuleInput } from "@omniralph/shared";
import { ApiRouteError } from "@/lib/api/handler";
import type { ScopedOrganization } from "@/lib/api/scope";
import type { RoutingRuleRow, RoutingRules, SavedRoutingRules } from "@/lib/api/routing-rules";
import { LINEAR_ROUTING_FIELDS } from "@/lib/tracker/linear/routing-fields";
import { getLinearSettingsOptions } from "@/lib/tracker/linear/settings-options";
import { loadSettingsHistory } from "@/lib/settings-history/history";
import { trackedRoutingRules } from "@/lib/settings-history/sections";

/** Shown on a rule whose repository isn't one of the organization's. */
export const UNKNOWN_ROUTING_REPOSITORY = "Pick one of your organization's repositories.";

function toRow(rule: RoutingRule): RoutingRuleRow {
  return {
    id: rule.id,
    position: rule.position,
    repositoryId: rule.repositoryId,
    query: rule.query,
    updatedAt: rule.updatedAt.toISOString(),
  };
}

async function loadLinear(organizationId: string): Promise<RoutingRules["linear"]> {
  try {
    const options = await getLinearSettingsOptions(organizationId);
    return options ? { status: "connected", options } : { status: "disconnected" };
  } catch (error) {
    console.error("Loading the Linear settings options failed", error);
    return { status: "unavailable" };
  }
}

/**
 * Settings › Advanced › Routing rules: the rules in order, the field catalog, the pickers'
 * values, the targets and the rules' latest change.
 */
export async function loadRoutingRules(
  db: Database,
  organization: ScopedOrganization,
): Promise<RoutingRules> {
  const organizationId = organization.id;
  const [rules, linear, repositories, history] = await Promise.all([
    listRoutingRules(db, organizationId),
    loadLinear(organizationId),
    listRepositoryOverview(db, organizationId),
    loadSettingsHistory(db, [organization], { section: "routing_rules", limit: 1 }),
  ]);
  return {
    rules: rules.map(toRow),
    fields: LINEAR_ROUTING_FIELDS.map((field) => ({
      ...field,
      operators: [...field.operators],
      options:
        field.options && "values" in field.options
          ? { values: [...field.options.values] }
          : field.options,
    })),
    linear,
    repositories: repositories.map((repo) => ({
      id: repo.id,
      provider: repo.provider,
      fullPath: repo.fullPath,
      codingEnabled: repo.codingEnabled,
    })),
    history: history.latest,
  };
}

/**
 * Replaces the organization's rules with `rules` (already validated against the catalog),
 * atomically. A rule whose repository isn't the organization's fails the whole save with an
 * error on its `rules.{index}.repositoryId`. Records the changed rules in the change history.
 */
export async function saveRoutingRules(
  db: Database,
  organizationId: string,
  rules: readonly RoutingRuleInput[],
  actor: SettingsActor,
): Promise<SavedRoutingRules> {
  const result = await withSettingsChanges(db, actor, trackedRoutingRules(organizationId), (tx) =>
    replaceRoutingRules(tx, organizationId, rules),
  );
  if (!result.ok) {
    throw new ApiRouteError(
      400,
      UNKNOWN_ROUTING_REPOSITORY,
      "invalid_request",
      Object.fromEntries(
        result.indexes.map((i) => [`rules.${i}.repositoryId`, UNKNOWN_ROUTING_REPOSITORY]),
      ),
    );
  }
  return { ok: true, rules: result.rules.map(toRow) };
}
