import "server-only";
import { getAgentOverview, type Database } from "@omniralph/db";
import { INSTALL_JOB_TYPE, type InstallPayload } from "@omniralph/shared";
import { InstallablePackageName, InstallableVersion } from "@omniralph/tasks";
import type { JobDispatcher } from "@/lib/dispatch";

export type EnqueueInstallResult =
  | { result: "enqueued"; jobId: string; created: boolean }
  | { result: "invalid"; field: "name" | "version" }
  | { result: "unknown_harness" };

/**
 * Enqueues an `install` system RPC targeted at one harness of the
 * organization, which installs or updates the installable there. Deduped per
 * harness, package and version while one is queued or running. `invalid` for a
 * name or version npm could read as anything but that registry package. Whether
 * the package may be installed is the harness's call (its local `installables.allow`).
 */
export async function enqueueInstall(
  db: Database,
  dispatcher: JobDispatcher,
  input: { organizationId: string; harnessId: string } & InstallPayload,
): Promise<EnqueueInstallResult> {
  if (!InstallablePackageName.safeParse(input.name).success) {
    return { result: "invalid", field: "name" };
  }
  if (input.version !== undefined && !InstallableVersion.safeParse(input.version).success) {
    return { result: "invalid", field: "version" };
  }
  const harness = await getAgentOverview(db, input.organizationId, input.harnessId);
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
    payload,
    dedupeKey: `${INSTALL_JOB_TYPE}:${input.harnessId}:${input.name}@${input.version ?? "latest"}`,
    targetAgentId: input.harnessId,
  });
  return { result: "enqueued", jobId: job.id, created };
}
