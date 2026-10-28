import type { AgentOverview, JobListEntry } from "@omniralph/db";
import type { AgentHostReport, AgentUpdateReport, SelfUpdateSupport } from "@omniralph/shared";
import {
  agentStatus,
  agentUpdateStatus,
  type AgentStatus,
  type AgentUpdateStatus,
} from "@/lib/fleet/status";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { jobTarget, type JobTarget } from "./display";

/** Serializable agent row for the Agents pages. */
export interface AgentRow {
  id: string;
  name: string;
  /** The server's `live_online` flag (the liveness cron clears it); never from a clock. */
  online: boolean;
  revoked: boolean;
  /** Fleet's status (`agentStatus`), offline taken from `online`. */
  status: AgentStatus;
  /** Attempts running on it. */
  runningCount: number;
  /** The machine it last reported running on; null until it reports one. */
  host: AgentHostReport | null;
  version: string | null;
  /** The version the agent should run: its local pin, else its organization's policy. */
  desiredVersion: string | null;
  /** The version pinned on the agent (its `settings.json`), as it reports it; null when none. */
  versionPin: string | null;
  /** `desiredVersion` is the latest on npm (the policy tracks it, no local pin). */
  tracksLatest: boolean;
  /** Null for agents that don't report it (older versions). */
  selfUpdate: SelfUpdateSupport | null;
  update: AgentUpdateReport | null;
  failedVersions: string[];
  updateStatus: AgentUpdateStatus;
  /**
   * Task types the agent claims jobs of (`system` jobs always run), as it reports them (its
   * local `acceptedTaskTypes`; every type until it reports any). Read-only.
   */
  acceptedTaskTypes: string[];
  /**
   * Its load: attempts running on it, and its slots as it reports them (its `settings.json`
   * `maxConcurrency`; null until it reports them). Read-only.
   */
  slots: { running: number; max: number | null };
  runningJobs: {
    id: string;
    type: string;
    taskType: string;
    target: JobTarget | null;
    /** The run the job is an attempt of; null for system work. */
    runId: string | null;
  }[];
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
 * `globalDesiredVersion` is the version policy's version (Fleet › Version policy), the target of
 * agents without a local pin (`globalTracksLatest`: it's the latest on npm).
 */
export function agentRow(
  agent: AgentOverview,
  now: Date = new Date(),
  globalDesiredVersion: string | null = null,
  globalTracksLatest = false,
): AgentRow {
  const versionPin = agent.reportedVersionPin;
  const desiredVersion = versionPin ?? globalDesiredVersion;
  const update = agent.updateState ?? null;
  const updateStatus = agentUpdateStatus({
    version: agent.reportedVersion,
    desiredVersion,
    selfUpdate: agent.selfUpdate,
    update,
    failedVersions: agent.failedVersions,
  });
  const revoked = agent.revokedAt !== null;
  const online = !revoked && agent.liveOnline;
  const runningCount = agent.runningJobs.length;
  return {
    id: agent.id,
    name: agent.name,
    online,
    revoked,
    status: agentStatus(
      {
        revoked,
        online,
        lastHeartbeatAt: agent.lastHeartbeatAt,
        updateStatus,
        runningCount,
        maxSlots: agent.reportedMaxConcurrency,
      },
      now,
    ),
    runningCount,
    host: agent.reportedHost ?? null,
    version: agent.reportedVersion,
    desiredVersion,
    versionPin,
    tracksLatest: !versionPin && globalTracksLatest,
    selfUpdate: agent.selfUpdate,
    update,
    failedVersions: agent.failedVersions,
    updateStatus,
    acceptedTaskTypes: agent.effective.acceptedTaskTypes,
    slots: { running: runningCount, max: agent.reportedMaxConcurrency },
    runningJobs: agent.runningJobs.map((job) => ({
      id: job.id,
      type: job.type,
      taskType: job.taskType,
      target: jobTarget(job),
      runId: job.runId,
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

/** Serializable job row: a job as the chat tools list it. */
export interface JobRow {
  id: string;
  type: string;
  taskType: string;
  status: JobListEntry["status"];
  deliveryCount: number;
  cancelRequested: boolean;
  error: string | null;
  agent: { id: string; name: string } | null;
  target: JobTarget | null;
  /** The run the job is an attempt of; null for system work. */
  runId: string | null;
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
    error: job.error,
    agent: job.agent,
    target: jobTarget(job),
    runId: job.runId,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
