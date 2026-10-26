import { listScmConnections } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { scmConnectionListQuerySchema, type ScmConnectionList } from "@/lib/api/repositories";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { connectionHealth } from "@/lib/connections/health";
import { getDb } from "@/lib/db";
import { connectionWebHost } from "@/lib/repositories/web-url";

/**
 * The add-repo sheet's connections: the GitHub App installations and GitLab connections of
 * `organization` (the active one when left out) with their health, by name. Admins of that
 * organization only; another organization's is not found.
 */
export const GET = apiHandler(
  { query: scmConnectionListQuerySchema },
  async ({ user, query }): Promise<ScmConnectionList> => {
    const organization = await requireOrganizationAccess(
      user,
      query.organization ?? user.organization.id,
      { role: "admin" },
    );
    const connections = await listScmConnections(getDb(), organization.id);
    return {
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        host: connectionWebHost(connection.provider, connection.baseUrl),
        health: connectionHealth(connection),
      })),
    };
  },
);
