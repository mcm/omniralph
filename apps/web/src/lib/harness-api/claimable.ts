import "server-only";
import { hasClaimableJob, type Database } from "@omniralph/db";

/**
 * The heartbeat's `claimable`: whether a claim for `claimablePools` would find
 * a job for the harness right now (`hasClaimableJob`, with the harness's
 * resolved accepted task types). Undefined, so the response omits it, when the
 * request carried no `claimablePools` (no free slot, long-polling, or an older harness).
 */
export async function heartbeatClaimable(
  db: Database,
  harness: {
    id: string;
    organizationId: string;
    acceptedTaskTypes: readonly string[];
    reportedVersion: string | null;
  },
  claimablePools: readonly string[] | undefined,
  check: typeof hasClaimableJob = hasClaimableJob,
): Promise<boolean | undefined> {
  if (claimablePools === undefined) return undefined;
  return check(db, {
    harnessId: harness.id,
    organizationId: harness.organizationId,
    acceptedTaskTypes: harness.acceptedTaskTypes,
    pools: claimablePools,
    harnessVersion: harness.reportedVersion,
  });
}
