"use server";

import { setDesiredAgentVersion } from "@omniralph/db";
import { AgentVersion } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { latestAgentVersion, npmToken, NpmRegistryError } from "@/lib/agents/npm";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";

function revalidate(): void {
  revalidatePath("/settings/agents");
  revalidatePath("/agents", "layout");
}

/**
 * Sets the version every agent should run (agents with their own override
 * keep it); blank clears it. Agents under pm2 update themselves to it.
 */
export async function setGlobalAgentVersion(version: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const trimmed = version.trim().replace(/^v(?=\d)/, "");
    const parsed = trimmed ? AgentVersion.safeParse(trimmed) : null;
    if (parsed && !parsed.success) {
      return { ok: false, error: "Enter a version like 1.4.0, or leave it blank." };
    }
    await setDesiredAgentVersion(getDb(), parsed?.data ?? null, admin.id);
    revalidate();
  });
}

export type LatestVersionResult = ActionResult & { version?: string };

/** Sets the global version to the agent package's `latest` on npm (needs `NPM_TOKEN`). */
export async function applyLatestAgentVersion(): Promise<LatestVersionResult> {
  let version: string | undefined;
  const result = await runAdminAction(async (admin) => {
    const token = npmToken();
    if (!token) return { ok: false, error: "Set NPM_TOKEN to read versions from npm." };
    try {
      version = await latestAgentVersion(token);
    } catch (error) {
      if (error instanceof NpmRegistryError) {
        return { ok: false, error: `Couldn't read the latest version: ${error.message}.` };
      }
      throw error;
    }
    await setDesiredAgentVersion(getDb(), version, admin.id);
    revalidate();
  });
  return result.ok ? { ...result, version } : result;
}
