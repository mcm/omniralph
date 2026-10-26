"use client";

import { Button, EmptyState } from "@omniralph/ui";
import type { ConnectionProvider } from "@/lib/api/connections";
import { useConnections } from "./queries";
import { connectionLabels } from "./settings-nav";
import { SettingsPage } from "./settings-page";

/**
 * A connection's page, titled as its nav entry. One the organization doesn't have (removed,
 * or another organization's) says so; the list is live, so a disconnect elsewhere shows.
 */
export function ConnectionSettings({
  provider,
  connectionId,
}: {
  provider: ConnectionProvider;
  connectionId: string;
}) {
  const list = useConnections();
  const connections = list.data?.connections;
  if (list.isError && !connections) {
    return (
      <EmptyState
        headingLevel={2}
        title="Couldn't load this connection"
        description={list.error.message}
        action={
          <Button variant="outline" onClick={() => void list.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!connections) return null;
  const connection = connections.find(
    (entry) => entry.provider === provider && entry.id === connectionId,
  );
  if (!connection) {
    return <EmptyState headingLevel={2} title="That connection doesn't exist" />;
  }
  return <SettingsPage title={connectionLabels(connections).get(connection.id)!} />;
}
