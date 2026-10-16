import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { changeRule, removeRule } from "@/lib/rules/manage";

type Params = { id: string; ruleId: string };

/**
 * Changes a custom or learned rule (`RuleChange`): `{ enabled }` switches it on or off
 * (disabled rules stay listed but aren't sent to reviews), `{ text }` edits it.
 */
export const PATCH = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) =>
    changeRule(
      getDb(),
      user.organization.id,
      requireUuid(params.id),
      requireUuid(params.ruleId),
      body,
    ),
);

/** Deletes a rule. */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) =>
    removeRule(getDb(), user.organization.id, requireUuid(params.id), requireUuid(params.ruleId)),
);
