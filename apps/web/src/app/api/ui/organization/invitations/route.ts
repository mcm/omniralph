import { apiHandler } from "@/lib/api/handler";
import { invitationInputSchema } from "@/lib/api/organization";
import { getDb } from "@/lib/db";
import { inviteMember } from "@/lib/organizations/settings";

/** Invites an email to the active organization with a role. */
export const POST = apiHandler(
  { access: "admin", body: invitationInputSchema },
  async ({ user, body }) => inviteMember(getDb(), user, body.email, body.role),
);
