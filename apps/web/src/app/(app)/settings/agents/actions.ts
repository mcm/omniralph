"use server";

import { setDesiredAgentVersion, TRACK_LATEST_AGENT_VERSION } from "@omniralph/db";
import { AgentVersion } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { recordLatestAgentVersion } from "@/lib/agents/desired-version";
import { latestAgentVersion, NpmRegistryError } from "@/lib/agents/npm";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";

function revalidate(): void {
  revalidatePath("/settings/agents");
  revalidatePath("/agents", "layout");
}

export type AgentVersionResult = ActionResult & {
  /** Tracking `latest`: the version on npm now. */
  version?: string;
};

/**
 * Sets the version every agent of the organization should run (agents with their own override
 * keep it); blank clears it, `latest` tracks the latest on npm. Agents under pm2 update
 * themselves to it.
 */
export async function setGlobalAgentVersion(version: string): Promise<AgentVersionResult> {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  if (trimmed.toLowerCase() === TRACK_LATEST_AGENT_VERSION) return trackLatestAgentVersion();
  return runAdminAction(async (admin) => {
    const parsed = trimmed ? AgentVersion.safeParse(trimmed) : null;
    if (parsed && !parsed.success) {
      return { ok: false, error: "Enter a version like 1.4.0 or latest, or leave it blank." };
    }
    await setDesiredAgentVersion(getDb(), admin.organization.id, parsed?.data ?? null, admin.id);
    revalidate();
  });
}

/**
 * Makes agents follow the agent package's `latest` on npm: they update with each release
 * (it's read again every few minutes). It's read at once, and nothing changes when it can't be.
 */
export async function trackLatestAgentVersion(): Promise<AgentVersionResult> {
  let version: string | undefined;
  const result = await runAdminAction(async (admin) => {
    try {
      version = await latestAgentVersion();
    } catch (error) {
      if (error instanceof NpmRegistryError) {
        return { ok: false, error: `Couldn't read the latest version: ${error.message}.` };
      }
      throw error;
    }
    const db = getDb();
    await recordLatestAgentVersion(db, admin.organization.id, version);
    await setDesiredAgentVersion(db, admin.organization.id, TRACK_LATEST_AGENT_VERSION, admin.id);
    revalidate();
  });
  return result.ok ? { ...result, version } : result;
}
