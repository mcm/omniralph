import type { ScmConnectionListRow } from "@/lib/api/repositories";
import { connectionWebHost } from "@/lib/repositories/web-url";
import { connectionHealth } from "./health";

/** A code-host connection as `GET /api/ui/scm-connections` lists it, with its health. */
export function scmConnectionListRow(connection: {
  id: string;
  provider: "github" | "gitlab";
  name: string;
  baseUrl: string;
  health: Parameters<typeof connectionHealth>[0]["health"];
}): ScmConnectionListRow {
  return {
    id: connection.id,
    provider: connection.provider,
    name: connection.name,
    host: connectionWebHost(connection.provider, connection.baseUrl),
    health: connectionHealth(connection),
  };
}
