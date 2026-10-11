import type { HarnessOverview } from "@omniralph/db";
import { harnessVersionAtLeast } from "@omniralph/shared";
import { isHarnessOnline } from "./display";

/** A harness that would get a query run, and whether it can claim one now. */
export interface QueryHarnessStatus {
  name: string;
  version: string | null;
  /** Whether it claims the run: online, accepting `query` tasks, on `minVersion` or later. */
  capable: boolean;
}

/**
 * The organization's harnesses that would get a query run in `repositoryId`
 * (its pinned harnesses when it has some, else all), each saying whether it
 * can claim one now: it accepts `query` tasks and reports `minVersion` (the
 * run's `min_harness_version`) or later. Revoked and offline harnesses are
 * left out.
 */
export function queryClaimableHarnesses(
  harnesses: readonly HarnessOverview[],
  repositoryId: string,
  minVersion: string,
  now: Date = new Date(),
): QueryHarnessStatus[] {
  const live = harnesses.filter((h) => !h.revokedAt);
  const pinned = live.filter((h) => h.pinnedRepositories.some((r) => r.id === repositoryId));
  return (pinned.length > 0 ? pinned : live)
    .filter((h) => isHarnessOnline(h.lastHeartbeatAt, now))
    .map((h) => ({
      name: h.name,
      version: h.reportedVersion,
      capable:
        h.acceptedTaskTypes.includes("query") &&
        h.reportedVersion !== null &&
        harnessVersionAtLeast(h.reportedVersion, minVersion),
    }));
}
