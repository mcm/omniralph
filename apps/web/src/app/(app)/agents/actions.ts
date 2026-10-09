"use server";

import {
  createAgentEnrollment,
  getAgentOverview,
  getDesiredAgentVersion,
  getRepository,
  TRACK_LATEST_AGENT_VERSION,
  requestAgentUpdate as requestAgentUpdateRow,
  setAgentDesiredVersion as setAgentDesiredVersionRow,
  unpinRepositoryFromAgent,
  updateAgentConfig as updateAgentConfigRow,
} from "@omniralph/db";
import { AgentVersion, CAPABILITIES, type Capability } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import {
  deleteAgent as deleteAgentWithRevoke,
  revokeAgent as revokeAgentWithJobs,
} from "@/lib/agent-auth/revoke";
import { recordLatestAgentVersion } from "@/lib/agents/desired-version";
import { enrollCommand } from "@/lib/agents/display";
import { latestAgentVersion, NpmRegistryError } from "@/lib/agents/npm";
import { pinRepository as pinRepositoryWithSync } from "@/lib/agents/pins";
import { getAppUrl } from "@/lib/app-url";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";

function revalidate(agentId?: string): void {
  revalidatePath("/agents");
  if (agentId) revalidatePath(`/agents/${agentId}`);
  revalidatePath("/repositories");
}

/** The control panel URL agents should use: `APP_URL`, else the URL this request came in on. */
async function serverUrl(): Promise<string> {
  try {
    return getAppUrl();
  } catch {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    const proto =
      h.get("x-forwarded-proto") ??
      (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

export type EnrollmentActionResult =
  | {
      ok: true;
      /** Shown once; only its hash is stored. */
      token: string;
      /** ISO timestamp (1 hour from now). */
      expiresAt: string;
      /** The `omniralph-agent enroll …` command to run on the agent host. */
      command: string;
    }
  | { ok: false; error: string };

const EnrollmentName = z.string().trim().max(100);

/** Creates a one-time enrollment token (valid for 1 hour) for a new agent of the active organization. */
export async function createEnrollment(name: string): Promise<EnrollmentActionResult> {
  let created: Extract<EnrollmentActionResult, { ok: true }> | undefined;
  const result = await runAdminAction(async (admin) => {
    const parsed = EnrollmentName.safeParse(name);
    if (!parsed.success) return { ok: false, error: "Names can be at most 100 characters." };
    const enrollment = await createAgentEnrollment(getDb(), {
      organizationId: admin.organization.id,
      name: parsed.data || null,
      createdBy: admin.id,
    });
    created = {
      ok: true,
      token: enrollment.token,
      expiresAt: enrollment.expiresAt.toISOString(),
      command: enrollCommand(await serverUrl(), enrollment.token),
    };
  });
  if (!result.ok) return result;
  return created ?? { ok: false, error: "Couldn't create an enrollment token." };
}

const AgentConfig = z
  .object({
    maxConcurrency: z.number().int().min(1).max(32),
    pollIntervalSeconds: z.number().int().min(1).max(300),
    enabledCapabilities: z.array(z.enum(CAPABILITIES)),
    capabilityLimits: z.partialRecord(z.enum(CAPABILITIES), z.number().int().min(1)).optional(),
  })
  .superRefine((config, ctx) => {
    for (const [capability, limit] of Object.entries(config.capabilityLimits ?? {})) {
      if (!config.enabledCapabilities.includes(capability as Capability)) {
        ctx.addIssue({ code: "custom", message: `${capability} isn't enabled.` });
      }
      if (limit !== undefined && limit > config.maxConcurrency) {
        ctx.addIssue({ code: "custom", message: `${capability}'s limit exceeds max concurrency.` });
      }
    }
  });
export interface AgentConfigForm {
  maxConcurrency: number;
  pollIntervalSeconds: number;
  enabledCapabilities: string[];
  /**
   * Per-capability concurrency limits of enabled capabilities (1 to
   * `maxConcurrency`); left-out ones use the default. Omitted: unchanged.
   */
  capabilityLimits?: Record<string, number>;
}

/** Updates an agent's central config; the agent gets it with its next heartbeat. */
export async function updateAgentConfig(
  agentId: string,
  input: AgentConfigForm,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = AgentConfig.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "Max concurrency must be 1–32, the poll interval 1–300 seconds, capabilities known ones, and each capability limit 1 to the max concurrency for an enabled capability.",
      };
    }
    if (!(await updateAgentConfigRow(getDb(), admin.organization.id, agentId, parsed.data))) {
      return { ok: false, error: "That agent doesn't exist or was revoked." };
    }
    revalidate(agentId);
  });
}

/**
 * Sets the version this agent should run, overriding Settings › Agents; blank
 * clears the override. Agents under pm2 update themselves to it.
 */
export async function setAgentDesiredVersion(
  agentId: string,
  version: string,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const trimmed = version.trim().replace(/^v(?=\d)/, "");
    const parsed = trimmed ? AgentVersion.safeParse(trimmed) : null;
    if (parsed && !parsed.success) {
      return { ok: false, error: "Enter a version like 1.4.0, or leave it blank." };
    }
    if (
      !(await setAgentDesiredVersionRow(
        getDb(),
        admin.organization.id,
        agentId,
        parsed?.data ?? null,
      ))
    ) {
      return { ok: false, error: "That agent doesn't exist or was revoked." };
    }
    revalidate(agentId);
  });
}

export type AgentUpdateActionResult = ActionResult & { version?: string };

/**
 * "Update now": asks the agent to update with its next heartbeat to its desired
 * version (its override, else the organization's), or to the latest on npm when
 * none is chosen or the organization tracks it. Unlike the automatic update it also retries a version that
 * failed on the agent. Only agents under pm2 can update themselves.
 */
export async function requestAgentUpdate(agentId: string): Promise<AgentUpdateActionResult> {
  let version: string | undefined;
  const result = await runAdminAction(async (admin) => {
    const db = getDb();
    const agent = await getAgentOverview(db, admin.organization.id, agentId);
    if (!agent || agent.revokedAt) {
      return { ok: false, error: "That agent doesn't exist or was revoked." };
    }
    if (agent.selfUpdate !== "supported") {
      return {
        ok: false,
        error:
          "This agent can't update itself (it isn't running under pm2). Update it on the host.",
      };
    }
    const desired =
      agent.desiredVersion ?? (await getDesiredAgentVersion(db, admin.organization.id));
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
        await recordLatestAgentVersion(db, admin.organization.id, target);
      }
    }
    if (target === agent.reportedVersion) {
      return { ok: false, error: `${agent.name} already runs ${target}.` };
    }
    if (!(await requestAgentUpdateRow(db, admin.organization.id, agentId, target))) {
      return { ok: false, error: "That agent doesn't exist or was revoked." };
    }
    version = target;
    revalidate(agentId);
  });
  return result.ok ? { ...result, version } : result;
}

/**
 * Revokes an agent: its tokens stop working at once, its running jobs are
 * redelivered to other agents and its pins are removed.
 */
export async function revokeAgent(agentId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const ip = await clientIp();
    if (
      !(await revokeAgentWithJobs(agentId, {
        revokedBy: admin.id,
        ip,
        organizationId: admin.organization.id,
      }))
    ) {
      return { ok: false, error: "That agent doesn't exist." };
    }
    revalidate(agentId);
    revalidatePath("/jobs");
  });
}

/**
 * Deletes an agent: revokes it if it isn't already (see `revokeAgent`), then
 * removes it from the Agents pages for good.
 */
export async function deleteAgent(agentId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (
      !(await deleteAgentWithRevoke(agentId, {
        organizationId: admin.organization.id,
        deletedBy: admin.id,
        ip: await clientIp(),
      }))
    ) {
      return { ok: false, error: "That agent doesn't exist." };
    }
    revalidate(agentId);
    revalidatePath("/jobs");
  });
}

/** Pins a repository to an agent; the agent pre-clones it via a `repo.sync` job. */
export async function pinRepository(agentId: string, repositoryId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    if (!(await getRepository(db, repositoryId, admin.organization.id))) {
      return { ok: false, error: "That repository isn't connected." };
    }
    const { result } = await pinRepositoryWithSync(db, getDispatcher(), {
      agentId,
      repositoryId,
    });
    if (result === "unknown_agent")
      return { ok: false, error: "That agent doesn't exist or was revoked." };
    if (result === "unknown_repository")
      return { ok: false, error: "That repository isn't connected." };
    revalidate(agentId);
  });
}

/** Unpins a repository from an agent (any agent may then serve it, unless other pins remain). */
export async function unpinRepository(
  agentId: string,
  repositoryId: string,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    if (
      !(await getRepository(db, repositoryId, admin.organization.id)) ||
      !(await unpinRepositoryFromAgent(db, { agentId, repositoryId }))
    ) {
      return { ok: false, error: "That repository isn't pinned to this agent." };
    }
    revalidate(agentId);
  });
}
