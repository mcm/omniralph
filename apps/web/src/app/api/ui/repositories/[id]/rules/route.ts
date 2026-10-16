import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { requireResourceInActiveOrganization, requireUuid } from "@/lib/api/resource";
import type { RepositoryRules } from "@/lib/api/rules";
import { getDb } from "@/lib/db";
import { addCustomRule, loadRepositoryRules } from "@/lib/rules/manage";

type Params = { id: string };

const rulesQuery = z.object({ next: z.string().max(2000).optional() });

/**
 * Repository › Rules: a connected repository of the active organization with its custom and
 * learned rules, polled. `?next=` is the page asking: when the repository is another of the
 * user's organizations', the 409 that switches to it comes back there.
 */
export const GET = apiHandler<"member", undefined, typeof rulesQuery, Params>(
  { query: rulesQuery },
  async ({ user, params, query }): Promise<RepositoryRules> => {
    await requireResourceInActiveOrganization(user, "repository", params.id, {
      pathPrefix: `/repositories/${params.id}`,
      next: query.next,
    });
    return loadRepositoryRules(getDb(), user.organization.id, params.id);
  },
);

/**
 * Adds an admin-written rule (`RuleInput`, checked by the add so its errors read like the
 * form's); it applies to the next review job of the repository.
 */
export const POST = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) =>
    addCustomRule(
      getDb(),
      { id: user.id, organizationId: user.organization.id },
      requireUuid(params.id),
      body,
    ),
);
