import "server-only";
import {
  createHostTool,
  deleteHostTool,
  DESIRED_AGENT_VERSION_KEY,
  getAppSetting,
  listHostTools,
  setDesiredAgentVersion,
  TRACK_LATEST_AGENT_VERSION,
  withSettingsChanges,
  type Database,
} from "@omniralph/db";
import { AGENT_PACKAGE, AgentVersion } from "@omniralph/shared";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import type {
  AddHostToolInput,
  AgentDefaults,
  AgentDefaultsSave,
  HostToolCatalogRow,
} from "@/lib/api/agent-defaults";
import type { VersionPolicy } from "@/lib/fleet/status";
import { settingsActor, trackedAgentDefaults } from "@/lib/settings-history/sections";
import { organizationAgentVersion, recordLatestAgentVersion } from "./desired-version";
import { bumpOrganizationHeartbeat } from "./heartbeat-cache";
import { agentVersionTooOld } from "./min-version";
import { latestAgentVersion, NpmRegistryError } from "./npm";

/**
 * The organization-wide agent defaults (Fleet edits the version policy) every agent gets
 * with its heartbeat, and the host tool catalog. The logic behind `/api/ui/agent-defaults`
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

/**
 * The version policy: the desired version (with `latest` resolved). Slots are each agent's
 * own (`settings.json`), so there is no concurrency default.
 */
export async function loadAgentDefaults(
  db: Database,
  organizationId: string,
): Promise<AgentDefaults> {
  const [setting, resolved] = await Promise.all([
    getAppSetting(db, organizationId, DESIRED_AGENT_VERSION_KEY),
    organizationAgentVersion(db, organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
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
    packageName: AGENT_PACKAGE,
  };
}

export type AgentVersionResult = ActionResult & {
  /** Tracking `latest`: the version on npm now. */
  version?: string;
};

/** A desired version as typed: `latest`, blank (unset), a version, or why it isn't one. */
export type ParsedDesiredVersion =
  | { kind: "latest" }
  | { kind: "unset" }
  | { kind: "pinned"; version: string }
  | { kind: "invalid"; result: ActionResult & { ok: false } };

/** Reads a typed desired version (a leading `v` and surrounding blanks are dropped). */
export function parseDesiredVersion(version: string): ParsedDesiredVersion {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  if (trimmed.toLowerCase() === TRACK_LATEST_AGENT_VERSION) return { kind: "latest" };
  if (!trimmed) return { kind: "unset" };
  const parsed = AgentVersion.safeParse(trimmed);
  if (!parsed.success) {
    return {
      kind: "invalid",
      result: { ok: false, error: "Enter a version like 2.0.0 or latest, or leave it blank." },
    };
  }
  const tooOld = agentVersionTooOld(parsed.data);
  if (tooOld) {
    return {
      kind: "invalid",
      result: { ok: false, error: tooOld, fieldErrors: { version: tooOld } },
    };
  }
  return { kind: "pinned", version: parsed.data };
}

/**
 * Sets the version every agent of the organization should run (agents with their own
 * override keep it); blank clears it, `latest` tracks the latest on npm. Agents under pm2
 * update themselves to it.
 */
export async function setGlobalAgentVersion(
  db: Database,
  admin: DefaultsActor,
  version: string,
): Promise<AgentVersionResult> {
  const parsed = parseDesiredVersion(version);
  if (parsed.kind === "latest") return trackLatestAgentVersion(db, admin);
  if (parsed.kind === "invalid") return parsed.result;
  const pinned = parsed.kind === "pinned" ? parsed.version : null;
  await setDesiredAgentVersion(db, admin.organization.id, pinned, admin.id);
  await bumpOrganizationHeartbeat(admin.organization.id);
  return { ok: true };
}

/**
 * Makes agents follow the agent package's `latest` on npm: they update with each release
 * (it's read again every few minutes). It's read at once, and nothing changes when it can't be.
 */
export async function trackLatestAgentVersion(
  db: Database,
  admin: DefaultsActor,
): Promise<AgentVersionResult> {
  let version: string;
  try {
    version = await latestAgentVersion();
  } catch (error) {
    if (error instanceof NpmRegistryError) {
      return { ok: false, error: `Couldn't read the latest version: ${error.message}.` };
    }
    throw error;
  }
  await recordLatestAgentVersion(db, admin.organization.id, version);
  await setDesiredAgentVersion(db, admin.organization.id, TRACK_LATEST_AGENT_VERSION, admin.id);
  await bumpOrganizationHeartbeat(admin.organization.id);
  return { ok: true, version };
}

/** The answer to a save: with a version sent, the version policy it set (Fleet's cell). */
export type AgentDefaultsSaveResult = ActionResult & { versionPolicy?: VersionPolicy };

/**
 * The version policy's save: the desired version, when sent. What it saved is recorded in the
 * change history. With a version saved, the answer carries the policy it set, so Fleet shows
 * it without a refetch.
 */
export async function saveAgentDefaults(
  db: Database,
  admin: DefaultsActor & { name: string | null; email: string | null },
  save: AgentDefaultsSave,
): Promise<AgentDefaultsSaveResult> {
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

/** The policy a saved version sets; `latest`: the version just read from npm. */
function savedPolicy(version: string, latest: string | undefined): VersionPolicy {
  const parsed = parseDesiredVersion(version);
  if (parsed.kind === "latest") return { mode: "latest", version: null, target: latest ?? null };
  if (parsed.kind === "pinned") {
    return { mode: "pinned", version: parsed.version, target: parsed.version };
  }
  return { mode: "unset", version: null, target: null };
}

async function saveDefaultsInOrder(
  db: Database,
  admin: DefaultsActor,
  save: AgentDefaultsSave,
): Promise<AgentDefaultsSaveResult> {
  if (save.version === undefined) return { ok: true };
  const saved = await setGlobalAgentVersion(db, admin, save.version);
  return saved.ok ? { ok: true, versionPolicy: savedPolicy(save.version, saved.version) } : saved;
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
 * Adds a host tool (software agent owners install by hand) to the organization's catalog.
 * Agents get it with their next heartbeat and report where they find it.
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

/** Removes a host tool from the catalog, with every agent's configured path for it. */
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
