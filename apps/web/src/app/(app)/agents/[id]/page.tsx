import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAgentOverview, listRecentAgentAudit, listRepositoryOverview } from "@omniralph/db";
import { CAPABILITIES } from "@omniralph/shared";
import { organizationAgentVersion } from "@/lib/agents/desired-version";
import { agentRow } from "@/lib/agents/rows";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import type { AuditRow } from "./agent-audit-log";
import { AgentDetailView } from "./agent-detail-view";

export const metadata: Metadata = { title: "Agent · Omniralph" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Number of audit events shown on the page. */
const AUDIT_LIMIT = 50;

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  await enterResourceOrganization(await requirePageUser(), "agent", id, `/agents/${id}`);
  const admin = await requirePageUser("admin");
  const db = getDb();
  const [agent, audit, repositories, organizationVersion] = await Promise.all([
    getAgentOverview(db, admin.organization.id, id),
    listRecentAgentAudit(db, id, AUDIT_LIMIT),
    listRepositoryOverview(db, admin.organization.id),
    organizationAgentVersion(db, admin.organization.id),
  ]);
  if (!agent) notFound();
  const now = new Date();

  return (
    <AgentDetailView
      agent={agentRow(agent, now, organizationVersion.version, organizationVersion.tracksLatest)}
      globalDesiredVersion={
        organizationVersion.tracksLatest
          ? `latest on npm, ${organizationVersion.version ?? "not read yet"}`
          : organizationVersion.version
      }
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
