import { getScmConnection } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { ScmConnectionSummary } from "@/lib/api/repositories";
import { requireResourceInActiveOrganization, requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { removeScmConnection } from "@/lib/repositories/manage";

type Params = { id: string };

const detailQuery = z.object({
  /** The picker asking: a connection of the other code host is not found. */
  provider: z.enum(["github", "gitlab"]),
  next: z.string().max(2000).optional(),
});

/**
 * A code-host connection of the active organization, for its picker's header. When it's
 * another of the user's organizations', the 409 that switches to it comes back to `next`.
 */
export const GET = apiHandler<"admin", undefined, typeof detailQuery, Params>(
  { access: "admin", query: detailQuery },
  async ({ user, params, query }): Promise<ScmConnectionSummary> => {
    await requireResourceInActiveOrganization(user, "scm_connection", params.id, {
      pathPrefix: `/repositories/${query.provider}/${params.id}`,
      next: query.next,
    });
    const connection = await getScmConnection(getDb(), user.organization.id, params.id);
    if (
      !connection ||
      connection.provider !== query.provider ||
      (connection.provider === "github" && !connection.externalId)
    ) {
      throw ApiRouteError.notFound();
    }
    return { id: connection.id, provider: connection.provider, name: connection.name };
  },
);

/** Removes the connection with its repositories (and their reviews, rules and pins). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => removeScmConnection(getDb(), user, requireUuid(params.id)),
);
