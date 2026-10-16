import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RepositoryCoding } from "@/lib/api/repositories";
import { requireResourceInActiveOrganization, requireUuid } from "@/lib/api/resource";
import { loadRepositoryCoding } from "@/lib/repositories/detail";
import { updateRepositoryCodingSettings } from "@/lib/repositories/save";

type Params = { id: string };

const codingQuery = z.object({ next: z.string().max(2000).optional() });

/** The repository's Coding tab (admins): its settings and its pickers' choices, polled. */
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

/** Saves the Coding tab (`RalphSettingsInput`); new Linear values must exist in the workspace. */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) =>
    updateRepositoryCodingSettings(user.organization.id, requireUuid(params.id), body),
);
