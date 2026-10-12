import "server-only";
import { getHarnessOverview, type Database } from "@omniralph/db";
import { INSTALL_JOB_TYPE, type InstallPayload } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";

export type InstallInstallableResult =
  { result: "enqueued"; jobId: string; created: boolean } | { result: "unknown_harness" };

/**
 * Enqueues an `install` system RPC targeted at one harness of the
 * organization, which installs or updates the installable there. Deduped per
 * harness, package and version while one is queued or running. Whether the package may
 * be installed is the harness's call (its local `installables.allow`).
 */
export async function installInstallable(
  db: Database,
  dispatcher: JobDispatcher,
  input: { organizationId: string; harnessId: string } & InstallPayload,
): Promise<InstallInstallableResult> {
  const harness = await getHarnessOverview(db, input.organizationId, input.harnessId);
  if (!harness || harness.revokedAt) return { result: "unknown_harness" };
  const payload: InstallPayload = {
    name: input.name,
    ...(input.version !== undefined && { version: input.version }),
  };
  const { job, created } = await dispatcher.createAndPublish({
    organizationId: input.organizationId,
    // A system RPC: no session, no pool; only the targeted harness claims it.
    type: INSTALL_JOB_TYPE,
    taskType: "system",
    pool: null,
    payload,
    dedupeKey: `${INSTALL_JOB_TYPE}:${input.harnessId}:${input.name}@${input.version ?? "latest"}`,
    targetHarnessId: input.harnessId,
  });
  return { result: "enqueued", jobId: job.id, created };
}
