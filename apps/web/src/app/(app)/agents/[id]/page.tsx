import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getAgentOverview,
  getDesiredAgentVersion,
  listRecentAgentAudit,
  listRepositoryOverview,
} from "@omniralph/db";
import { CAPABILITIES } from "@omniralph/shared";
import { agentRow } from "@/lib/agents/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import type { AuditRow } from "./agent-audit-log";
import { AgentDetailView } from "./agent-detail-view";

export const metadata: Metadata = { title: "Agent · Omniralph" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Number of audit events shown on the page. */
const AUDIT_LIMIT = 50;

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePageUser("admin");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const db = getDb();
  const [agent, audit, repositories, globalVersion] = await Promise.all([
    getAgentOverview(db, id),
    listRecentAgentAudit(db, id, AUDIT_LIMIT),
    listRepositoryOverview(db, admin.organization.id),
    getDesiredAgentVersion(db),
  ]);
  if (!agent) notFound();
  const now = new Date();

  return (
    <AgentDetailView
      agent={agentRow(agent, now, globalVersion)}
      globalDesiredVersion={globalVersion}
      now={now.getTime()}
      knownCapabilities={[...CAPABILITIES]}
      repositories={repositories.map((repo) => ({
        id: repo.id,
        provider: repo.provider,
        fullPath: repo.fullPath,
      }))}
      audit={audit.map((entry): AuditRow => ({
        id: entry.id,
        event: entry.event,
        ip: entry.ip,
        detail: entry.detail,
        createdAt: entry.createdAt.toISOString(),
      }))}
    />
  );
}
