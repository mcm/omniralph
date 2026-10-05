"use server";

import {
  createAgentEnrollment,
  unpinRepositoryFromAgent,
  updateAgentConfig as updateAgentConfigRow,
} from "@omniralph/db";
import { CAPABILITIES } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { revokeAgent as revokeAgentWithJobs } from "@/lib/agent-auth/revoke";
import { enrollCommand } from "@/lib/agents/display";
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

/** Creates a one-time enrollment token (valid for 1 hour) for a new agent. */
export async function createEnrollment(name: string): Promise<EnrollmentActionResult> {
  let created: Extract<EnrollmentActionResult, { ok: true }> | undefined;
  const result = await runAdminAction(async (admin) => {
    const parsed = EnrollmentName.safeParse(name);
    if (!parsed.success) return { ok: false, error: "Names can be at most 100 characters." };
    const enrollment = await createAgentEnrollment(getDb(), {
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

const AgentConfig = z.object({
  maxConcurrency: z.number().int().min(1).max(32),
  pollIntervalSeconds: z.number().int().min(1).max(300),
  enabledCapabilities: z.array(z.enum(CAPABILITIES)),
});
export interface AgentConfigForm {
  maxConcurrency: number;
  pollIntervalSeconds: number;
  enabledCapabilities: string[];
}

/** Updates an agent's central config; the agent gets it with its next heartbeat. */
export async function updateAgentConfig(
  agentId: string,
  input: AgentConfigForm,
): Promise<ActionResult> {
  return runAdminAction(async () => {
    const parsed = AgentConfig.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "Max concurrency must be 1–32, the poll interval 1–300 seconds, and capabilities known ones.",
      };
    }
    if (!(await updateAgentConfigRow(getDb(), agentId, parsed.data))) {
      return { ok: false, error: "That agent doesn't exist or was revoked." };
    }
    revalidate(agentId);
  });
}

/**
 * Revokes an agent: its tokens stop working at once, its running jobs are
 * redelivered to other agents and its pins are removed.
 */
export async function revokeAgent(agentId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const h = await headers();
    const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    if (!(await revokeAgentWithJobs(agentId, { revokedBy: admin.id, ip }))) {
      return { ok: false, error: "That agent doesn't exist." };
    }
    revalidate(agentId);
    revalidatePath("/jobs");
  });
}

/** Pins a repository to an agent; the agent pre-clones it via a `repo.sync` job. */
export async function pinRepository(agentId: string, repositoryId: string): Promise<ActionResult> {
  return runAdminAction(async () => {
    const { result } = await pinRepositoryWithSync(getDb(), getDispatcher(), {
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
  return runAdminAction(async () => {
    if (!(await unpinRepositoryFromAgent(getDb(), { agentId, repositoryId }))) {
      return { ok: false, error: "That repository isn't pinned to this agent." };
    }
    revalidate(agentId);
  });
}
