import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RepositoryRules } from "@/lib/api/rules";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { addCustomRule, loadRepositoryRules } from "@/lib/rules/manage";

type Params = { id: string };

/**
 * A connected repository of any of the user's organizations with its custom and learned
 * rules. Another organization's repository is not found.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<RepositoryRules> => {
    const { organization } = await requireRepositoryAccess(user, params.id);
    return loadRepositoryRules(getDb(), organization.id, params.id);
  },
);

/**
 * Adds an admin-written rule (`RuleInput`, checked by the add so its errors read like the
 * form's); it applies to the next review job of the repository. Admins of the repository's
 * organization only.
 */
export const POST = apiHandler<"member", z.ZodUnknown, undefined, Params>(
  { body: z.unknown() },
  async ({ user, params, body }) => {
    const { organization } = await requireRepositoryAccess(user, params.id, "admin");
    return addCustomRule(
      getDb(),
      { id: user.id, organizationId: organization.id },
      params.id,
      body,
    );
  },
);
