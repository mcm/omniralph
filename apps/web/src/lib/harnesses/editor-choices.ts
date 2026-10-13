import "server-only";
import {
  listActiveHarnessIds,
  listReportedInstallables,
  listReportedModels,
  type Database,
  type ReportedInstallableOption,
  type ReportedModelOption,
} from "@omniralph/db";

/**
 * What the agent, task and profile editors pick models and installables from: what the
 * organization's harnesses (not revoked or deleted) report, and how many there are.
 */
export interface HarnessChoices {
  models: ReportedModelOption[];
  installables: ReportedInstallableOption[];
  harnessCount: number;
}

/** The organization's harness choices for the definition editors. */
export async function loadHarnessChoices(
  db: Database,
  organizationId: string,
): Promise<HarnessChoices> {
  const [harnessIds, models, installables] = await Promise.all([
    listActiveHarnessIds(db, organizationId),
    listReportedModels(db, organizationId),
    listReportedInstallables(db, organizationId),
  ]);
  return { models, installables, harnessCount: harnessIds.length };
}
