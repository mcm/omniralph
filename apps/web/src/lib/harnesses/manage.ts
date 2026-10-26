import "server-only";
import {
  getDefaultMaxConcurrency,
  getDesiredAgentVersion,
  getAgentOverview,
  listAgentHostTools,
  requestAgentUpdate as requestHarnessUpdateRow,
  setAgentDesiredVersion as setHarnessDesiredVersionRow,
  setAgentHostToolPath,
  TRACK_LATEST_AGENT_VERSION,
  updateAgentConfig as updateHarnessConfigRow,
  type Database,
} from "@omniralph/db";
import { AgentVersion, HostToolPath, POOLS } from "@omniralph/shared";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import type {
  HarnessConfigForm,
  HarnessSettingsSave,
  HostToolPathsSave,
} from "@/lib/api/harnesses";
import type { JobDispatcher } from "@/lib/dispatch";
import {
  deleteHarness as deleteHarnessWithRevoke,
  revokeAgent as revokeHarnessWithJobs,
} from "@/lib/harness-auth/revoke";
import { recordLatestHarnessVersion } from "./desired-version";
import { bumpHarnessHeartbeat } from "./heartbeat-cache";
import { enqueueInstall } from "./installables";
import { latestHarnessVersion, NpmRegistryError } from "./npm";

/**
 * An admin's changes to one harness of their organization (its detail pages): the logic
 * behind the `/api/ui/harnesses/{id}/…` handlers, which parse, authorize and serialize.
 * Every function is scoped to `organizationId` and answers an `ActionResult` worded for
 * the panel's toasts.
 */

type Failure = Extract<ActionResult, { ok: false }>;

const UNKNOWN_HARNESS: Failure = {
  ok: false,
  error: "That harness doesn't exist or was revoked.",
};

const HarnessConfig = z.object({
  maxConcurrency: z.number().int().min(1).max(32).nullable(),
  poolLimits: z.partialRecord(z.enum(POOLS), z.number().int().min(1)),
});

/** Updates a harness's central config; the harness gets it with its next heartbeat. */
export async function updateAgentConfig(
  db: Database,
  organizationId: string,
  harnessId: string,
  input: HarnessConfigForm,
): Promise<ActionResult> {
  const parsed = HarnessConfig.safeParse(input);
  // Pool limits are checked against the max concurrency the harness gets, inherited or not.
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
  if (!(await updateHarnessConfigRow(db, organizationId, harnessId, parsed.data))) {
    return UNKNOWN_HARNESS;
  }
  await bumpHarnessHeartbeat(harnessId);
  return { ok: true };
}

/**
 * Sets the version this harness should run, overriding Settings › Harness defaults; blank
 * clears the override. Harnesses under pm2 update themselves to it.
 */
export async function setAgentDesiredVersion(
  db: Database,
  organizationId: string,
  harnessId: string,
  version: string,
): Promise<ActionResult> {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  const parsed = trimmed ? AgentVersion.safeParse(trimmed) : null;
  if (parsed && !parsed.success) {
    return { ok: false, error: "Enter a version like 1.4.0, or leave it blank." };
  }
  if (!(await setHarnessDesiredVersionRow(db, organizationId, harnessId, parsed?.data ?? null))) {
    return UNKNOWN_HARNESS;
  }
  await bumpHarnessHeartbeat(harnessId);
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
export async function saveHarnessSettings(
  db: Database,
  organizationId: string,
  harnessId: string,
  save: HarnessSettingsSave,
): Promise<ActionResult> {
  return saveInOrder([
    ...(save.config
      ? [
          {
            label: "concurrency",
            run: () => updateAgentConfig(db, organizationId, harnessId, save.config!),
          },
        ]
      : []),
    ...(save.version !== undefined
      ? [
          {
            label: "the desired version",
            run: () => setAgentDesiredVersion(db, organizationId, harnessId, save.version!),
          },
        ]
      : []),
  ]);
}

export type HarnessUpdateResult = ActionResult & { version?: string };

/**
 * "Update now": asks the harness to update with its next heartbeat to its desired
 * version (its override, else the organization's), or to the latest on npm when
 * none is chosen or the organization tracks it. Unlike the automatic update it also retries a version that
 * failed on the harness. Only harnesses under pm2 can update themselves.
 */
export async function requestAgentUpdate(
  db: Database,
  organizationId: string,
  harnessId: string,
): Promise<HarnessUpdateResult> {
  const harness = await getAgentOverview(db, organizationId, harnessId);
  if (!harness || harness.revokedAt) return UNKNOWN_HARNESS;
  if (harness.selfUpdate !== "supported") {
    return {
      ok: false,
      error:
        "This harness can't update itself (it isn't running under pm2). Update it on the host.",
    };
  }
  const desired = harness.desiredVersion ?? (await getDesiredAgentVersion(db, organizationId));
  let target = desired === TRACK_LATEST_AGENT_VERSION ? null : desired;
  if (!target) {
    try {
      target = await latestHarnessVersion();
    } catch (error) {
      if (error instanceof NpmRegistryError) {
        return { ok: false, error: `Couldn't read the latest version: ${error.message}.` };
      }
      throw error;
    }
    // Heartbeats then hand out this version too, so the harness isn't sent back to an older one.
    if (desired === TRACK_LATEST_AGENT_VERSION) {
      await recordLatestHarnessVersion(db, organizationId, target);
    }
  }
  if (target === harness.reportedVersion) {
    return { ok: false, error: `${harness.name} already runs ${target}.` };
  }
  if (!(await requestHarnessUpdateRow(db, organizationId, harnessId, target))) {
    return UNKNOWN_HARNESS;
  }
  await bumpHarnessHeartbeat(harnessId);
  return { ok: true, version: target };
}

/** Who revokes or deletes a harness, for its audit log. */
export interface HarnessActor {
  organizationId: string;
  userId: string;
  ip: string | null;
}

/**
 * Revokes a harness: its tokens stop working at once, its running jobs are
 * redelivered to other harnesses and its pins are removed.
 */
export async function revokeAgent(harnessId: string, actor: HarnessActor): Promise<ActionResult> {
  if (
    !(await revokeHarnessWithJobs(harnessId, {
      revokedBy: actor.userId,
      ip: actor.ip,
      organizationId: actor.organizationId,
    }))
  ) {
    return { ok: false, error: "That harness doesn't exist." };
  }
  return { ok: true };
}

/**
 * Deletes a harness: revokes it if it isn't already (see `revokeAgent`), then
 * removes it from the Harnesses pages for good.
 */
export async function deleteHarness(harnessId: string, actor: HarnessActor): Promise<ActionResult> {
  if (
    !(await deleteHarnessWithRevoke(harnessId, {
      organizationId: actor.organizationId,
      deletedBy: actor.userId,
      ip: actor.ip,
    }))
  ) {
    return { ok: false, error: "That harness doesn't exist." };
  }
  return { ok: true };
}

export type InstallResult = ActionResult & { jobId?: string };

/**
 * Installs or updates an installable on one harness (an `install` system RPC
 * targeted at it). The version is an exact version or a dist-tag (default
 * `latest`); the harness refuses packages its local allowlist doesn't allow.
 */
export async function installInstallable(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  harnessId: string,
  input: { name: string; version?: string },
): Promise<InstallResult> {
  const name = input.name.trim();
  const version = input.version?.trim() || undefined;
  const enqueued = await enqueueInstall(db, dispatcher, {
    organizationId,
    harnessId,
    name,
    ...(version !== undefined && { version }),
  });
  if (enqueued.result === "invalid") {
    const field = enqueued.field === "version" ? "version" : "package name";
    return { ok: false, error: `That isn't a valid ${field}.` };
  }
  if (enqueued.result === "unknown_harness") return UNKNOWN_HARNESS;
  return { ok: true, jobId: enqueued.jobId };
}

const INVALID_HOST_TOOL_PATH =
  "Enter an absolute path, like /usr/local/bin/semgrep, or leave it blank.";

/**
 * Sets the path a harness runs a host tool from (an absolute path on the harness host); blank
 * clears it, and the harness then uses the path it discovers on its `PATH`. The harness gets it
 * with its next heartbeat response and reports whether it exists with the heartbeat after.
 */
export async function setHostToolPath(
  db: Database,
  organizationId: string,
  harnessId: string,
  hostToolId: string,
  path: string,
): Promise<ActionResult> {
  const trimmed = path.trim();
  const parsed = trimmed ? HostToolPath.safeParse(trimmed) : null;
  if (parsed && !parsed.success) return { ok: false, error: INVALID_HOST_TOOL_PATH };
  const ids = z.uuid();
  const result =
    ids.safeParse(harnessId).success && ids.safeParse(hostToolId).success
      ? await setAgentHostToolPath(db, organizationId, harnessId, hostToolId, parsed?.data ?? null)
      : ({ ok: false, error: "not_found" } as const);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "invalid_path"
          ? INVALID_HOST_TOOL_PATH
          : "That harness or host tool doesn't exist, or the harness was revoked.",
    };
  }
  await bumpHarnessHeartbeat(harnessId);
  return { ok: true };
}

/**
 * The Host tools tab's save, as one request: each path in order, stopping at the first that
 * fails; the error names the paths it didn't save (those before it are saved).
 */
export async function saveHostToolPaths(
  db: Database,
  organizationId: string,
  harnessId: string,
  save: HostToolPathsSave,
): Promise<ActionResult> {
  const names = new Map(
    z.uuid().safeParse(harnessId).success
      ? (await listAgentHostTools(db, organizationId, harnessId)).map((tool) => [
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
        run: () => setHostToolPath(db, organizationId, harnessId, hostToolId, path),
      };
    }),
  );
}
