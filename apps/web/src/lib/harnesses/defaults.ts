import "server-only";
import {
  createHostTool,
  DEFAULT_MAX_CONCURRENCY,
  deleteHostTool,
  DESIRED_HARNESS_VERSION_KEY,
  getAppSetting,
  getDefaultMaxConcurrency,
  listHostTools,
  MAX_MAX_CONCURRENCY,
  MIN_MAX_CONCURRENCY,
  setDefaultMaxConcurrency,
  setDesiredHarnessVersion,
  TRACK_LATEST_HARNESS_VERSION,
  withSettingsChanges,
  type Database,
} from "@omniralph/db";
import { HARNESS_PACKAGE, HarnessVersion } from "@omniralph/shared";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import type {
  AddHostToolInput,
  HarnessDefaults,
  HarnessDefaultsSave,
  HostToolCatalogRow,
} from "@/lib/api/harness-defaults";
import { settingsActor, trackedAgentDefaults } from "@/lib/settings-history/sections";
import { organizationHarnessVersion, recordLatestHarnessVersion } from "./desired-version";
import { bumpOrganizationHeartbeat } from "./heartbeat-cache";
import { saveInOrder } from "./manage";
import { latestHarnessVersion, NpmRegistryError } from "./npm";

/**
 * Settings › Harness defaults: the organization-wide harness settings every harness gets
 * with its heartbeat, and the host tool catalog. The logic behind `/api/ui/harness-defaults`
 * and `/api/ui/host-tools/**`, whose handlers parse, authorize and serialize. Every function
 * is scoped to the admin's active organization and answers an `ActionResult` worded for the
 * panel's toasts.
 */

/** Who makes a change: the admin and their active organization. */
export interface DefaultsActor {
  id: string;
  organization: { id: string };
}

/** npm's `latest` is read at most every 5 minutes (cached); never let it hold up a poll for long. */
const NPM_TIMEOUT_MS = 2_000;

/** The Defaults tab: the desired version (with `latest` resolved) and the concurrency default. */
export async function loadHarnessDefaults(
  db: Database,
  organizationId: string,
): Promise<HarnessDefaults> {
  const [setting, resolved, maxConcurrency] = await Promise.all([
    getAppSetting(db, organizationId, DESIRED_HARNESS_VERSION_KEY),
    organizationHarnessVersion(db, organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
    getDefaultMaxConcurrency(db, organizationId),
  ]);
  return {
    desiredVersion: typeof setting?.value === "string" ? setting.value : null,
    updatedAt: setting?.updatedAt.toISOString() ?? null,
    latest: resolved.tracksLatest
      ? {
          version: resolved.version,
          error: resolved.latestError,
          checkedAt: resolved.latestCheckedAt?.toISOString() ?? null,
        }
      : null,
    packageName: HARNESS_PACKAGE,
    defaults: { maxConcurrency },
    builtInDefaults: { maxConcurrency: DEFAULT_MAX_CONCURRENCY },
  };
}

export type HarnessVersionResult = ActionResult & {
  /** Tracking `latest`: the version on npm now. */
  version?: string;
};

/**
 * Sets the version every harness of the organization should run (harnesses with their own
 * override keep it); blank clears it, `latest` tracks the latest on npm. Harnesses under pm2
 * update themselves to it.
 */
export async function setGlobalHarnessVersion(
  db: Database,
  admin: DefaultsActor,
  version: string,
): Promise<HarnessVersionResult> {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  if (trimmed.toLowerCase() === TRACK_LATEST_HARNESS_VERSION) {
    return trackLatestHarnessVersion(db, admin);
  }
  const parsed = trimmed ? HarnessVersion.safeParse(trimmed) : null;
  if (parsed && !parsed.success) {
    return { ok: false, error: "Enter a version like 1.4.0 or latest, or leave it blank." };
  }
  await setDesiredHarnessVersion(db, admin.organization.id, parsed?.data ?? null, admin.id);
  await bumpOrganizationHeartbeat(admin.organization.id);
  return { ok: true };
}

/**
 * Makes harnesses follow the harness package's `latest` on npm: they update with each release
 * (it's read again every few minutes). It's read at once, and nothing changes when it can't be.
 */
export async function trackLatestHarnessVersion(
  db: Database,
  admin: DefaultsActor,
): Promise<HarnessVersionResult> {
  let version: string;
  try {
    version = await latestHarnessVersion();
  } catch (error) {
    if (error instanceof NpmRegistryError) {
      return { ok: false, error: `Couldn't read the latest version: ${error.message}.` };
    }
    throw error;
  }
  await recordLatestHarnessVersion(db, admin.organization.id, version);
  await setDesiredHarnessVersion(db, admin.organization.id, TRACK_LATEST_HARNESS_VERSION, admin.id);
  await bumpOrganizationHeartbeat(admin.organization.id);
  return { ok: true, version };
}

const OrganizationDefaultsInput = z.strictObject({
  maxConcurrency: z.number().int().min(MIN_MAX_CONCURRENCY).max(MAX_MAX_CONCURRENCY),
});

/**
 * Sets the max concurrency every harness of the organization inherits unless it sets its own;
 * it takes effect with the next heartbeat.
 */
export async function setOrganizationDefaults(
  db: Database,
  admin: DefaultsActor,
  input: unknown,
): Promise<ActionResult> {
  const parsed = OrganizationDefaultsInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Max concurrency must be ${MIN_MAX_CONCURRENCY}–${MAX_MAX_CONCURRENCY}.`,
    };
  }
  await setDefaultMaxConcurrency(db, admin.organization.id, parsed.data.maxConcurrency, admin.id);
  await bumpOrganizationHeartbeat(admin.organization.id);
  return { ok: true };
}

/**
 * The Defaults tab's save, as one request: the concurrency default, then the
 * desired version, each only when sent. It stops at the first that fails; the error names
 * what it didn't save. What it saved is recorded in the change history.
 */
export async function saveHarnessDefaults(
  db: Database,
  admin: DefaultsActor & { name: string | null; email: string | null },
  save: HarnessDefaultsSave,
): Promise<ActionResult> {
  const result = await withSettingsChanges(
    db,
    settingsActor(admin),
    trackedAgentDefaults(admin.organization.id),
    (tx) => saveDefaultsInOrder(tx, admin, save),
  );
  // The bumps in the transaction ran before its commit: bump again once it's visible.
  await bumpOrganizationHeartbeat(admin.organization.id);
  return result;
}

function saveDefaultsInOrder(
  db: Database,
  admin: DefaultsActor,
  save: HarnessDefaultsSave,
): Promise<ActionResult> {
  return saveInOrder([
    ...(save.defaults !== undefined
      ? [
          {
            label: "max concurrency",
            run: () => setOrganizationDefaults(db, admin, save.defaults),
          },
        ]
      : []),
    ...(save.version !== undefined
      ? [
          {
            label: "the desired version",
            run: () => setGlobalHarnessVersion(db, admin, save.version!),
          },
        ]
      : []),
  ]);
}

/** The organization's host tool catalog, by name. */
export async function loadHostToolCatalog(
  db: Database,
  organizationId: string,
): Promise<HostToolCatalogRow[]> {
  const tools = await listHostTools(db, organizationId);
  return tools.map(({ id, name, description }) => ({ id, name, description }));
}

/** Longest host tool description accepted. */
const MAX_HOST_TOOL_DESCRIPTION = 500;

export type HostToolResult = ActionResult & { hostToolId?: string };

/**
 * Adds a host tool (software harness owners install by hand) to the organization's catalog.
 * Harnesses get it with their next heartbeat and report where they find it.
 */
export async function addHostTool(
  db: Database,
  organizationId: string,
  input: AddHostToolInput,
): Promise<HostToolResult> {
  const name = input.name.trim();
  const description = input.description?.trim() || null;
  if (description && description.length > MAX_HOST_TOOL_DESCRIPTION) {
    return {
      ok: false,
      error: `Descriptions can be at most ${MAX_HOST_TOOL_DESCRIPTION} characters.`,
    };
  }
  const created = await createHostTool(db, organizationId, { name, description });
  if (!created.ok) {
    return {
      ok: false,
      error:
        created.error === "duplicate_name"
          ? `There already is a host tool named ${name}.`
          : "Names are the executable's name: lowercase letters, digits, dots, dashes and underscores (up to 64), starting with a letter or digit.",
    };
  }
  await bumpOrganizationHeartbeat(organizationId);
  return { ok: true, hostToolId: created.hostTool.id };
}

/** Removes a host tool from the catalog, with every harness's configured path for it. */
export async function removeHostTool(
  db: Database,
  organizationId: string,
  hostToolId: string,
): Promise<ActionResult> {
  if (
    !z.uuid().safeParse(hostToolId).success ||
    !(await deleteHostTool(db, organizationId, hostToolId))
  ) {
    return { ok: false, error: "That host tool doesn't exist." };
  }
  await bumpOrganizationHeartbeat(organizationId);
  return { ok: true };
}
