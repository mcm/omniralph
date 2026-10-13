import { notFound } from "next/navigation";
import {
  getHarnessOverview,
  listHarnessHostTools,
  listHarnessInstallJobs,
  listRecentHarnessAudit,
} from "@omniralph/db";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { harnessRow } from "@/lib/harnesses/rows";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import type { AuditRow } from "./harness-audit-log";
import { HarnessDetailView } from "./harness-detail-view";
import type { HostToolRow } from "./harness-host-tools";
import type { InstallJobRow } from "./harness-installables";
import { harnessTabHref, type HarnessTab } from "./harness-tabs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Number of audit events shown on the page. */
const AUDIT_LIMIT = 50;
/** How far back the page lists install jobs. */
const INSTALL_JOBS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A harness tab: Overview, Settings, Installables or Host tools. Each loads what it shows; the
 * audit log loads on every tab, since a token theft warning shows above all of them.
 */
export async function renderHarnessPage(params: Promise<{ id: string }>, tab: HarnessTab) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  await enterResourceOrganization(await requirePageUser(), "harness", id, harnessTabHref(id, tab));
  const admin = await requirePageUser("admin");
  const orgId = admin.organization.id;
  const db = getDb();
  const now = new Date();
  const since = new Date(now.getTime() - INSTALL_JOBS_WINDOW_MS);
  const [harness, audit, organizationVersion, installJobs, hostTools] = await Promise.all([
    getHarnessOverview(db, orgId, id),
    listRecentHarnessAudit(db, id, AUDIT_LIMIT),
    organizationHarnessVersion(db, orgId),
    tab === "installables" ? listHarnessInstallJobs(db, orgId, id, since) : [],
    tab === "host-tools" ? listHarnessHostTools(db, orgId, id) : [],
  ]);
  if (!harness) notFound();

  return (
    <HarnessDetailView
      tab={tab}
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
      audit={audit.map((entry): AuditRow => ({
        id: entry.id,
        event: entry.event,
        ip: entry.ip,
        detail: entry.detail,
        createdAt: entry.createdAt.toISOString(),
      }))}
      installables={harness.reportedInstallables.map(({ name, version }) => ({ name, version }))}
      installJobs={installJobs.map((job): InstallJobRow => ({
        id: job.id,
        status: job.status,
        name: job.name,
        version: job.version,
        installedVersion: job.installedVersion,
        error: job.error,
        createdAt: job.createdAt.toISOString(),
      }))}
      hostTools={hostTools.map((tool): HostToolRow => ({
        ...tool,
        reportedAt: tool.reportedAt?.toISOString() ?? null,
      }))}
    />
  );
}
