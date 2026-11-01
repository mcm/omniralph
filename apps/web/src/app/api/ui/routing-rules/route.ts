import { apiHandler } from "@/lib/api/handler";
import type { RoutingRules, SavedRoutingRules } from "@/lib/api/routing-rules";
import { activeOrganization } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { routingRulesBodySchema } from "@/lib/routing/fields";
import { loadRoutingRules, saveRoutingRules } from "@/lib/routing/rules";
import { settingsActor } from "@/lib/settings-history/sections";

/**
 * Settings › Advanced › Routing rules (every member): the organization's rules in evaluation
 * order, the fields they can test, the tracker values the pickers offer (calls the tracker), the
 * repositories they can target and the rules' latest change.
 */
export const GET = apiHandler({}, async ({ user }): Promise<RoutingRules> =>
  loadRoutingRules(getDb(), activeOrganization(user)),
);

/**
 * Saves the whole list, in order (admins): `{ rules: [{ repositoryId, query }] }`. An invalid
 * query or a repository outside the organization answers 400 with the field errors, and
 * nothing is saved.
 */
export const PUT = apiHandler(
  { access: "admin", body: routingRulesBodySchema },
  async ({ user, body }): Promise<SavedRoutingRules> =>
    saveRoutingRules(getDb(), user.organization.id, body.rules, settingsActor(user)),
);
