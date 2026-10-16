import { apiHandler } from "@/lib/api/handler";
import { switchOrganizationSchema } from "@/lib/api/organization";
import { switchOrganization } from "@/lib/organizations/membership";

/**
 * Makes one of the caller's organizations the active one (on this device: the cookie the
 * other tabs' `OrganizationGuard` watches); other organizations are refused. Any signed-in
 * user may call it, whatever their active organization.
 */
export const POST = apiHandler(
  { access: "signed-in", body: switchOrganizationSchema },
  async ({ user, body }) => switchOrganization(user.id, body.organizationId),
);
