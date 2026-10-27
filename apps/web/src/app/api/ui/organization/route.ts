import { apiHandler } from "@/lib/api/handler";
import { organizationChangeSchema, type OrganizationSettings } from "@/lib/api/organization";
import { getDb } from "@/lib/db";
import { changeOrganization, loadOrganizationSettings } from "@/lib/organizations/settings";

/**
 * Settings › General and Members: the active organization with its members and email domains,
 * and (admins) its pending invitations.
 */
export const GET = apiHandler({}, async ({ user }): Promise<OrganizationSettings> =>
  loadOrganizationSettings(getDb(), user),
);

/** Renames the organization (`{ name }`) or switches joining by email domain (`{ allowDomainJoin }`). */
export const PATCH = apiHandler(
  { access: "admin", body: organizationChangeSchema },
  async ({ user, body }) => changeOrganization(getDb(), user, body),
);
