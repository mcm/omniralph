import { RepositoryCodingInput } from "@omniralph/shared";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { apiHandler } from "@/lib/api/handler";
import type { RepositoryCoding } from "@/lib/api/repositories";
import { requireResourceInActiveOrganization, requireUuid } from "@/lib/api/resource";
import { loadRepositoryCoding } from "@/lib/repositories/detail";
import { updateRepositoryCodingSettings } from "@/lib/repositories/save";

type Params = { id: string };

const codingQuery = z.object({ next: z.string().max(2000).optional() });

/** The repository's coding policy (admins), with its story playbook's round limits. */
export const GET = apiHandler<"admin", undefined, typeof codingQuery, Params>(
  { access: "admin", query: codingQuery },
  async ({ user, params, query }): Promise<RepositoryCoding> => {
    await requireResourceInActiveOrganization(user, "repository", params.id, {
      pathPrefix: `/repositories/${params.id}`,
      next: query.next,
    });
    return loadRepositoryCoding(user.organization.id, params.id);
  },
);

/**
 * Saves the repository's coding policy: exactly `RepositoryCodingInput` (any other key answers
 * 400). Answers the saved policy.
 */
export const PUT = apiHandler<"admin", typeof RepositoryCodingInput, undefined, Params>(
  { access: "admin", body: RepositoryCodingInput },
  async ({ user, params, body }): Promise<RepositoryCoding | ActionResult> =>
    updateRepositoryCodingSettings(user, requireUuid(params.id), body),
);
