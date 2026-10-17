import { apiHandler } from "@/lib/api/handler";
import type { RoutingRules, SavedRoutingRules } from "@/lib/api/routing-rules";
import { getDb } from "@/lib/db";
import { linearRoutingRulesSchema } from "@/lib/linear/routing-fields";
import { loadRoutingRules, saveRoutingRules } from "@/lib/routing/rules";

/**
 * Settings › Routing (every member): the organization's rules in evaluation order, the fields
 * they can test, the Linear values the pickers offer (calls Linear) and the repositories they
 * can target.
 */
export const GET = apiHandler({}, async ({ user }): Promise<RoutingRules> =>
  loadRoutingRules(getDb(), user.organization.id),
);

/**
 * Saves the whole list, in order (admins): `{ rules: [{ repositoryId, query }] }`. An invalid
 * query or a repository outside the organization answers 400 with the field errors, and
 * nothing is saved.
 */
export const PUT = apiHandler(
  { access: "admin", body: linearRoutingRulesSchema },
  async ({ user, body }): Promise<SavedRoutingRules> =>
    saveRoutingRules(getDb(), user.organization.id, body.rules),
);
