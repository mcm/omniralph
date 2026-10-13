"use server";

import {
  createHarnessEnrollment,
  getDefaultMaxConcurrency,
  getHarnessOverview,
  getDesiredHarnessVersion,
  getRepository,
  listRepositoryOverviewPage,
  TRACK_LATEST_HARNESS_VERSION,
  requestHarnessUpdate as requestHarnessUpdateRow,
  setHarnessHostToolPath,
  setHarnessDesiredVersion as setHarnessDesiredVersionRow,
  unpinRepositoryFromHarness,
  updateHarnessConfig as updateHarnessConfigRow,
} from "@omniralph/db";
import { HarnessVersion, HostToolPath } from "@omniralph/shared";
import { POOLS, TASK_TYPES } from "@omniralph/tasks";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import {
  deleteHarness as deleteHarnessWithRevoke,
  revokeHarness as revokeHarnessWithJobs,
} from "@/lib/harness-auth/revoke";
import { recordLatestHarnessVersion } from "@/lib/harnesses/desired-version";
import { enrollCommand } from "@/lib/harnesses/display";
import { latestHarnessVersion, NpmRegistryError } from "@/lib/harnesses/npm";
import { enqueueInstall } from "@/lib/harnesses/installables";
import { pinRepository as pinRepositoryWithSync } from "@/lib/harnesses/pins";
import { getAppUrl } from "@/lib/app-url";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { HARNESS_TABS, harnessTabHref } from "./[id]/harness-tabs";

function revalidate(harnessId?: string): void {
  revalidatePath("/harnesses");
  if (harnessId) {
    for (const tab of HARNESS_TABS) revalidatePath(harnessTabHref(harnessId, tab.value));
  }
  revalidatePath("/repositories");
}

/** The control panel URL harnesses should use: `APP_URL`, else the URL this request came in on. */
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
      /** The `omniralph-harness enroll …` command to run on the harness host. */
      command: string;
    }
  | { ok: false; error: string };

const EnrollmentName = z.string().trim().max(100);

/** Creates a one-time enrollment token (valid for 1 hour) for a new harness of the active organization. */
export async function createEnrollment(name: string): Promise<EnrollmentActionResult> {
  let created: Extract<EnrollmentActionResult, { ok: true }> | undefined;
  const result = await runAdminAction(async (admin) => {
    const parsed = EnrollmentName.safeParse(name);
    if (!parsed.success) return { ok: false, error: "Names can be at most 100 characters." };
    const enrollment = await createHarnessEnrollment(getDb(), {
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

const HarnessConfig = z.object({
  maxConcurrency: z.number().int().min(1).max(32).nullable(),
  acceptedTaskTypes: z.array(z.enum(TASK_TYPES)).nullable(),
  poolLimits: z.partialRecord(z.enum(POOLS), z.number().int().min(1)),
});
export interface HarnessConfigForm {
  /** Null uses the organization's default (Settings › Harnesses). */
  maxConcurrency: number | null;
  /**
   * Task types the harness may claim jobs of (`query`, `review`, `coding`); null uses the
   * organization's default.
   */
  acceptedTaskTypes: string[] | null;
  /**
   * Per-pool concurrency limits (1 to the effective max concurrency); left-out pools use
   * the default.
   */
  poolLimits: Record<string, number>;
}

/** Updates a harness's central config; the harness gets it with its next heartbeat. */
export async function updateHarnessConfig(
  harnessId: string,
  input: HarnessConfigForm,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const invalid = {
      ok: false,
      error:
        "Max concurrency must be 1–32, task types known ones, and each pool limit 1 to the max concurrency.",
    } as const;
    const parsed = HarnessConfig.safeParse(input);
    if (!parsed.success) return invalid;
    // Pool limits are checked against the max concurrency the harness gets, inherited or not.
    const maxConcurrency =
      parsed.data.maxConcurrency ??
      (await getDefaultMaxConcurrency(getDb(), admin.organization.id));
    if (Object.values(parsed.data.poolLimits).some((limit) => limit > maxConcurrency)) {
      return invalid;
    }
    if (!(await updateHarnessConfigRow(getDb(), admin.organization.id, harnessId, parsed.data))) {
      return { ok: false, error: "That harness doesn't exist or was revoked." };
    }
    revalidate(harnessId);
  });
}

/**
 * Sets the version this harness should run, overriding Settings › Harness defaults; blank
 * clears the override. Harnesses under pm2 update themselves to it.
 */
export async function setHarnessDesiredVersion(
  harnessId: string,
  version: string,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const trimmed = version.trim().replace(/^v(?=\d)/, "");
    const parsed = trimmed ? HarnessVersion.safeParse(trimmed) : null;
    if (parsed && !parsed.success) {
      return { ok: false, error: "Enter a version like 1.4.0, or leave it blank." };
    }
    if (
      !(await setHarnessDesiredVersionRow(
        getDb(),
        admin.organization.id,
        harnessId,
        parsed?.data ?? null,
      ))
    ) {
      return { ok: false, error: "That harness doesn't exist or was revoked." };
    }
    revalidate(harnessId);
  });
}

export type HarnessUpdateActionResult = ActionResult & { version?: string };

/**
 * "Update now": asks the harness to update with its next heartbeat to its desired
 * version (its override, else the organization's), or to the latest on npm when
 * none is chosen or the organization tracks it. Unlike the automatic update it also retries a version that
 * failed on the harness. Only harnesses under pm2 can update themselves.
 */
export async function requestHarnessUpdate(harnessId: string): Promise<HarnessUpdateActionResult> {
  let version: string | undefined;
  const result = await runAdminAction(async (admin) => {
    const db = getDb();
    const harness = await getHarnessOverview(db, admin.organization.id, harnessId);
    if (!harness || harness.revokedAt) {
      return { ok: false, error: "That harness doesn't exist or was revoked." };
    }
    if (harness.selfUpdate !== "supported") {
      return {
        ok: false,
        error:
          "This harness can't update itself (it isn't running under pm2). Update it on the host.",
      };
    }
    const desired =
      harness.desiredVersion ?? (await getDesiredHarnessVersion(db, admin.organization.id));
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
        await recordLatestHarnessVersion(db, admin.organization.id, target);
      }
    }
    if (target === harness.reportedVersion) {
      return { ok: false, error: `${harness.name} already runs ${target}.` };
    }
    if (!(await requestHarnessUpdateRow(db, admin.organization.id, harnessId, target))) {
      return { ok: false, error: "That harness doesn't exist or was revoked." };
    }
    version = target;
    revalidate(harnessId);
  });
  return result.ok ? { ...result, version } : result;
}

/**
 * Revokes a harness: its tokens stop working at once, its running jobs are
 * redelivered to other harnesses and its pins are removed.
 */
export async function revokeHarness(harnessId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const ip = await clientIp();
    if (
      !(await revokeHarnessWithJobs(harnessId, {
        revokedBy: admin.id,
        ip,
        organizationId: admin.organization.id,
      }))
    ) {
      return { ok: false, error: "That harness doesn't exist." };
    }
    revalidate(harnessId);
    revalidatePath("/jobs");
  });
}

/**
 * Deletes a harness: revokes it if it isn't already (see `revokeHarness`), then
 * removes it from the Harnesses pages for good.
 */
export async function deleteHarness(harnessId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (
      !(await deleteHarnessWithRevoke(harnessId, {
        organizationId: admin.organization.id,
        deletedBy: admin.id,
        ip: await clientIp(),
      }))
    ) {
      return { ok: false, error: "That harness doesn't exist." };
    }
    revalidate(harnessId);
    revalidatePath("/jobs");
  });
}

/** Pins a repository to a harness; the harness pre-clones it via a `repo.sync` job. */
export async function pinRepository(
  harnessId: string,
  repositoryId: string,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    if (!(await getRepository(db, repositoryId, admin.organization.id))) {
      return { ok: false, error: "That repository isn't connected." };
    }
    const { result } = await pinRepositoryWithSync(db, getDispatcher(), {
      harnessId,
      repositoryId,
    });
    if (result === "unknown_agent")
      return { ok: false, error: "That harness doesn't exist or was revoked." };
    if (result === "unknown_repository")
      return { ok: false, error: "That repository isn't connected." };
    revalidate(harnessId);
  });
}

/**
 * Installs or updates an installable on one harness (an `install` system RPC
 * targeted at it). The version is an exact version or a dist-tag (default
 * `latest`); the harness refuses packages its local allowlist doesn't allow.
 */
export async function installInstallable(
  harnessId: string,
  input: { name: string; version?: string },
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const name = input.name.trim();
    const version = input.version?.trim() || undefined;
    const enqueued = await enqueueInstall(getDb(), getDispatcher(), {
      organizationId: admin.organization.id,
      harnessId,
      name,
      ...(version !== undefined && { version }),
    });
    if (enqueued.result === "invalid") {
      const field = enqueued.field === "version" ? "version" : "package name";
      return { ok: false, error: `That isn't a valid ${field}.` };
    }
    if (enqueued.result === "unknown_harness") {
      return { ok: false, error: "That harness doesn't exist or was revoked." };
    }
    revalidate(harnessId);
    revalidatePath("/jobs");
  });
}

const INVALID_HOST_TOOL_PATH =
  "Enter an absolute path, like /usr/local/bin/semgrep, or leave it blank.";

/**
 * Sets the path a harness runs a host tool from (an absolute path on the harness host); blank
 * clears it, and the harness then uses the path it discovers on its `PATH`. The harness gets it
 * with its next heartbeat response and reports whether it exists with the heartbeat after.
 */
export async function setHostToolPath(
  harnessId: string,
  hostToolId: string,
  path: string,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const trimmed = path.trim();
    const parsed = trimmed ? HostToolPath.safeParse(trimmed) : null;
    if (parsed && !parsed.success) return { ok: false, error: INVALID_HOST_TOOL_PATH };
    const ids = z.uuid();
    const result =
      ids.safeParse(harnessId).success && ids.safeParse(hostToolId).success
        ? await setHarnessHostToolPath(
            getDb(),
            admin.organization.id,
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
    revalidate(harnessId);
  });
}

/** A connected repository a harness can be pinned to. */
export interface PinnableRepository {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
}

/** Most repositories one search returns: the picker asks people to type more past it. */
const REPOSITORY_SEARCH_LIMIT = 20;

export type RepositorySearchResult = ActionResult & { repositories?: PinnableRepository[] };

/**
 * The organization's connected repositories whose path contains `query` (all of them when it's
 * blank), in path order, at most `REPOSITORY_SEARCH_LIMIT`: the choices of a harness's pins.
 */
export async function searchPinnableRepositories(query: string): Promise<RepositorySearchResult> {
  let repositories: PinnableRepository[] = [];
  const result = await runAdminAction(async (admin) => {
    const page = await listRepositoryOverviewPage(getDb(), admin.organization.id, {
      search: query.slice(0, 200),
      pageSize: REPOSITORY_SEARCH_LIMIT,
    });
    repositories = page.repositories.map(({ id, provider, fullPath }) => ({
      id,
      provider,
      fullPath,
    }));
  });
  return result.ok ? { ...result, repositories } : result;
}

/** Unpins a repository from a harness (any harness may then serve it, unless other pins remain). */
export async function unpinRepository(
  harnessId: string,
  repositoryId: string,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    if (
      !(await getRepository(db, repositoryId, admin.organization.id)) ||
      !(await unpinRepositoryFromHarness(db, { harnessId, repositoryId }))
    ) {
      return { ok: false, error: "That repository isn't pinned to this harness." };
    }
    revalidate(harnessId);
  });
}
