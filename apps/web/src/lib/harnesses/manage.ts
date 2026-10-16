import "server-only";
import {
  getDefaultMaxConcurrency,
  getDesiredHarnessVersion,
  getHarnessOverview,
  getRepository,
  listHarnessHostTools,
  listRepositoryOverviewPage,
  requestHarnessUpdate as requestHarnessUpdateRow,
  setHarnessDesiredVersion as setHarnessDesiredVersionRow,
  setHarnessHostToolPath,
  TRACK_LATEST_HARNESS_VERSION,
  unpinRepositoryFromHarness,
  updateHarnessConfig as updateHarnessConfigRow,
  type Database,
} from "@omniralph/db";
import { HarnessVersion, HostToolPath } from "@omniralph/shared";
import { POOLS, TASK_TYPES } from "@omniralph/tasks";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import type {
  HarnessConfigForm,
  HarnessSettingsSave,
  HostToolPathsSave,
  PinnableRepository,
} from "@/lib/api/harnesses";
import type { JobDispatcher } from "@/lib/dispatch";
import {
  deleteHarness as deleteHarnessWithRevoke,
  revokeHarness as revokeHarnessWithJobs,
} from "@/lib/harness-auth/revoke";
import { recordLatestHarnessVersion } from "./desired-version";
import { enqueueInstall } from "./installables";
import { latestHarnessVersion, NpmRegistryError } from "./npm";
import { pinRepository as pinRepositoryWithSync } from "./pins";

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
  acceptedTaskTypes: z.array(z.enum(TASK_TYPES)).nullable(),
  poolLimits: z.partialRecord(z.enum(POOLS), z.number().int().min(1)),
});

/** Updates a harness's central config; the harness gets it with its next heartbeat. */
export async function updateHarnessConfig(
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
      error:
        "Max concurrency must be 1–32, task types known ones, and each pool limit 1 to the max concurrency.",
    };
  }
  if (!(await updateHarnessConfigRow(db, organizationId, harnessId, parsed.data))) {
    return UNKNOWN_HARNESS;
  }
  return { ok: true };
}

/**
 * Sets the version this harness should run, overriding Settings › Harness defaults; blank
 * clears the override. Harnesses under pm2 update themselves to it.
 */
export async function setHarnessDesiredVersion(
  db: Database,
  organizationId: string,
  harnessId: string,
  version: string,
): Promise<ActionResult> {
  const trimmed = version.trim().replace(/^v(?=\d)/, "");
  const parsed = trimmed ? HarnessVersion.safeParse(trimmed) : null;
  if (parsed && !parsed.success) {
    return { ok: false, error: "Enter a version like 1.4.0, or leave it blank." };
  }
  if (!(await setHarnessDesiredVersionRow(db, organizationId, harnessId, parsed?.data ?? null))) {
    return UNKNOWN_HARNESS;
  }
  return { ok: true };
}

/** Pins a repository to a harness; the harness pre-clones it via a `repo.sync` job. */
export async function pinRepository(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  harnessId: string,
  repositoryId: string,
): Promise<ActionResult> {
  const notConnected: Failure = { ok: false, error: "That repository isn't connected." };
  if (!z.uuid().safeParse(repositoryId).success) return notConnected;
  if (!(await getRepository(db, repositoryId, organizationId))) return notConnected;
  const { result } = await pinRepositoryWithSync(db, dispatcher, { harnessId, repositoryId });
  if (result === "unknown_agent") return UNKNOWN_HARNESS;
  if (result === "unknown_repository") return notConnected;
  return { ok: true };
}

/** Unpins a repository from a harness (any harness may then serve it, unless other pins remain). */
export async function unpinRepository(
  db: Database,
  organizationId: string,
  harnessId: string,
  repositoryId: string,
): Promise<ActionResult> {
  if (
    !z.uuid().safeParse(repositoryId).success ||
    !(await getRepository(db, repositoryId, organizationId)) ||
    !(await unpinRepositoryFromHarness(db, { harnessId, repositoryId }))
  ) {
    return { ok: false, error: "That repository isn't pinned to this harness." };
  }
  return { ok: true };
}

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** A failure part-way through a save, naming what it didn't save: "… Not saved: x and y." */
function partialFailure(failure: Failure, unsaved: readonly string[]): Failure {
  const error = /[.!?]$/.test(failure.error) ? failure.error : `${failure.error}.`;
  return { ...failure, error: `${error} Not saved: ${listFormat.format(unsaved)}.` };
}

interface Step {
  /** What the step saves, for the failure message. */
  label: string;
  run: () => Promise<ActionResult>;
}

/**
 * Runs `steps` in order and stops at the first failure. When the save holds more than one
 * change, the error names every change it didn't save (the failed one and those after it).
 */
async function saveInOrder(steps: readonly Step[]): Promise<ActionResult> {
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
 * The Settings tab's save, as one request: the config, then the desired version, then the
 * unpins and the pins, in that order. It stops at the first that fails; the error names the
 * changes it didn't save (those before it are saved).
 */
export async function saveHarnessSettings(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  harnessId: string,
  save: HarnessSettingsSave,
): Promise<ActionResult> {
  const pins = "pinned repositories";
  return saveInOrder([
    ...(save.config
      ? [
          {
            label: "concurrency and task types",
            run: () => updateHarnessConfig(db, organizationId, harnessId, save.config!),
          },
        ]
      : []),
    ...(save.version !== undefined
      ? [
          {
            label: "the desired version",
            run: () => setHarnessDesiredVersion(db, organizationId, harnessId, save.version!),
          },
        ]
      : []),
    ...save.unpin.map((id) => ({
      label: pins,
      run: () => unpinRepository(db, organizationId, harnessId, id),
    })),
    ...save.pin.map((id) => ({
      label: pins,
      run: () => pinRepository(db, dispatcher, organizationId, harnessId, id),
    })),
  ]);
}

export type HarnessUpdateResult = ActionResult & { version?: string };

/**
 * "Update now": asks the harness to update with its next heartbeat to its desired
 * version (its override, else the organization's), or to the latest on npm when
 * none is chosen or the organization tracks it. Unlike the automatic update it also retries a version that
 * failed on the harness. Only harnesses under pm2 can update themselves.
 */
export async function requestHarnessUpdate(
  db: Database,
  organizationId: string,
  harnessId: string,
): Promise<HarnessUpdateResult> {
  const harness = await getHarnessOverview(db, organizationId, harnessId);
  if (!harness || harness.revokedAt) return UNKNOWN_HARNESS;
  if (harness.selfUpdate !== "supported") {
    return {
      ok: false,
      error:
        "This harness can't update itself (it isn't running under pm2). Update it on the host.",
    };
  }
  const desired = harness.desiredVersion ?? (await getDesiredHarnessVersion(db, organizationId));
  let target = desired === TRACK_LATEST_HARNESS_VERSION ? null : desired;
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
    if (desired === TRACK_LATEST_HARNESS_VERSION) {
      await recordLatestHarnessVersion(db, organizationId, target);
    }
  }
  if (target === harness.reportedVersion) {
    return { ok: false, error: `${harness.name} already runs ${target}.` };
  }
  if (!(await requestHarnessUpdateRow(db, organizationId, harnessId, target))) {
    return UNKNOWN_HARNESS;
  }
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
export async function revokeHarness(harnessId: string, actor: HarnessActor): Promise<ActionResult> {
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
 * Deletes a harness: revokes it if it isn't already (see `revokeHarness`), then
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
      ? await setHarnessHostToolPath(
          db,
          organizationId,
          harnessId,
          hostToolId,
          parsed?.data ?? null,
        )
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
      ? (await listHarnessHostTools(db, organizationId, harnessId)).map((tool) => [
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

/** Most repositories one search returns: the picker asks people to type more past it. */
export const REPOSITORY_SEARCH_LIMIT = 20;

/**
 * The organization's connected repositories whose path contains `query` (all of them when it's
 * blank), in path order, at most `REPOSITORY_SEARCH_LIMIT`: the choices of a harness's pins.
 */
export async function searchPinnableRepositories(
  db: Database,
  organizationId: string,
  query: string,
): Promise<PinnableRepository[]> {
  const page = await listRepositoryOverviewPage(db, organizationId, {
    search: query.slice(0, 200),
    pageSize: REPOSITORY_SEARCH_LIMIT,
  });
  return page.repositories.map(({ id, provider, fullPath }) => ({ id, provider, fullPath }));
}
