import "server-only";
import {
  getDesiredAgentVersion,
  getAgentOverview,
  requestAgentUpdate as requestAgentUpdateRow,
  TRACK_LATEST_AGENT_VERSION,
  type Database,
} from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import type { JobDispatcher } from "@/lib/dispatch";
import {
  deleteAgent as deleteAgentWithRevoke,
  revokeAgent as revokeAgentWithJobs,
} from "@/lib/agent-auth/revoke";
import { recordLatestAgentVersion } from "./desired-version";
import { bumpAgentHeartbeat } from "./heartbeat-cache";
import { enqueueInstall } from "./installables";
import { latestAgentVersion, NpmRegistryError } from "./npm";

/**
 * An admin's changes to one agent of their organization (its detail pages): the logic
 * behind the `/api/ui/agents/{id}/…` handlers, which parse, authorize and serialize.
 * Every function is scoped to `organizationId` and answers an `ActionResult` worded for
 * the panel's toasts.
 */

type Failure = Extract<ActionResult, { ok: false }>;

const UNKNOWN_AGENT: Failure = {
  ok: false,
  error: "That agent doesn't exist or was revoked.",
};

export type AgentUpdateResult = ActionResult & { version?: string };

/**
 * "Update now": asks the agent to update with its next heartbeat to its desired
 * version (its override, else the organization's), or to the latest on npm when
 * none is chosen or the organization tracks it. Unlike the automatic update it also retries a version that
 * failed on the agent. Only agents under pm2 can update themselves.
 */
export async function requestAgentUpdate(
  db: Database,
  organizationId: string,
  agentId: string,
): Promise<AgentUpdateResult> {
  const agent = await getAgentOverview(db, organizationId, agentId);
  if (!agent || agent.revokedAt) return UNKNOWN_AGENT;
  if (agent.selfUpdate !== "supported") {
    return {
      ok: false,
      error: "This agent can't update itself (it isn't running under pm2). Update it on the host.",
    };
  }
  const desired = agent.desiredVersion ?? (await getDesiredAgentVersion(db, organizationId));
  let target = desired === TRACK_LATEST_AGENT_VERSION ? null : desired;
  if (!target) {
    try {
      target = await latestAgentVersion();
    } catch (error) {
      if (error instanceof NpmRegistryError) {
        return { ok: false, error: `Couldn't read the latest version: ${error.message}.` };
      }
      throw error;
    }
    // Heartbeats then hand out this version too, so the agent isn't sent back to an older one.
    if (desired === TRACK_LATEST_AGENT_VERSION) {
      await recordLatestAgentVersion(db, organizationId, target);
    }
  }
  if (target === agent.reportedVersion) {
    return { ok: false, error: `${agent.name} already runs ${target}.` };
  }
  if (!(await requestAgentUpdateRow(db, organizationId, agentId, target))) {
    return UNKNOWN_AGENT;
  }
  await bumpAgentHeartbeat(agentId);
  return { ok: true, version: target };
}

/** Who revokes or deletes an agent, for its audit log. */
export interface AgentActor {
  organizationId: string;
  userId: string;
  ip: string | null;
}

/**
 * Revokes an agent: its tokens stop working at once, its running jobs are
 * redelivered to other agents and its pins are removed.
 */
export async function revokeAgent(agentId: string, actor: AgentActor): Promise<ActionResult> {
  if (
    !(await revokeAgentWithJobs(agentId, {
      revokedBy: actor.userId,
      ip: actor.ip,
      organizationId: actor.organizationId,
    }))
  ) {
    return { ok: false, error: "That agent doesn't exist." };
  }
  return { ok: true };
}

/**
 * Deletes an agent: revokes it if it isn't already (see `revokeAgent`), then
 * removes it from the Agents pages for good.
 */
export async function deleteAgent(agentId: string, actor: AgentActor): Promise<ActionResult> {
  if (
    !(await deleteAgentWithRevoke(agentId, {
      organizationId: actor.organizationId,
      deletedBy: actor.userId,
      ip: actor.ip,
    }))
  ) {
    return { ok: false, error: "That agent doesn't exist." };
  }
  return { ok: true };
}

export type InstallResult = ActionResult & { jobId?: string };

/**
 * Installs or updates an installable on one agent (an `install` system RPC
 * targeted at it). The version is an exact version or a dist-tag (default
 * `latest`); the agent refuses packages its local allowlist doesn't allow.
 */
export async function installInstallable(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  agentId: string,
  input: { name: string; version?: string },
): Promise<InstallResult> {
  const name = input.name.trim();
  const version = input.version?.trim() || undefined;
  const enqueued = await enqueueInstall(db, dispatcher, {
    organizationId,
    agentId,
    name,
    ...(version !== undefined && { version }),
  });
  if (enqueued.result === "invalid") {
    const field = enqueued.field === "version" ? "version" : "package name";
    return { ok: false, error: `That isn't a valid ${field}.` };
  }
  if (enqueued.result === "unknown_agent") return UNKNOWN_AGENT;
  return { ok: true, jobId: enqueued.jobId };
}
