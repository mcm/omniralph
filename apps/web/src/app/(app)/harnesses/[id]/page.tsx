import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getHarnessOverview, listRecentHarnessAudit, listRepositoryOverview } from "@omniralph/db";
import { CAPABILITIES } from "@omniralph/shared";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { harnessRow } from "@/lib/harnesses/rows";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import type { AuditRow } from "./harness-audit-log";
import { HarnessDetailView } from "./harness-detail-view";

export const metadata: Metadata = { title: "Harness · Omniralph" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Number of audit events shown on the page. */
const AUDIT_LIMIT = 50;

export default async function HarnessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  await enterResourceOrganization(await requirePageUser(), "harness", id, `/harnesses/${id}`);
  const admin = await requirePageUser("admin");
  const db = getDb();
  const [harness, audit, repositories, organizationVersion] = await Promise.all([
    getHarnessOverview(db, admin.organization.id, id),
    listRecentHarnessAudit(db, id, AUDIT_LIMIT),
    listRepositoryOverview(db, admin.organization.id),
    organizationHarnessVersion(db, admin.organization.id),
  ]);
  if (!harness) notFound();
  const now = new Date();

  return (
    <HarnessDetailView
      harness={harnessRow(
        harness,
        now,
        organizationVersion.version,
        organizationVersion.tracksLatest,
      )}
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
