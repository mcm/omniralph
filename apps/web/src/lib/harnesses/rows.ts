import type { HarnessOverview, JobListEntry } from "@omniralph/db";
import {
  effectiveCapabilityLimits,
  type HarnessUpdateReport,
  type SelfUpdateSupport,
} from "@omniralph/shared";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { isHarnessOnline, jobTarget, type JobTarget } from "./display";
import { harnessUpdateStatus, type HarnessUpdateStatus } from "./update";

/** Serializable harness row for the Harnesses pages. */
export interface HarnessRow {
  id: string;
  name: string;
  online: boolean;
  revoked: boolean;
  version: string | null;
  /** The version the harness should run: its override, else the global setting. */
  desiredVersion: string | null;
  /** The harness's own desired version, overriding the global one. */
  desiredVersionOverride: string | null;
  /** `desiredVersion` is the latest on npm (the global setting tracks it, no override). */
  tracksLatest: boolean;
  /** Null for harnesses that don't report it (older versions). */
  selfUpdate: SelfUpdateSupport | null;
  update: HarnessUpdateReport | null;
  failedVersions: string[];
  /** An admin's "Update now" the harness hasn't acted on yet (`requestedAt` is ISO). */
  updateRequest: { version: string; requestedAt: string } | null;
  updateStatus: HarnessUpdateStatus;
  reportedCapabilities: string[];
  enabledCapabilities: string[];
  maxConcurrency: number;
  /** Per-capability limits as stored (unset ones use the default). */
  capabilityLimits: Record<string, number>;
  /** Effective per-capability limits of the enabled capabilities, as sent to the harness. */
  effectiveCapabilityLimits: Record<string, number>;
  runningJobs: { id: string; capability: string; type: string; target: JobTarget | null }[];
  pinnedRepositories: {
    id: string;
    provider: "github" | "gitlab";
    fullPath: string;
    webUrl: string;
  }[];
  /** ISO timestamps. */
  lastHeartbeatAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * `globalDesiredVersion` is the Settings › Harnesses version, used by harnesses
 * without their own override (`globalTracksLatest`: it's the latest on npm).
 */
export function harnessRow(
  agent: HarnessOverview,
  now: Date = new Date(),
  globalDesiredVersion: string | null = null,
  globalTracksLatest = false,
): HarnessRow {
  const desiredVersion = agent.desiredVersion ?? globalDesiredVersion;
  const update = agent.updateState ?? null;
  const updateRequest =
    agent.updateRequestVersion && agent.updateRequestedAt
      ? {
          version: agent.updateRequestVersion,
          requestedAt: agent.updateRequestedAt.toISOString(),
        }
      : null;
  return {
    id: agent.id,
    name: agent.name,
    online: !agent.revokedAt && isHarnessOnline(agent.lastHeartbeatAt, now),
    revoked: agent.revokedAt !== null,
    version: agent.reportedVersion,
    desiredVersion,
    desiredVersionOverride: agent.desiredVersion,
    tracksLatest: !agent.desiredVersion && globalTracksLatest,
    selfUpdate: agent.selfUpdate,
    update,
    failedVersions: agent.failedVersions,
    updateRequest,
    updateStatus: harnessUpdateStatus({
      version: agent.reportedVersion,
      desiredVersion,
      selfUpdate: agent.selfUpdate,
      update,
      failedVersions: agent.failedVersions,
      updateRequested: updateRequest !== null,
    }),
    reportedCapabilities: agent.reportedCapabilities ?? [],
    enabledCapabilities: agent.enabledCapabilities,
    maxConcurrency: agent.maxConcurrency,
    capabilityLimits: storedLimits(agent.capabilityLimits),
    effectiveCapabilityLimits: effectiveCapabilityLimits(
      agent.enabledCapabilities,
      agent.capabilityLimits,
      agent.maxConcurrency,
    ),
    runningJobs: agent.runningJobs.map((job) => ({
      id: job.id,
      capability: job.capability,
      type: job.type,
      target: jobTarget(job),
    })),
    pinnedRepositories: agent.pinnedRepositories.map((repo) => ({
      id: repo.id,
      provider: repo.provider,
      fullPath: repo.fullPath,
      webUrl: repositoryWebUrl(repo.provider, repo.baseUrl, repo.fullPath),
    })),
    lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
    revokedAt: agent.revokedAt?.toISOString() ?? null,
    createdAt: agent.createdAt.toISOString(),
  };
}

/** Serializable job row for the Jobs page. */
export interface JobRow {
  id: string;
  capability: string;
  type: string;
  status: JobListEntry["status"];
  deliveryCount: number;
  cancelRequested: boolean;
  error: string | null;
  agent: { id: string; name: string } | null;
  target: JobTarget | null;
  createdAt: string;
  finishedAt: string | null;
}

export function jobRow(job: JobListEntry): JobRow {
  return {
    id: job.id,
    capability: job.capability,
    type: job.type,
    status: job.status,
    deliveryCount: job.deliveryCount,
    cancelRequested: job.cancelRequested,
    error: job.error,
    agent: job.agent,
    target: jobTarget(job),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function storedLimits(limits: Partial<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(limits).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}
