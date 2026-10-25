import { apiHandler } from "@/lib/api/handler";
import { switchOrganizationSchema } from "@/lib/api/organization";
import { showAllOrganizations, switchOrganization } from "@/lib/organizations/membership";

/**
 * Picks this device's organization scope (the cookies the other tabs' `OrganizationGuard`
 * watches): `{ organizationId }` makes one of the caller's organizations the active one
 * (other organizations are refused), `{ scope: "all" }` shows all of theirs (refused
 * unless they belong to two or more). Any signed-in user may call it, whatever their
 * active organization.
 */
export const POST = apiHandler(
  { access: "signed-in", body: switchOrganizationSchema },
  async ({ user, body }) =>
    "scope" in body
      ? showAllOrganizations(user.id)
      : switchOrganization(user.id, body.organizationId),
);
