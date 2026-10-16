import { apiHandler } from "@/lib/api/handler";
import { memberChangeSchema } from "@/lib/api/organization";
import { getDb } from "@/lib/db";
import { changeMemberRole, removeOrganizationMember } from "@/lib/organizations/settings";

type Params = { userId: string };

/** Changes a member's role (`{ role }`) in the active organization. */
export const PATCH = apiHandler<"admin", typeof memberChangeSchema, undefined, Params>(
  { access: "admin", body: memberChangeSchema },
  async ({ user, params, body }) => changeMemberRole(getDb(), user, params.userId, body.role),
);

/** Removes a member from the active organization. */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => removeOrganizationMember(getDb(), user, params.userId),
);
