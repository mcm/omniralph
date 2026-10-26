import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { changeRule, removeRule } from "@/lib/rules/manage";

type Params = { id: string; ruleId: string };

/**
 * Changes a custom or learned rule (`RuleChange`): `{ enabled }` switches it on or off
 * (disabled rules stay listed but aren't sent to reviews), `{ text }` edits it. Admins of
 * the repository's organization only.
 */
export const PATCH = apiHandler<"member", z.ZodUnknown, undefined, Params>(
  { body: z.unknown() },
  async ({ user, params, body }) => {
    const { organization } = await requireRepositoryAccess(user, params.id, "admin");
    return changeRule(getDb(), organization.id, params.id, requireUuid(params.ruleId), body);
  },
);

/** Deletes a rule (admins of the repository's organization). */
export const DELETE = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }) => {
    const { organization } = await requireRepositoryAccess(user, params.id, "admin");
    return removeRule(getDb(), organization.id, params.id, requireUuid(params.ruleId));
  },
);
