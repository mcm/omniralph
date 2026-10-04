import "server-only";
import { revokeAgent as revokeAgentRow, writeAgentAudit } from "@omniralph/db";
import { getDb } from "@/lib/db";

/**
 * Revokes an agent (Agents page): sets `revoked_at`, revokes every refresh-token
 * family and writes a `revoke` audit row. Unexpired access and job tokens are
 * rejected from the next request on, because `requireAgent`/`requireJob` check
 * the agent row. Returns false for unknown agents.
 */
export async function revokeAgent(
  agentId: string,
  options: { revokedBy?: string | null; ip?: string | null } = {},
): Promise<boolean> {
  const db = getDb();
  if (!(await revokeAgentRow(db, agentId))) return false;
  await writeAgentAudit(db, {
    agentId,
    event: "revoke",
    ip: options.ip ?? null,
    detail: { revokedBy: options.revokedBy ?? null },
  });
  return true;
}
