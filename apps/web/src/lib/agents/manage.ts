import "server-only";
import {
  getDefaultMaxConcurrency,
  getDesiredAgentVersion,
  getAgentOverview,
  listAgentHostTools,
  requestAgentUpdate as requestAgentUpdateRow,
  setAgentDesiredVersion as setAgentDesiredVersionRow,
  setAgentHostToolPath,
  TRACK_LATEST_AGENT_VERSION,
  updateAgentConfig as updateAgentConfigRow,
  type Database,
} from "@omniralph/db";
import { AgentVersion, HostToolPath, POOLS } from "@omniralph/shared";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import type { AgentConfigForm, AgentSettingsSave, HostToolPathsSave } from "@/lib/api/agents";
import type { JobDispatcher } from "@/lib/dispatch";
import {
  deleteAgent as deleteAgentWithRevoke,
  revokeAgent as revokeAgentWithJobs,
} from "@/lib/agent-auth/revoke";
import { recordLatestAgentVersion } from "./desired-version";
import { bumpAgentHeartbeat } from "./heartbeat-cache";
import { enqueueInstall } from "./installables";
import { agentVersionTooOld } from "./min-version";
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

const AgentConfig = z.object({
  maxConcurrency: z.number().int().min(1).max(32).nullable(),
  poolLimits: z.partialRecord(z.enum(POOLS), z.number().int().min(1)),
});

/** Updates an agent's central config; the agent gets it with its next heartbeat. */
export async function updateAgentConfig(
  db: Database,
  organizationId: string,
  agentId: string,
  input: AgentConfigForm,
): Promise<ActionResult> {
  const parsed = AgentConfig.safeParse(input);
  // Pool limits are checked against the max concurrency the agent gets, inherited or not.
  const maxConcurrency = parsed.success
    ? (parsed.data.maxConcurrency ?? (await getDefaultMaxConcurrency(db, organizationId)))
    : 0;
  if (
    !parsed.success ||
    Object.values(parsed.data.poolLimits).some((limit) => limit > maxConcurrency)
  ) {
    return {
      ok: false,
      error: "Max concurrency must be 1–32 and each pool limit 1 to the max concurrency.",
    };
  }
  if (!(await updateAgentConfigRow(db, organizationId, agentId, parsed.data))) {
    return UNKNOWN_AGENT;
  }
  await bumpAgentHeartbeat(agentId);
  return { ok: true };
}

/**
 * Sets the version this agent should run, overriding the version policy (Fleet › Version policy); blank
 * clears the override. Agents under pm2 update themselves to it.
 */
export async function setAgentDesiredVersion(
  db: Database,
  organizationId: string,
  agentId: string,
  version: string,
): Promise<ActionResult> {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  const parsed = trimmed ? AgentVersion.safeParse(trimmed) : null;
  if (parsed && !parsed.success) {
    return { ok: false, error: "Enter a version like 2.0.0, or leave it blank." };
  }
  const tooOld = parsed && agentVersionTooOld(parsed.data);
  if (tooOld) return { ok: false, error: tooOld, fieldErrors: { version: tooOld } };
  if (!(await setAgentDesiredVersionRow(db, organizationId, agentId, parsed?.data ?? null))) {
    return UNKNOWN_AGENT;
  }
  await bumpAgentHeartbeat(agentId);
  return { ok: true };
}

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** A failure part-way through a save, naming what it didn't save: "… Not saved: x and y." */
function partialFailure(failure: Failure, unsaved: readonly string[]): Failure {
  const error = /[.!?]$/.test(failure.error) ? failure.error : `${failure.error}.`;
  return { ...failure, error: `${error} Not saved: ${listFormat.format(unsaved)}.` };
}

export interface SaveStep {
  /** What the step saves, for the failure message. */
  label: string;
  run: () => Promise<ActionResult>;
}

/**
 * Runs `steps` in order and stops at the first failure. When the save holds more than one
 * change, the error names every change it didn't save (the failed one and those after it).
 */
export async function saveInOrder(steps: readonly SaveStep[]): Promise<ActionResult> {
  const several = new Set(steps.map((step) => step.label)).size > 1;
  for (const [index, step] of steps.entries()) {
    const result = await step.run();
    if (!result.ok) {
      if (!several) return result;
      return partialFailure(result, [...new Set(steps.slice(index).map((s) => s.label))]);
    }
  }
  return { ok: true };
}

/**
 * The Settings tab's save, as one request: the config, then the desired version, in that
 * order. It stops at the first that fails; the error names the changes it didn't save (those
 * before it are saved).
 */
export async function saveAgentSettings(
  db: Database,
  organizationId: string,
  agentId: string,
  save: AgentSettingsSave,
): Promise<ActionResult> {
  return saveInOrder([
    ...(save.config
      ? [
          {
            label: "concurrency",
            run: () => updateAgentConfig(db, organizationId, agentId, save.config!),
          },
        ]
      : []),
    ...(save.version !== undefined
      ? [
          {
            label: "the desired version",
            run: () => setAgentDesiredVersion(db, organizationId, agentId, save.version!),
          },
        ]
      : []),
  ]);
}

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

const INVALID_HOST_TOOL_PATH =
  "Enter an absolute path, like /usr/local/bin/semgrep, or leave it blank.";

/**
 * Sets the path an agent runs a host tool from (an absolute path on the agent host); blank
 * clears it, and the agent then uses the path it discovers on its `PATH`. The agent gets it
 * with its next heartbeat response and reports whether it exists with the heartbeat after.
 */
export async function setHostToolPath(
  db: Database,
  organizationId: string,
  agentId: string,
  hostToolId: string,
  path: string,
): Promise<ActionResult> {
  const trimmed = path.trim();
  const parsed = trimmed ? HostToolPath.safeParse(trimmed) : null;
  if (parsed && !parsed.success) return { ok: false, error: INVALID_HOST_TOOL_PATH };
  const ids = z.uuid();
  const result =
    ids.safeParse(agentId).success && ids.safeParse(hostToolId).success
      ? await setAgentHostToolPath(db, organizationId, agentId, hostToolId, parsed?.data ?? null)
      : ({ ok: false, error: "not_found" } as const);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "invalid_path"
          ? INVALID_HOST_TOOL_PATH
          : "That agent or host tool doesn't exist, or the agent was revoked.",
    };
  }
  await bumpAgentHeartbeat(agentId);
  return { ok: true };
}

/**
 * The Host tools tab's save, as one request: each path in order, stopping at the first that
 * fails; the error names the paths it didn't save (those before it are saved).
 */
export async function saveHostToolPaths(
  db: Database,
  organizationId: string,
  agentId: string,
  save: HostToolPathsSave,
): Promise<ActionResult> {
  const names = new Map(
    z.uuid().safeParse(agentId).success
      ? (await listAgentHostTools(db, organizationId, agentId)).map((tool) => [
          tool.hostToolId,
          tool.name,
        ])
      : [],
  );
  return saveInOrder(
    save.paths.map(({ hostToolId, path }) => {
      const name = names.get(hostToolId);
      return {
        label: name ? `the ${name} path` : "a host tool path",
        run: () => setHostToolPath(db, organizationId, agentId, hostToolId, path),
      };
    }),
  );
}
