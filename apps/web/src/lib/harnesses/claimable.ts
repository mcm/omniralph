import type { HarnessOverview } from "@omniralph/db";
import { harnessVersionAtLeast } from "@omniralph/shared";
import { isHarnessOnline } from "./display";

/** A harness that would get a query run, and whether it can claim one now. */
export interface QueryHarnessStatus {
  name: string;
  version: string | null;
  /**
   * Whether it claims the run: online, accepting `query` tasks, on the run's
   * minimum version or later, with every installable and host tool it requires.
   */
  capable: boolean;
}

/** What a run needs from the harness claiming it, as `claimJob` checks it. */
export interface RunHarnessRequirements {
  /** The run's `min_harness_version`; null for none. */
  minHarnessVersion: string | null;
  /** `required_installables`: each must be in the harness's `reportedInstallables`. */
  installables: readonly string[];
  /** `required_host_tools`: each must have an effective path on the harness. */
  hostTools: readonly string[];
}

/**
 * The organization's harnesses that would get a query run in `repositoryId`
 * (its pinned harnesses when it has some, else all), each saying whether it
 * can claim one now as `claimJob` decides: it accepts `query` tasks (itself or
 * by the organization's default: `effective`), reports
 * the run's minimum version or later, reports every required installable and
 * has an effective path for every required host tool (`usableHostTools`, by
 * harness ID: `listHarnessesUsableHostTools`). Revoked and offline harnesses
 * are left out.
 */
export function queryClaimableHarnesses(
  harnesses: readonly HarnessOverview[],
  usableHostTools: ReadonlyMap<string, readonly string[]>,
  repositoryId: string,
  requirements: RunHarnessRequirements,
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
        h.effective.acceptedTaskTypes.includes("query") &&
        versionCapable(h.reportedVersion, requirements.minHarnessVersion) &&
        requirements.installables.every((name) =>
          h.reportedInstallables.some((installable) => installable.name === name),
        ) &&
        requirements.hostTools.every((name) => usableHostTools.get(h.id)?.includes(name)),
    }));
}

/** As `claimJob`: no minimum takes any harness, a minimum one that reported a version. */
function versionCapable(reported: string | null, minimum: string | null): boolean {
  if (minimum === null) return true;
  return reported !== null && harnessVersionAtLeast(reported, minimum);
}
