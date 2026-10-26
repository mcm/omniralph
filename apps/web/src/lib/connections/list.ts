import "server-only";
import {
  getConnectionUsage,
  getIntegration,
  listChatConnections,
  listScmConnections,
  type Database,
} from "@omniralph/db";
import {
  CONNECTION_PROVIDER_ROLES,
  CONNECTION_PROVIDERS,
  type Connection,
  type ConnectionProvider,
} from "@/lib/api/connections";
import type { ConnectionHealthRow } from "@/lib/api/repositories";
import { connectionHealth } from "@/lib/connections/health";
import { connectionWebHost } from "@/lib/repositories/web-url";

const PROVIDER_ORDER = new Map(CONNECTION_PROVIDERS.map((provider, index) => [provider, index]));

/**
 * Every connection of `organizationId` (`GET /api/ui/connections`), by provider
 * (`CONNECTION_PROVIDERS`), then name, with its health (`connectionHealth`), the repos
 * using it, its role and its unreplayed failed deliveries. Reads only names, hosts and
 * health: never credentials.
 */
export async function listConnections(
  db: Database,
  organizationId: string,
  now: Date = new Date(),
): Promise<Connection[]> {
  const [scm, linear, chat, usage] = await Promise.all([
    listScmConnections(db, organizationId),
    getIntegration(db, organizationId, "linear"),
    listChatConnections(db, organizationId),
    getConnectionUsage(db, organizationId, now),
  ]);
  const row = (
    provider: ConnectionProvider,
    fields: Pick<Connection, "id" | "name" | "host" | "account" | "reposUsing" | "linkedAccounts">,
    health: ConnectionHealthRow | null = null,
  ): Connection => ({
    provider,
    ...fields,
    health: connectionHealth({ provider, health }, now),
    usedAs: CONNECTION_PROVIDER_ROLES[provider],
    failedDeliveries: usage.failedDeliveries.get(fields.id) ?? 0,
  });
  const connections: Connection[] = [
    ...scm.map((connection) =>
      row(
        connection.provider,
        {
          id: connection.id,
          name: connection.name,
          host: connectionWebHost(connection.provider, connection.baseUrl),
          account: connection.provider === "github" ? connection.name : connection.botUsername,
          reposUsing: usage.reposByScmConnection.get(connection.id) ?? 0,
          linkedAccounts: null,
        },
        connection.health,
      ),
    ),
    ...(linear
      ? [
          row("linear", {
            id: linear.id,
            name: linear.name,
            host: null,
            account: linear.name,
            reposUsing: usage.linearMatchedRepos,
            linkedAccounts: null,
          }),
        ]
      : []),
    ...chat.map((connection) =>
      row(connection.platform, {
        id: connection.id,
        name: connection.name,
        host: null,
        account: connection.name,
        reposUsing: null,
        linkedAccounts: usage.linkedAccounts.get(connection.platform) ?? 0,
      }),
    ),
  ];
  return connections.sort(
    (a, b) =>
      PROVIDER_ORDER.get(a.provider)! - PROVIDER_ORDER.get(b.provider)! ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}
