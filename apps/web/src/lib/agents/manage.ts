import "server-only";
import type { Database } from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import type { JobDispatcher } from "@/lib/dispatch";
import {
  deleteAgent as deleteAgentWithRevoke,
  revokeAgent as revokeAgentWithJobs,
} from "@/lib/agent-auth/revoke";
import { enqueueInstall } from "./installables";

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
