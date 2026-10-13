"use server";

import {
  createHostTool,
  deleteHostTool,
  MAX_MAX_CONCURRENCY,
  MIN_MAX_CONCURRENCY,
  setAllowedTaskTypeDefaults,
  setDefaultMaxConcurrency,
  setDesiredHarnessVersion,
  TRACK_LATEST_HARNESS_VERSION,
} from "@omniralph/db";
import { HarnessVersion } from "@omniralph/shared";
import { TASK_TYPES } from "@omniralph/tasks";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { recordLatestHarnessVersion } from "@/lib/harnesses/desired-version";
import { latestHarnessVersion, NpmRegistryError } from "@/lib/harnesses/npm";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";

function revalidate(): void {
  revalidatePath("/settings/harnesses");
  revalidatePath("/settings/harnesses/host-tools");
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

const OrganizationDefaults = z.object({
  allowedTaskTypes: z.array(z.enum(TASK_TYPES)),
  maxConcurrency: z.number().int().min(MIN_MAX_CONCURRENCY).max(MAX_MAX_CONCURRENCY),
});

export interface OrganizationDefaultsForm {
  /** Task types harnesses and repositories allow unless they set their own (`query`, `review`, `coding`). */
  allowedTaskTypes: string[];
  /** Jobs a harness runs at once unless it sets its own (1–32). */
  maxConcurrency: number;
}

/**
 * Sets the task types and max concurrency every harness and repository of the organization
 * inherits unless it sets its own; they take effect with the next claim or heartbeat.
 */
export async function setOrganizationDefaults(
  input: OrganizationDefaultsForm,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = OrganizationDefaults.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Max concurrency must be ${MIN_MAX_CONCURRENCY}–${MAX_MAX_CONCURRENCY} and task types known ones.`,
      };
    }
    const db = getDb();
    await setAllowedTaskTypeDefaults(
      db,
      admin.organization.id,
      parsed.data.allowedTaskTypes,
      admin.id,
    );
    await setDefaultMaxConcurrency(db, admin.organization.id, parsed.data.maxConcurrency, admin.id);
    revalidate();
  });
}

/** Longest host tool description accepted. */
const MAX_HOST_TOOL_DESCRIPTION = 500;

export type HostToolActionResult = ActionResult & { hostToolId?: string };

/**
 * Adds a host tool (software harness owners install by hand) to the organization's catalog.
 * Harnesses get it with their next heartbeat and report where they find it.
 */
export async function addHostTool(input: {
  name: string;
  description?: string;
}): Promise<HostToolActionResult> {
  let hostToolId: string | undefined;
  const result = await runAdminAction(async (admin) => {
    const name = input.name.trim();
    const description = input.description?.trim() || null;
    if (description && description.length > MAX_HOST_TOOL_DESCRIPTION) {
      return {
        ok: false,
        error: `Descriptions can be at most ${MAX_HOST_TOOL_DESCRIPTION} characters.`,
      };
    }
    const created = await createHostTool(getDb(), admin.organization.id, { name, description });
    if (!created.ok) {
      return {
        ok: false,
        error:
          created.error === "duplicate_name"
            ? `There already is a host tool named ${name}.`
            : "Names are the executable's name: lowercase letters, digits, dots, dashes and underscores (up to 64), starting with a letter or digit.",
      };
    }
    hostToolId = created.hostTool.id;
    revalidate();
  });
  return result.ok ? { ...result, hostToolId } : result;
}

/** Removes a host tool from the catalog, with every harness's configured path for it. */
export async function removeHostTool(hostToolId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (
      !z.uuid().safeParse(hostToolId).success ||
      !(await deleteHostTool(getDb(), admin.organization.id, hostToolId))
    ) {
      return { ok: false, error: "That host tool doesn't exist." };
    }
    revalidate();
  });
}
