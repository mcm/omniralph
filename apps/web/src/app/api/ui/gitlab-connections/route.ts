import { getScmConnection } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { connectGitLabSchema } from "@/lib/api/repositories";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { scmConnectionListRow } from "@/lib/connections/list-row";
import { getDb } from "@/lib/db";
import { connectGitLab } from "@/lib/repositories/manage";

/**
 * Connects GitLab with a bot token (validated first) to `organizationId` (the active
 * organization when left out), where the user must be an admin; answers the connection to
 * pick projects of, as `GET /api/ui/scm-connections` lists it.
 */
export const POST = apiHandler({ body: connectGitLabSchema }, async ({ user, body }) => {
  const { organizationId, ...form } = body;
  const organization = await requireOrganizationAccess(
    user,
    organizationId ?? user.organization.id,
    { role: "admin" },
  );
  const db = getDb();
  const result = await connectGitLab(db, user, organization.id, form);
  if (!result.ok || !result.connectionId) return result;
  const connection = await getScmConnection(db, organization.id, result.connectionId);
  return { ...result, ...(connection && { connection: scmConnectionListRow(connection) }) };
});
