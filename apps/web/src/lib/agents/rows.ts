import type { AgentOverview, JobListEntry } from "@omniralph/db";
import {
  effectivePoolLimits,
  type AgentUpdateReport,
  type SelfUpdateSupport,
} from "@omniralph/shared";
import { isRerunnable } from "@/lib/jobs/rerun-kind";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { triageJobRun } from "@/lib/triage/view";
import { isAgentOnline, jobTarget, type JobTarget } from "./display";
import { agentUpdateStatus, type AgentUpdateStatus } from "./update";

/** Serializable agent row for the Agents pages. */
export interface AgentRow {
  id: string;
  name: string;
  online: boolean;
  revoked: boolean;
  version: string | null;
  /** The version the agent should run: its override, else the global setting. */
  desiredVersion: string | null;
  /** The agent's own desired version, overriding the global one. */
  desiredVersionOverride: string | null;
  /** `desiredVersion` is the latest on npm (the global setting tracks it, no override). */
  tracksLatest: boolean;
  /** Null for agents that don't report it (older versions). */
  selfUpdate: SelfUpdateSupport | null;
  update: AgentUpdateReport | null;
  failedVersions: string[];
  /** An admin's "Update now" the agent hasn't acted on yet (`requestedAt` is ISO). */
  updateRequest: { version: string; requestedAt: string } | null;
  updateStatus: AgentUpdateStatus;
  /**
   * Task types the agent claims jobs of (`system` jobs always run), as it reports them (its
   * local `acceptedTaskTypes`; every type until it reports any). Read-only.
   */
  acceptedTaskTypes: string[];
  /** Its max concurrency, the organization's default filled in. */
  maxConcurrency: number;
  /** The agent's own max concurrency; null inherits `defaults`. */
  overrides: { maxConcurrency: number | null };
  /** The organization's defaults (Settings › Agents). */
  defaults: { maxConcurrency: number };
  /** Per-pool limits as stored (unset ones use the default). */
  poolLimits: Record<string, number>;
  /** Effective limits of the `short` and `long` pools, as sent to the agent. */
  effectivePoolLimits: Record<string, number>;
  runningJobs: { id: string; type: string; taskType: string; target: JobTarget | null }[];
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
 * `globalDesiredVersion` is the Settings › Agent defaults version, used by agents
 * without their own override (`globalTracksLatest`: it's the latest on npm).
 */
export function agentRow(
  agent: AgentOverview,
  now: Date = new Date(),
  globalDesiredVersion: string | null = null,
  globalTracksLatest = false,
): AgentRow {
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
    online: !agent.revokedAt && isAgentOnline(agent.lastHeartbeatAt, now),
    revoked: agent.revokedAt !== null,
    version: agent.reportedVersion,
    desiredVersion,
    desiredVersionOverride: agent.desiredVersion,
    tracksLatest: !agent.desiredVersion && globalTracksLatest,
    selfUpdate: agent.selfUpdate,
    update,
    failedVersions: agent.failedVersions,
    updateRequest,
    updateStatus: agentUpdateStatus({
      version: agent.reportedVersion,
      desiredVersion,
      selfUpdate: agent.selfUpdate,
      update,
      failedVersions: agent.failedVersions,
      updateRequested: updateRequest !== null,
    }),
    acceptedTaskTypes: agent.effective.acceptedTaskTypes,
    maxConcurrency: agent.effective.maxConcurrency,
    overrides: { maxConcurrency: agent.maxConcurrency },
    defaults: { maxConcurrency: agent.defaults.maxConcurrency },
    poolLimits: storedLimits(agent.poolLimits),
    effectivePoolLimits: effectivePoolLimits(agent.poolLimits, agent.effective.maxConcurrency),
    runningJobs: agent.runningJobs.map((job) => ({
      id: job.id,
      type: job.type,
      taskType: job.taskType,
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
  type: string;
  taskType: string;
  status: JobListEntry["status"];
  deliveryCount: number;
  cancelRequested: boolean;
  /** Whether the Jobs page offers to rerun it (`isRerunnable`). */
  rerunnable: boolean;
  error: string | null;
  agent: { id: string; name: string } | null;
  target: JobTarget | null;
  /** The triage run of a `triage.run` job (`label`: its issue), linked to its page. */
  triageRun: { id: string; label: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

export function jobRow(job: JobListEntry): JobRow {
  return {
    id: job.id,
    type: job.type,
    taskType: job.taskType,
    status: job.status,
    deliveryCount: job.deliveryCount,
    cancelRequested: job.cancelRequested,
    rerunnable: isRerunnable(job),
    error: job.error,
    agent: job.agent,
    target: jobTarget(job),
    triageRun: triageJobRun(job),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function storedLimits(limits: Partial<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(limits).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}
