import "server-only";
import { getIntegrationById } from "@omniralph/db";
import { z } from "zod";
import { ApiRouteError } from "@/lib/api/handler";
import { requireOrganizationAccess, type ScopedOrganization } from "@/lib/api/scope";
import type { Role } from "@/lib/auth/roles";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import { TrackerNotConnectedError, type WorkItemTracker } from "@/lib/work-items/tracker";

/** The 404 message of a tracker connection the user can't see. */
export const TRACKER_NOT_FOUND = "That tracker connection doesn't exist.";

/**
 * The tracker of `integrationId` in any of the user's organizations, with at least `role`
 * there (`/api/ui/trackers/{integrationId}/…`). A malformed or unknown ID, another
 * organization's connection or a disconnected tracker answers 404.
 */
export async function trackerFor(
  user: OrgUser,
  integrationId: string,
  role: Role,
): Promise<{ tracker: WorkItemTracker; organization: ScopedOrganization }> {
  if (!z.uuid().safeParse(integrationId).success) {
    throw ApiRouteError.notFound(TRACKER_NOT_FOUND);
  }
  const db = getDb();
  const integration = await getIntegrationById(db, integrationId);
  const organization = await requireOrganizationAccess(user, integration?.organizationId ?? null, {
    role,
    notFoundMessage: TRACKER_NOT_FOUND,
  });
  try {
    const tracker = await getWorkItemTracker({ db, organizationId: organization.id });
    if (tracker.integrationId !== integrationId) throw ApiRouteError.notFound(TRACKER_NOT_FOUND);
    return { tracker, organization };
  } catch (error) {
    if (error instanceof TrackerNotConnectedError) throw ApiRouteError.notFound(TRACKER_NOT_FOUND);
    throw error;
  }
}
