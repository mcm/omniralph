import "server-only";
import {
  getIntegration,
  listChatConnections,
  listScmConnections,
  type Database,
} from "@omniralph/db";
import { CONNECTION_PROVIDERS, type Connection } from "@/lib/api/connections";
import { connectionWebHost } from "@/lib/repositories/web-url";

const PROVIDER_ORDER = new Map(CONNECTION_PROVIDERS.map((provider, index) => [provider, index]));

/**
 * Every connection of `organizationId` (`GET /api/ui/connections`), by provider
 * (`CONNECTION_PROVIDERS`), then name. Reads only names and hosts: never credentials.
 */
export async function listConnections(db: Database, organizationId: string): Promise<Connection[]> {
  const [scm, linear, chat] = await Promise.all([
    listScmConnections(db, organizationId),
    getIntegration(db, organizationId, "linear"),
    listChatConnections(db, organizationId),
  ]);
  const connections: Connection[] = [
    ...scm.map((connection) => ({
      provider: connection.provider,
      id: connection.id,
      name: connection.name,
      host: connectionWebHost(connection.provider, connection.baseUrl),
      account: connection.provider === "github" ? connection.name : connection.botUsername,
    })),
    ...(linear
      ? [
          {
            provider: "linear" as const,
            id: linear.id,
            name: linear.name,
            host: null,
            account: linear.name,
          },
        ]
      : []),
    ...chat.map((connection) => ({
      provider: connection.platform,
      id: connection.id,
      name: connection.name,
      host: null,
      account: connection.name,
    })),
  ];
  return connections.sort(
    (a, b) =>
      PROVIDER_ORDER.get(a.provider)! - PROVIDER_ORDER.get(b.provider)! ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}
