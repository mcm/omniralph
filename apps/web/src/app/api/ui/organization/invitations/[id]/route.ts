import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { revokeOrganizationInvitation } from "@/lib/organizations/settings";

type Params = { id: string };

/** Revokes a pending invitation of the active organization. */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => revokeOrganizationInvitation(getDb(), user, requireUuid(params.id)),
);
