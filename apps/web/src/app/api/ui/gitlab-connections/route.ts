import { apiHandler } from "@/lib/api/handler";
import { connectGitLabSchema } from "@/lib/api/repositories";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { connectGitLab } from "@/lib/repositories/manage";

/**
 * Connects GitLab with a bot token (validated first) to `organizationId` (the active
 * organization when left out), where the user must be an admin; answers the connection to
 * pick projects of.
 */
export const POST = apiHandler({ body: connectGitLabSchema }, async ({ user, body }) => {
  const { organizationId, ...form } = body;
  const organization = await requireOrganizationAccess(
    user,
    organizationId ?? user.organization.id,
    { role: "admin" },
  );
  return connectGitLab(getDb(), user, organization.id, form);
});
