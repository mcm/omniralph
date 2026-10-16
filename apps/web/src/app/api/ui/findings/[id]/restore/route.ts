import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import {
  FINDING_NOT_FOUND,
  findingInOrganization,
  restoreFindingFromPanel,
} from "@/lib/reviews/manage";

/** Restores a dismissed finding of the active organization to `open` (members). */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params }) => {
    const db = getDb();
    const findingId = requireUuid(params.id);
    if (!(await findingInOrganization(db, user.organization.id, findingId))) {
      throw ApiRouteError.notFound(FINDING_NOT_FOUND);
    }
    return restoreFindingFromPanel(db, { findingId, userId: user.id });
  },
);
