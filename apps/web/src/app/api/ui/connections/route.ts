import { apiHandler } from "@/lib/api/handler";
import type { ConnectionList } from "@/lib/api/connections";
import { getDb } from "@/lib/db";
import { listConnections } from "@/lib/connections/list";

/**
 * Settings' connections: every GitHub, GitLab, Linear, Slack and Discord connection of the
 * active organization, without any token or secret. Any member may read it.
 */
export const GET = apiHandler({}, async ({ user }): Promise<ConnectionList> => ({
  connections: await listConnections(getDb(), user.organization.id),
}));
