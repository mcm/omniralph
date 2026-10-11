"use server";

import { setDesiredHarnessVersion, TRACK_LATEST_HARNESS_VERSION } from "@omniralph/db";
import { HarnessVersion } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { recordLatestHarnessVersion } from "@/lib/harnesses/desired-version";
import { latestHarnessVersion, NpmRegistryError } from "@/lib/harnesses/npm";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";

function revalidate(): void {
  revalidatePath("/settings/harnesses");
  revalidatePath("/harnesses", "layout");
}

export type HarnessVersionResult = ActionResult & {
  /** Tracking `latest`: the version on npm now. */
  version?: string;
};

/**
 * Sets the version every harness of the organization should run (harnesses with their own override
 * keep it); blank clears it, `latest` tracks the latest on npm. Harnesses under pm2 update
 * themselves to it.
 */
export async function setGlobalHarnessVersion(version: string): Promise<HarnessVersionResult> {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  if (trimmed.toLowerCase() === TRACK_LATEST_HARNESS_VERSION) return trackLatestHarnessVersion();
  return runAdminAction(async (admin) => {
    const parsed = trimmed ? HarnessVersion.safeParse(trimmed) : null;
    if (parsed && !parsed.success) {
      return { ok: false, error: "Enter a version like 1.4.0 or latest, or leave it blank." };
    }
    await setDesiredHarnessVersion(getDb(), admin.organization.id, parsed?.data ?? null, admin.id);
    revalidate();
  });
}

/**
 * Makes harnesses follow the harness package's `latest` on npm: they update with each release
 * (it's read again every few minutes). It's read at once, and nothing changes when it can't be.
 */
export async function trackLatestHarnessVersion(): Promise<HarnessVersionResult> {
  let version: string | undefined;
  const result = await runAdminAction(async (admin) => {
    try {
      version = await latestHarnessVersion();
    } catch (error) {
      if (error instanceof NpmRegistryError) {
        return { ok: false, error: `Couldn't read the latest version: ${error.message}.` };
      }
      throw error;
    }
    const db = getDb();
    await recordLatestHarnessVersion(db, admin.organization.id, version);
    await setDesiredHarnessVersion(
      db,
      admin.organization.id,
      TRACK_LATEST_HARNESS_VERSION,
      admin.id,
    );
    revalidate();
  });
  return result.ok ? { ...result, version } : result;
}
