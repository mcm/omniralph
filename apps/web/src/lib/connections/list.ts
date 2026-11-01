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
import type { ScopedOrganization } from "@/lib/api/scope";
import { githubInstallationUrl } from "@/lib/connections/github-installation";
import { connectionHealth } from "@/lib/connections/health";
import { connectionWebHost } from "@/lib/repositories/web-url";
import { loadSettingsHistory } from "@/lib/settings-history/history";

const PROVIDER_ORDER = new Map(CONNECTION_PROVIDERS.map((provider, index) => [provider, index]));

/**
 * Every connection of `organization` (`GET /api/ui/connections`), by provider
 * (`CONNECTION_PROVIDERS`), then name, with its health (`connectionHealth`), the repos
 * using it, its role, its unreplayed failed deliveries and its latest recorded change.
 * Reads only names, hosts and health: never credentials.
 */
export async function listConnections(
  db: Database,
  organization: ScopedOrganization,
  now: Date = new Date(),
): Promise<Connection[]> {
  const organizationId = organization.id;
  const [scm, linear, chat, usage] = await Promise.all([
    listScmConnections(db, organizationId),
    getIntegration(db, organizationId, "linear"),
    listChatConnections(db, organizationId),
    getConnectionUsage(db, organizationId, now),
  ]);
  const row = (
    provider: ConnectionProvider,
    fields: Pick<Connection, "id" | "name" | "host" | "account" | "reposUsing" | "linkedAccounts"> &
      Partial<Pick<Connection, "instanceUrl" | "installationUrl">>,
    health: ConnectionHealthRow | null = null,
  ): Omit<Connection, "history"> => ({
    provider,
    instanceUrl: null,
    installationUrl: null,
    ...fields,
    health: connectionHealth({ provider, health }, now),
    usedAs: CONNECTION_PROVIDER_ROLES[provider],
    failedDeliveries: usage.failedDeliveries.get(fields.id) ?? 0,
  });
  const connections: Omit<Connection, "history">[] = [
    ...scm.map((connection) => {
      const host = connectionWebHost(connection.provider, connection.baseUrl);
      return row(
        connection.provider,
        {
          id: connection.id,
          name: connection.name,
          host,
          account: connection.provider === "github" ? connection.name : connection.botUsername,
          reposUsing: usage.reposByScmConnection.get(connection.id) ?? 0,
          linkedAccounts: null,
          instanceUrl: connection.provider === "gitlab" ? connection.baseUrl : null,
          installationUrl:
            connection.provider === "github" && connection.externalId
              ? githubInstallationUrl({
                  host,
                  account: connection.name,
                  accountType: connection.accountType,
                  installationId: connection.externalId,
                })
              : null,
        },
        connection.health,
      );
    }),
    ...(linear
      ? [
          row("linear", {
            id: linear.id,
            name: linear.name,
            host: null,
            account: linear.name,
            reposUsing: usage.matchedReposByTracker.get("linear") ?? 0,
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
  const histories = await Promise.all(
    connections.map(
      async (connection) =>
        (
          await loadSettingsHistory(db, [organization], {
            section: "connection",
            subject: connection.id,
            limit: 1,
          })
        ).latest,
    ),
  );
  return connections
    .map((connection, index) => ({ ...connection, history: histories[index] ?? null }))
    .sort(
      (a, b) =>
        PROVIDER_ORDER.get(a.provider)! - PROVIDER_ORDER.get(b.provider)! ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}
