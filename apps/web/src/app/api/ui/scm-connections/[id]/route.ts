import { getScmConnectionById } from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { removeScmConnection } from "@/lib/repositories/manage";

type Params = { id: string };

/**
 * Removes the connection with its repositories (and their reviews, rules and pins). The
 * connection may belong to any of the user's organizations, where they must be an admin;
 * one of an organization they aren't a member of isn't found.
 */
export const DELETE = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }) => {
    const db = getDb();
    const connection = await getScmConnectionById(db, requireUuid(params.id));
    if (!connection) throw ApiRouteError.notFound();
    const organization = await requireOrganizationAccess(user, connection.organizationId, {
      role: "admin",
    });
    return removeScmConnection(db, user, organization.id, connection.id);
  },
);
