import { DismissFindingInput } from "@omniralph/shared";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import {
  dismissFindingFromPanel,
  FINDING_NOT_FOUND,
  findingInOrganization,
} from "@/lib/reviews/manage";

/**
 * Dismisses an open finding of the active organization (members; body
 * `DismissFindingInput`): `ui` feedback by the caller, and its thread on the code host
 * resolved. A thread that can't be resolved comes back as `warning`; the dismissal stands.
 */
export const POST = apiHandler<"member", typeof DismissFindingInput, undefined, { id: string }>(
  { body: DismissFindingInput },
  async ({ user, params, body }) => {
    const db = getDb();
    const findingId = requireUuid(params.id);
    if (!(await findingInOrganization(db, user.organization.id, findingId))) {
      throw ApiRouteError.notFound(FINDING_NOT_FOUND);
    }
    return dismissFindingFromPanel(db, { findingId, userId: user.id, input: body });
  },
);
